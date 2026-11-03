// Metrics, computed in code from the ledger (never by the AI). Every answer carries its provenance:
// basis, as-of, included/excluded accounts, stale sources, pending review items, AI entries and row ids.
// Definitions: docs/roundtable/finance-model.md §8, adapted to the ledger.
import { mrrMovements, mrrSeries, productList, valueAt } from './mrr.ts'
import type { EntityId, Id, IsoDate, MetricAnswer, MetricName, MetricScope, Money } from '@agfn/contracts'
import { cashRole, isExpenseRole, NON_CASH_EXPENSE_ROLES, PAYROLL_ROLES } from './coa.ts'
import { openItems, runChecks, type CheckResult } from './checks.ts'
import type { Basis, EntityInfo, SourceAccountInfo, SourceRecord } from './model.ts'
import { formatMoney, NOT_MONEY } from './money.ts'
import { addDays, addMonths, baseBalances, daysBetween, ledgerAccounts, monthEnd, monthStart, scopeEntities, sumLinesIn, today, trailingMonths, type ReadContext, todayFor, localDate, zoneOf, walkedLines } from './queries.ts'
import { listReviewItems } from './review.ts'
import { coverage } from './coverage.ts'
import { dataHealth } from './health.ts'
import { recurringSpend } from './buckets.ts'
import { heldRows } from './set-aside.ts'
import type { LineRow } from './store.ts'
import { syncedLongAgo } from './store.ts'

export interface MetricContext extends ReadContext {
  /** The engine, for metrics that need review items or registered providers. */
  engine: { metricProviders?: Map<string, MetricProvider> }
  /** Optional per-request memo, so many metrics in one overview share one checks/review pass. */
  memo?: Map<string, Promise<unknown>>
  /** AGFN_SET_ASIDES: runway uses available cash. */
  setAsides?: boolean
}

function memo<T>(rc: MetricContext, key: string, fn: () => Promise<T>): Promise<T> {
  if (!rc.memo) return fn()
  const hit = rc.memo.get(key)
  if (hit) return hit as Promise<T>
  const p = fn()
  rc.memo.set(key, p)
  return p
}

export type MetricProvider = (scope: MetricScope, rc: ReadContext) => Promise<MetricAnswer>

/** A metric answer plus the checks that are currently failing for its scope. */
export interface CoreMetricAnswer extends MetricAnswer {
  failedChecks: Array<Pick<CheckResult, 'name' | 'status' | 'message' | 'entityId'>>
  /** Row ids are capped; this is the full count. */
  rowCount: number
}

export const MAX_ROW_IDS = 200
const STALE_MS = 24 * 60 * 60 * 1000

interface Scope {
  rc: MetricContext
  entities: EntityInfo[]
  entityIds: EntityId[]
  byId: Map<EntityId, EntityInfo>
  asOf: IsoDate
  from: IsoDate
  to: IsoDate
  basis: Basis
  currency: string
  /** MetricScope.figureOnly: no checks, review or stale sources in the answer. */
  figureOnly?: boolean
}

async function makeScope(rc: MetricContext, scope: MetricScope, defaultBasis: Basis): Promise<Scope> {
  const entities = await scopeEntities(rc, scope.entityIds)
  const asOf = scope.to ?? (await todayFor(rc))
  const lastMonth = trailingMonths(asOf, 1)[0] as { from: IsoDate; to: IsoDate }
  return {
    rc,
    entities,
    entityIds: entities.map((e) => e.id),
    byId: new Map(entities.map((e) => [e.id, e])),
    asOf,
    from: scope.from ?? (scope.to ? monthStart(scope.to) : lastMonth.from),
    to: scope.to ?? (scope.from ? asOf : lastMonth.to),
    basis: scope.basis ?? defaultBasis,
    currency: await rc.directory.reportingCurrency(rc.ws),
    ...(scope.figureOnly ? { figureOnly: true } : {}),
  }
}

export async function computeMetric(name: MetricName, scope: MetricScope, rc: MetricContext): Promise<CoreMetricAnswer> {
  const provider = rc.engine.metricProviders?.get(name)
  if (provider) return finish(await makeScope(rc, scope, 'cash'), await provider(scope, rc), [])
  switch (name) {
    case 'cash':
    case 'card_balances':
    case 'net_cash':
      return balanceMetric(name, await makeScope(rc, scope, 'cash'))
    case 'available_cash':
      return availableCashMetric(await makeScope(rc, scope, 'cash'))
    case 'gross_burn':
    case 'net_burn':
      return burnMetric(name, await makeScope(rc, scope, 'cash'), scope.from !== undefined, scope.to === undefined)
    case 'runway':
      return runwayMetric(await makeScope(rc, scope, 'cash'))
    case 'revenue':
      return revenueMetric(await makeScope(rc, scope, 'cash'))
    case 'ar_open':
    case 'ar_overdue':
    case 'ap_due':
      return openItemsMetric(name, await makeScope(rc, scope, 'accrual'))
    case 'payroll_cost':
      return payrollMetric(await makeScope(rc, scope, 'accrual'))
    case 'owner_balance':
    case 'intercompany_balance':
      return positionMetric(name, await makeScope(rc, scope, 'cash'))
    case 'recurring_spend':
      return recurringMetric(await makeScope(rc, scope, 'cash'))
    case 'mrr':
    case 'arr':
      return mrrMetric(name, await makeScope(rc, scope, 'accrual'))
    case 'data_health':
      return healthMetric(await makeScope(rc, scope, 'cash'))
    case 'mrr_churn_rate':
    case 'net_new_mrr':
      return mrrMovementMetric(name, await makeScope(rc, scope, 'accrual'))
    case 'fully_diluted':
      return finish(await makeScope(rc, scope, 'accrual'), blank(name, 'accrual', rc.now, 'Fully diluted ownership comes from the cap table (equity module); not connected.'), [])
  }
}

function blank(name: MetricName, basis: Basis, asOf: string, formula: string): MetricAnswer {
  return {
    name,
    value: null,
    state: 'no_data',
    basis,
    asOf,
    includedAccounts: [],
    excludedAccounts: [],
    staleSources: [],
    pendingReviewCount: 0,
    agentEntriesIncluded: 0,
    rowIds: [],
    formula,
  }
}

/**
 * Problems from the checks, for a scope. One run over every entity per request (and per write, through the shared
 * cache), filtered here: an overview of four companies asked seven scoped runs. A workspace-level problem (no
 * entity) belongs to a scope only when it covers every entity.
 */
async function scopedChecks(rc: MetricContext, entityIds: EntityId[], _asOf: IsoDate): Promise<CheckResult[]> {
  const all = await memo(rc, 'entities|*', () => rc.directory.listEntities(rc.ws))
  const every = await checksNow(rc)
  const scope = new Set(entityIds)
  const whole = all.every((e) => scope.has(e.id))
  return every.filter((c) => (c.entityId === null ? whole : scope.has(c.entityId)))
}

async function checksNow(rc: MetricContext): Promise<CheckResult[]> {
  const all = await memo(rc, 'entities|*', () => rc.directory.listEntities(rc.ws))
  // The books' problems as they stand today, whatever period the figure covers: what needs attention now (and one
  // check run per request instead of one per as-of date; last month's flows asked for a second, cold).
  const now = await todayFor(rc)
  return memo(rc, `checks|*|${now}`, () => runChecks(rc, { entityIds: all.map((e) => e.id), asOf: now, problemsOnly: true }))
}

// ---------- A failing check in the answer it affects ----------

const TIE_OUTS: readonly CheckResult['name'][] = ['balance_identity', 'balance_assertion']

/**
 * Failed checks, as facts for the reader. A balance figure gets the tie-outs of its own accounts, in the check's words.
 * Burn or revenue can go to a connection that can't see balances, so it gets the account's name and no amount.
 */
async function checkCaveats(s: Scope, a: MetricAnswer, checks: CheckResult[]): Promise<string[]> {
  const balance = BALANCE_METRICS.includes(a.name)
  if (!balance && !FLOW_METRICS.includes(a.name)) return []
  const accounts = await memo(s.rc, 'sourceAccounts|*', () => s.rc.directory.listSourceAccounts(s.rc.ws))
  const failed = checks.filter((c) => c.status === 'fail')
  const accountOf = (c: CheckResult) => c.accountId ?? c.subjectId
  if (balance) return [...new Set(failed.filter((c) => TIE_OUTS.includes(c.name) && (!a.includedAccounts.length || a.includedAccounts.includes(accountOf(c) as Id))).map((c) => c.message))]
  const flowChecks: readonly CheckResult['name'][] = [...TIE_OUTS, 'trial_balance', 'duplicate_source', 'provider_report']
  return [...new Set(failed.filter((c) => flowChecks.includes(c.name)).map((c) => `${accounts.find((x) => x.id === accountOf(c))?.name ?? 'A check'} doesn't match, so this figure may be off`))]
}

/**
 * A sale proposed as the same one in a processor and other books counts in both until someone answers, so revenue says
 * how much that is. One charge can be proposed against both the invoice and its payment: it counts once.
 */
async function unconfirmedSales(s: Scope, from: IsoDate, to: IsoDate): Promise<string[]> {
  const links = (await s.rc.store.listLinks(s.rc.ws, { statuses: ['proposed'] })).filter((l) => l.type === 'invoice_payment' && l.scores?.name === 1 && l.amount)
  if (!links.length) return []
  const amounts = new Map(links.map((l) => [l.toId, l.amount as Money]))
  const scope = new Set<string>(s.entityIds)
  const charges = (await s.rc.store.getRecords(s.rc.ws, [...amounts.keys()])).filter((r) => r.entityId && scope.has(r.entityId) && r.date >= from && r.date <= to)
  if (!charges.length) return []
  let total = 0
  for (const r of charges) total += (await s.rc.toCurrency(amounts.get(r.id) as Money, s.currency, r.date)).minor
  return [`${formatMoney(total, s.currency)} in sales that may also be in your books is waiting in Review and is counted twice until confirmed`]
}

/** The same for a refund in both, which only the accrual side takes off twice. */
async function unconfirmedRefunds(s: Scope, from: IsoDate, to: IsoDate): Promise<string[]> {
  if (s.basis !== 'accrual') return []
  const links = (await s.rc.store.listLinks(s.rc.ws, { types: ['refund'], statuses: ['proposed'] })).filter((l) => l.scores?.name === 1 && l.amount)
  if (!links.length) return []
  const amounts = new Map(links.map((l) => [l.toId, l.amount as Money]))
  const scope = new Set<string>(s.entityIds)
  const rows = (await s.rc.store.getRecords(s.rc.ws, [...amounts.keys()])).filter((r) => r.entityId && scope.has(r.entityId) && r.date >= from && r.date <= to)
  let total = 0
  for (const r of rows) total += (await s.rc.toCurrency(amounts.get(r.id) as Money, s.currency, r.date)).minor
  return total ? [`${formatMoney(total, s.currency)} in refunds that may also be in your books is waiting in Review and is counted twice until confirmed`] : []
}

/** Burn counts a proposed transfer's debit as spending until someone answers, so the answer says how much that is. */
async function unconfirmedMoves(s: Scope, name: MetricName, from: IsoDate, to: IsoDate): Promise<string[]> {
  if (name === 'revenue') return [...(await unconfirmedSales(s, from, to)), ...(await unconfirmedRefunds(s, from, to))]
  if (name !== 'gross_burn' && name !== 'net_burn' && name !== 'runway') return []
  const links = (await s.rc.store.listLinks(s.rc.ws, { statuses: ['proposed'] })).filter((l) => l.type === 'transfer' || l.type === 'intercompany')
  if (!links.length) return []
  const scope = new Set<string>(s.entityIds)
  const debits = (await s.rc.store.getRecords(s.rc.ws, [...new Set(links.map((l) => l.fromId))])).filter((r) => r.entityId && scope.has(r.entityId) && r.date >= from && r.date <= to && r.amount && r.amount.minor < 0)
  if (!debits.length) return []
  let total = 0
  for (const r of debits) total += Math.abs((await s.rc.toCurrency(r.amount as Money, s.currency, r.date)).minor)
  return [`${formatMoney(total, s.currency)} in possible transfers is waiting in Review and is counted as spending until confirmed`]
}

/** The caveats go in coverage.gaps and the reason. A figure already unknown or short of history keeps its own state. */
function withCaveats(a: MetricAnswer, caveats: string[]): MetricAnswer {
  if (!caveats.length) return a
  const reason = caveats.join('; ')
  return {
    ...a,
    ...(a.state === undefined || a.state === 'ok' ? { state: 'stale' as const } : {}),
    unknownReason: a.unknownReason ? `${a.unknownReason}; ${reason}` : reason,
    checkCaveat: true,
    coverage: { accounts: a.coverage?.accounts ?? [], gaps: [...(a.coverage?.gaps ?? []), ...caveats] },
  }
}

/** Fill the shared provenance fields every answer carries. */
async function finish(s: Scope, a: MetricAnswer, rowIds: Id[]): Promise<CoreMetricAnswer> {
  const rc = s.rc
  const byHand = await memo(rc, 'byhand', () => rc.store.addedByHand(rc.ws))
  // An undone entry (voided: its lines and their reversal net to zero) is no longer part of the number.
  const undone = (id: Id) => { const st = byHand.get(id); return st === 'void' || st === 'excluded' }
  const unique = await stableOrder(rc, [...new Set(rowIds.filter((id) => !id.startsWith('opening:') && !undone(id)))])
  const agentEntries = unique.filter((id) => byHand.has(id)).length
  const ids = [...s.entityIds].sort().join(',')
  // Figure only (the write pipeline's alert): no workspace-wide checks or review, the costliest part after a write.
  const none = Promise.resolve([] as never[])
  const [stale, review, checks, cov] = await Promise.all([
    s.figureOnly ? none : memo(rc, `stale|${ids}`, () => staleSources(s)),
    s.figureOnly ? none : memo(rc, `review|${ids}`, () => listReviewItems(rc, { entityIds: s.entityIds })),
    s.figureOnly ? none : scopedChecks(rc, s.entityIds, s.asOf),
    memo(rc, `cov|${ids}|${s.asOf}|${s.from}|${s.to}`, () => coverageBlock(s)),
  ])
  const order = await accountOrder(s)
  // A problem with no company (a broken ledger) touches every figure, even when scopedChecks leaves it off a company's list.
  const caveats = s.figureOnly ? [] : [...(await checkCaveats(s, a, [...checks, ...(await checksNow(rc)).filter((c) => c.entityId === null && !checks.includes(c))])), ...(await unconfirmedMoves(s, a.name, a.name === 'runway' ? addMonths(s.from, -2) : s.from, s.to))]
  return {
    ...withCaveats({
      ...honesty({ ...a, includedAccounts: [...a.includedAccounts].sort(order.byId), excludedAccounts: [...a.excludedAccounts].sort((x, y) => order.byId(x.id, y.id)) }, s, cov),
      coverage: { accounts: cov.accounts, gaps: cov.gaps },
    }, caveats),
    asOf: await answerAsOf(s, a.asOf ?? s.asOf),
    staleSources: stale,
    pendingReviewCount: review.length,
    agentEntriesIncluded: agentEntries,
    rowIds: unique.slice(0, MAX_ROW_IDS),
    rowCount: unique.length,
    formula: unique.length > MAX_ROW_IDS ? `${a.formula} (first ${MAX_ROW_IDS} of ${unique.length} rows listed)` : a.formula,
    failedChecks: checks.map((c) => ({ name: c.name, status: c.status, message: c.message, entityId: c.entityId })),
  }
}

/**
 * Accounts as an answer lists them: by company, then account name, then id. Never by creation order, which depends on
 * how an import was paged (the same books gave a different order after the demo's pages grew, 2026-10-13).
 */
async function accountOrder(s: Scope): Promise<{ byId: (x: Id, y: Id) => number }> {
  const all = await memo(s.rc, 'sourceAccounts|*', () => s.rc.directory.listSourceAccounts(s.rc.ws))
  const key = new Map(all.map((a) => [a.id, `${(a.entityId && s.byId.get(a.entityId)?.name) ?? '~'}\u0000${a.name}\u0000${a.id}`]))
  const k = (id: Id) => key.get(id) ?? `~\u0000~\u0000${id}`
  return { byId: (x, y) => (k(x) < k(y) ? -1 : k(x) > k(y) ? 1 : 0) }
}

/**
 * Rows by date, then the provider's type and id: the same rows in the same order on every run and database (record ids
 * are random, and the first MAX_ROW_IDS are what an answer lists). The workspace's keys are read once per ledger version
 * (one light read, kept with the other derived results), and once per request without that cache.
 */
async function stableOrder(rc: MetricContext, ids: Id[]): Promise<Id[]> {
  if (ids.length < 2) return ids
  const read = () => rc.store.recordSortKeys(rc.ws)
  const keys = await memo(rc, 'sortkeys', () => (rc.shared ? rc.shared('sortkeys', read) : read()))
  const key = (id: Id) => keys.get(id) ?? `~|${id}`
  return [...ids].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : a > b ? 1 : 0))
}

// ---------- Coverage: unknown, not zero ----------

/** Synced sources are expected to be current within a week; hand-kept and statement-only accounts within a month. */
const STALE_DAYS_SYNCED = 7
const STALE_DAYS_MONTHLY = 35
/** A period ending today or yesterday counts as synced through if the source synced in the last few days. */
const RECENT_SYNC_DAYS = 3

const BALANCE_METRICS: readonly MetricName[] = ['cash', 'card_balances', 'net_cash', 'available_cash']
const FLOW_METRICS: readonly MetricName[] = ['gross_burn', 'net_burn', 'revenue', 'runway', 'payroll_cost', 'recurring_spend']

/** Kept by hand in the app (cash on hand, money paid personally): the ledger is its only source, so always known. */
function handKept(a: { accountType: string }, conn: { connectorKey: string } | undefined): boolean {
  return a.accountType === 'cash_on_hand' || conn?.connectorKey === 'manual'
}

interface CovAccount {
  accountId: Id
  name: string
  balanceAsOf: IsoDate | null
  syncedThrough: IsoDate | null
  stale: boolean
  /** Synced by a connector (not by hand or from uploaded statements). */
  synced: boolean
}

async function coverageBlock(s: Scope): Promise<{ accounts: CovAccount[]; gaps: string[]; gapMonths: Map<Id, string[]>; today: IsoDate }> {
  const rc = s.rc
  const { inScope } = await scopedAccounts(s)
  const conns = new Map((await rc.directory.listConnections(rc.ws)).map((c) => [c.id, c]))
  const accounts: CovAccount[] = []
  for (const a of inScope) {
    if (a.accountType !== 'credit_card' && !a.includeInCash) continue
    const conn = a.connectionId ? conns.get(a.connectionId) : undefined
    const synced = Boolean(conn && conn.connectorKey !== 'manual' && conn.connectorKey !== 'files')
    const snap = (await newestDay(rc, a.id, ['balance.snapshot'], s.asOf)).find((r) => r.status === 'recorded')
    const row = (await newestDay(rc, a.id, ['txn.upsert', 'processor.balance_txn'], s.asOf))[0]
    const lastSync = conn?.lastSuccessAt ? localDate(conn.lastSuccessAt, await zoneOf(rc)) : null
    const lastData = [snap?.date, row?.date].filter((d): d is IsoDate => Boolean(d)).sort().pop() ?? null
    const syncedThrough = synced ? lastSync : lastData
    // A synced account that sent neither a balance nor a row hasn't told us anything yet. One kept by hand or by the
    // ledger itself (cash on hand, a Square cash drawer, paid personally) is what the ledger says, even while its
    // connection's first sync runs: nothing recorded is a known zero, not unknown.
    const today = await todayFor(rc)
    // Synced that way (the drawer), it's as current as the last sync: a quiet week without cash sales isn't stale.
    const kept = [lastData, synced ? lastSync : null].filter((d): d is IsoDate => Boolean(d)).sort().pop()
    // A processor balance (Gumroad, Lemon Squeezy, Stripe…) is the sum of its own rows; the provider never sends a
    // balance. Once a sync has finished, an account with no sales yet is a known zero, not "never reported".
    const ledgerKept = synced && a.accountType === 'processor_balance'
    const balanceAsOf = handKept(a, conn) ? (kept ?? today) : synced ? (snap?.date ?? (row || ledgerKept ? lastSync : null)) : lastData
    const limit = synced ? STALE_DAYS_SYNCED : STALE_DAYS_MONTHLY
    const stale = balanceAsOf !== null && daysBetween(balanceAsOf, (await todayFor(rc))) > limit
    accounts.push({ accountId: a.id, name: `${a.name}${a.mask ? ` ··${a.mask}` : ''}`, balanceAsOf, syncedThrough, stale, synced })
  }
  // A stable order to show them in (accounts made in the same instant otherwise sort by a random id).
  accounts.sort((x, y) => x.name.localeCompare(y.name) || (x.accountId < y.accountId ? -1 : 1))
  // Missing or mismatched months inside the period, from the coverage view.
  const gaps: string[] = []
  const gapMonths = new Map<Id, string[]>()
  const covered = new Set(accounts.map((x) => x.accountId))
  for (const c of await coverage(rc, { entityIds: s.entityIds, from: s.from.slice(0, 7), to: s.to.slice(0, 7) })) {
    if (!covered.has(c.accountId)) continue
    for (const m of c.months) {
      if (m.month < s.from.slice(0, 7) || m.month > s.to.slice(0, 7) || (m.status !== 'missing' && m.status !== 'mismatched')) continue
      gapMonths.set(c.accountId, [...(gapMonths.get(c.accountId) ?? []), m.month])
      gaps.push(`${c.name}${c.mask ? ` ··${c.mask}` : ''}: ${m.month} ${m.status === 'missing' ? 'has no data' : "doesn't add up"}${m.detail ? ` (${m.detail})` : ''}`)
    }
  }
  return { accounts, gaps, gapMonths, today: await todayFor(rc) }
}

function shortDate(d: IsoDate): string {
  return new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Unknown, not zero. Balance figures: unknown only when an included account never reported; stale (value kept) when
 * a balance is old. Flow figures over a period: unknown when a month is missing or doesn't add up, or a synced
 * source hasn't synced through the period's end.
 */
function honesty(a: MetricAnswer, s: Scope, cov: { accounts: CovAccount[]; gaps: string[]; today: IsoDate }): MetricAnswer {
  if (a.value === null && a.state !== 'ok' && a.state !== undefined) return a
  const isBalance = BALANCE_METRICS.includes(a.name) || a.name === 'runway'
  const isFlow = FLOW_METRICS.includes(a.name)
  if (!isBalance && !isFlow) return a
  const included = a.includedAccounts.length ? new Set(a.includedAccounts) : null
  const relevant = cov.accounts.filter((x) => !included || included.has(x.accountId))
  const unknown = (reason: string): MetricAnswer => ({ ...a, value: null, state: 'unknown', unknownReason: reason })
  if (isBalance) {
    const never = relevant.filter((x) => x.balanceAsOf === null)
    if (never.length) return unknown(`${never.map((x) => x.name).join(', ')} ${never.length === 1 ? 'has' : 'have'} never reported a balance`)
  }
  if (isFlow) {
    if (cov.gaps.length) return unknown(cov.gaps.join('; '))
    const now = cov.today
    const recentEnd = daysBetween(s.to, now) <= 1
    for (const x of relevant.filter((r) => r.synced)) {
      const through = x.syncedThrough
      const ok = through !== null && (recentEnd ? daysBetween(through, now) <= RECENT_SYNC_DAYS : through >= s.to)
      if (!ok) return unknown(through ? `${x.name} has only synced through ${shortDate(through)}` : `${x.name} hasn't synced yet`)
    }
  }
  const old = relevant.filter((x) => x.stale && x.balanceAsOf)
  if (isBalance && old.length) {
    return { ...a, state: 'stale', unknownReason: `${old.map((x) => `${x.name} last reported ${shortDate(x.balanceAsOf as IsoDate)}`).join('; ')}; total uses ${old.length === 1 ? 'that balance' : 'those balances'}` }
  }
  return a
}

/**
 * When a figure is as of: for a past day, that day; for today, as fresh as its stalest source (the oldest last good
 * sync among the scope's syncing connections that aren't stale), else now. A bare date would read as midnight UTC ("4h ago").
 */
async function answerAsOf(s: Scope, asOf: string): Promise<string> {
  if (asOf.length > 10) return asOf
  const today = await todayFor(s.rc)
  if (asOf < today) return asOf
  return memo(s.rc, `fresh|${[...s.entityIds].sort().join(',')}`, async () => {
    const accounts = (await memo(s.rc, 'sourceAccounts|*', () => s.rc.directory.listSourceAccounts(s.rc.ws))).filter((a) => a.entityId && s.byId.has(a.entityId))
    const ids = new Set(accounts.map((a) => a.connectionId).filter((c): c is Id => c !== null))
    // Stale sources are listed on their own (staleSources): the figure is as of the oldest of the others, when any.
    const now = Date.parse(s.rc.now)
    let fresh: string | null = null
    let any: string | null = null
    for (const c of await memo(s.rc, 'connections|*', () => s.rc.directory.listConnections(s.rc.ws))) {
      if (!ids.has(c.id) && !(c.entityId && s.byId.has(c.entityId))) continue
      if (c.connectorKey === 'manual' || c.status === 'disconnected' || !c.lastSuccessAt) continue
      if (!any || c.lastSuccessAt < any) any = c.lastSuccessAt
      const ok = c.status === 'active' && now - Date.parse(c.lastSuccessAt) <= STALE_MS
      if (ok && (!fresh || c.lastSuccessAt < fresh)) fresh = c.lastSuccessAt
    }
    return fresh ?? any ?? s.rc.now
  })
}

async function staleSources(s: Scope): Promise<Id[]> {
  const accounts = (await memo(s.rc, 'sourceAccounts|*', () => s.rc.directory.listSourceAccounts(s.rc.ws))).filter((a) => a.entityId && s.byId.has(a.entityId))
  const connIds = new Set(accounts.map((a) => a.connectionId).filter((c): c is Id => c !== null))
  const conns = await memo(s.rc, 'connections|*', () => s.rc.directory.listConnections(s.rc.ws))
  for (const c of conns) if (c.entityId && s.byId.has(c.entityId)) connIds.add(c.id)
  const now = Date.parse(s.rc.now)
  const out: Id[] = []
  for (const id of connIds) {
    const c = conns.find((x) => x.id === id) ?? (await s.rc.directory.getConnection(s.rc.ws, id))
    // "Added by hand" never syncs, so it can't go stale (same rule as dataHealth).
    if (!c || c.connectorKey === 'manual' || c.status === 'disconnected') continue
    const old = syncedLongAgo(c, now)
    if (old || c.status !== 'active') out.push(id)
  }
  return out.sort()
}

function money(minor: number, currency: string): Money {
  return { minor: minor || 0, currency }
}

// ---------- Cash, cards, net cash ----------

async function scopedAccounts(s: Scope): Promise<{ inScope: SourceAccountInfo[]; excluded: Array<{ id: Id; reason: string }> }> {
  const all = await s.rc.directory.listSourceAccounts(s.rc.ws)
  const inScope: SourceAccountInfo[] = []
  const excluded: Array<{ id: Id; reason: string }> = []
  for (const a of all) {
    if (!a.entityId) {
      excluded.push({ id: a.id, reason: 'not assigned to a company yet' })
      continue
    }
    if (!s.byId.has(a.entityId)) continue
    if (a.duplicateOf) excluded.push({ id: a.id, reason: `same account as ${a.duplicateOf}` })
    else if (a.currency === NOT_MONEY) excluded.push({ id: a.id, reason: 'not money (points or crypto)' })
    else inScope.push(a)
  }
  return { inScope, excluded }
}

/** Latest provider balance on or before asOf, else the ledger balance. Signed (+ = money held). */
/**
 * Every account's records of these types on its newest day up to `toDate`, read once per request for all accounts
 * (balances and coverage asked per account, per scope: dozens of reads for an overview).
 */
async function newestDay(rc: MetricContext, accountId: Id, types: SourceRecord['eventType'][], toDate: IsoDate): Promise<SourceRecord[]> {
  // Without a request memo there's no "once": read just this account.
  if (!rc.memo) return rc.store.latestRecordsByAccount(rc.ws, [accountId], types, toDate)
  const key = `newest|${types.join(',')}|${toDate}`
  const read = async () => {
    const ids = (await rc.directory.listSourceAccounts(rc.ws)).map((a) => a.id)
    const by = new Map<Id, SourceRecord[]>()
    for (const r of await rc.store.latestRecordsByAccount(rc.ws, ids, types, toDate)) if (r.sourceAccountId) by.set(r.sourceAccountId, [...(by.get(r.sourceAccountId) ?? []), r])
    return by
  }
  // Kept until the next write, across requests (the warm's scopes and the first requests read it once, not each).
  const all = await memo(rc, key, () => (rc.shared ? rc.shared(key, read) : read()))
  return all.get(accountId) ?? []
}

export async function accountBalance(s: Pick<Scope, 'rc' | 'asOf'>, a: SourceAccountInfo): Promise<{ minor: number; currency: string; rowId: Id | null; rowIds: Id[]; source: 'provider' | 'ledger' }> {
  // Newest day's snapshots only (a few per day at most); the latest `at` wins.
  const snaps = (await newestDay(s.rc, a.id, ['balance.snapshot'], s.asOf)).filter((r) => r.status === 'recorded' && r.event.type === 'balance.snapshot')
  const latest = snaps.reduce<SourceRecord | null>((m, r) => (m === null || (r.event as { at: string }).at > (m.event as { at: string }).at ? r : m), null)
  if (latest && latest.event.type === 'balance.snapshot') return { ...latest.event.current, rowId: latest.id, rowIds: [latest.id], source: 'provider' }
  const ledger = await s.rc.store.findLedgerAccount(s.rc.ws, a.entityId as EntityId, cashRole(a.id, a.accountType))
  if (!ledger) return { minor: 0, currency: a.currency, rowId: null, rowIds: [], source: 'ledger' }
  const lines = await walkedLines(s.rc, ledger.id, s.asOf)
  const own = lines.filter((l) => l.currency === a.currency)
  return { minor: own.reduce((t, l) => t + l.debitMinor - l.creditMinor, 0), currency: a.currency, rowId: null, rowIds: [...new Set(own.map((l) => l.sourceId))], source: 'ledger' }
}

/**
 * The `cash` metric on many days at once (a trend line): each account's balances and ledger lines are read once, then
 * every day is answered from memory, by the same rule as the metric (latest provider balance on or before the day,
 * else the ledger balance), converted at that day's rate. One answer per day, in the scope's reporting currency;
 * null on a day the metric is unknown because an account had told us nothing yet (no balance and no row by then).
 */
export async function cashHistory(rc: MetricContext, entityIds: EntityId[], days: IsoDate[]): Promise<Array<Money | null>> {
  if (days.length === 0) return []
  const last = [...days].sort().at(-1) as IsoDate
  const s = await makeScope(rc, { workspaceId: rc.ws, entityIds, to: last }, 'cash')
  const { inScope } = await scopedAccounts(s)
  const cashAccounts = inScope.filter((a) => a.accountType !== 'credit_card' && a.includeInCash)
  const snaps = new Map<Id, SourceRecord[]>()
  for (const r of await rc.store.listRecords(rc.ws, { entityIds: s.entityIds, eventTypes: ['balance.snapshot'], statuses: ['recorded'], toDate: last })) {
    if (r.sourceAccountId) snaps.set(r.sourceAccountId, [...(snaps.get(r.sourceAccountId) ?? []), r])
  }
  const conns = new Map((await rc.directory.listConnections(rc.ws)).map((c) => [c.id, c]))
  const perAccount = await Promise.all(
    cashAccounts.map(async (a) => {
      const own = snaps.get(a.id) ?? []
      // The metric's honesty rule (coverageBlock): known from the first balance, or the first row (a synced
      // account's rows count only once its connection has synced).
      const conn = a.connectionId ? conns.get(a.connectionId) : undefined
      const synced = Boolean(conn && conn.connectorKey !== 'manual' && conn.connectorKey !== 'files')
      const [firstRow] = await rc.store.listRecords(rc.ws, { sourceAccountId: a.id, eventTypes: ['txn.upsert', 'processor.balance_txn'], statuses: ['posted', 'recorded'], limit: 1 })
      const firstSnap = own.reduce<IsoDate | null>((m, r) => (m === null || r.date < m ? r.date : m), null)
      const rowsCount = firstRow !== undefined && (!synced || Boolean(conn?.lastSuccessAt))
      const knownFrom = handKept(a, conn) ? '0000-01-01' : ([firstSnap, rowsCount ? (firstRow as SourceRecord).date : null].filter((d): d is IsoDate => d !== null).sort()[0] ?? null)
      // Newest day on or before d, the latest `at` that day: the same pick as accountBalance.
      const fromSnapshot = (d: IsoDate): { minor: number; currency: string } | null => {
        let best: SourceRecord | null = null
        for (const r of own) {
          if (r.date > d || r.event.type !== 'balance.snapshot') continue
          if (!best || r.date > best.date || (r.date === best.date && (r.event as { at: string }).at > (best.event as { at: string }).at)) best = r
        }
        return best && best.event.type === 'balance.snapshot' ? best.event.current : null
      }
      // Days before its first balance read come from the ledger (one read for all of them).
      const needsLedger = days.some((d) => !own.some((r) => r.date <= d))
      const ledger = !needsLedger ? null : await rc.store.findLedgerAccount(rc.ws, a.entityId as EntityId, cashRole(a.id, a.accountType))
      const lines = ledger ? (await walkedLines(rc, ledger.id, last)).filter((l) => l.currency === a.currency) : []
      const fromLedger = (d: IsoDate): number => lines.reduce((t, l) => (l.date <= d ? t + l.debitMinor - l.creditMinor : t), 0)
      return { known: (d: IsoDate) => knownFrom !== null && knownFrom <= d, at: (d: IsoDate) => fromSnapshot(d) ?? { minor: fromLedger(d), currency: a.currency } }
    }),
  )
  return Promise.all(
    days.map(async (d) => {
      if (perAccount.length === 0 || perAccount.some((x) => !x.known(d))) return null
      let total = 0
      for (const x of perAccount) total += (await rc.toCurrency(x.at(d), s.currency, d)).minor
      return { minor: total, currency: s.currency }
    }),
  )
}

type CashFigures = { cash: number; cards: number; included: Id[]; cardIds: Id[]; excluded: Array<{ id: Id; reason: string }>; rows: Id[]; ledgerOnly: string[] }

async function cashFigures(s: Scope): Promise<CashFigures> {
  // Cash, card balances and runway all start here; share one pass per request (copies: callers push to `excluded`).
  const f = await memo(s.rc, `cashfig|${[...s.entityIds].sort().join(',')}|${s.asOf}|${s.currency}`, () => computeCashFigures(s))
  return structuredClone(f)
}

async function computeCashFigures(s: Scope): Promise<CashFigures> {
  const { inScope, excluded } = await scopedAccounts(s)
  let cash = 0
  let cards = 0
  const included: Id[] = []
  const cardIds: Id[] = []
  const rows: Id[] = []
  const ledgerOnly: string[] = []
  for (const a of inScope) {
    const isCard = a.accountType === 'credit_card'
    if (!isCard && !a.includeInCash) {
      excluded.push({ id: a.id, reason: a.accountType === 'loan' ? 'loan account' : 'not counted as cash (setting)' })
      continue
    }
    const b = await accountBalance(s, a)
    const conv = (await s.rc.toCurrency(b, s.currency, s.asOf)).minor
    rows.push(...b.rowIds)
    if (b.source === 'ledger') ledgerOnly.push(a.name)
    if (isCard) {
      cards += -conv
      cardIds.push(a.id)
    } else {
      cash += conv
      included.push(a.id)
    }
  }
  return { cash, cards, included, cardIds, excluded, rows, ledgerOnly }
}

// Plain words, no nested parentheses: it is read inside "cash unknown (…)" in tool answers (the web says it its own way).
const NO_CASH_ACCOUNT = 'No bank or cash account connected yet'

async function balanceMetric(name: 'cash' | 'card_balances' | 'net_cash', s: Scope): Promise<CoreMetricAnswer> {
  const f = await cashFigures(s)
  const value = name === 'cash' ? f.cash : name === 'card_balances' ? f.cards : f.cash - f.cards
  const included = name === 'cash' ? f.included : name === 'card_balances' ? f.cardIds : [...f.included, ...f.cardIds]
  const excluded = name === 'card_balances' ? f.excluded.filter(() => false) : f.excluded
  const formulas = {
    cash: 'Sum of the latest provider balance (current, not available) of accounts counted as cash: bank, cash on hand, processor balances; converted at the as-of rate. Card balances are not subtracted.',
    card_balances: 'Sum of what is owed on credit cards (latest provider balance), as a positive number.',
    net_cash: 'Cash − card balances owed.',
  }
  const note = f.ledgerOnly.length ? ` No provider balance for ${f.ledgerOnly.join(', ')}; ledger balance used.` : ''
  const hasAny = included.length > 0
  // No account counts as cash: the figure is unknown, never $0 (and runway with it).
  const noCash = !hasAny && name !== 'card_balances'
  const answer = await finish(
    s,
    {
      name,
      value: hasAny ? money(value, s.currency) : null,
      state: hasAny ? 'ok' : noCash ? 'unknown' : 'no_data',
      ...(noCash ? { unknownReason: NO_CASH_ACCOUNT } : {}),
      basis: 'cash',
      asOf: s.asOf,
      includedAccounts: included,
      excludedAccounts: excluded,
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula: formulas[name] + note,
    },
    f.rows,
  )
  return hasAny && name !== 'card_balances' ? withGaps(answer, await inTransit(s)) : answer
}

/** Payouts and transfers that left one account and haven't been seen arriving: in neither balance, so not in cash. */
async function inTransit(s: Scope): Promise<string[]> {
  const idx = await ledgerAccounts(s.rc, s.entityIds)
  const bal = await baseBalances(s.rc, s.entityIds, 'cash', s.asOf)
  let total = 0
  for (const a of idx.byId.values()) {
    if (a.role !== 'clearing_payouts' && a.role !== 'clearing_transfers') continue
    const entity = s.byId.get(a.entityId)
    const b = bal.get(a.id) ?? 0
    if (!entity || b <= 0) continue
    total += (await s.rc.toCurrency({ minor: b, currency: entity.baseCurrency }, s.currency, s.asOf)).minor
  }
  return total ? [`${formatMoney(total, s.currency)} in payouts or transfers has left one account and hasn't been seen arriving yet, so it isn't in this figure`] : []
}

// ---------- Burn, revenue (flows from the P&L) ----------

interface Flows {
  expenses: number
  refunds: number
  inflows: number
  revenue: number
  rows: Id[]
  hasData: boolean
}

/** Lines in a span, shared per request (burn and runway read the same three months). Callers must not mutate. */
function linesFor(s: Scope, from: IsoDate, to: IsoDate, basis: Basis): Promise<LineRow[]> {
  if (!s.rc.memo) return s.rc.store.listLines(s.rc.ws, { entityIds: s.entityIds, basis, fromDate: from, toDate: to })
  // One read for every company in the request, filtered per scope: an overview asks each company for the same months.
  const key = `${[...s.entityIds].sort().join(',')}|${basis}|${from}|${to}`
  return memo(s.rc, `lines|${key}`, async () => {
    const all = await memo(s.rc, `lines|*|${basis}|${from}|${to}`, async () => {
      const every = await memo(s.rc, 'entities|*', () => s.rc.directory.listEntities(s.rc.ws))
      return s.rc.store.listLines(s.rc.ws, { entityIds: every.map((e) => e.id), basis, fromDate: from, toDate: to })
    })
    const want = new Set<string>(s.entityIds)
    return all.filter((l) => want.has(l.entityId))
  })
}

async function flows(s: Scope, from: IsoDate, to: IsoDate, basis: Basis, span?: LineRow[]): Promise<Flows> {
  const idx = await ledgerAccounts(s.rc, s.entityIds)
  const lines = span ? span.filter((l) => l.date >= from && l.date <= to) : await linesFor(s, from, to, basis)
  const pick = (pred: (role: string) => boolean): LineRow[] => lines.filter((l) => pred(idx.byId.get(l.ledgerAccountId)?.role ?? ''))
  const expenseLines = pick((r) => isExpenseRole(r) && !NON_CASH_EXPENSE_ROLES.includes(r))
  const refundLines = pick((r) => r === 'refunds')
  const inflowLines = pick((r) => r === 'revenue' || r === 'interest_income' || r === 'wages_income' || r === 'other_income')
  const revenueLines = pick((r) => r === 'revenue' || r === 'refunds')
  const used = [...expenseLines, ...refundLines, ...inflowLines]
  return {
    expenses: await sumLinesIn(s.rc, expenseLines, s.byId, s.currency),
    refunds: await sumLinesIn(s.rc, refundLines, s.byId, s.currency),
    inflows: -(await sumLinesIn(s.rc, inflowLines, s.byId, s.currency)),
    revenue: -(await sumLinesIn(s.rc, revenueLines, s.byId, s.currency)),
    rows: used.map((l) => l.sourceId),
    hasData: lines.length > 0,
  }
}

/** The first posted bank or processor row in scope: history starts there. */
async function earliestActivity(s: Scope): Promise<IsoDate | null> {
  const first = await s.rc.store.listRecords(s.rc.ws, { entityIds: s.entityIds, eventTypes: ['txn.upsert', 'processor.balance_txn'], statuses: ['posted'], limit: 1 })
  return first[0]?.date ?? null
}

/**
 * Which of these full months history covers (1) and which it doesn't (0). A month that starts part-way isn't complete,
 * so it stays out of the average, its spending and its month both. Averages divide by the sum: two months of books
 * average two, not three.
 */
function monthWeights(months: Array<{ from: IsoDate; to: IsoDate }>, earliest: IsoDate | null): number[] {
  return months.map((m) => (earliest !== null && earliest <= m.from ? 1 : 0))
}

/** Accounts whose rows start after the window does: what they spent before that isn't in the average. A fact, not a verdict. */
async function lateStarts(s: Scope, from: IsoDate): Promise<string[]> {
  const out: string[] = []
  for (const a of (await scopedAccounts(s)).inScope) {
    if (a.accountType !== 'credit_card' && !a.includeInCash) continue
    const [first] = await s.rc.store.listRecords(s.rc.ws, { sourceAccountId: a.id, eventTypes: ['txn.upsert', 'processor.balance_txn'], statuses: ['posted'], limit: 1 })
    if (first && first.date > from) out.push(`${a.name}${a.mask ? ` ··${a.mask}` : ''}: rows start ${first.date}, so nothing before that is in this average`)
  }
  return out.sort()
}

/** Payments to a card that isn't connected: the only sighting of that spending, as one lump on the day it was paid. */
async function looseCardPayments(s: Scope, from: IsoDate, to: IsoDate): Promise<string[]> {
  const accounts = await s.rc.directory.listSourceAccounts(s.rc.ws)
  const noCard = s.entityIds.filter((id) => !accounts.some((a) => a.entityId === id && a.accountType === 'credit_card' && !a.duplicateOf))
  if (!noCard.length) return []
  const rows = await s.rc.store.listRecords(s.rc.ws, { entityIds: noCard, eventTypes: ['txn.upsert'], statuses: ['posted'], fromDate: from, toDate: to })
  let total = 0
  for (const r of rows) {
    if (r.event.type === 'txn.upsert' && r.event.categoryHint === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' && r.amount && r.amount.minor < 0) total += Math.abs((await s.rc.toCurrency(r.amount, s.currency, r.date)).minor)
  }
  return total ? [`${formatMoney(total, s.currency)} in credit card payments counts as spending in one lump, because no card is connected`] : []
}

/** Payments onto a connected loan: all of it comes off the loan, so the interest inside isn't in burn. */
async function loanPayments(s: Scope, from: IsoDate, to: IsoDate): Promise<string[]> {
  const accounts = await s.rc.directory.listSourceAccounts(s.rc.ws)
  const loans = new Set(accounts.filter((a) => a.accountType === 'loan' && !a.duplicateOf).map((a) => a.id))
  if (!loans.size) return []
  const rows = await s.rc.store.listRecords(s.rc.ws, { entityIds: s.entityIds, eventTypes: ['txn.upsert'], statuses: ['posted'], fromDate: from, toDate: to })
  let total = 0
  for (const r of rows) {
    if (r.sourceAccountId && loans.has(r.sourceAccountId) && r.amount && r.amount.minor > 0) total += (await s.rc.toCurrency(r.amount, s.currency, r.date)).minor
  }
  return total ? [`${formatMoney(total, s.currency)} in loan payments counts as paying down the loan, so burn can read low by the interest inside them`] : []
}

function withGaps<A extends MetricAnswer>(a: A, gaps: string[]): A {
  if (!gaps.length) return a
  return { ...a, coverage: { accounts: a.coverage?.accounts ?? [], gaps: [...(a.coverage?.gaps ?? []), ...gaps] } }
}

/** Calendar months from one date's month to another's, both counted (2026-07-15 to 2026-09-02 is 3). */
function monthsSpanned(from: IsoDate, to: IsoDate): number {
  const n = (d: IsoDate) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7))
  return Math.max(1, n(to) - n(from) + 1)
}

/** The last complete months as of a day. A month-end date in the past has just completed its month, so that month counts. */
async function completedMonths(s: Scope, n: number): Promise<Array<{ from: IsoDate; to: IsoDate }>> {
  const ended = s.asOf === monthEnd(s.asOf) && s.asOf < (await todayFor(s.rc))
  return trailingMonths(ended ? addDays(s.asOf, 1) : s.asOf, n)
}

/**
 * Burn is a monthly average. Without a start date: the last 3 full months, or those of them history covers (a company
 * two months old averages two). With a period: its total ÷ the calendar months it spans.
 */
async function burnMetric(name: 'gross_burn' | 'net_burn', s: Scope, explicitPeriod: boolean, openEnded = false): Promise<CoreMetricAnswer> {
  let from = s.from
  let to = s.to
  // A start with no end stops at the last full month: an average can't count a month still under way as whole.
  const fullThrough = (trailingMonths(s.asOf, 1)[0] as { to: IsoDate }).to
  if (explicitPeriod && openEnded && from <= fullThrough) to = fullThrough
  let months = monthsSpanned(from, to)
  let short = false
  if (!explicitPeriod) {
    const trailing = await completedMonths(s, 3)
    const weights = monthWeights(trailing, await earliestActivity(s))
    const first = weights.findIndex((w) => w > 0)
    short = first < 0
    const use = short ? trailing : trailing.slice(first)
    from = (use[0] as { from: IsoDate }).from
    to = (use[use.length - 1] as { to: IsoDate }).to
    months = short ? 3 : Math.round(weights.reduce((a, b) => a + b, 0) * 100) / 100
  }
  const f = await flows(s, from, to, 'cash')
  const gross = Math.round((f.expenses + f.refunds) / months)
  const net = Math.round((f.expenses + f.refunds - f.inflows) / months)
  const { inScope } = await scopedAccounts(s)
  const per = `average per month over ${from} to ${to} (${months} ${months === 1 ? 'month' : 'months'})`
  const formula =
    name === 'gross_burn'
      ? `Spending, ${per}, cash basis: every expense account (card purchases at swipe, payroll, fees, taxes) plus customer refunds. Excludes transfers, card payments, payouts, owner and investor money, loan principal and sales-tax remittances.`
      : `Gross burn − operating money in (revenue, interest, other income), ${per}, cash basis. Positive = burning; negative = cash-flow positive.`
  const state: MetricAnswer['state'] = !f.hasData ? 'no_data' : short ? 'not_enough_history' : name === 'net_burn' && net <= 0 ? 'not_burning' : 'ok'
  const answer = await finish(
    { ...s, from, to },
    {
      name,
      value: f.hasData && !short ? money(name === 'gross_burn' ? gross : net, s.currency) : null,
      state,
      basis: 'cash',
      asOf: to,
      includedAccounts: inScope.map((a) => a.id),
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula,
    },
    f.rows,
  )
  return explicitPeriod || short ? answer : withGaps(answer, [...(await lateStarts(s, from)), ...(await looseCardPayments(s, from, to)), ...(await loanPayments(s, from, to))])
}

/**
 * What set-asides that don't count take out of these cash accounts, in the reporting currency. Per account, never more
 * than the account holds: an underfunded set-aside can't push cash below what's really there (review warns about it).
 */
async function setAsideOut(s: Scope, included: readonly Id[]): Promise<{ total: number; lines: string[] }> {
  const rows = (await heldRows(s.rc, s.asOf)).filter((r) => !r.countsInCash && included.includes(r.accountId))
  if (!rows.length) return { total: 0, lines: [] }
  const accounts = new Map((await s.rc.directory.listSourceAccounts(s.rc.ws)).map((a) => [a.id, a]))
  let total = 0
  const lines: string[] = []
  for (const id of new Set(rows.map((r) => r.accountId))) {
    const here = rows.filter((r) => r.accountId === id)
    const bal = await accountBalance(s, accounts.get(id) as SourceAccountInfo)
    const out = Math.min(here.reduce((t, r) => t + r.minor, 0), Math.max(0, bal.minor))
    total += (await s.rc.toCurrency({ minor: out, currency: bal.currency }, s.currency, s.asOf)).minor
    lines.push(`${formatMoney(out, bal.currency)} from ${here[0]?.accountName} (${[...new Set(here.map((r) => r.bucketName))].join(', ')})`)
  }
  return { total, lines }
}

async function availableCashMetric(s: Scope): Promise<CoreMetricAnswer> {
  const cash = await balanceMetric('cash', s)
  const f = await cashFigures(s)
  const out = await setAsideOut(s, f.included)
  const today = await todayFor(s.rc)
  const past = s.asOf < today ? ' Set-asides are today\'s: they have no history.' : ''
  const formula = out.lines.length ? `Cash ${formatMoney(f.cash, s.currency)} (the bank's total) − set-asides that don't count in cash: ${out.lines.join('; ')}.${past}` : `Same as cash: no set-aside is left out of it.${past}`
  return { ...cash, name: 'available_cash', value: f.included.length ? money(f.cash - out.total, s.currency) : null, formula }
}

async function runwayMetric(s: Scope): Promise<CoreMetricAnswer> {
  const months = await completedMonths(s, 3)
  const figures = await cashFigures(s)
  // Flag off, set-asides change no number: runway is cash over burn, which is what the tools' note says.
  const out = s.rc.setAsides ? await setAsideOut(s, figures.included) : { total: 0, lines: [] }
  const cash = { ...figures, cash: figures.cash - out.total }
  const cashWord = out.lines.length ? 'Available cash (after set-asides)' : 'Cash'
  const nets: number[] = []
  const rows: Id[] = [...cash.rows]
  const span = await linesFor(s, (months[0] as { from: IsoDate }).from, (months[months.length - 1] as { to: IsoDate }).to, 'cash')
  for (const m of months) {
    const f = await flows(s, m.from, m.to, 'cash', span)
    nets.push(f.expenses + f.refunds - f.inflows)
    rows.push(...f.rows)
  }
  // History: at least two complete months with posted activity, and the average is over only the complete months
  // (a company two months old averages two, not two and an empty one).
  const earliest = await earliestActivity(s)
  const enough = earliest !== null && earliest <= (months[1] as { from: IsoDate }).from
  const weights = monthWeights(months, earliest)
  const covered = Math.round(weights.reduce((a, b) => a + b, 0) * 100) / 100
  const avg = covered > 0 ? nets.reduce((a, b, i) => a + b * (weights[i] ?? 0), 0) / covered : 0
  let value: number | null = null
  let state: MetricAnswer['state'] = 'ok'
  const spanText = covered === 3 ? '3 complete months' : `${covered} complete months of history in the last 3`
  let formula = `${cashWord} ÷ average net burn over ${months[0]?.from} to ${months[2]?.to} (${spanText}), cash basis.`
  let unknownReason: string | undefined
  if (!cash.included.length) {
    state = 'unknown'
    unknownReason = NO_CASH_ACCOUNT
  } else if (!enough) state = 'not_enough_history'
  else if (avg <= 0) state = 'not_burning'
  else if (cash.cash <= 0) {
    state = 'unknown'
    unknownReason = `Cash is ${formatMoney(cash.cash, s.currency)}, so there's no runway to work out`
  } else {
    value = Math.round((cash.cash / avg) * 10) / 10
    const runOut = addDays(s.asOf, Math.floor(value * 30.4375))
    formula += ` ${cashWord} ${formatMoney(cash.cash, s.currency)} ÷ ${formatMoney(Math.round(avg), s.currency)} per month = ${value} months (around ${runOut}).`
  }
  // Runway rests on burn: when burn can't be trusted over these months, nor can it (a gap in any of them, a stale card).
  const burn = await burnMetric('net_burn', s, false)
  if (value !== null && burn.state === 'unknown') {
    value = null
    state = 'unknown'
    unknownReason = burn.unknownReason
  }
  const answer = await finish(
    s,
    {
      name: 'runway',
      value,
      state,
      ...(unknownReason ? { unknownReason } : {}),
      basis: 'cash',
      asOf: s.asOf,
      includedAccounts: cash.included,
      excludedAccounts: cash.excluded,
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula,
    },
    rows,
  )
  const start = months[weights.indexOf(1)]?.from
  return start ? withGaps(answer, [...(await lateStarts(s, start)), ...(await looseCardPayments(s, start, (months[months.length - 1] as { to: IsoDate }).to)), ...(await loanPayments(s, start, (months[months.length - 1] as { to: IsoDate }).to))]) : answer
}

const TAX_BLIND: Record<string, string> = { shopify: 'Shopify sale', stripe: 'Stripe charge', square: 'Square payment', gumroad: 'Gumroad sale' }

/** Processors whose rows don't split sales tax. Only a charge tied to an invoice has its tax taken out. */
async function taxInsideCharges(s: Scope): Promise<string[]> {
  const conns = new Map((await s.rc.directory.listConnections(s.rc.ws)).filter((c) => TAX_BLIND[c.connectorKey]).map((c) => [c.id, c.connectorKey]))
  if (!conns.size) return []
  const linked = new Set((await s.rc.store.listLinks(s.rc.ws, { types: ['invoice_payment'], statuses: ['confirmed'] })).map((l) => l.toId))
  const rows = await s.rc.store.listRecords(s.rc.ws, { entityIds: s.entityIds, eventTypes: ['processor.balance_txn'], statuses: ['posted'], fromDate: s.from, toDate: s.to })
  const counts = new Map<string, number>()
  for (const r of rows) {
    const key = r.connectionId ? conns.get(r.connectionId) : undefined
    if (key && r.event.type === 'processor.balance_txn' && r.event.kind === 'charge' && !r.event.taxIncluded && !linked.has(r.id)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort().map(([key, n]) => `May include sales tax collected on ${n} ${TAX_BLIND[key]}${n === 1 ? '' : 's'}${key === 'stripe' ? ' without an invoice' : ''}`)
}

async function revenueMetric(s: Scope): Promise<CoreMetricAnswer> {
  const f = await flows(s, s.from, s.to, s.basis)
  const formula =
    s.basis === 'cash'
      ? `Money in from customers, ${s.from} to ${s.to}: processor charges at gross (refunds subtracted) plus bank receipts categorized as revenue. Payouts, transfers, owner and investor money are excluded, and so is sales tax, except tax inside a processor charge with no invoice, which the processor's row doesn't split out. Gross of processor fees: each processor charge is listed at gross with its fee as its own row (kind fee, the Processor fees expense), so the charge rows add up to this; don't add the fees back.`
      : `Invoiced revenue recognized ${s.from} to ${s.to} (issue date), minus credit notes and refunds, net of sales tax. Processor fees are a separate expense, not taken off revenue. Only as complete as the connected invoicing sources.`
  const answer = await finish(
    s,
    {
      name: 'revenue',
      value: f.hasData ? money(f.revenue, s.currency) : null,
      state: f.hasData ? 'ok' : 'no_data',
      basis: s.basis,
      asOf: s.to,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula,
    },
    f.rows,
  )
  return s.figureOnly ? answer : withGaps(answer, await taxInsideCharges(s))
}

// ---------- AR / AP ----------

async function openItemsMetric(name: 'ar_open' | 'ar_overdue' | 'ap_due', s: Scope): Promise<CoreMetricAnswer> {
  const direction = name === 'ap_due' ? 'payable' : 'receivable'
  const items = await openItems(s.rc, s.entityIds, direction, s.asOf)
  // One read for the scope's three open-item figures (owed to you, overdue, bills due).
  const invoices = await memo(s.rc, `invoices|${[...s.entityIds].sort().join(',')}|${s.asOf}`, () => s.rc.store.listRecords(s.rc.ws, { entityIds: s.entityIds, eventTypes: ['invoice.upsert'], toDate: s.asOf }))
  const anyInvoices = invoices.some(
    (r) => r.event.type === 'invoice.upsert' && r.event.direction === direction,
  )
  const horizon = addDays(s.asOf, 30)
  const picked = items.filter((it) => {
    if (name === 'ar_open') return true
    if (name === 'ar_overdue') return it.dueDate !== null && it.dueDate < s.asOf
    return it.dueDate === null || it.dueDate <= horizon
  })
  let total = 0
  for (const it of picked) total += (await s.rc.toCurrency({ minor: it.remainingMinor, currency: it.currency }, s.currency, s.asOf)).minor
  const formulas = {
    ar_open: 'Sum still owed on receivable invoices that are open, partly paid or disputed (total − paid − credited). Drafts, voids, paid and written-off invoices excluded.',
    ar_overdue: `Open receivables with a due date before ${s.asOf}.`,
    ap_due: `Open bills overdue or due by ${horizon}.`,
  }
  return finish(
    s,
    {
      name,
      value: anyInvoices ? money(total, s.currency) : null,
      state: anyInvoices ? 'ok' : 'no_data',
      basis: 'accrual',
      asOf: s.asOf,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula: formulas[name],
    },
    picked.map((p) => p.record.id),
  )
}

// ---------- Payroll ----------

async function payrollMetric(s: Scope): Promise<CoreMetricAnswer> {
  const idx = await ledgerAccounts(s.rc, s.entityIds)
  const runs = await s.rc.store.listRecords(s.rc.ws, { entityIds: s.entityIds, eventTypes: ['payroll.run'], statuses: ['posted'], fromDate: s.from, toDate: s.to })
  const basis: Basis = s.basis === 'accrual' && runs.length === 0 ? 'cash' : s.basis
  const lines = (await s.rc.store.listLines(s.rc.ws, { entityIds: s.entityIds, basis, fromDate: s.from, toDate: s.to })).filter((l) =>
    (PAYROLL_ROLES as readonly string[]).includes(idx.byId.get(l.ledgerAccountId)?.role ?? ''),
  )
  const total = await sumLinesIn(s.rc, lines, s.byId, s.currency)
  const formula =
    basis === 'accrual'
      ? `Payroll runs paid ${s.from} to ${s.to}: gross pay + employer taxes + employer benefits, plus contractors. Excludes reimbursements and owner draws.`
      : `Payroll and contractor payments seen at the bank ${s.from} to ${s.to} (estimated from bank debits; no payroll provider data for this period).`
  return finish(
    s,
    {
      name: 'payroll_cost',
      value: lines.length ? money(total, s.currency) : null,
      state: lines.length ? 'ok' : 'no_data',
      basis,
      asOf: s.to,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula,
    },
    lines.map((l) => l.sourceId),
  )
}

// ---------- Whose money ----------

async function positionMetric(name: 'owner_balance' | 'intercompany_balance', s: Scope): Promise<CoreMetricAnswer> {
  const idx = await ledgerAccounts(s.rc, s.entityIds)
  const bal = await baseBalances(s.rc, s.entityIds, 'cash', s.asOf)
  let total = 0
  const accountIds: Id[] = []
  for (const a of idx.byId.values()) {
    const owner = a.role.startsWith('owner_payable:')
    const ic = a.role.startsWith('due_from:') || a.role.startsWith('due_to:')
    if ((name === 'owner_balance' && !owner) || (name === 'intercompany_balance' && !ic)) continue
    const entity = s.byId.get(a.entityId)
    if (!entity) continue
    const b = bal.get(a.id) ?? 0
    if (b === 0) continue
    // owner_balance: positive = companies owe owners (credit balance). intercompany: positive = net owed to the scope.
    const signed = name === 'owner_balance' ? -b : b
    total += (await s.rc.toCurrency({ minor: signed, currency: entity.baseCurrency }, s.currency, s.asOf)).minor
    accountIds.push(a.id)
  }
  const rows = accountIds.length ? (await s.rc.store.listLines(s.rc.ws, { entityIds: s.entityIds, basis: 'cash', ledgerAccountIds: accountIds, toDate: s.asOf })).map((l) => l.sourceId) : []
  const formula =
    name === 'owner_balance'
      ? 'What the companies owe their owners: founder loans + company costs paid personally − repayments − reimbursements. Positive = the company owes you. Owner money not yet marked loan or investment is listed in Review, not here.'
      : 'Net money owed between companies in scope (due from − due to). Across a whole group this nets to zero.'
  return finish(
    s,
    {
      name,
      value: money(total, s.currency),
      state: 'ok',
      basis: 'cash',
      asOf: s.asOf,
      includedAccounts: accountIds,
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula,
    },
    rows,
  )
}

// ---------- Recurring, MRR, health ----------

async function recurringMetric(s: Scope): Promise<CoreMetricAnswer> {
  const r = await recurringSpend(s.rc, s.entityIds, s.asOf, s.currency)
  return finish(
    s,
    {
      name: 'recurring_spend',
      value: r.series.length ? money(r.monthlyMinor, s.currency) : null,
      state: r.series.length ? 'ok' : 'no_data',
      basis: 'cash',
      asOf: s.asOf,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula: `Monthly equivalent of recurring spending: scheduled buckets plus charges seen 3+ times on a regular cadence (annual ÷ 12, quarterly ÷ 3, weekly × 52/12). ${r.series.length} series.`,
    },
    r.rowIds,
  )
}

async function mrrMetric(name: 'mrr' | 'arr', s: Scope): Promise<CoreMetricAnswer> {
  // From each subscription's dated history, so MRR on a past day counts what was live that day.
  const subs = await mrrSeries(s.rc, s.entityIds)
  let total = 0
  const rows: Id[] = []
  const parts: Parameters<typeof productList>[0] = []
  for (const sub of subs) {
    const v = valueAt(sub.points, s.asOf)
    if (v === 0) continue
    const minor = (await s.rc.toCurrency({ minor: v, currency: sub.currency }, s.currency, s.asOf)).minor
    total += minor
    rows.push(sub.recordId)
    parts.push({ products: sub.products, minor })
  }
  const value = name === 'mrr' ? total : total * 12
  return finish(
    s,
    {
      name,
      value: subs.length ? money(value, s.currency) : null,
      state: subs.length ? 'ok' : 'no_data',
      basis: 'accrual',
      asOf: s.asOf,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula:
        (name === 'mrr' ? '' : 'MRR × 12. ') +
        'MRR (Stripe definition): monthly-normalized value of active and past-due subscriptions, after discounts, excluding tax, trials and metered usage; converted at the as-of rate.',
      // Which products it is (none when there are no subscriptions to tell from).
      ...(subs.length ? productList(parts) : {}),
    },
    rows,
  )
}

/**
 * Churn and net new MRR for the last complete month. Unknown, never 0, when there is no subscription source or a
 * source hadn't synced past the month's end: a quiet month and a missing one look the same otherwise.
 */
async function mrrMovementMetric(name: 'mrr_churn_rate' | 'net_new_mrr', s: Scope): Promise<CoreMetricAnswer> {
  const month = lastCompleteMonth(s.asOf)
  const formula =
    name === 'mrr_churn_rate'
      ? `MRR churn for ${month}: (churned + downgraded MRR) ÷ MRR at the start of the month, per customer (a customer who moves to another plan isn't churn).`
      : `Net new MRR for ${month}: new + expansion + reactivation − contraction − churn.`
  const base: MetricAnswer = { ...blank(name, 'accrual', s.asOf, formula), state: 'ok' }
  const unknown = async (reason: string, rows: Id[] = []) => finish(s, { ...base, value: null, state: 'unknown', unknownReason: reason }, rows)
  const series = await mrrSeries(s.rc, s.entityIds)
  if (series.length === 0) return unknown('No subscription source (Stripe, Paddle, …) is connected for this company')
  const monthEnd = lastDayOf(month)
  const behind: string[] = []
  for (const id of new Set(series.map((x) => x.connectionId))) {
    const c = await s.rc.directory.getConnection(s.rc.ws, id)
    const through = c?.lastSuccessAt ? localDate(c.lastSuccessAt, await zoneOf(s.rc)) : null
    if (!through || through < monthEnd) behind.push(`${c?.displayName ?? 'A subscription source'} ${through ? `last synced ${shortDate(through)}` : 'has never synced'}`)
  }
  if (behind.length) return unknown(`${behind.join('; ')}, before ${month} ended`)
  const [m] = await mrrMovements(s.rc, { entityIds: s.entityIds, from: month, to: month, currency: s.currency })
  const rows = series.map((x) => x.recordId)
  if (!m) return unknown('No MRR history for that month', rows)
  if (name === 'net_new_mrr') {
    const net = m.end.minor - m.start.minor
    return finish(s, { ...base, value: money(net, s.currency) }, rows)
  }
  if (m.revenueChurnRate === null) return unknown(`No MRR at the start of ${month}, so there was nothing to churn`, rows)
  return finish(s, { ...base, value: Math.round(m.revenueChurnRate * 10_000) / 10_000 }, rows)
}

function lastCompleteMonth(asOf: IsoDate): string {
  const [y, m] = asOf.slice(0, 10).split('-').map(Number) as [number, number]
  if (lastDayOf(asOf.slice(0, 7)) === asOf.slice(0, 10)) return asOf.slice(0, 7)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

function lastDayOf(month: string): IsoDate {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/**
 * The same count and words as the Workspace's grey line (health.ts dataHealth), so an AI and the person see one
 * number for one workspace: review items, balances that don't match, transfers not seen arriving, connections not
 * syncing and missing months.
 */
async function healthMetric(s: Scope): Promise<CoreMetricAnswer> {
  const h = await dataHealth(s.rc, s.entityIds)
  const c = h.counts
  const total = c.toReview + c.failedChecks + c.unmatchedInTransit + c.staleSources + c.missingStatements
  const review = await listReviewItems(s.rc, { entityIds: s.entityIds })
  return finish(
    s,
    {
      name: 'data_health',
      value: total,
      state: 'ok',
      basis: 'cash',
      asOf: s.asOf,
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: 0,
      rowIds: [],
      formula: `Things needing a look, as the Workspace shows them: ${h.line}. ${c.passedChecks} check${c.passedChecks === 1 ? '' : 's'} pass${c.warnings ? `, ${c.warnings} warning${c.warnings === 1 ? '' : 's'}` : ''}. 0 = all reconciled.`,
      health: { passedChecks: c.passedChecks, failedChecks: c.failedChecks, warnings: c.warnings, pendingReview: c.toReview, staleSources: c.staleSources, line: h.line },
    },
    review.flatMap((r) => r.recordIds),
  )
}

export { addMonths, daysBetween, monthEnd }
