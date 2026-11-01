// Statement coverage and balance assertions.
//
// Coverage: for each account and month, did we get the money's history? covered · missing (a month with no rows for
// an account that usually has several, or after the last uploaded statement) · mismatched (the provider's balances or
// a pinned balance disagree with the rows) · in_progress (this month) · not_expected (before the account's history).
// Missing data is unknown, never zero.
//
// Balance assertions: "Chase held $12,340.11 on Sept 30" (a statement, a person, an AI). They never post anything;
// each one is a check of the ledger balance at the end of that day.
import type { EntityId, Id, IsoDate } from '@agfn/contracts'
import { latestPerDay, snapCurrent, type CheckResult } from './checks.ts'
import { cashRole } from './coa.ts'
import type { BalanceAssertion, SourceAccountInfo, SourceRecord } from './model.ts'
import { formatMoney } from './money.ts'
import { addDays, ledgerAccountFor, scopeEntities, snapshotsOf, today, type ReadContext, todayFor, walkedLines } from './queries.ts'

export type CoverageStatus = 'covered' | 'missing' | 'mismatched' | 'in_progress' | 'not_expected'

export interface CoverageMonth {
  month: string
  status: CoverageStatus
  rows: number
  detail?: string
}

export interface AccountCoverage {
  accountId: Id
  entityId: EntityId
  name: string
  mask: string | null
  months: CoverageMonth[]
  /** One plain line per gap or mismatch, e.g. "Chase ··4411: August statement missing". */
  problems: string[]
}

/** An account usually this busy (median rows per month with activity) is expected to show rows every month. */
const BUSY_MONTH_ROWS = 3

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function monthName(m: string, ref: string): string {
  const name = MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m
  return m.slice(0, 4) === ref.slice(0, 4) ? name : `${name} ${m.slice(0, 4)}`
}

function nextMonth(m: string): string {
  const y = Number(m.slice(0, 4))
  const mo = Number(m.slice(5, 7))
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

function monthEnd(m: string): IsoDate {
  return addDays(`${nextMonth(m)}-01`, -1)
}

function label(a: SourceAccountInfo): string {
  return `${a.name}${a.mask ? ` ··${a.mask}` : ''}`
}

/** Owed-type accounts carry negative ledger balances; statements show what's owed as a positive number. */
function owedType(a: SourceAccountInfo): boolean {
  return a.accountType === 'credit_card' || a.accountType === 'loan'
}

/** Running ledger balance of a source account's cash-side ledger account, in its own currency. */
async function balanceFn(rc: ReadContext, a: SourceAccountInfo): Promise<(date: IsoDate) => number> {
  const ledger = a.entityId ? await ledgerAccountFor(rc, a.entityId, cashRole(a.id, a.accountType)) : null
  const lines = ledger ? await walkedLines(rc, ledger.id) : []
  const days: IsoDate[] = []
  const running: number[] = []
  let total = 0
  for (const l of lines) {
    if (l.currency !== a.currency) continue
    total += l.debitMinor - l.creditMinor
    if (days[days.length - 1] === l.date) running[running.length - 1] = total
    else {
      days.push(l.date)
      running.push(total)
    }
  }
  return (date) => {
    let lo = 0
    let hi = days.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((days[mid] as IsoDate) <= date) lo = mid + 1
      else hi = mid
    }
    return lo === 0 ? 0 : (running[lo - 1] as number)
  }
}

/** Accounts in scope that hold their own history (a second source for an account merges into its primary). */
async function primaryAccounts(rc: ReadContext, entityIds: EntityId[], withCashOnHand = false): Promise<{ primaries: SourceAccountInfo[]; twins: Map<Id, Id[]> }> {
  const all = await rc.directory.listSourceAccounts(rc.ws)
  const ids = new Set(entityIds)
  // Cash on hand has no synced history to cover, but a balance pinned on it is checked like any other.
  const primaries = all.filter((a) => a.entityId && ids.has(a.entityId) && !a.duplicateOf && (withCashOnHand || a.accountType !== 'cash_on_hand'))
  const twins = new Map<Id, Id[]>()
  for (const a of all) if (a.duplicateOf) twins.set(a.duplicateOf, [...(twins.get(a.duplicateOf) ?? []), a.id])
  return { primaries, twins }
}

export async function assertionChecks(rc: ReadContext, entityIds: EntityId[], asOf: IsoDate): Promise<CheckResult[]> {
  const { primaries } = await primaryAccounts(rc, entityIds, true)
  const byId = new Map(primaries.map((a) => [a.id, a]))
  const out: CheckResult[] = []
  const assertions = (await rc.store.listAssertions(rc.ws, [...byId.keys()])).filter((x) => x.date <= asOf)
  const fns = new Map<Id, (d: IsoDate) => number>()
  for (const x of assertions) {
    const a = byId.get(x.accountId) as SourceAccountInfo
    if (!fns.has(a.id)) fns.set(a.id, await balanceFn(rc, a))
    const at = fns.get(a.id) as (d: IsoDate) => number
    const ledger = at(x.date)
    const stated = owedType(a) ? -x.balance.minor : x.balance.minor
    const ok = x.balance.currency === a.currency && ledger === stated
    // Bank dates, sync times (UTC) and the person's own "today" can sit a day apart around midnight: a balance that
    // matches the day before or after is noted, not failed.
    const near = !ok && x.balance.currency === a.currency ? [addDays(x.date, -1), addDays(x.date, 1)].find((d) => at(d) === stated) : undefined
    const show = (minor: number) => formatMoney(owedType(a) ? -minor : minor, a.currency)
    out.push({
      name: 'balance_assertion',
      status: ok ? 'ok' : near ? 'warn' : 'fail',
      ...(near ? { matchesOn: near } : {}),
      entityId: a.entityId,
      subjectId: x.id,
      expectedMinor: stated,
      actualMinor: ledger,
      differenceMinor: stated - ledger,
      currency: a.currency,
      message: ok
        ? `${label(a)} on ${x.date}: matches ${x.source ?? 'the pinned balance'}`
        : near
          ? `${label(a)}: ${x.source ?? 'the pinned balance'} (${show(stated)}) matches the ledger on ${near}, not ${x.date}; bank and sync dates can differ by a day around midnight`
          : `${label(a)} on ${x.date}: ${x.source ?? 'the pinned balance'} says ${formatMoney(x.balance.minor, x.balance.currency)}, the ledger says ${show(ledger)}`,
    })
  }
  return out
}

export interface CoverageOptions {
  entityIds?: EntityId[] | 'all'
  /** First and last month shown ('YYYY-MM'); defaults: each account's first month with data, and this month. */
  from?: string
  to?: string
}

export async function coverage(rc: ReadContext, opts: CoverageOptions = {}): Promise<AccountCoverage[]> {
  if (!rc.shared) return computeCoverage(rc, opts)
  // Computed once for the whole workspace (per range and day) and filtered to the scope: an overview of four companies
  // and its health line used to ask for eight scopes, each a grouped count over every record.
  const all = await rc.shared(`coverage|*|${opts.from ?? ''}|${opts.to ?? ''}|${(await todayFor(rc))}`, () => computeCoverage(rc, { ...opts, entityIds: 'all' }))
  if (!opts.entityIds || opts.entityIds === 'all') return all
  const scope = new Set<string>(opts.entityIds)
  return all.filter((a) => scope.has(a.entityId))
}

async function computeCoverage(rc: ReadContext, opts: CoverageOptions): Promise<AccountCoverage[]> {
  const entities = await scopeEntities(rc, opts.entityIds ?? 'all')
  const { primaries, twins } = await primaryAccounts(rc, entities.map((e) => e.id))
  const now = (await todayFor(rc))
  const thisMonth = now.slice(0, 7)
  const last = opts.to ?? thisMonth
  const uploadConns = new Set((await rc.directory.listConnections(rc.ws)).filter((c) => c.connectorKey === 'files').map((c) => c.id))
  const counts = await rc.store.monthlyRowCounts(rc.ws, primaries.flatMap((a) => [a.id, ...(twins.get(a.id) ?? [])]))
  const rowsBy = new Map<string, number>()
  const owner = new Map<Id, Id>()
  for (const a of primaries) for (const t of [a.id, ...(twins.get(a.id) ?? [])]) owner.set(t, a.id)
  for (const c of counts) {
    const k = `${owner.get(c.accountId)}|${c.month}`
    rowsBy.set(k, (rowsBy.get(k) ?? 0) + c.rows)
  }
  const assertions = await rc.store.listAssertions(rc.ws, primaries.map((a) => a.id))
  const failing = new Set((await assertionChecks(rc, entities.map((e) => e.id), now)).filter((c) => c.status === 'fail').map((c) => c.subjectId))
  const out: AccountCoverage[] = []
  for (const a of primaries) {
    const active = [...rowsBy].filter(([k, n]) => k.startsWith(`${a.id}|`) && n > 0).map(([k]) => k.slice(a.id.length + 1)).sort()
    const snaps = latestPerDay(await snapshotsOf(rc, a.id))
    const firstData = [active[0], snaps[0]?.date.slice(0, 7)].filter((x): x is string => Boolean(x)).sort()[0]
    if (!firstData) {
      out.push({ accountId: a.id, entityId: a.entityId as EntityId, name: a.name, mask: a.mask ?? null, months: [], problems: [] })
      continue
    }
    const busy = (() => {
      const ns = active.map((m) => rowsBy.get(`${a.id}|${m}`) ?? 0).sort((x, y) => x - y)
      return (ns[Math.floor(ns.length / 2)] ?? 0) >= BUSY_MONTH_ROWS
    })()
    const uploaded = a.connectionId !== null && uploadConns.has(a.connectionId)
    const lastActive = active[active.length - 1] ?? firstData
    const balanceAt = snaps.length ? await balanceFn(rc, a) : null
    const months: CoverageMonth[] = []
    const problems: string[] = []
    for (let m = opts.from && opts.from > firstData ? opts.from : firstData; m <= last; m = nextMonth(m)) {
      const rows = rowsBy.get(`${a.id}|${m}`) ?? 0
      let status: CoverageStatus = 'covered'
      let detail: string | undefined
      if (m < firstData) status = 'not_expected'
      else if (m === thisMonth) status = 'in_progress'
      else if (rows === 0 && (busy || (uploaded && m > lastActive))) {
        status = 'missing'
        detail = uploaded ? 'no statement for this month' : 'no rows this month'
      }
      // Provider balances: the month's movement must equal the rows posted in it.
      if (status !== 'not_expected' && balanceAt && m !== thisMonth) {
        const end = monthEnd(m)
        const s1 = [...snaps].reverse().find((s) => s.date <= end)
        const s0 = [...snaps].reverse().find((s) => s.date < `${m}-01`)
        if (s1 && s0 && s1.date >= `${m}-01`) {
          const expected = snapCurrent(s1 as SourceRecord).minor - snapCurrent(s0 as SourceRecord).minor
          const actual = balanceAt(s1.date) - balanceAt(s0.date)
          if (expected !== actual) {
            status = 'mismatched'
            const fmt = (m: number) => formatMoney(m, a.currency)
            detail = `the balance moved ${fmt(expected)}, rows add up to ${fmt(actual)}`
          }
        }
      }
      const bad = assertions.filter((x) => x.accountId === a.id && x.date.slice(0, 7) === m && failing.has(x.id))
      if (bad.length && status !== 'not_expected') {
        status = 'mismatched'
        detail = `pinned balance on ${(bad[0] as BalanceAssertion).date} doesn't match`
      }
      months.push({ month: m, status, rows, ...(detail ? { detail } : {}) })
      if (status === 'missing') problems.push(`${label(a)}: ${monthName(m, now)} ${uploaded ? 'statement missing' : 'has no transactions'}`)
      if (status === 'mismatched') problems.push(`${label(a)}: ${monthName(m, now)} doesn't add up (${detail})`)
    }
    out.push({ accountId: a.id, entityId: a.entityId as EntityId, name: a.name, mask: a.mask ?? null, months, problems })
  }
  return out
}
