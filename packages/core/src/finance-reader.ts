// FinanceReader (contracts) over the ledger: everything S7's read tools and the UI show.
// Every view carries entityId; the caller passes an already permission-filtered scope and filters again.
// Third-party strings (counterparty, memo) are returned raw; S7 cleans and labels them.
import type {
  InvestmentEvent,
  InvestmentView,
  InvestmentTotals,
  MrrMovementView,
  ProcessorBalanceTxn,
  PeriodLockView,
  AccountFilter,
  AccountView,
  AddedBy,
  AgingBuckets,
  BucketView,
  CapTableView,
  CounterpartyView,
  CoverageView,
  DataType,
  DocumentView,
  EntityId,
  EntityInfo,
  FinanceReader,
  Id,
  InvoiceQuery,
  InvoiceSearchResult,
  InvoiceUpsert,
  InvoiceView,
  IsoDate,
  IsoTimestamp,
  MetricAnswer,
  MetricName,
  MetricScope,
  Money,
  Overview,
  OverviewEntity,
  OwnerBalanceView,
  PayrollView,
  PersonId,
  ReadScope,
  RecordType,
  RecordView,
  ReportView,
  ReviewItemView,
  SourceStatus,
  TxnQuery,
  TxnSearchResult,
  TxnView,
  UpcomingItem,
  WorkspaceId,
} from '@agfn/contracts'
import { bucketView, detectRecurring, type BucketView as CoreBucketView } from './buckets.ts'
import type { Anomaly } from './anomalies.ts'
import { cashRole, isCashLikeRole } from './coa.ts'
import { positionOrder } from './posting.ts'
import { openItems } from './checks.ts'
import type { LedgerEngine } from './engine.ts'
import { computeMetric, type MetricContext } from './metrics.ts'
import type { AccountDirectory, LineRow } from './store.ts'
import type { Bucket, JournalEntry, LedgerAccount, Link, RecordOverride, SourceAccountInfo, SourceRecord } from './model.ts'
import { nameSimilarity } from './matching.ts'
import { addDays, addMonths, daysBetween, localDate, monthStart, today, todayFor, zoneOf } from './queries.ts'
import { balanceSheet, cashFlow, profitAndLoss, type ReportSection } from './reports.ts'
import { applyRules, merchantKey } from './rules.ts'
import { matchesFilter, parseQuery } from './query.ts'
import { listReviewItems, type ReviewItem } from './review.ts'
import { setAsideView } from './set-aside.ts'
import { YIELD_EVERY, yieldNow } from './yield.ts'
import { syncedLongAgo } from './store.ts'

/** Parts other slices own; the reader delegates to them when wired. */
export interface ReaderProviders {
  /** S6: cap table views and whether a scope has equity data. */
  equity?: { capTable(scope: ReadScope): Promise<CapTableView[]>; hasEquity(scope: ReadScope): Promise<boolean> }
  /** S0: documents (uploads, email-in). */
  documents?: { list(scope: ReadScope, status?: DocumentView['status']): Promise<DocumentView[]>; get(ws: WorkspaceId, id: Id): Promise<DocumentView | null> }
  /** Display names of AI connections and people for "added by …" (grant/person id → name). */
  names?: (ws: WorkspaceId, id: string) => Promise<string | null>
}

const money = (minor: number, currency: string): Money => ({ minor: minor || 0, currency })

function sumByCurrency(items: Money[]): Money[] {
  const m = new Map<string, number>()
  for (const x of items) m.set(x.currency, (m.get(x.currency) ?? 0) + x.minor)
  return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, v]) => money(v, c))
}

interface Ctx {
  ws: WorkspaceId
  scope: Set<EntityId>
  accounts: Map<Id, SourceAccountInfo>
  ledger: Map<Id, LedgerAccount>
  connections: Map<Id, { connectorKey: string; displayName: string }>
}

/**
 * Big searches (a page over BIG_SEARCH rows: a whole-ledger sum or export) run at most BIG_SEARCHES at once per
 * process; the rest wait their turn. Each builds every row's view (~10k rows, tens of MB): fifty workspaces asking at
 * once ran a 512 MB machine out of heap (f8's run M, 50 MCP accounts).
 */
const BIG_SEARCH = 1_000
const BIG_SEARCHES = 2
let bigRunning = 0
const bigWaiting: Array<() => void> = []
async function bigTurn<T>(fn: () => Promise<T>): Promise<T> {
  if (bigRunning >= BIG_SEARCHES) await new Promise<void>((go) => bigWaiting.push(go))
  else bigRunning++
  try {
    return await fn()
  } finally {
    const next = bigWaiting.shift()
    if (next) next()
    else bigRunning--
  }
}

/** Investment platforms a position can be read from: where its "Via …" link goes (InvestmentView.source). */
const INVESTMENT_SOURCES: Record<string, { name: string; url: string }> = {
  wefunder: { name: 'Wefunder', url: 'https://wefunder.com/portfolio' },
}

/** An https link on the same site as the platform's own URL (so a stored link can only point at that platform). */
function onSite(url: string, platformUrl: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === new URL(platformUrl).hostname
  } catch {
    return false
  }
}

/** Receivables more than this many days overdue are left out of upcoming expected income (see upcoming). */
const OVERDUE_INCOME_DAYS = 30

export class LedgerFinanceReader implements FinanceReader {
  readonly engine: LedgerEngine
  readonly providers: ReaderProviders

  constructor(engine: LedgerEngine, providers: ReaderProviders = {}) {
    this.engine = engine
    this.providers = providers
  }

  get #store() {
    return this.engine.store
  }

  get #dir() {
    return this.engine.directory
  }

  #rc(ws: WorkspaceId): MetricContext {
    const base = this.engine.metricContext(ws)
    return { ...base, directory: requestDirectory(base.directory), memo: new Map() }
  }

  async #ctx(scope: ReadScope): Promise<Ctx> {
    const [accounts, ledger, conns] = await Promise.all([this.#dir.listSourceAccounts(scope.workspaceId), this.#store.listLedgerAccounts(scope.workspaceId, scope.entityIds), this.#dir.listConnections(scope.workspaceId)])
    return {
      ws: scope.workspaceId,
      scope: new Set(scope.entityIds),
      accounts: new Map(accounts.map((a) => [a.id, a])),
      ledger: new Map(ledger.map((a) => [a.id, a])),
      connections: new Map(conns.map((c) => [c.id, { connectorKey: c.connectorKey, displayName: c.displayName }])),
    }
  }

  async #addedBy(c: Ctx, r: SourceRecord): Promise<AddedBy> {
    const p = r.provenance
    if (r.origin === 'agent') return { kind: 'agent', name: p?.label ?? 'AI', ...(p?.grantId ? { grantId: p.grantId } : {}) }
    if (r.origin === 'ui') return { kind: 'person', name: p?.label ?? (r.createdBy ? ((await this.providers.names?.(c.ws, r.createdBy)) ?? 'Someone') : 'Someone') }
    if (r.origin === 'rule') return { kind: 'rule', name: 'Rule' }
    if (r.origin === 'import') return { kind: 'import', name: 'Import' }
    if (r.origin === 'email') return { kind: 'email', name: 'Email' }
    return { kind: 'sync', name: c.connections.get(r.connectionId)?.displayName ?? 'Sync' }
  }

  // ---------- entities, data, sources ----------

  async entities(ws: WorkspaceId): Promise<EntityInfo[]> {
    return (await this.#dir.listEntities(ws)).map((e) => ({ id: e.id, name: e.name, kind: e.kind, currency: e.baseCurrency, ...(e.ownerPersonId ? { ownerPersonId: e.ownerPersonId } : {}) }))
  }

  async dataAvailability(scope: ReadScope): Promise<DataType[]> {
    if (scope.entityIds.length === 0) return []
    return this.#cached(scope.workspaceId, `available|${[...scope.entityIds].sort().join(',')}`, () => this.#dataAvailability(scope))
  }

  /** Which kinds of data a scope has: presence only (it used to load every record and every ledger line to find out). */
  async #dataAvailability(scope: ReadScope): Promise<DataType[]> {
    const ws = scope.workspaceId
    const ids = scope.entityIds
    const out = new Set<DataType>()
    const accounts = (await this.#dir.listSourceAccounts(ws)).filter((a) => a.entityId && ids.includes(a.entityId))
    if (accounts.length) out.add('balances')
    const types = await this.#store.eventTypesPresent(ws, ids)
    if (types.has('txn.upsert') || types.has('processor.balance_txn') || types.has('balance.snapshot')) {
      out.add('balances')
      out.add('transactions')
    }
    if (types.has('payroll.run')) out.add('payroll')
    if (types.has('equity.event') || types.has('investment.event')) out.add('equity')
    if (types.has('invoice.upsert')) {
      for (const r of await this.#store.listRecords(ws, { entityIds: ids, eventTypes: ['invoice.upsert'] })) {
        if (r.event.type === 'invoice.upsert') out.add(r.event.direction === 'receivable' ? 'invoices' : 'bills')
      }
    }
    if ((await this.#store.listBuckets(ws, ids)).length) out.add('buckets')
    // Reports read the ledger's lines: there are some as soon as anything has posted.
    if ((await this.#store.listRecords(ws, { entityIds: ids, statuses: ['posted'], limit: 1 })).length) out.add('reports')
    if (await this.providers.equity?.hasEquity(scope)) out.add('equity')
    if ((await this.providers.documents?.list(scope))?.length) out.add('documents')
    const entities = await this.#dir.listEntities(ws)
    if (entities.some((e) => ids.includes(e.id) && e.kind === 'personal')) out.add('personal')
    return [...out].sort()
  }

  async sources(scope: ReadScope): Promise<SourceStatus[]> {
    const ws = scope.workspaceId
    const ids = new Set(scope.entityIds)
    const accounts = await this.#dir.listSourceAccounts(ws)
    const now = Date.parse(this.engine.now())
    const out: SourceStatus[] = []
    for (const c of await this.#dir.listConnections(ws)) {
      if (c.connectorKey === 'manual') continue
      const ents = new Set<EntityId>()
      for (const a of accounts) if (a.connectionId === c.id && a.entityId && ids.has(a.entityId)) ents.add(a.entityId)
      if (c.entityId && ids.has(c.entityId)) ents.add(c.entityId)
      if (ents.size === 0) continue
      const health: SourceStatus['health'] = c.status === 'needs_reauth' ? 'needs_reauth' : c.status === 'rate_limited' ? 'rate_limited' : c.status === 'active' ? 'ok' : 'error'
      out.push({
        connectionId: c.id,
        name: c.displayName,
        entityIds: [...ents].sort(),
        lastSyncAt: c.lastSuccessAt,
        stale: syncedLongAgo(c, now),
        health,
      })
    }
    return out
  }

  // ---------- overview and metrics ----------

  async metric(name: MetricName, scope: MetricScope): Promise<MetricAnswer> {
    const ids = scope.entityIds === 'all' ? ['*'] : [...scope.entityIds].sort()
    const key = `metric|${name}|${ids.join(',')}|${scope.from ?? ''}|${scope.to ?? ''}|${scope.basis ?? ''}|${scope.figureOnly ? 'f' : ''}`
    return this.#cached(scope.workspaceId, key, () => this.engine.metric(name, scope))
  }

  /** The state of the workspace's sources that a figure shows without a ledger write (a sync's time, going stale, an account's company). */
  async #sourcesKey(ws: WorkspaceId, rc: MetricContext): Promise<string> {
    const [conns, accounts] = await Promise.all([rc.directory.listConnections(ws), rc.directory.listSourceAccounts(ws)])
    const now = Date.parse(this.engine.now())
    return [...conns.map((c) => `${c.id}:${c.status}:${c.lastSuccessAt ?? ''}:${c.entityId ?? ''}:${syncedLongAgo(c, now)}`), ...accounts.map((a) => `${a.id}:${a.entityId ?? ''}:${a.duplicateOf ?? ''}`)].sort().join(',')
  }

  /**
   * A read reused until the next write, per day and source state (rc.shared, as the overview). The company drawer asks
   * for cash, runway, MRR, buckets and anomalies on every open; recomputed each time it took 0.7–2.4 s warm on the
   * demo's Harbor Coffee (24 months).
   */
  async #cached<T>(ws: WorkspaceId, key: string, fn: () => Promise<T>): Promise<T> {
    const rc = this.#rc(ws)
    if (!rc.shared) return fn()
    return rc.shared(`${key}|${this.engine.now().slice(0, 10)}|${await this.#sourcesKey(ws, rc)}`, fn)
  }

  /**
   * The whole answer is reused until the next write (rc.shared: the workspace version, at most 30 minutes), per scope and
   * day. Keyed also by each connection's state and last good sync and each account's company, which change without a
   * ledger write (a sync that brought nothing new still clears "hasn't synced"). Staging: a fresh demo's first overview
   * was 2.3 s, a repeat 0.6 s; both now read the answer the warm left.
   */
  async overview(scope: ReadScope, asOf?: IsoTimestamp): Promise<Overview> {
    const ws = scope.workspaceId
    const rc = this.#rc(ws)
    const at = asOf ?? this.engine.now()
    // The workspace's own day, as metrics use (a UTC date runs a day ahead in the evening in the Americas).
    const day = localDate(at, await zoneOf(rc))
    if (!rc.shared) return this.#overview(scope, at, day, rc)
    const sources = await this.#sourcesKey(ws, rc)
    const key = `overview|${[...scope.entityIds].sort().join(',')}|${day}|${sources}`
    return { ...(await rc.shared(key, () => this.#overview(scope, at, day, rc))), asOf: at }
  }

  async #overview(scope: ReadScope, asOf: IsoTimestamp, asOfDate: IsoDate, rc: MetricContext): Promise<Overview> {
    const ws = scope.workspaceId
    const entities = (await this.#dir.listEntities(ws)).filter((e) => scope.entityIds.includes(e.id))
    const home = await this.#dir.reportingCurrency(ws)
    // Every company at once, and within one its figures, open invoices and next payroll together: the shared read
    // context (rc) computes checks, review and coverage once per scope however many metrics ask.
    const perEntity = await Promise.all(
      entities.map(async (e) => {
        const one: MetricScope = { workspaceId: ws, entityIds: [e.id], to: asOfDate }
        const m = (n: MetricName, extra: Partial<MetricScope> = {}) => computeMetric(n, { ...one, ...extra }, rc)
        const [cash, cards, runway, burn, mrr, arOpen, arOver, ap, receivable, nextPayroll] = await Promise.all([
          m('cash'),
          m('card_balances'),
          m('runway'),
          m('net_burn'),
          m('mrr'),
          m('ar_open'),
          m('ar_overdue'),
          m('ap_due'),
          openItems(rc, [e.id], 'receivable', asOfDate),
          this.#nextPayroll(ws, e.id, asOfDate),
        ])
        return { e, cash, cards, runway, burn, mrr, arOpen, arOver, ap, receivable, nextPayroll }
      }),
    )
    const out: OverviewEntity[] = []
    const attention: Overview['attention'] = []
    const failing = new Map<string, Overview['failingChecks'][number]>()
    for (const { e, cash, cards, runway, burn, mrr, arOpen, arOver, ap, receivable, nextPayroll } of perEntity) {
      const mv = (a: MetricAnswer): Money => (a.value && typeof a.value === 'object' ? a.value : money(0, home))
      // net_burn is already a monthly average (the last 3 full months, or those history covers).
      const burnAvg = burn.value && typeof burn.value === 'object' ? burn.value : null
      out.push({
        entityId: e.id,
        cash: mv(cash),
        cardDebt: mv(cards),
        netBurn3mo: burnAvg,
        runwayMonths: typeof runway.value === 'number' ? runway.value : null,
        runwayState: runway.state ?? 'no_data',
        mrr: mrr.value && typeof mrr.value === 'object' ? mrr.value : null,
        owedToYou: { total: mv(arOpen), overdue: mv(arOver) },
        billsDue30d: mv(ap),
        nextPayroll,
        ...caveatsOf({ cash, cardDebt: cards, netBurn3mo: burn, runwayMonths: runway }),
        ...noDataOf({ owedToYou: arOpen, billsDue30d: ap }),
      })
      if (typeof runway.value === 'number' && runway.value < 6) attention.push({ kind: 'low_runway', entityId: e.id, text: `${e.name}: about ${runway.value} months of runway` })
      for (const it of receivable.filter((i) => i.dueDate && i.dueDate < asOfDate).slice(0, 3)) {
        const inv = it.record.event as InvoiceUpsert
        attention.push({ kind: 'overdue_invoice', entityId: e.id, recordId: it.record.id, text: `${inv.number ?? 'An invoice'} to ${inv.counterparty} is ${daysBetween(it.dueDate as IsoDate, asOfDate)} days overdue` })
      }
      for (const c of [cash, runway].flatMap((a) => (a as { failedChecks?: Array<{ name: string; message: string; entityId: EntityId | null; status: string }> }).failedChecks ?? [])) {
        if (c.status !== 'fail') continue
        failing.set(`${c.name}|${c.message}`, { ...(c.entityId ? { entityId: c.entityId } : {}), check: c.name, detail: c.message })
      }
      if (cash.pendingReviewCount > 0) attention.push({ kind: 'needs_review', entityId: e.id, text: `${e.name}: ${cash.pendingReviewCount} item(s) to review` })
      for (const sId of cash.staleSources) attention.push({ kind: 'stale_source', entityId: e.id, text: `A connection for ${e.name} hasn't synced in over a day`, recordId: sId })
    }
    for (const f of failing.values()) attention.push({ kind: 'failed_check', ...(f.entityId ? { entityId: f.entityId } : {}), text: f.detail })
    return { asOf, homeCurrency: home, entities: out, attention, failingChecks: [...failing.values()] }
  }

  async #nextPayroll(ws: WorkspaceId, entityId: EntityId, asOf: IsoDate): Promise<{ date: IsoDate; estimate: Money } | null> {
    const runs = (await this.#store.listRecords(ws, { entityIds: [entityId], eventTypes: ['payroll.run'] })).filter((r) => r.event.type === 'payroll.run' && r.status !== 'void')
    const next = runs.filter((r) => r.event.type === 'payroll.run' && r.event.status === 'scheduled' && r.date >= asOf).sort((a, b) => (a.date < b.date ? -1 : 1))[0]
    if (next && next.event.type === 'payroll.run') {
      const ev = next.event
      // next.date is the workspace-tz business date (= payDate unless the connector gave a real `at`); match the ledger.
      return { date: next.date, estimate: ev.companyDebit ?? money(ev.gross.minor + ev.employerTaxes.minor, ev.gross.currency) }
    }
    return null
  }

  // ---------- accounts and transactions ----------

  async accounts(scope: ReadScope, filter: AccountFilter): Promise<AccountView[]> {
    const c = await this.#ctx(scope)
    const conns = new Map((await this.#dir.listConnections(scope.workspaceId)).map((x) => [x.id, x]))
    const out: AccountView[] = []
    const wanted = [...c.accounts.values()].filter((a) => a.entityId && c.scope.has(a.entityId) && !a.duplicateOf && (!filter.type || a.accountType === filter.type))
    const latest = await this.#latestSnapshots(scope.workspaceId, wanted.map((a) => a.id))
    for (const a of wanted) {
      if (!a.entityId) continue
      const snap = latest.get(a.id) ?? null
      let balance: Money | null = snap ? snap.current : null
      if (!balance) {
        const la = [...c.ledger.values()].find((l) => l.entityId === a.entityId && l.role === cashRole(a.id, a.accountType))
        if (la) {
          const lines = await this.#store.listLines(scope.workspaceId, { basis: 'cash', ledgerAccountIds: [la.id] })
          balance = money(lines.filter((l) => l.currency === a.currency).reduce((s, l) => s + l.debitMinor - l.creditMinor, 0), a.currency)
        } else if (a.accountType === 'processor_balance' && a.connectionId && conns.get(a.connectionId)?.lastSuccessAt) {
          // A processor balance is the sum of its own rows (the provider never sends one): synced with no sales yet, $0.
          balance = money(0, a.currency)
        }
      }
      out.push({
        id: a.id,
        entityId: a.entityId,
        name: a.name,
        ...(a.institution ? { institution: a.institution } : {}),
        ...(a.mask ? { mask: a.mask } : {}),
        type: a.accountType,
        currency: a.currency,
        balance,
        available: snap?.available ?? null,
        limit: null,
        lastSyncAt: a.connectionId ? (conns.get(a.connectionId)?.lastSuccessAt ?? null) : null,
        closed: false,
      })
    }
    return out
  }

  /** Each account's latest provider balance (the latest `at` on its newest day), in one read for all of them. */
  async #latestSnapshots(ws: WorkspaceId, accountIds: Id[]): Promise<Map<Id, { current: Money; available: Money | null }>> {
    const out = new Map<Id, { current: Money; available: Money | null }>()
    const best = new Map<Id, SourceRecord>()
    for (const s of await this.#store.latestRecordsByAccount(ws, accountIds, ['balance.snapshot'])) {
      if (s.event.type !== 'balance.snapshot' || !s.sourceAccountId) continue
      const b = best.get(s.sourceAccountId)
      if (!b || (b.event as { at: string }).at < s.event.at) best.set(s.sourceAccountId, s)
    }
    for (const [id, s] of best) if (s.event.type === 'balance.snapshot') out.set(id, { current: s.event.current, available: s.event.available ?? null })
    return out
  }

  /** Counter-account role per source record (the "category"), from one pass over the cash-view lines. */
  async #categories(c: Ctx, entityIds: EntityId[], sourceIds?: Id[]): Promise<Map<Id, { role: string; entityId: EntityId; bucketId: Id | null }>> {
    // Many rows (query_transactions reads every one in a page of 10,000): the whole scope in one read, kept until the
    // next write, beats a read per 500 ids (staging demo: 16 reads, ~0.9 s of a 1.2 s query_transactions).
    if (sourceIds && sourceIds.length > CATEGORY_CHUNK) {
      const rc = this.#rc(c.ws)
      const load = () => this.#categories(c, entityIds)
      const all = rc.shared ? await rc.shared(`categories|${[...entityIds].sort().join(',')}`, load) : await load()
      const wanted = new Set(sourceIds)
      return new Map([...all].filter(([id]) => wanted.has(id)))
    }
    const lines: LineRow[] = []
    if (!sourceIds) lines.push(...(await this.#store.listLines(c.ws, { entityIds, basis: 'cash' })))
    // Chunked so the IN list stays well under SQLite's parameter limit.
    else for (let i = 0; i < sourceIds.length; i += CATEGORY_CHUNK) lines.push(...(await this.#store.listLines(c.ws, { entityIds, basis: 'cash', sourceIds: sourceIds.slice(i, i + CATEGORY_CHUNK) })))
    const ledger = c.ledger.size ? c.ledger : new Map((await this.#store.listLedgerAccounts(c.ws)).map((a) => [a.id, a]))
    const reversed = new Set<Id>()
    const out = new Map<Id, { role: string; entityId: EntityId; bucketId: Id | null; abs: number }>()
    // Only current (non-reversed) entries count: net each (source, account) and keep the largest counter line.
    const net = new Map<string, { sourceId: Id; role: string; entityId: EntityId; bucketId: Id | null; v: number }>()
    for (const l of lines) {
      const a = ledger.get(l.ledgerAccountId)
      if (!a) continue
      if (isCashLikeRole(a.role) || a.role.startsWith('card:') || a.role.startsWith('loan:')) continue
      const key = `${l.sourceId}|${a.id}`
      const n = net.get(key) ?? { sourceId: l.sourceId, role: a.role, entityId: l.entityId, bucketId: l.bucketId, v: 0 }
      n.v += l.debitMinor - l.creditMinor
      if (l.bucketId) n.bucketId = l.bucketId
      net.set(key, n)
    }
    void reversed
    for (const n of net.values()) {
      if (n.v === 0) continue
      const prev = out.get(n.sourceId)
      // Prefer the line in another entity (whose money: the "for" side holds the real category).
      const crossInter = n.role.startsWith('due_') || n.role.startsWith('owner_payable:')
      const score = Math.abs(n.v) + (crossInter ? 0 : 0.5)
      if (!prev || score > prev.abs) out.set(n.sourceId, { role: n.role, entityId: n.entityId, bucketId: n.bucketId, abs: score })
    }
    return new Map([...out].map(([k, v]) => [k, { role: v.role, entityId: v.entityId, bucketId: v.bucketId }]))
  }

  /** `overrides` and `kinds` are read once per page of rows (listOverrides, activeEntryKinds), not per row. */
  async #txnView(c: Ctx, r: SourceRecord, cats: Map<Id, { role: string; entityId: EntityId; bucketId: Id | null }>, links: Link[], proposed: Set<Id>, overrides: Map<Id, RecordOverride>, kinds: Map<Id, JournalEntry['kind']>): Promise<TxnView | null> {
    const b = txnBasics(r)
    if (!r.entityId || !b) return null
    const { amount, counterparty, rawText, status } = b
    const o = overrides.get(r.id) ?? null
    const cat = cats.get(r.id)
    const kind = kinds.get(r.id)
    return {
      id: r.id,
      entityId: r.entityId,
      accountId: r.sourceAccountId,
      date: r.date,
      amount,
      status,
      ...(counterparty ? { counterparty } : {}),
      ...(cat ? { category: cat.role } : {}),
      ...(kind ? { kind } : {}),
      ...((o?.bucketId ?? cat?.bucketId) ? { bucketId: (o?.bucketId ?? cat?.bucketId) as Id } : {}),
      ...(rawText ? { rawText } : {}),
      paidByEntityId: r.entityId,
      ...(cat && cat.entityId !== r.entityId ? { forEntityId: cat.entityId } : o?.forEntityId ? { forEntityId: o.forEntityId } : {}),
      addedBy: await this.#addedBy(c, r),
      links: links.filter((l) => l.status === 'confirmed').map((l) => ({ type: l.type, recordId: l.fromId === r.id ? l.toId : l.fromId })),
      needsReview: proposed.has(r.id) || cat?.role === 'suspense' || cat?.role === 'owner_money_unspecified',
    }
  }

  searchTransactions(scope: ReadScope, q: TxnQuery): Promise<TxnSearchResult> {
    // Never queued inside a ledger transaction: it holds a pool connection while it waits (engine #inTx).
    return (q.limit ?? 0) > BIG_SEARCH && !this.#store.inTransaction?.() ? bigTurn(() => this.#searchTransactions(scope, q)) : this.#searchTransactions(scope, q)
  }

  async #searchTransactions(scope: ReadScope, q: TxnQuery): Promise<TxnSearchResult> {
    const c = await this.#ctx(scope)
    // Shared, frozen rows (engine.txnRecords); dates and account narrowed here.
    const records = (await this.engine.txnRecords(scope.workspaceId, scope.entityIds)).filter(
      (r) => (!q.from || r.date >= q.from) && (!q.to || r.date <= q.to) && (!q.accountId || r.sourceAccountId === q.accountId),
    )
    const text = q.text?.toLowerCase()
    const cp = q.counterparty ? merchantKey(q.counterparty) : null
    const filter = q.q?.trim() ? parseQuery(q.q) : null
    const feesAsked = (q.category ?? filter?.category)?.toLowerCase() === 'processor_fees'
    const copies = new Set((await this.#store.listLinks(scope.workspaceId, { types: ['duplicate'], statuses: ['confirmed'] })).map((l) => l.toId))
    // Rules that rename counterparties change what rows are called, in search too.
    const renames = (await this.#store.listRules(scope.workspaceId)).filter((r) => r.status === 'active' && r.actions.renameTo)
    const renamed = (r: SourceRecord): string | undefined => (renames.length ? applyRules(renames, r, r.sourceAccountId ? c.accounts.get(r.sourceAccountId) : null).actions.renameTo : undefined)
    // First pass on what the row itself says (amount, words, source); categories and links are read only for the
    // rows that survive, and only for the page unless the query filters on them.
    const hits: Array<{ r: SourceRecord; amount: Money; status: TxnView['status']; name?: string; fee?: { counterparty: string; rawText: string } }> = []
    let seen = 0
    for (const r of records) {
      if (++seen % YIELD_EVERY === 0) await yieldNow()
      // Void rows (removed by the provider) and copies counted once through a confirmed duplicate link aren't
      // transactions to list or count.
      if (r.status === 'excluded' || r.status === 'unassigned' || r.status === 'void' || !r.entityId || copies.has(r.id)) continue
      const raw = txnBasics(r)
      if (!raw) continue
      const fee = processorFee(r)
      const by = r.sourceAccountId ? c.accounts.get(r.sourceAccountId) : undefined
      const processor = by?.institution ?? by?.name.replace(/\s+balance\b.*$/i, '') ?? 'Processor'
      // Rules (renames) act on the charge only, never on its fee row.
      const newName = renamed(r)
      const charge = newName ? { ...raw, counterparty: newName } : raw
      for (const b of [charge, ...(fee ? [{ amount: fee, counterparty: processor, rawText: `${processor} fee`, status: raw.status, isFee: true }] : [])]) {
        const isFee = 'isFee' in b
        const abs = Math.abs(b.amount.minor)
        if (q.minAbsMinor !== undefined && abs < q.minAbsMinor) continue
        if (q.maxAbsMinor !== undefined && abs > q.maxAbsMinor) continue
        if (q.direction === 'in' && b.amount.minor <= 0) continue
        if (q.direction === 'out' && b.amount.minor >= 0) continue
        if (q.status && b.status !== q.status) continue
        // A query for fees also finds a charge's fee row by the charge's own words ("Bean Club" category:processor_fees).
        const named = isFee && feesAsked ? [b, charge] : [b]
        if (text && !named.some((x) => `${x.counterparty ?? ''} ${x.rawText ?? ''}`.toLowerCase().includes(text))) continue
        if (filter) {
          const acct = r.sourceAccountId ? c.accounts.get(r.sourceAccountId) : undefined
          const account = acct ? { id: acct.id, name: acct.name, mask: acct.mask ?? null } : null
          if (!named.some((x) => matchesFilter({ ...filter, category: undefined }, { text: x.rawText ?? '', counterparty: x.counterparty ?? null, amount: b.amount, date: r.date, account }))) continue
        }
        if (cp && !named.some((x) => merchantKey(x.counterparty ?? x.rawText ?? '').includes(cp) || nameSimilarity(q.counterparty as string, x.counterparty ?? x.rawText ?? '') >= 0.8)) continue
        if (q.source) {
          const acct = r.sourceAccountId ? c.accounts.get(r.sourceAccountId) : undefined
          const src =
            r.origin === 'agent' ? 'agent' : r.origin === 'ui' ? 'manual' : r.event.type === 'processor.balance_txn' || acct?.accountType === 'processor_balance' ? 'processor' : acct?.accountType === 'credit_card' ? 'card' : 'bank'
          if (src !== q.source) continue
        }
        hits.push({ r, amount: b.amount, status: b.status, ...(newName && !isFee ? { name: newName } : {}), ...(isFee ? { fee: { counterparty: b.counterparty as string, rawText: b.rawText as string } } : {}) })
      }
    }
    // Newest first; a fee row right after its charge.
    hits.sort((a, b) => (a.r.date > b.r.date ? -1 : a.r.date < b.r.date ? 1 : a.r.id > b.r.id ? -1 : a.r.id < b.r.id ? 1 : a.fee ? 1 : b.fee ? -1 : 0))
    // Waiting on a suggested match only while Review still asks it: an alternative left over once another match used
    // the money up (the other of two alike invoices) isn't a question any more.
    const proposed = new Set(
      (await listReviewItems(this.engine.metricContext(scope.workspaceId), { entityIds: scope.entityIds })).filter((i) => i.kind === 'suggested_match').flatMap((i) => [...i.recordIds, ...(i.alternatives ?? []).flatMap((a) => a.recordIds)]),
    )
    const views = async (rows: typeof hits): Promise<TxnView[]> => {
      if (rows.length === 0) return []
      const cats = await this.#categories(c, scope.entityIds, rows.map((h) => h.r.id))
      const linksBy = new Map<Id, Link[]>()
      for (const l of await this.#store.listLinks(scope.workspaceId, { recordIds: rows.map((h) => h.r.id), statuses: ['confirmed'] })) {
        for (const id of [l.fromId, l.toId]) linksBy.set(id, [...(linksBy.get(id) ?? []), l])
      }
      const overrides = new Map((await this.#store.listOverrides(scope.workspaceId)).map((o) => [o.recordId, o]))
      const kinds = await this.#store.activeEntryKinds(scope.workspaceId, rows.map((h) => h.r.id))
      const out: TxnView[] = []
      let done = 0
      for (const h of rows) {
        if (++done % YIELD_EVERY === 0) await yieldNow()
        const v = await this.#txnView(c, h.r, cats, linksBy.get(h.r.id) ?? [], proposed, overrides, kinds)
        if (!v) continue
        if (h.fee) {
          const { bucketId: _b, forEntityId: _f, ...base } = v
          out.push({ ...base, id: `${v.id}${FEE_ROW}`, amount: h.amount, counterparty: h.fee.counterparty, rawText: h.fee.rawText, category: 'processor_fees', kind: 'fee', links: [], needsReview: false })
        } else out.push(h.name ? { ...v, counterparty: h.name } : v)
      }
      return out
    }
    const category = q.category ?? filter?.category
    if (category || q.needsReview !== undefined) {
      const all = (await views(hits)).filter((v) => (!category || v.category?.toLowerCase() === category.toLowerCase()) && (q.needsReview === undefined || v.needsReview === q.needsReview))
      return { ...page(all, q.limit, q.cursor, (prev, next) => next.id === `${prev.id}${FEE_ROW}`), sums: sumByCurrency(all.filter((v) => v.status !== 'void').map((v) => v.amount)) }
    }
    const p = page(hits, q.limit, q.cursor, (prev, next) => next.fee !== undefined && next.r.id === prev.r.id)
    return { ...p, rows: await views(p.rows), sums: sumByCurrency(hits.filter((h) => h.status !== 'void').map((h) => h.amount)) }
  }

  // ---------- invoices ----------

  async #invoiceViews(scope: ReadScope, asOf: IsoDate): Promise<InvoiceView[]> {
    const c = await this.#ctx(scope)
    const rc = this.#rc(scope.workspaceId)
    const records = await this.#store.listRecords(scope.workspaceId, { entityIds: scope.entityIds, eventTypes: ['invoice.upsert'] })
    const open = new Map<Id, number>()
    for (const dir of ['receivable', 'payable'] as const) for (const it of await openItems(rc, scope.entityIds, dir, '9999-12-31')) open.set(it.record.id, it.remainingMinor)
    // People's notes (overrides) in one read, not one per invoice.
    const overrides = new Map((await this.#store.listOverrides(scope.workspaceId)).map((o) => [o.recordId, o]))
    const payments = await this.#invoicePayments(scope.workspaceId, records)
    const out: InvoiceView[] = []
    for (const r of records) {
      if (r.event.type !== 'invoice.upsert' || !r.entityId) continue
      const inv = r.event
      const remaining = open.get(r.id) ?? 0
      const paid = inv.status === 'void' || inv.status === 'draft' ? inv.amountPaid.minor : Math.max(0, inv.total.minor - remaining)
      let status: InvoiceView['status'] = r.status === 'void' ? 'void' : inv.status
      if (status === 'open' || status === 'partially_paid') {
        if (remaining === 0 && inv.total.minor > 0) status = 'paid'
        else if (paid > 0) status = 'partially_paid'
        if (remaining > 0 && inv.dueDate && inv.dueDate < asOf) status = 'overdue'
      }
      const o = overrides.get(r.id)
      out.push({
        id: r.id,
        entityId: r.entityId,
        direction: inv.direction,
        ...(inv.number ? { number: inv.number } : {}),
        counterparty: inv.counterparty,
        issueDate: r.date,
        ...(inv.dueDate ? { dueDate: inv.dueDate } : {}),
        total: inv.total,
        amountPaid: money(paid, inv.total.currency),
        status,
        daysOverdue: remaining > 0 && inv.dueDate && inv.dueDate < asOf ? daysBetween(inv.dueDate, asOf) : 0,
        source: c.connections.get(r.connectionId)?.displayName ?? 'Added by hand',
        hasAttachment: Boolean(r.provenance?.fileSha256 || r.provenance?.sourceDocumentId),
        ...(inv.lines ? { lines: inv.lines.map((l) => ({ description: l.description, amount: l.amount, ...(l.quantity !== undefined ? { quantity: l.quantity } : {}) })) } : {}),
        payments: payments.get(r.id) ?? [],
        ...(o?.note ? { note: o.note } : {}),
        addedBy: await this.#addedBy(c, r),
      })
    }
    return out
  }

  /**
   * Each invoice's payments: the invoicing tool's payments applied to it (payment.applied, by the invoice's id there),
   * and bank or processor rows linked to it directly (confirmed invoice_payment links). A tool payment shows as the
   * bank row it is linked to, when there is one. The amount is what was applied to this invoice.
   */
  async #invoicePayments(ws: WorkspaceId, invoices: SourceRecord[]): Promise<Map<Id, NonNullable<InvoiceView['payments']>>> {
    const links = await this.#store.listLinks(ws, { types: ['invoice_payment'], statuses: ['confirmed'] })
    const tool = (await this.#store.listRecords(ws, { eventTypes: ['payment.applied'] })).filter((r) => r.status !== 'void')
    const toolIds = new Set(tool.map((r) => r.id))
    const invIds = new Set(invoices.map((r) => r.id))
    const onward = new Map<Id, Id>()
    for (const l of links) if (toolIds.has(l.fromId)) onward.set(l.fromId, l.toId)
    const direct = links.filter((l) => invIds.has(l.fromId))
    const recs = new Map((await this.#store.getRecords(ws, [...new Set([...onward.values(), ...direct.map((l) => l.toId)])])).map((r) => [r.id, r]))
    const byExternal = new Map(invoices.map((r) => [`${r.connectionId}|${r.externalId}`, r]))
    const out = new Map<Id, NonNullable<InvoiceView['payments']>>()
    const add = (invId: Id, p: NonNullable<InvoiceView['payments']>[number]) => out.set(invId, [...(out.get(invId) ?? []), p])
    for (const r of tool) {
      if (r.event.type !== 'payment.applied') continue
      const bank = recs.get(onward.get(r.id) ?? '')
      const paidBy = bank && bank.status !== 'void' ? bank : r
      for (const a of r.event.applications) {
        const inv = byExternal.get(`${r.connectionId}|${a.invoiceExternalId}`)
        if (inv) add(inv.id, { date: paidBy.date, amount: a.amount, recordId: paidBy.id })
      }
    }
    for (const l of direct) {
      const to = recs.get(l.toId)
      if (!to || to.status === 'void') continue
      // A link without an amount applied the whole payment, up to the invoice's total.
      const inv = invoices.find((r) => r.id === l.fromId)!.event as InvoiceUpsert
      const whole = to.event.type === 'processor.balance_txn' ? to.event.gross : to.event.type === 'txn.upsert' ? to.event.amount : undefined
      const amount = l.amount ?? (whole ? money(Math.min(Math.abs(whole.minor), inv.total.minor), whole.currency) : null)
      if (amount) add(l.fromId, { date: to.date, amount, recordId: to.id })
    }
    for (const list of out.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.recordId < b.recordId ? -1 : 1))
    return out
  }

  async searchInvoices(scope: ReadScope, q: InvoiceQuery): Promise<InvoiceSearchResult> {
    const asOf = await todayFor(this.engine.metricContext(scope.workspaceId))
    const all = await this.#invoiceViews(scope, asOf)
    const rows = all.filter((v) => {
      if (q.direction && v.direction !== q.direction) return false
      // An overdue invoice with something paid is shown as overdue (the more urgent fact) and is partly paid too.
      if (q.status && v.status !== q.status && !(q.status === 'partially_paid' && v.status === 'overdue' && v.amountPaid.minor > 0)) return false
      if (q.counterparty && !(merchantKey(v.counterparty).includes(merchantKey(q.counterparty)) || nameSimilarity(q.counterparty, v.counterparty) >= 0.8)) return false
      if (q.number && v.number?.toLowerCase() !== q.number.toLowerCase()) return false
      if (q.dueBefore && (!v.dueDate || v.dueDate >= q.dueBefore)) return false
      if (q.overdueDaysMin !== undefined && v.daysOverdue < q.overdueDaysMin) return false
      if (q.amountMinor !== undefined && Math.abs(v.total.minor - q.amountMinor) > (q.amountToleranceMinor ?? 0)) return false
      return true
    })
    rows.sort((a, b) => (a.issueDate > b.issueDate ? -1 : a.issueDate < b.issueDate ? 1 : a.id > b.id ? -1 : 1))
    const totals: InvoiceSearchResult['totals'] = []
    const aging: InvoiceSearchResult['aging'] = []
    for (const direction of ['receivable', 'payable'] as const) {
      const mine = all.filter((v) => v.direction === direction && ['open', 'partially_paid', 'overdue', 'disputed'].includes(v.status))
      for (const cur of [...new Set(mine.map((v) => v.total.currency))].sort()) {
        const inCur = mine.filter((v) => v.total.currency === cur)
        const rem = (v: InvoiceView) => v.total.minor - v.amountPaid.minor
        totals.push({ direction, open: money(inCur.reduce((s, v) => s + rem(v), 0), cur), overdue: money(inCur.filter((v) => v.daysOverdue > 0).reduce((s, v) => s + rem(v), 0), cur) })
        const b: AgingBuckets = { currency: cur, current: money(0, cur), d1_30: money(0, cur), d31_60: money(0, cur), d61_90: money(0, cur), d90_plus: money(0, cur) }
        for (const v of inCur) {
          const d = v.daysOverdue
          const k: keyof Omit<AgingBuckets, 'currency'> = d <= 0 ? 'current' : d <= 30 ? 'd1_30' : d <= 60 ? 'd31_60' : d <= 90 ? 'd61_90' : 'd90_plus'
          b[k] = money(b[k].minor + rem(v), cur)
        }
        aging.push({ ...b, direction })
      }
    }
    return { ...page(rows, q.limit, q.cursor), totals, aging }
  }

  // ---------- one record ----------

  /** What a processor payout paid out: the rows the processor marked with its payout id (charges, refunds, fees). */
  async #payoutMakeup(ws: WorkspaceId, payout: SourceRecord, payoutId: string): Promise<PayoutMakeup> {
    const rows = (await this.#store.listRecords(ws, { entityIds: [payout.entityId as EntityId], eventTypes: ['processor.balance_txn'], ...(payout.sourceAccountId ? { sourceAccountId: payout.sourceAccountId } : {}) }))
      .filter((x) => x.status !== 'void' && x.event.type === 'processor.balance_txn' && x.event.kind !== 'payout' && x.event.payoutExternalId === payoutId)
    const cur = (payout.event as ProcessorBalanceTxn).net.currency
    const sum = (f: (e: ProcessorBalanceTxn) => number, keep: (e: ProcessorBalanceTxn) => boolean = () => true) => money(rows.map((x) => x.event as ProcessorBalanceTxn).filter(keep).reduce((t, e) => t + f(e), 0), cur)
    const charges = rows.filter((x) => (x.event as ProcessorBalanceTxn).kind === 'charge')
    return {
      charges: charges.length,
      chargeIds: charges.map((x) => x.id),
      gross: sum((e) => e.gross.minor, (e) => e.kind === 'charge'),
      refunds: sum((e) => -e.gross.minor, (e) => e.kind === 'refund'),
      fees: sum((e) => e.fee.minor),
      other: sum((e) => e.gross.minor, (e) => e.kind !== 'charge' && e.kind !== 'refund'),
      net: sum((e) => e.net.minor),
    }
  }

  async getRecord(ws: WorkspaceId, id: Id): Promise<RecordView | null> {
    // A fee row is part of its charge: the charge's record shows gross, fee and net.
    if (id.endsWith(FEE_ROW)) return this.getRecord(ws, id.slice(0, -FEE_ROW.length))
    const r = await this.#store.getRecord(ws, id)
    if (r && r.entityId) {
      const c = await this.#ctx({ workspaceId: ws, entityIds: [r.entityId] })
      const links = await this.#store.listLinks(ws, { recordId: id, statuses: ['confirmed', 'proposed'] })
      const o = await this.#store.getOverride(ws, id)
      const entries = await this.#store.activeEntriesForSource(ws, id)
      const ledger = new Map((await this.#store.listLedgerAccounts(ws)).map((a) => [a.id, a]))
      const ev = r.event
      const type: RecordType =
        ev.type === 'txn.upsert' ? (r.origin === 'connector' ? 'transaction' : 'entry') : ev.type === 'processor.balance_txn' ? 'transaction' : ev.type === 'invoice.upsert' ? 'invoice' : ev.type === 'payroll.run' ? 'payroll_run' : ev.type === 'equity.event' ? 'equity_event' : ev.type === 'account.upsert' ? 'account' : 'entry'
      const dataType: DataType =
        ev.type === 'invoice.upsert' ? (ev.direction === 'receivable' ? 'invoices' : 'bills') : ev.type === 'payment.applied' || ev.type === 'credit_note.upsert' ? (ev.direction === 'receivable' ? 'invoices' : 'bills') : ev.type === 'payroll.run' ? 'payroll' : ev.type === 'equity.event' || ev.type === 'investment.event' ? 'equity' : ev.type === 'balance.snapshot' || ev.type === 'account.upsert' ? 'balances' : 'transactions'
      const { connectionId: _c, rawRef: _r, ...data } = ev as typeof ev & { rawRef?: string }
      const audit: RecordView['audit'] = [{ at: r.createdAt, actor: await this.#addedBy(c, r), action: 'added' }]
      if (o) audit.push({ at: o.updatedAt, actor: { kind: o.updatedBy ? 'person' : 'rule', name: o.updatedBy ?? 'Rule' }, action: 'changed', changes: Object.fromEntries(Object.entries(o).filter(([k]) => !['recordId', 'workspaceId', 'updatedAt', 'updatedBy'].includes(k)).map(([k, v]) => [k, { from: null, to: v }])) })
      if (r.updatedAt !== r.createdAt) audit.push({ at: r.updatedAt, actor: await this.#addedBy(c, r), action: r.status === 'void' ? 'voided' : 'updated' })
      return {
        id: r.id,
        type,
        entityId: r.entityId,
        dataType,
        data: {
          ...data,
          ...(ev.type === 'processor.balance_txn' && ev.kind === 'payout' && ev.payoutExternalId ? { payout: await this.#payoutMakeup(ws, r, ev.payoutExternalId) } : {}),
          status: r.status === 'void' ? 'void' : (data as { status?: string }).status ?? r.status,
          ...(o ? { override: { category: o.category, kind: o.kind, forEntityId: o.forEntityId, bucketId: o.bucketId, note: o.note } } : {}),
          entries: entries.map((e) => ({
            id: e.id,
            date: e.date,
            basis: e.basis,
            kind: e.kind,
            entityId: e.entityId,
            lines: e.lines.map((l) => ({ account: ledger.get(l.ledgerAccountId)?.name ?? l.ledgerAccountId, role: ledger.get(l.ledgerAccountId)?.role, debit: money(l.debitMinor, l.currency), credit: money(l.creditMinor, l.currency) })),
          })),
        },
        links: links.map((l) => ({ type: l.type, recordId: l.fromId === id ? l.toId : l.fromId, confirmed: l.status === 'confirmed' })),
        audit,
        addedBy: await this.#addedBy(c, r),
        voided: r.status === 'void',
      }
    }
    const b = await this.#store.getBucket(ws, id)
    if (b) {
      const v = await this.bucket(ws, id)
      return { id, type: 'bucket', entityId: b.entityId, dataType: 'buckets', data: v as unknown as Record<string, unknown>, links: [], audit: [{ at: b.createdAt, actor: v?.addedBy ?? { kind: 'person', name: 'Someone' }, action: 'added' }], addedBy: v?.addedBy ?? { kind: 'person', name: 'Someone' }, voided: Boolean(b.archivedAt) }
    }
    const rule = await this.#store.getRule(ws, id)
    if (rule) {
      const entityId = rule.conditions.entityIds?.[0] ?? rule.actions.forEntityId
      if (!entityId) return null
      const by: AddedBy = rule.origin === 'agent' ? { kind: 'agent', name: 'AI' } : rule.origin === 'learned' ? { kind: 'rule', name: 'Suggested from repeats' } : { kind: 'person', name: 'Someone' }
      return { id, type: 'rule', entityId, dataType: 'transactions', data: { name: rule.name, conditions: rule.conditions, actions: rule.actions, status: rule.status, hitCount: rule.hitCount }, links: [], audit: [{ at: rule.createdAt, actor: by, action: 'added' }], addedBy: by, voided: rule.status === 'disabled' || rule.status === 'rejected' }
    }
    const acc = await this.#dir.getSourceAccount(ws, id)
    if (acc?.entityId) {
      return { id, type: 'account', entityId: acc.entityId, dataType: 'balances', data: { ...acc }, links: [], audit: [], addedBy: { kind: 'sync', name: acc.institution ?? acc.name }, voided: false }
    }
    return null
  }

  // ---------- counterparties, upcoming, owner money ----------

  async counterparty(scope: ReadScope, nameOrId: string): Promise<CounterpartyView | null> {
    const key = merchantKey(nameOrId.startsWith('cp:') ? nameOrId.slice(3) : nameOrId)
    if (key.length < 2) return null
    const matches = (s: string | undefined): boolean => !!s && (merchantKey(s) === key || merchantKey(s).includes(key) || nameSimilarity(key, s) >= 0.85)
    const txns = await this.searchTransactions(scope, { limit: 10_000 })
    const mine = txns.rows.filter((t) => t.status !== 'void' && matches(t.counterparty ?? t.rawText))
    const invoices = (await this.#invoiceViews(scope, await todayFor(this.engine.metricContext(scope.workspaceId)))).filter((v) => matches(v.counterparty))
    if (mine.length === 0 && invoices.length === 0) return null
    const year = `${(await todayFor(this.engine.metricContext(scope.workspaceId))).slice(0, 4)}-01-01`
    const out = (rows: TxnView[]) => sumByCurrency(rows.filter((t) => t.amount.minor < 0).map((t) => money(-t.amount.minor, t.amount.currency)))
    const inn = (rows: TxnView[]) => sumByCurrency(rows.filter((t) => t.amount.minor > 0).map((t) => t.amount))
    const ytd = mine.filter((t) => t.date >= year)
    // Average days from invoice date to the payment that settled it.
    const days: number[] = []
    for (const inv of invoices.filter((v) => v.direction === 'receivable')) {
      for (const l of await this.#store.listLinks(scope.workspaceId, { recordId: inv.id, types: ['invoice_payment'], statuses: ['confirmed'] })) {
        const pay = await this.#store.getRecord(scope.workspaceId, l.toId)
        if (pay) days.push(daysBetween(inv.issueDate, pay.date))
      }
    }
    const name = mine[0]?.counterparty ?? invoices[0]?.counterparty ?? nameOrId
    return {
      id: `cp:${key}`,
      name,
      entityIds: [...new Set([...mine.map((t) => t.entityId), ...invoices.map((v) => v.entityId)])].sort(),
      paidToThemYtd: out(ytd),
      receivedFromThemYtd: inn(ytd),
      paidToThemAllTime: out(mine),
      receivedFromThemAllTime: inn(mine),
      openInvoices: invoices.filter((v) => ['open', 'partially_paid', 'overdue', 'disputed'].includes(v.status)),
      lastPayments: mine.slice(0, 5),
      averageDaysToPay: days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null,
    }
  }

  async upcoming(scope: ReadScope, days: number, kinds?: UpcomingItem['kind'][]): Promise<UpcomingItem[]> {
    const ws = scope.workspaceId
    const start = await todayFor(this.engine.metricContext(ws))
    const end = addDays(start, Math.max(0, Math.min(days, 366)))
    const want = (k: UpcomingItem['kind']) => !kinds || kinds.includes(k)
    const out: UpcomingItem[] = []
    const rc = this.#rc(ws)
    for (const dir of ['payable', 'receivable'] as const) {
      const kind = dir === 'payable' ? 'bill' : 'expected_income'
      if (!want(kind)) continue
      for (const it of await openItems(rc, scope.entityIds, dir, start)) {
        if (!it.dueDate || it.dueDate > end) continue
        // A customer more than OVERDUE_INCOME_DAYS late isn't income to expect today (43's e2e: $134,950 of 90+-day
        // receivables listed under today made "expected in the next 30 days" wrong). They stay in receivables and aging.
        // A late bill you owe is still due now.
        if (dir === 'receivable' && it.dueDate < addDays(start, -OVERDUE_INCOME_DAYS)) continue
        const inv = it.record.event as InvoiceUpsert
        out.push({ date: it.dueDate < start ? start : it.dueDate, entityId: it.record.entityId as EntityId, kind, what: `${inv.number ? `${inv.number} ` : ''}${inv.counterparty}`, amount: money(it.remainingMinor, it.currency), confidence: 'scheduled', recordId: it.record.id })
      }
    }
    if (want('payroll')) {
      for (const r of await this.#store.listRecords(ws, { entityIds: scope.entityIds, eventTypes: ['payroll.run'], fromDate: start, toDate: end })) {
        if (r.event.type !== 'payroll.run' || r.event.status !== 'scheduled') continue
        out.push({ date: r.date, entityId: r.entityId as EntityId, kind: 'payroll', what: 'Payroll', amount: r.event.companyDebit ?? money(r.event.gross.minor + r.event.employerTaxes.minor, r.event.gross.currency), confidence: 'scheduled', recordId: r.id })
      }
    }
    if (want('bucket_schedule')) {
      for (const b of await this.#store.listBuckets(ws, scope.entityIds)) {
        if (b.archivedAt || !b.schedule) continue
        const v = await bucketView(rc, b, start)
        for (const o of v.occurrences) {
          if (o.status !== 'upcoming' || o.dueDate < start || o.dueDate > end) continue
          out.push({ date: o.dueDate, entityId: b.entityId, kind: 'bucket_schedule', what: b.name, amount: money(b.schedule.direction === 'out' ? -o.expected.minor : o.expected.minor, o.expected.currency), confidence: 'scheduled', recordId: b.id })
        }
      }
    }
    if (want('subscription')) {
      const records = await this.#store.listRecords(ws, { entityIds: scope.entityIds, eventTypes: ['txn.upsert'], statuses: ['posted'], fromDate: addDays(start, -400), toDate: start })
      for (const s of detectRecurring(records, start)) {
        const step = s.cadence === 'weekly' ? 7 : s.cadence === 'biweekly' ? 14 : 0
        let next = step ? addDays(s.lastDate, step) : addMonths(s.lastDate, s.cadence === 'monthly' ? 1 : s.cadence === 'quarterly' ? 3 : 12)
        while (next < start) next = step ? addDays(next, step) : addMonths(next, s.cadence === 'monthly' ? 1 : s.cadence === 'quarterly' ? 3 : 12)
        if (next > end) continue
        const last = records.find((r) => r.id === s.recordIds[s.recordIds.length - 1])
        out.push({ date: next, entityId: last?.entityId as EntityId, kind: 'subscription', what: s.label, amount: money(-Math.abs((last?.amount?.minor ?? 0)), s.currency), confidence: 'recurring_detected' })
      }
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.what < b.what ? -1 : 1))
  }

  async ownerBalances(scope: ReadScope, personId: PersonId): Promise<OwnerBalanceView[]> {
    const ws = scope.workspaceId
    const entities = await this.#dir.listEntities(ws)
    const personal = entities.find((e) => e.kind === 'personal' && e.ownerPersonId === personId)
    if (!personal) return []
    const ledger = await this.#store.listLedgerAccounts(ws, scope.entityIds)
    const out: OwnerBalanceView[] = []
    for (const c of entities.filter((e) => e.kind === 'company' && scope.entityIds.includes(e.id))) {
      const payable = ledger.find((a) => a.entityId === c.id && a.role === `owner_payable:${personal.id}`)
      const unspecified = ledger.find((a) => a.entityId === c.id && a.role === 'owner_money_unspecified')
      const contrib = ledger.find((a) => a.entityId === c.id && a.role === 'owner_contributions')
      const ids = [payable, unspecified, contrib].filter((a): a is LedgerAccount => Boolean(a)).map((a) => a.id)
      if (ids.length === 0) continue
      const lines = await this.#store.listLines(ws, { entityIds: [c.id], basis: 'cash', ledgerAccountIds: ids })
      const sum = (acct: LedgerAccount | undefined, pred: (kind: string) => boolean = () => true) =>
        acct ? -lines.filter((l) => l.ledgerAccountId === acct.id && pred(l.kind)).reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0) : 0
      const balance = sum(payable)
      const loans = sum(payable, (k) => k === 'owner_loan')
      out.push({
        personId,
        entityId: c.id,
        balance: money(balance, c.baseCurrency),
        loans: money(loans, c.baseCurrency),
        contributions: money(sum(contrib), c.baseCurrency),
        unreimbursedExpenses: money(balance - loans, c.baseCurrency),
        unspecified: money(sum(unspecified), c.baseCurrency),
        rowIds: [...new Set(lines.map((l) => l.sourceId))],
      })
    }
    return out
  }

  // ---------- buckets ----------

  async #bucketView(ws: WorkspaceId, b: Bucket): Promise<BucketView> {
    const v: CoreBucketView = await bucketView(this.engine.metricContext(ws), b, await todayFor(this.engine.metricContext(ws)))
    const rules = (await this.#store.listRules(ws)).filter((r) => r.actions.bucketId === b.id && r.status === 'active')
    const count = (s: string) => v.occurrences.filter((o) => o.status === s).length
    const setAside = await setAsideView(this.engine.metricContext(ws), b, await todayFor(this.engine.metricContext(ws)))
    const cadence = b.schedule ? ({ weekly: 'weekly', biweekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', annual: 'yearly' } as const)[b.schedule.cadence] : null
    const addedBy: AddedBy =
      b.origin === 'agent'
        ? { kind: 'agent', name: 'AI' }
        : b.origin === 'connector'
          ? { kind: 'sync', name: 'Sync' }
          : { kind: 'person', name: (b.createdBy ? await this.providers.names?.(ws, b.createdBy) : null) ?? 'Someone' }
    return {
      id: b.id,
      entityId: b.entityId,
      name: b.name,
      fields: b.fields.map((f) => ({ key: f.key, label: f.label, type: f.type === 'select' ? 'text' : f.type })),
      values: b.values,
      schedule: b.schedule && cadence ? { amount: b.schedule.amount, cadence, ...(b.schedule.dueDay ? { dueDay: b.schedule.dueDay } : {}), ...(b.schedule.endDate ? { endDate: b.schedule.endDate } : {}) } : null,
      rules: rules.map((r) => ({ id: r.id, description: r.name })),
      status: { paid: count('paid') + count('partial'), upcoming: count('upcoming'), missed: count('missed') },
      payments: [
        ...v.payments.map((p) => ({ date: p.date, amount: p.amount, state: 'paid' as const, txnId: p.recordId })),
        ...v.occurrences.filter((o) => o.status === 'upcoming' || o.status === 'missed').map((o) => ({ date: o.dueDate, amount: o.expected, state: o.status as 'upcoming' | 'missed' })),
      ].sort((a, b2) => (a.date < b2.date ? -1 : 1)),
      ...(setAside ? { setAside, createdOn: b.createdAt.slice(0, 10) } : {}),
      addedBy,
    }
  }

  async buckets(scope: ReadScope): Promise<BucketView[]> {
    return this.#cached(scope.workspaceId, `buckets|${[...scope.entityIds].sort().join(',')}`, () => this.#buckets(scope))
  }

  async #buckets(scope: ReadScope): Promise<BucketView[]> {
    const out: BucketView[] = []
    for (const b of await this.#store.listBuckets(scope.workspaceId, scope.entityIds)) if (!b.archivedAt) out.push(await this.#bucketView(scope.workspaceId, b))
    return out
  }

  async bucket(ws: WorkspaceId, id: Id): Promise<BucketView | null> {
    const b = await this.#store.getBucket(ws, id)
    return b ? this.#bucketView(ws, b) : null
  }

  /** "Anything odd" for the company drawer (not yet in the FinanceReader contract; S8 reads it through the server). */
  async anomalies(scope: ReadScope, asOf?: IsoDate): Promise<Anomaly[]> {
    const all = await this.#cached(scope.workspaceId, `anomalies|${[...scope.entityIds].sort().join(',')}|${asOf ?? ''}`, () => this.engine.anomalies(scope.workspaceId, { entityIds: scope.entityIds, ...(asOf ? { asOf } : {}) }))
    return all.filter((a) => scope.entityIds.includes(a.entityId))
  }

  // ---------- delegated / payroll / review / documents / reports ----------

  /**
   * Investment positions as of a day (default today), from their investment.event records: cost, value (latest
   * mark, else the cost still in it), money back, MOIC. Same arithmetic as posting (posting.ts costBefore).
   */
  async investments(scope: ReadScope, asOf?: IsoDate): Promise<InvestmentView[]> {
    return (await this.#positions(scope, asOf)).map((p) => p.view)
  }

  /**
   * Totals per company and currency over the same positions (investments()): one definition for the page and
   * get_investments. MOIC from the sums, over positions whose MOIC is known, to 2 places. Largest invested first.
   */
  async investmentTotals(scope: ReadScope, asOf?: IsoDate): Promise<InvestmentTotals[]> {
    const rows = new Map<string, { t: InvestmentTotals; mi: number; mv: number }>()
    for (const { view: v, writtenOff } of await this.#positions(scope, asOf)) {
      const key = `${v.entityId}|${v.invested.currency}`
      const cur = v.invested.currency
      const r = rows.get(key) ?? { t: { entityId: v.entityId, currency: cur, positions: 0, active: 0, invested: money(0, cur), value: money(0, cur), distributed: money(0, cur), writtenOff: money(0, cur), moic: null, moicExcludes: 0 }, mi: 0, mv: 0 }
      r.t.positions++
      if (v.status === 'active') r.t.active++
      r.t.invested = money(r.t.invested.minor + v.invested.minor, cur)
      r.t.value = money(r.t.value.minor + v.value.minor, cur)
      r.t.distributed = money(r.t.distributed.minor + v.distributed.minor, cur)
      r.t.writtenOff = money(r.t.writtenOff.minor + writtenOff, cur)
      if (v.moic !== null) {
        r.mi += v.invested.minor
        r.mv += v.value.minor + v.distributed.minor
      } else if (v.status === 'exited' && v.invested.minor > 0) r.t.moicExcludes++
      rows.set(key, r)
    }
    return [...rows.values()]
      .map(({ t, mi, mv }) => ({ ...t, moic: mi > 0 ? Math.round((mv / mi) * 100) / 100 : null }))
      .sort((a, b) => b.invested.minor - a.invested.minor || a.currency.localeCompare(b.currency))
  }

  /** Each position as of the day, with the cost it wrote off (for the totals). */
  async #positions(scope: ReadScope, asOf?: IsoDate): Promise<Array<{ view: InvestmentView; writtenOff: number }>> {
    const ws = scope.workspaceId
    const day = asOf ?? (await todayFor(this.engine.metricContext(ws)))
    const recs = (await this.#store.listRecords(ws, { entityIds: scope.entityIds, eventTypes: ['investment.event'], statuses: ['posted'], toDate: day })).filter((r) => r.entityId && r.event.type === 'investment.event')
    const byPos = new Map<string, SourceRecord[]>()
    for (const r of recs) {
      const key = `${r.entityId}|${(r.event as InvestmentEvent).positionId}`
      byPos.set(key, [...(byPos.get(key) ?? []), r])
    }
    const out: Array<{ view: InvestmentView; writtenOff: number }> = []
    const keyOf = recs.length ? new Map((await this.#dir.listConnections(ws)).map((c) => [c.id, c.connectorKey])) : new Map<string, string>()
    for (const rows of byPos.values()) {
      rows.sort(positionOrder)
      const platform = INVESTMENT_SOURCES[keyOf.get(rows[0]?.connectionId ?? '') ?? '']
      const evs = rows.map((r) => r.event as InvestmentEvent)
      // The position's own page when the connector gave one on the platform's site; else the platform's portfolio page.
      const own = platform && [...evs].reverse().find((e) => e.sourceUrl && onSite(e.sourceUrl, platform.url))?.sourceUrl
      const source = platform && own ? { ...platform, url: own } : platform
      const first = evs.find((e) => e.kind === 'invest' && e.amount) ?? (evs[0] as InvestmentEvent)
      const cur = first.amount?.currency ?? 'USD'
      let invested = 0
      let cost = 0
      let distributed = 0
      let shares: number | undefined
      let mark: { minor: number; date: IsoDate } | null = null
      let status: InvestmentView['status'] = 'active'
      // Left without money (in kind, transferred): what it returned isn't known, so neither is its multiple.
      let inKind = false
      let writtenOff = 0
      let terms = { securityType: first.securityType, series: first.series, valuationCap: first.valuationCap, discountPct: first.discountPct }
      for (const e of evs) {
        const a = e.amount?.minor ?? 0
        if (e.kind === 'invest') {
          invested += a
          cost += a
          if (e.shares !== undefined) shares = (shares ?? 0) + e.shares
        } else if (e.kind === 'distribution') {
          distributed += a
          cost -= Math.min(a, cost)
        } else if (e.kind === 'exit') {
          distributed += a
          if (!e.amount) inKind = true
          cost = 0
          status = 'exited'
        } else if (e.kind === 'write_off') {
          writtenOff += cost
          cost = 0
          status = 'written_off'
        } else if (e.kind === 'mark') {
          mark = { minor: a, date: e.date }
        } else if (e.kind === 'convert') {
          terms = { securityType: e.securityType, series: e.series ?? terms.series, valuationCap: undefined, discountPct: undefined }
          if (e.shares !== undefined) shares = e.shares
        }
      }
      const value = status !== 'active' ? 0 : mark ? mark.minor : cost
      const valueSource: InvestmentView['valueSource'] = status === 'exited' ? 'exited' : status === 'written_off' ? 'written_off' : mark ? 'mark' : 'cost'
      out.push({ writtenOff, view: {
        positionId: first.positionId,
        entityId: rows[0]?.entityId as EntityId,
        issuer: first.issuer,
        securityType: terms.securityType,
        ...(terms.series ? { series: terms.series } : {}),
        firstInvested: (rows.find((r) => (r.event as InvestmentEvent).kind === 'invest') ?? rows[0])?.date as IsoDate,
        invested: money(invested, cur),
        ...(shares !== undefined ? { shares } : {}),
        ...(terms.valuationCap ? { valuationCap: terms.valuationCap } : {}),
        ...(terms.discountPct !== undefined ? { discountPct: terms.discountPct } : {}),
        value: money(value, cur),
        valueSource,
        ...(mark && status === 'active' ? { markedAt: mark.date } : {}),
        distributed: money(distributed, cur),
        moic: invested > 0 && !inKind ? Math.round(((value + distributed) / invested) * 100) / 100 : null,
        status,
        recordIds: rows.map((r) => r.id),
        ...(source ? { source } : {}),
      } })
    }
    return out.sort(({ view: a }, { view: b }) => (a.firstInvested < b.firstInvested ? -1 : a.firstInvested > b.firstInvested ? 1 : a.issuer.localeCompare(b.issuer)))
  }

  async capTable(scope: ReadScope): Promise<CapTableView[]> {
    return (await this.providers.equity?.capTable(scope)) ?? []
  }

  async payroll(scope: ReadScope, opts: { from?: IsoDate; to?: IsoDate; people: boolean }): Promise<PayrollView[]> {
    const ws = scope.workspaceId
    const out: PayrollView[] = []
    const asOf = await todayFor(this.engine.metricContext(ws))
    for (const entityId of scope.entityIds) {
      const recs = (await this.#store.listRecords(ws, { entityIds: [entityId], eventTypes: ['payroll.run'], ...(opts.from ? { fromDate: opts.from } : {}), ...(opts.to ? { toDate: opts.to } : {}) })).filter(
        (r) => r.event.type === 'payroll.run' && r.status !== 'void' && r.event.status !== 'scheduled',
      )
      // A bank-detected estimate is superseded by a reported run (provider or register) within ±5 days.
      const reported = recs.filter((r) => r.event.type === 'payroll.run' && !(r.event.estimated || r.event.source === 'bank_detected'))
      const kept = recs.filter((r) => {
        const ev = r.event as Extract<SourceRecord['event'], { type: 'payroll.run' }>
        if (!(ev.estimated || ev.source === 'bank_detected')) return true
        return !reported.some((x) => Math.abs(daysBetween(x.date, r.date)) <= 5)
      })
      recs.splice(0, recs.length, ...kept)
      if (recs.length === 0) continue
      const runs = recs.map((r) => {
        const ev = r.event as Extract<SourceRecord['event'], { type: 'payroll.run' }>
        return {
          id: r.id,
          payDate: r.date,
          gross: ev.gross,
          employerTaxes: ev.employerTaxes,
          net: ev.net,
          employerCost: money(ev.gross.minor + ev.employerTaxes.minor + (ev.employerBenefits?.minor ?? 0), ev.gross.currency),
          estimated: Boolean(ev.estimated || ev.source === 'bank_detected'),
        }
      })
      const latest = recs[recs.length - 1]?.event as Extract<SourceRecord['event'], { type: 'payroll.run' }>
      const people = latest.lines ?? []
      out.push({
        entityId,
        runs: runs.sort((a, b) => (a.payDate > b.payDate ? -1 : 1)),
        nextRun: await this.#nextPayroll(ws, entityId, asOf),
        headcount: latest.employeeCount ?? (people.length ? people.filter((p) => p.kind === 'employee').length : null),
        contractors: people.length ? people.filter((p) => p.kind === 'contractor').length : null,
        ...(opts.people && people.length ? { people: people.map((p) => ({ person: p.person, kind: p.kind, gross: p.gross, net: p.net })) } : {}),
      })
    }
    return out
  }

  async filedItems(scope: ReadScope): Promise<Array<{ id: string; entityId: EntityId | null; text: string; filedAt: IsoTimestamp }>> {
    return this.engine.filedItems(scope.workspaceId, { entityIds: scope.entityIds })
  }

  async reviewItems(scope: ReadScope, kinds?: ReviewItemView['kind'][]): Promise<ReviewItemView[]> {
    const ws = scope.workspaceId
    const items = await listReviewItems(this.engine.metricContext(ws), { entityIds: scope.entityIds })
    const out: ReviewItemView[] = []
    for (const it of items) {
      if (it.kind === 'which_company') {
        // Workspace-level (the account has no company yet); callers show it only to people who manage connections.
        if (kinds && !kinds.includes('which_company')) continue
        out.push({ id: it.id, entityId: null, ...(it.accountId ? { accountId: it.accountId } : {}), ...(it.connectionId ? { connectionId: it.connectionId } : {}), ...(it.suggested ? { suggested: it.suggested } : {}), kind: 'which_company', title: it.title, detail: it.detail, createdAt: this.engine.now(), recordIds: it.recordIds, options: ['edit'] })
        continue
      }
      if (!it.entityId || !scope.entityIds.includes(it.entityId)) continue
      let kind: ReviewItemView['kind']
      let options: ReviewItemView['options']
      let createdAt = this.engine.now()
      if (it.kind === 'suggested_match') {
        const link = it.linkId ? await this.#store.getLink(ws, it.linkId) : null
        kind = link?.type === 'duplicate' ? 'possible_duplicate' : 'suggested_match'
        options = ['confirm', 'reject']
        createdAt = link?.createdAt ?? createdAt
      } else if (it.kind === 'suggested_rule') {
        kind = 'suggested_rule'
        options = ['confirm', 'reject']
        createdAt = (it.ruleId ? (await this.#store.getRule(ws, it.ruleId))?.createdAt : null) ?? createdAt
      } else if (it.kind === 'owner_money' || it.kind === 'unexplained_money') {
        kind = 'whose_money'
        options = ['edit']
        createdAt = (await this.#store.getRecord(ws, it.recordIds[0] as Id))?.createdAt ?? createdAt
      } else if (it.kind === 'underfunded_set_aside') {
        // Nothing to answer: it clears when the balance or the set-aside changes.
        kind = 'underfunded_set_aside'
        options = []
      } else continue
      if (kinds && !kinds.includes(kind)) continue
      const words = (i: ReviewItem) => ({ ...(i.question ? { question: i.question } : {}), ...(i.questionNames ? { questionNames: i.questionNames } : {}), ...(i.confirmLabel ? { confirmLabel: i.confirmLabel } : {}), ...(i.rejectLabel ? { rejectLabel: i.rejectLabel } : {}) })
      out.push({
        id: it.id,
        entityId: it.entityId,
        kind,
        title: it.title,
        detail: it.detail,
        createdAt,
        recordIds: it.recordIds,
        options,
        ...words(it),
        ...(it.group ? { group: it.group } : {}),
        ...(it.alternatives ? { alternatives: it.alternatives.map((a) => ({ id: a.id, entityId: a.entityId, kind, title: a.title, detail: a.detail, createdAt, recordIds: a.recordIds, options, ...words(a) })) } : {}),
        ...(it.choices?.length ? { choices: it.choices } : {}),
      })
    }
    return out
  }

  async coverage(scope: ReadScope, from?: string, to?: string): Promise<CoverageView[]> {
    return this.engine.coverage(scope.workspaceId, { entityIds: scope.entityIds, ...(from ? { from } : {}), ...(to ? { to } : {}) })
  }

  async mrrMovements(scope: ReadScope, from: string, to: string): Promise<MrrMovementView[]> {
    return this.engine.mrrMovements(scope.workspaceId, { entityIds: scope.entityIds, from, to })
  }

  async periodLocks(scope: ReadScope): Promise<PeriodLockView[]> {
    return (await this.engine.periodLocks(scope.workspaceId)).filter((l) => scope.entityIds.includes(l.entityId)).map((l) => ({ entityId: l.entityId, through: l.through, note: l.note, createdAt: l.createdAt }))
  }

  async documents(scope: ReadScope, status?: DocumentView['status']): Promise<DocumentView[]> {
    return (await this.providers.documents?.list(scope, status)) ?? []
  }

  async document(ws: WorkspaceId, id: Id): Promise<DocumentView | null> {
    return (await this.providers.documents?.get(ws, id)) ?? null
  }

  async reports(scope: ReadScope, kind: ReportView['kind'], from: IsoDate, to: IsoDate, basis: 'cash' | 'accrual'): Promise<ReportView[]> {
    const rc = this.engine.metricContext(scope.workspaceId)
    const rows = (s: ReportSection) => ({ name: s.title, rows: s.lines.map((l) => ({ account: l.name, amount: l.amount, role: l.role })), total: s.total })
    const out: ReportView[] = []
    for (const entityId of scope.entityIds) {
      if (kind === 'profit_and_loss') {
        const p = await profitAndLoss(rc, { entityIds: [entityId], from, to, basis })
        const sections = [p.revenue, p.costOfRevenue, p.operatingExpenses, p.other]
        let noData: string | undefined
        if (sections.every((s) => !s.lines.length)) {
          // Invoice-only books on cash basis: the accrual P&L has lines, nothing was paid yet.
          const other = basis === 'cash' ? await profitAndLoss(rc, { entityIds: [entityId], from, to, basis: 'accrual' }) : null
          const accrualHas = other && [other.revenue, other.costOfRevenue, other.operatingExpenses, other.other].some((s) => s.lines.length)
          noData = accrualHas ? 'No cash-basis activity in this period: there are invoices or bills, but nothing was paid in or out. The accrual basis shows them.' : 'No income or expenses posted in this period.'
        }
        out.push({ kind, entityId, from, to, basis, currency: p.currency, sections: sections.map(rows), total: p.netIncome, ...(noData ? { noData } : {}) })
      } else if (kind === 'balance_sheet') {
        const b = await balanceSheet(rc, { entityIds: [entityId], asOf: to, basis })
        const noData = [b.assets, b.liabilities, b.equity].every((s) => !s.lines.length) ? `Nothing posted on or before ${to}.` : undefined
        out.push({ kind, entityId, from, to, basis, currency: b.currency, sections: [rows(b.assets), rows(b.liabilities), rows(b.equity)], total: b.assets.total, ...(noData ? { noData } : {}) })
      } else {
        const c = await cashFlow(rc, { entityIds: [entityId], from, to })
        const extra = { name: 'Summary', rows: [{ account: 'Opening cash and cards', amount: c.opening }, { account: 'Money in transit', amount: c.inTransit }, { account: 'Currency effect', amount: c.fxEffect }, { account: 'Closing cash and cards', amount: c.closing }], total: c.closing }
        const still = [c.operating, c.investing, c.financing].every((s) => !s.lines.length) && c.opening.minor === 0 && c.closing.minor === 0
        const noData = still ? 'No cash or card activity in this period.' : undefined
        out.push({ kind, entityId, from, to, basis: 'cash', currency: c.currency, sections: [rows(c.operating), rows(c.investing), rows(c.financing), extra], total: c.closing, ...(noData ? { noData } : {}) })
      }
    }
    return out
  }
}

/** Ids per categories read, well under SQLite's parameter limit. */
const CATEGORY_CHUNK = 500

/** Overview figures that are unknown or stale, with the reason (the figure itself shows 0 or the last known value). */
function noDataOf(figures: Record<'owedToYou' | 'billsDue30d', MetricAnswer>): { noData?: NonNullable<OverviewEntity['noData']> } {
  const out = (Object.keys(figures) as Array<keyof typeof figures>).filter((f) => figures[f].state === 'no_data')
  return out.length ? { noData: out } : {}
}

function caveatsOf(figures: Record<'cash' | 'cardDebt' | 'netBurn3mo' | 'runwayMonths', MetricAnswer>): { caveats?: NonNullable<OverviewEntity['caveats']> } {
  const out: NonNullable<OverviewEntity['caveats']> = []
  for (const [figure, a] of Object.entries(figures) as Array<[keyof typeof figures, MetricAnswer]>) {
    if (a.state === 'unknown' || a.state === 'stale') out.push({ figure, state: a.state, reason: a.unknownReason ?? '' })
  }
  return out.length ? { caveats: out } : {}
}

/** What a bank or processor row says about itself, before categories and links. */
function txnBasics(r: SourceRecord): { amount: Money; counterparty: string | undefined; rawText: string | undefined; status: TxnView['status'] } | null {
  const ev = r.event
  if (ev.type === 'txn.upsert') return { amount: ev.amount, counterparty: ev.counterparty, rawText: ev.rawText, status: r.status === 'void' ? 'void' : ev.status }
  if (ev.type === 'processor.balance_txn') {
    return { amount: processorFee(r) ? ev.gross : ev.net, counterparty: ev.counterparty ?? ev.customer, rawText: ev.description ?? ev.kind, status: r.status === 'void' ? 'void' : 'posted' }
  }
  return null
}

/**
 * A payout's makeup (get_record on a processor payout): its charges at gross, refunds, fees and other rows
 * (disputes, adjustments) at gross; net = gross − refunds − fees + other, which the payout paid out.
 */
export interface PayoutMakeup {
  charges: number
  chargeIds: Id[]
  gross: Money
  refunds: Money
  fees: Money
  other: Money
  net: Money
}

/** A fee row's id: its charge's id plus this suffix. Never a stored record; writes to it are refused. */
export const FEE_ROW = ':fee'

/**
 * A processor row with a fee lists as two rows that add up to its net, as the P&L counts them: the charge (or
 * refund) at gross, and the fee on its own (kind fee, category processor_fees). Summing rows then gives gross sales,
 * and fees can be found. Returns the fee row's amount, or null when the row has no fee to split off.
 */
function processorFee(r: SourceRecord): Money | null {
  const ev = r.event
  if (ev.type !== 'processor.balance_txn' || ev.fee.minor === 0 || ev.gross.minor === 0) return null
  return { minor: -ev.fee.minor, currency: ev.fee.currency }
}

/** `together(prev, next)`: rows a page must not split (a charge and its fee row); the page grows by one instead. */
function page<T>(rows: T[], limit: number, cursor?: string, together?: (prev: T, next: T) => boolean): { rows: T[]; totalCount: number; nextCursor: string | null } {
  const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0
  let end = start + Math.max(1, Math.min(limit || 50, 10_000))
  if (together && end < rows.length && end > start && together(rows[end - 1] as T, rows[end] as T)) end++
  return { rows: rows.slice(start, end), totalCount: rows.length, nextCursor: end < rows.length ? String(end) : null }
}

export { monthStart }

/** Posted bank and card rows for an entity since a date (e.g. for payroll detection), as the connectors sent them. */
export async function bankRows(engine: LedgerEngine, ws: WorkspaceId, entityId: EntityId, since: IsoDate): Promise<Array<TxnUpsertWithId>> {
  const recs = await engine.store.listRecords(ws, { entityIds: [entityId], eventTypes: ['txn.upsert'], statuses: ['posted'], fromDate: since })
  return recs.filter((r) => r.event.type === 'txn.upsert').map((r) => ({ ...(r.event as Extract<SourceRecord['event'], { type: 'txn.upsert' }>), recordId: r.id }))
}

export type TxnUpsertWithId = Extract<SourceRecord['event'], { type: 'txn.upsert' }> & { recordId: Id }

/**
 * The directory for one read request: entities, reporting currency, accounts and connections are read once however
 * many metrics ask (an overview asked ~33 times each). Reads only; anything else goes to the real directory.
 */
function requestDirectory(dir: AccountDirectory): AccountDirectory {
  const once = new Map<string, Promise<unknown>>()
  const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    let p = once.get(key) as Promise<T> | undefined
    if (!p) {
      p = fn()
      once.set(key, p)
      p.catch(() => once.delete(key))
    }
    return p
  }
  // Every method bound to the real directory (its classes keep private fields), then the reads replaced.
  const d = {} as Record<string, unknown>
  for (let proto = Object.getPrototypeOf(dir); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      const v = (dir as unknown as Record<string, unknown>)[k]
      if (k !== 'constructor' && typeof v === 'function' && !(k in d)) d[k] = (v as (...a: unknown[]) => unknown).bind(dir)
    }
  }
  for (const k of Object.keys(dir)) if (!(k in d)) d[k] = (dir as unknown as Record<string, unknown>)[k]
  return withReads(d as unknown as AccountDirectory, dir, memo)
}

function withReads(d: AccountDirectory, dir: AccountDirectory, memo: <T>(key: string, fn: () => Promise<T>) => Promise<T>): AccountDirectory {
  d.listEntities = (ws) => memo(`entities|${ws}`, () => dir.listEntities(ws)).then((x) => x.map((e) => ({ ...e })))
  d.reportingCurrency = (ws) => memo(`currency|${ws}`, () => dir.reportingCurrency(ws))
  d.listSourceAccounts = (ws) => memo(`accounts|${ws}`, () => dir.listSourceAccounts(ws)).then((x) => x.map((a) => ({ ...a })))
  d.listConnections = (ws) => memo(`connections|${ws}`, () => dir.listConnections(ws)).then((x) => x.map((c) => ({ ...c })))
  d.getEntity = async (ws, id) => (await d.listEntities(ws)).find((e) => e.id === id) ?? null
  return d
}
