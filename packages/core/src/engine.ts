// LedgerEngine: implements the Ledger contract. Posts events idempotently, derives entries with posting.ts,
// keeps links, overrides and rules, and rebuilds affected entries (reverse + repost) whenever an input changes.
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type {
  ListingComplete,
  ListingKind,
  EntityId,
  Id,
  IsoDate,
  SubscriptionUpsert,
  IsoTimestamp,
  Ledger,
  LinkProposal,
  MetricAnswer,
  MetricName,
  MetricScope,
  Money,
  NormalizedEvent,
  PostResult,
  Provenance,
  TxnKind,
  WorkspaceId,
  WriteOrigin,
} from '@agfn/contracts'
import { newId, perfCount } from '@agfn/db'
import { cashRole, defineRole, type SystemRole } from './coa.ts'
import type { BalanceAssertion, PeriodLock, Basis, EntityInfo, EntryBasis, JournalEntry, JournalLine, LedgerAccount, Link, RecordOverride, Rule, SourceAccountInfo, SourceRecord } from './model.ts'
import { convert, impliedRate, NOT_MONEY } from './money.ts'
import { RateUnavailableError } from './fx.ts'
import { changePoints, initialPoints, mrrMovements, nextPoint, type MrrMonth } from './mrr.ts'
import { AUTO_CONFIRM, MATCHER_VERSION, accountPair, findMatchesYielding, type Proposal } from './matching.ts'
import { classifyTxn, fxFits, plan, PostingError, UTILITY_HINT, type Classification, type LinkedRecord, type PlanContext, type PlannedEntry } from './posting.ts'
import { applyRules, suggestRules, validateRule, type RuleSuggestion } from './rules.ts'
import type { AccountDirectory, ConnectionInfo, LedgerStore, RateSource } from './store.ts'
import { validateEvent } from './validate.ts'
import { cashHistory, computeMetric, type CoreMetricAnswer, type MetricContext, type MetricProvider } from './metrics.ts'
import { bucketView, validateFields, validateSchedule, validateValues, type BucketView } from './buckets.ts'
import { runChecks, type CheckOptions, type CheckResult } from './checks.ts'
import { balanceSheet, cashFlow, profitAndLoss, type BalanceSheet, type CashFlow, type ProfitAndLoss } from './reports.ts'
import { listReviewItems, type ReviewItem } from './review.ts'
import { AUTO_FILED, AUTO_STALE, AUTO_UNDONE, filedItems, isFiledLink, planAutoFile, type FiledItem } from './autofile.ts'
import { dataHealth, type DataHealth } from './health.ts'
import { findAnomalies, type Anomaly, type AnomalyOptions } from './anomalies.ts'
import { weeklyDigest as buildDigest, type WeeklyDigest } from './digest.ts'
import { coverage, type AccountCoverage, type CoverageOptions } from './coverage.ts'
import { addDays, forgetZone, today, todayFor, localDate, zoneOf } from './queries.ts'
import type { Bucket, BucketField, BucketSchedule, SetAside } from './model.ts'
import { validateSetAside } from './set-aside.ts'
import { YIELD_EVERY, yieldNow } from './yield.ts'

/** How far apart (days) bank rows can be and still be read together when matching a sync page. */
const MATCH_WINDOW_DAYS = 35
const WINDOWED_TYPES = ['txn.upsert', 'processor.balance_txn'] as const
/** A strong duplicate suggestion holds the copy back until someone answers it, so cash isn't counted twice meanwhile. */
const HOLD_COPY_AT = 0.85
function holdsCopy(l: Link): boolean {
  return l.type === 'duplicate' && l.status === 'proposed' && l.confidence >= HOLD_COPY_AT
}

/**
 * A derived result (checks, review, coverage, overview) is reused for its whole key: until the next write (the
 * version) on the same day (every kept key carries its day). Was 30 minutes, then every machine recomputed idle
 * workspaces (f8's run L tail). Kept rows older than the start of yesterday (UTC) are pruned: a workspace's local day
 * can be up to a day off UTC.
 */
function keepFrom(now: number): string {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1)).toISOString()
}
const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10)
/**
 * Derived results also kept in the database (LedgerStore.putDerived), so a process that starts cold reads them instead
 * of computing them. The costly ones that are plain data; prefixes of #shared keys.
 */
const PERSISTED = ['overview|', 'checks|', 'review|', 'coverage|', 'open|']
/** Overviews computed at once per process when not cached anywhere (f8's run K: a cold machine ran 20, CPU pegged). */
const COLD_BUILDS = 2

/** JSON for a derived result, or null when it isn't plain data (a Map or a Set would come back wrong). */
function plainJson(v: unknown): string | null {
  try {
    return JSON.stringify(v, (_k, x: unknown) => {
      if (x instanceof Map || x instanceof Set) throw new Error('not plain')
      return x
    })
  } catch {
    return null
  }
}
/**
 * Transaction rows kept parsed for searches (Engine.txnRecords): at most this many sets (workspace × companies) and
 * about this many rows in all, per process, least recently used out. Each search used to read and parse the whole
 * ledger (~10k rows, ~20 MB) for itself; demo visitors asking different questions at once ran a 512 MB machine out
 * of heap (f8's run M).
 */
const RECORD_SETS = 3
/** ~2 KB of heap a row: about one demo's worth. A bigger set is served but not kept. */
const RECORD_ROWS = 12_000

/** Each row frozen, a chunk at a time (see yield.ts), then the list. */
async function freezeRows<T>(rows: T[]): Promise<readonly T[]> {
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % YIELD_EVERY === 0) await yieldNow()
    deepFreeze(rows[i])
  }
  return Object.freeze(rows)
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

/** How long one read context reuses the workspace version it read (see #sharedFor). */
const VERSION_REUSE_MS = 2_000

export interface JournalExport {
  id: Id
  entityId: EntityId
  date: IsoDate
  kind: JournalEntry['kind']
  memo: string | null
  /** The record (or opening balance) this entry comes from. */
  sourceId: Id
  lines: Array<{
    account: { id: Id; code: string; name: string; role: string; type: LedgerAccount['type'] }
    debitMinor: number
    creditMinor: number
    currency: string
    baseDebitMinor: number
    baseCreditMinor: number
    memo: string | null
  }>
}

export interface EngineOptions {
  store: LedgerStore
  directory: AccountDirectory
  rates: RateSource
  now?: () => IsoTimestamp
  /** Repeats before a rule is suggested (2 or 3; default 3). */
  ruleSuggestThreshold?: number
  /** Reuse checks and review results until the next write (default true). */
  shareDerived?: boolean
  /** AGFN_SET_ASIDES: runway uses available cash. Off, set-asides change no number (default off). */
  setAsides?: boolean
}

export interface PostOptions {
  origin?: WriteOrigin
  /** Person or grant id when an AI/UI wrote it. */
  createdBy?: string | null
  /** For records on a connection with no company (e.g. "Added by hand"): the company it belongs to. */
  entityId?: EntityId
  provenance?: Provenance
  /**
   * postBatch for one page of a sync: skip matching and opening balances for these rows (each connection is marked
   * unsettled instead); `settle` does them once for the whole sync.
   */
  settleLater?: boolean
}

export class LinkError extends Error {
  override name = 'LinkError'
}

/** Events that never carry an account or entity of their own. */
const INFORMATIONAL = new Set(['report.snapshot', 'ledger_account.upsert', 'subscription.upsert'])

interface Ctx {
  ws: WorkspaceId
  entities: Map<EntityId, EntityInfo>
  accounts: Map<Id, SourceAccountInfo>
  rules: Rule[]
  /** Records whose links were unwound during this operation; matching runs for them again. */
  relink: Set<Id>
  /** When set, opening balances touched by link changes are refreshed once at the end instead of per link. */
  dirty?: Set<Id>
  /** Per account, the earliest day whose entries this operation changed (an opening balance only moves for changes on or before its snapshot). */
  dirtyFrom?: Map<Id, string>
  /** The workspace's time zone: which day an instant (a balance read, a processor row) belongs to. */
  timeZone: string
  /** Connections removed with their data in this operation: their records stay out. */
  removed?: Set<Id>
  /** Whether each connection seen in this operation is disconnected (late rows of a sync that was running then). */
  gone?: Map<Id, boolean>
  booksStart?: Map<EntityId, IsoDate | null>
  /** Investment positions being re-planned in this operation (entity|position), and their issuers (account names). */
  positionsReposting?: Set<string>
  issuers?: Map<string, string>
  /** What this context was built from (shared by writes nested in one transaction). */
  base?: CtxBase
  /** Last closed day per company: changes on or before it post on the day after. */
  locks: Map<EntityId, IsoDate>
  /** Ledger accounts found or created during this operation, by entity and role. */
  ledgerAccounts?: Map<string, LedgerAccount>
  /** Active entries per source as this operation last wrote or read them (a new record starts with none). */
  entries?: Map<Id, JournalEntry[]>
  /** Records created in this operation that no link touches yet: no links, override or entries to read. */
  unlinked?: Set<Id>
  /** Records already stored for this page's events, by connection|type|externalId (null = new). */
  existing?: Map<string, SourceRecord | null>
  /** Rules applied in this operation to records it created (which had none before): no read to know them. */
  ruleApplied?: Map<Id, Set<string>>
}

export class LedgerEngine implements Ledger {
  readonly store: LedgerStore
  readonly directory: AccountDirectory
  readonly rates: RateSource
  readonly #tx = new AsyncLocalStorage<TxState>()
  readonly #stats: StatsState = {}
  readonly now: () => IsoTimestamp
  readonly ruleSuggestThreshold: number
  /** Metrics other slices provide (e.g. fully_diluted from the equity module). */
  readonly metricProviders = new Map<string, MetricProvider>()
  /** Serializes writes per workspace inside this process (SQLite has one writer; Postgres workers lease per workspace). */
  #locks = new Map<WorkspaceId, Promise<unknown>>()
  #derived = new Map<WorkspaceId, { version: number; at: number; values: Map<string, Promise<unknown>> }>()
  readonly #shareDerived: boolean
  readonly #setAsides: boolean
  #records = new Map<string, { version: number; rows: number; value: Promise<readonly SourceRecord[]> }>()

  constructor(opts: EngineOptions) {
    this.store = opts.store
    this.directory = opts.directory
    this.rates = opts.rates
    this.now = opts.now ?? (() => new Date().toISOString())
    this.ruleSuggestThreshold = opts.ruleSuggestThreshold ?? 3
    this.#shareDerived = opts.shareDerived ?? true
    this.#setAsides = opts.setAsides ?? false
  }

  /**
   * One database transaction that never waits on the network: inside it, FX rates come from the cache only. A rate
   * a posting can't do without rolls the transaction back, is fetched outside, and the work runs again; rates that
   * matching merely skipped are fetched after commit (one ranged request per currency pair) for next time.
   * Nested calls join the outer transaction.
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#tx.getStore()) return fn()
    for (let attempt = 0; ; attempt++) {
      const state: TxState = { missing: new Map() }
      try {
        const out = await this.#tx.run(state, () => this.store.transaction(fn))
        if (state.missing.size > 0) await this.rates.prefetch?.([...state.missing.values()]).catch(() => undefined)
        return out
      } catch (err) {
        if (!(err instanceof RateNeeded) || attempt >= 20) throw err instanceof RateNeeded ? new RateUnavailableError(err.message) : err
        const n = err.need
        await this.rates.prefetch?.([n, ...state.missing.values()]).catch(() => undefined)
        // Not covered by the ranged fetch (today, a holiday run): one direct request, which also says if there is none.
        if (!(await this.rates.cached?.(n.date, n.from, n.to))) await this.rates.rate(n.date, n.from, n.to)
      }
    }
  }

  /**
   * Inside a ledger transaction (a write, the demo tidy): it holds a pool connection, so it must never wait on work
   * that runs elsewhere (another request's shared read on the pool, a turn in an in-process queue). With a pool of 3
   * that took every connection and stalled a ledger transaction 175 s (staging, 2026-10-13). It also sees its own
   * uncommitted writes, which a shared result must not carry. Shared caches are skipped there: computed in place.
   */
  #inTx(): boolean {
    return this.#tx.getStore() !== undefined || this.store.inTransaction?.() === true
  }

  async #exclusive<T>(ws: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    // Already inside an open ledger transaction (a writer apply that makes several ledger writes): take the database
    // lock on it (re-entrant) and go on. Waiting in the in-process queue here could deadlock: this transaction may
    // already hold the workspace lock while the queue's head waits in Postgres for that same lock.
    if (this.#tx.getStore()) return this.transaction(() => this.#locked(ws, fn))
    const prev = this.#locks.get(ws) ?? Promise.resolve()
    const queued = performance.now()
    // In-process queue first, then the cross-process lock inside the transaction every write runs in.
    const run = prev.catch(() => undefined).then(() => {
      perfCount('lockWait', performance.now() - queued)
      return this.transaction(() => this.#locked(ws, fn))
    })
    this.#locks.set(ws, run)
    try {
      return await run
    } finally {
      if (this.#locks.get(ws) === run) this.#locks.delete(ws)
    }
  }

  /** Inside the transaction: the workspace lock and the version bump, once per transaction however many writes nest. */
  async #locked<T>(ws: WorkspaceId, fn: () => Promise<T>): Promise<T> {
    const tx = this.#tx.getStore() as TxState
    if (!(tx.locked ??= new Set()).has(ws)) {
      const t0 = performance.now()
      await this.store.lockWorkspace(ws)
      perfCount('lockWait', performance.now() - t0)
      tx.locked.add(ws)
    }
    const out = await fn()
    if (!(tx.bumped ??= new Set()).has(ws)) {
      await this.store.bumpVersion(ws, this.now())
      tx.bumped.add(ws)
    }
    return out
  }

  /**
   * Results derived from the whole ledger (checks, review) are reused until the next write to the workspace, from
   * any process (the counter lives in the database), on the same day (a sync that changed nothing, or a connection
   * going stale, doesn't bump it; company and time zone edits do, via directoryChanged; overview keys carry the
   * sources' freshness).
   * Skipped while this process is writing to the workspace; hits are copies, so callers may mutate them.
   */
  async #shared<T>(ws: WorkspaceId, key: string, fn: () => Promise<T>, versionOf: () => Promise<number> = () => this.#versionNow(ws)): Promise<T> {
    if (this.#locks.has(ws) || this.#inTx()) return fn()
    const version = await versionOf()
    const now = Date.now()
    let slot = this.#derived.get(ws)
    // A new day starts a fresh slot so yesterday's keys don't pile up in memory.
    if (!slot || slot.version !== version || utcDay(slot.at) !== utcDay(now)) {
      slot = { version, at: now, values: new Map() }
      this.#derived.set(ws, slot)
    }
    let hit = slot.values.get(key) as Promise<T> | undefined
    if (!hit) {
      hit = PERSISTED.some((p) => key.startsWith(p)) ? this.#sharedFromDb(ws, key, version, slot.at, fn) : fn()
      slot.values.set(key, hit)
      const s = slot
      hit.catch(() => s.values.delete(key))
    }
    return structuredClone(await hit)
  }

  /** A miss in this process: what another process computed at this version, else compute (a few at once) and keep it. */
  async #sharedFromDb<T>(ws: WorkspaceId, key: string, version: number, slotAt: number, fn: () => Promise<T>): Promise<T> {
    const store = this.store
    const keyHash = createHash('sha256').update(key).digest('hex')
    if (store.getDerived) {
      const json = await store.getDerived(ws, keyHash, version, keepFrom(slotAt)).catch(() => null)
      if (json !== null) return JSON.parse(json) as T
    }
    // Only a top-level overview waits its turn: what it needs inside (checks, review) runs within its turn, never queued
    // behind another overview's.
    const value = key.startsWith('overview|') ? await this.#coldBuild(fn) : await fn()
    const json = store.putDerived ? plainJson(value) : null
    if (json !== null) {
      const at = new Date()
      // Awaited: inside a request's read transaction, a write left running would land after the commit and be lost.
      await store.putDerived!(ws, key, keyHash, version, json, at.toISOString(), keepFrom(at.getTime())).catch(() => undefined)
    }
    return value
  }

  #coldRunning = 0
  #coldQueue: Array<() => void> = []
  async #coldBuild<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#coldRunning >= COLD_BUILDS) await new Promise<void>((r) => this.#coldQueue.push(r))
    this.#coldRunning++
    try {
      return await fn()
    } finally {
      this.#coldRunning--
      this.#coldQueue.shift()?.()
    }
  }

  /**
   * For a process about to take traffic: load the derived results other processes wrote in the last `sinceMs` (at most
   * the reuse window) that are still current, so the first requests here find them in memory. Run across workspaces
   * (bypass). Returns how many it loaded.
   */
  async prewarm(sinceMs?: number): Promise<number> {
    if (!this.store.recentDerived) return 0
    const from = keepFrom(Date.now())
    const asked = sinceMs === undefined ? from : new Date(Date.now() - sinceMs).toISOString()
    const rows = await this.store.recentDerived(asked > from ? asked : from)
    const byWs = new Map<WorkspaceId, typeof rows>()
    for (const r of rows) byWs.set(r.workspaceId, [...(byWs.get(r.workspaceId) ?? []), r])
    let loaded = 0
    for (const [ws, list] of byWs) {
      const version = await this.store.version(ws)
      const current = list.filter((r) => r.version === version)
      if (!current.length) continue
      let slot = this.#derived.get(ws)
      // Stamped now: keys carry their day, so a row kept yesterday is still right for yesterday's key.
      if (!slot || slot.version !== version || utcDay(slot.at) !== utcDay(Date.now())) {
        slot = { version, at: Date.now(), values: new Map() }
        this.#derived.set(ws, slot)
      }
      for (const r of current) {
        if (slot.values.has(r.key)) continue
        slot.values.set(r.key, Promise.resolve(JSON.parse(r.valueJson)))
        loaded++
      }
    }
    return loaded
  }

  /**
   * The companies' bank, card and processor rows (txn.upsert, processor.balance_txn), oldest first, read once per
   * workspace version and shared by every search in this process: frozen, so callers must copy before changing one.
   * Searches at once share one read. Bounded by RECORD_SETS and RECORD_ROWS (least recently used out).
   */
  async txnRecords(ws: WorkspaceId, entityIds: EntityId[]): Promise<readonly SourceRecord[]> {
    const load = () => this.store.listRecords(ws, { entityIds, eventTypes: ['txn.upsert', 'processor.balance_txn'] })
    if (!this.#shareDerived || this.#locks.has(ws) || this.#inTx()) return load()
    const version = await this.#versionNow(ws)
    const key = `${ws}|${[...entityIds].sort().join(',')}`
    let e = this.#records.get(key)
    this.#records.delete(key)
    if (!e || e.version !== version) {
      const mine: { version: number; rows: number; value: Promise<readonly SourceRecord[]> } = { version, rows: 0, value: load().then(freezeRows) }
      mine.value.then(
        (r) => ((mine.rows = r.length), this.#trimRecords()),
        () => this.#records.get(key) === mine && this.#records.delete(key),
      )
      e = mine
    }
    this.#records.set(key, e)
    this.#trimRecords()
    return e.value
  }

  #trimRecords(): void {
    let rows = 0
    for (const e of this.#records.values()) rows += e.rows
    for (const [k, e] of this.#records) {
      if (this.#records.size <= RECORD_SETS && rows <= RECORD_ROWS) break
      this.#records.delete(k)
      rows -= e.rows
    }
  }

  /** Concurrent cache lookups for a workspace share one version read (an overview asks dozens at once). */
  #versionReads = new Map<WorkspaceId, Promise<number>>()
  #versionNow(ws: WorkspaceId): Promise<number> {
    // A transaction reads its own (it may have bumped it), and never hands its connection's read to other requests.
    if (this.#inTx()) return this.store.version(ws)
    let p = this.#versionReads.get(ws)
    if (!p) {
      p = this.store.version(ws)
      this.#versionReads.set(ws, p)
      const clear = () => {
        if (this.#versionReads.get(ws) === p) this.#versionReads.delete(ws)
      }
      p.then(clear, clear)
    }
    return p
  }

  #accountByExternal(ctx: Ctx, connectionId: Id, externalId: string): SourceAccountInfo | undefined {
    for (const a of ctx.accounts.values()) if (a.connectionId === connectionId && a.externalId === externalId) return a
    return undefined
  }

  async #ctx(ws: WorkspaceId): Promise<Ctx> {
    const tx = this.#tx.getStore()
    let base = tx?.base?.get(ws)
    if (!base) {
      const [entities, accounts, rules, locks] = await Promise.all([this.directory.listEntities(ws), this.directory.listSourceAccounts(ws), this.store.listRules(ws), this.store.listPeriodLocks(ws)])
      const timeZone = await zoneOf({ ws, directory: this.directory })
      base = { entities: new Map(entities.map((e) => [e.id, e])), accounts: new Map(accounts.map((a) => [a.id, a])), rules, locks: new Map(locks.map((l) => [l.entityId, l.through])), timeZone }
      if (tx) (tx.base ??= new Map()).set(ws, base)
    }
    return { ws, entities: base.entities, accounts: base.accounts, rules: base.rules, relink: new Set(), timeZone: base.timeZone, locks: base.locks, base, ...(base.ledgerAccounts ? { ledgerAccounts: base.ledgerAccounts } : {}) }
  }

  /** The directory, rules or locks just changed: the next write in this transaction reloads them. */
  #forgetCtx(ws: WorkspaceId): void {
    this.#tx.getStore()?.base?.delete(ws)
  }

  // ---------------------------------------------------------------------------------------------
  // Posting
  // ---------------------------------------------------------------------------------------------

  /** Contract entry point: post one normalized event (idempotent per connection + type + external id). */
  async post(ws: WorkspaceId, event: NormalizedEvent, opts: PostOptions = {}): Promise<PostResult> {
    const [r] = await this.postBatch(ws, [event], opts)
    return r as PostResult
  }

  /** Post many events (a sync page) in one transaction; opening balances and links are refreshed once at the end. */
  async postBatch(ws: WorkspaceId, input: readonly NormalizedEvent[], opts: PostOptions = {}): Promise<PostResult[]> {
    // A completed full listing isn't a record: it voids what the listing left out, after this page's rows are in.
    const listings = input.filter(isListingComplete)
    const events = input.filter((e) => !isListingComplete(e)).map(capText)
    for (const ev of events) if (!INFORMATIONAL.has(ev.type)) validateEvent(ev)
    for (const l of listings) validateListing(l)
    const posted = await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        const results: PostResult[] = []
        const dirtyAccounts = new Set<Id>()
        ctx.dirty = dirtyAccounts
        ctx.entries = new Map()
        ctx.unlinked = new Set()
        ctx.existing = new Map()
        // One query for "which of these rows do we have already" instead of one per row.
        for (const r of await this.store.findRecordsByKeys(ws, events.map((e) => ({ connectionId: e.connectionId, eventType: e.type, externalId: e.externalId })))) {
          ctx.existing.set(`${r.connectionId}|${r.eventType}|${r.externalId}`, r)
        }
        for (const e of events) {
          const key = `${e.connectionId}|${e.type}|${e.externalId}`
          if (!ctx.existing.has(key)) ctx.existing.set(key, null)
        }
        // Their current entries too, in one query: a full re-listing sends mostly unchanged rows, each of which
        // reports its entry, and changed ones repost from them.
        const known = [...ctx.existing.values()].filter((r): r is SourceRecord => r !== null).map((r) => r.id)
        if (known.length) await this.store.prefetchActiveEntries?.(ws, known)
        const touched: SourceRecord[] = []
        for (const ev of events) {
          const { result, record } = await this.#postOne(ctx, ev, opts)
          results.push(result)
          if (record) {
            touched.push(record)
            if (record.sourceAccountId) dirtyAccounts.add(record.sourceAccountId)
          }
        }
        const relinked: SourceRecord[] = []
        for (const id of ctx.relink) {
          const r = await this.store.getRecord(ws, id)
          if (r) relinked.push(r)
        }
        if (opts.settleLater) {
          // Rows from elsewhere whose links this page unwound are rematched now; this page's own wait for settle.
          // Marked as of the page's earliest row, so settle's "changed since" reads every one of them.
          const since = new Map<Id, IsoTimestamp>()
          for (const r of touched) if (!since.has(r.connectionId) || r.updatedAt < (since.get(r.connectionId) as string)) since.set(r.connectionId, r.updatedAt)
          for (const [conn, at] of since) await this.store.markUnsettled(ws, conn, at)
          await this.#autoLink(ctx, relinked)
          for (const acc of dirtyAccounts) if (!touched.some((r) => r.sourceAccountId === acc)) await this.#refreshOpening(ctx, acc)
        } else {
          await this.#autoLink(ctx, [...touched, ...relinked])
          for (const acc of dirtyAccounts) await this.#refreshOpening(ctx, acc)
          const moved = new Set(touched.filter((r) => r.entityId && MONEY_HISTORY.has(r.eventType)).map((r) => r.entityId as EntityId))
          if (moved.size) await this.#repostEquity(ctx, [...moved])
        }
        // Report the entry that exists after links/openings settled.
        for (const [i, rec] of touched.entries()) {
          const res = results[i]
          if (res && res.status === 'posted') {
            const active = ctx.entries.get(rec.id) ?? (await this.store.activeEntriesForSource(ws, rec.id))
            res.journalEntryId = active[0]?.id ?? null
            if (!res.journalEntryId) res.status = 'recorded'
          }
        }
        // Every record this page carried was seen now, unchanged ones included (one statement): what a later
        // completed listing didn't see is gone at the provider.
        const carried = [...ctx.existing.values()].filter((r): r is SourceRecord => r !== null && r.origin === 'connector').map((r) => r.id)
        await this.store.markSeen(ws, carried, this.now())
        for (const l of listings) await this.#applyListing(ctx, l, opts)
        return results
      }),
    )
    if (listings.length === 0) return posted
    // Results in the order events came; a listing is 'recorded'.
    let i = 0
    return input.map((e) => (isListingComplete(e) ? { journalEntryId: null, status: 'recorded' as const } : (posted[i++] as PostResult)))
  }

  /**
   * A full listing of these kinds completed at the provider: this connection's synced records of those kinds that it
   * didn't carry (last seen before it started) were deleted there, and are voided here (reversed on the first open
   * day when their period is closed). Not when it would void most of a kind or very many at once, or when the listing
   * carried nothing: that looks like a provider mistake, so it's reported in data health instead.
   */
  async #applyListing(ctx: Ctx, l: ListingComplete, opts: PostOptions): Promise<void> {
    const ws = ctx.ws
    const now = this.now()
    for (const kind of new Set(l.kinds)) {
      const type = LISTING_TYPES[kind]
      const seenAt = await this.store.lastSeen(ws, l.connectionId, [type])
      const live = (await this.store.listRecords(ws, { connectionId: l.connectionId, eventTypes: [type] })).filter(
        (r) =>
          r.origin === 'connector' &&
          r.status !== 'void' &&
          r.status !== 'excluded' &&
          (!l.scope || r.externalId.startsWith(l.scope)) &&
          (kind === 'invoice' || kind === 'bill' ? r.event.type === 'invoice.upsert' && r.event.direction === (kind === 'invoice' ? 'receivable' : 'payable') : true),
      )
      const gone = live.filter((r) => (seenAt.get(r.id) ?? r.createdAt) < l.startedAt)
      const seen = live.length - gone.length
      const outcome = { workspaceId: ws, connectionId: l.connectionId, kind, startedAt: l.startedAt, appliedAt: now, seen }
      const skipped =
        gone.length === 0
          ? null
          : seen === 0
            ? `the listing carried none of the ${live.length}`
            : gone.length > LISTING_MAX_VOIDS
              ? `${gone.length} would be voided (more than ${LISTING_MAX_VOIDS} at once)`
              : live.length >= 10 && gone.length * 2 > live.length
                ? `${gone.length} of ${live.length} would be voided (more than half)`
                : null
      if (skipped) {
        await this.store.saveListing({ ...outcome, voided: 0, skippedReason: skipped })
        continue
      }
      for (const r of gone) {
        const updated: SourceRecord = { ...r, status: 'void', contentHash: `${GONE_PREFIX}${r.contentHash}`, updatedAt: now }
        await this.store.saveRecord(updated)
        await this.#unwindLinks(ctx, r.id)
        await this.#repost(ctx, updated)
        if (r.sourceAccountId) {
          noteDirty(ctx, r.sourceAccountId, r.date)
          if (!opts.settleLater) await this.#refreshOpening(ctx, r.sourceAccountId)
        }
      }
      if (opts.settleLater && gone.length) await this.store.markUnsettled(ws, l.connectionId, now)
      await this.store.saveListing({ ...outcome, voided: gone.length, skippedReason: null })
    }
  }

  async #disconnected(ctx: Ctx, connectionId: Id): Promise<boolean> {
    const known = (ctx.gone ??= new Map()).get(connectionId)
    if (known !== undefined) return known
    const gone = (await this.#connection(ctx, connectionId))?.status === 'disconnected'
    ctx.gone.set(connectionId, gone)
    return gone
  }

  /** The workspace's connections, read once per transaction (connectionChanged and redate forget them). */
  async #connections(ctx: Ctx): Promise<Map<Id, ConnectionInfo>> {
    const cached = ctx.base?.connections
    if (cached) return cached
    const all = new Map((await this.directory.listConnections(ctx.ws)).map((c) => [c.id, c]))
    if (ctx.base) ctx.base.connections = all
    return all
  }

  async #connection(ctx: Ctx, id: Id): Promise<ConnectionInfo | null> {
    return (await this.#connections(ctx)).get(id) ?? null
  }

  /** Ask for a statistics refresh after this burst of settles (see STATS_QUIET_MS); never fails anything. */
  #statsSoon(): void {
    const refresh = this.store.refreshStats?.bind(this.store)
    if (!refresh) return
    const stats = this.#stats
    const now = Date.now()
    stats.firstAsk ??= now
    if (stats.timer) clearTimeout(stats.timer)
    // After a quiet spell it runs then (the last settle of a fill may be followed by someone's first question at once);
    // only a run forced in the middle of a long burst is held STATS_MIN_GAP_MS after the previous one.
    const forced = stats.firstAsk + STATS_MAX_WAIT_MS - now
    const wait = forced < STATS_QUIET_MS ? Math.max(0, forced, (stats.lastDone ?? 0) + STATS_MIN_GAP_MS - now) : STATS_QUIET_MS
    stats.timer = setTimeout(() => {
      stats.timer = undefined
      stats.firstAsk = undefined
      // One at a time; a burst that ends while one runs gets another after it.
      if (stats.running) return void (stats.again = true)
      stats.running = refresh()
        .catch((err: unknown) => console.warn('[agfn] planner statistics refresh failed', { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => {
          stats.running = undefined
          stats.lastDone = Date.now()
          if (stats.again) {
            stats.again = false
            this.#statsSoon()
          }
        })
    }, wait)
    stats.timer.unref?.()
  }

  /**
   * Finish what pages posted with `settleLater` left: match the connection's rows changed since its mark against
   * everything, and refresh their accounts' opening balances, in one transaction. A no-op when nothing waits.
   */
  async settle(ws: WorkspaceId, connectionId: Id): Promise<void> {
    // Nothing waiting (a sync that changed nothing): no lock and no version bump, so cached reads stay valid.
    if (!this.#tx.getStore()) {
      if ((await this.store.unsettledSince(ws, connectionId)) === null && !(await this.#matcherBehind(ws))) return
      // An import just landed and outruns the planner's statistics: refresh them once the burst goes quiet.
      this.#statsSoon()
    }
    const standalone = !this.#tx.getStore()
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const since = await this.store.unsettledSince(ws, connectionId)
        const rematch = await this.#matcherBehind(ws)
        if (since === null && !rematch) return
        const ctx = await this.#ctx(ws)
        if (since === null) {
          await this.#rematchAll(ctx)
          return
        }
        const touched = await this.store.listRecords(ws, { connectionId, updatedSince: since })
        ctx.dirty = new Set(touched.flatMap((r) => (r.sourceAccountId ? [r.sourceAccountId] : [])))
        // Pages didn't record which dates they moved: these accounts' openings are recomputed in full.
        for (const acc of ctx.dirty) noteDirty(ctx, acc, '')
        ctx.entries = new Map()
        ctx.unlinked = new Set()
        await this.#autoLink(ctx, touched)
        for (const acc of ctx.dirty) await this.#refreshOpening(ctx, acc)
        // Bank history arriving moves where a company's books start: equity raised before it is in the openings.
        const moved = new Set(touched.filter((r) => r.entityId && MONEY_HISTORY.has(r.eventType)).map((r) => r.entityId as EntityId))
        if (moved.size) await this.#repostEquity(ctx, [...moved])
        await this.store.clearUnsettled(ws, connectionId)
        if (rematch) await this.#rematchAll(ctx)
      }),
    )
    if (standalone) await this.autoFile(ws).catch((e) => console.warn('[agfn] auto-file failed', e instanceof Error ? e.message : String(e)))
  }

  /** File what Review needn't ask (autofile.ts). A failure leaves the questions in Review; it never fails a sync. */
  async autoFile(ws: WorkspaceId): Promise<{ filed: number }> {
    let filed = 0
    const plan = await planAutoFile(this.metricContext(ws))
    for (const id of plan.stale) await this.decideLink(ws, id, 'rejected', AUTO_STALE).catch(() => undefined)
    // One row that can't be filed stays a question; it doesn't stop the rest.
    const file = async (id: Id, write: () => Promise<unknown>): Promise<void> => {
      try {
        await write()
        filed++
      } catch (e) {
        if (!(e instanceof LinkError)) console.warn(`[agfn] auto-file skipped ${id}:`, e instanceof Error ? e.message : String(e))
      }
    }
    for (const id of plan.links) await file(id, () => this.decideLink(ws, id, 'confirmed', AUTO_FILED))
    for (const id of plan.small) await file(id, () => this.#setOverride(ws, id, { kind: 'other', category: 'other_income' }, AUTO_FILED))
    for (const id of plan.opening) await file(id, () => this.#setOverride(ws, id, { kind: 'other', category: 'opening_balance_equity' }, AUTO_FILED))
    return { filed }
  }

  async filedItems(ws: WorkspaceId, opts: { entityIds?: EntityId[] } = {}): Promise<FiledItem[]> {
    return filedItems(this.metricContext(ws), opts)
  }

  /** Put a filing back as a question ("link:<id>" or "record:<id>"); it won't be filed again. */
  async undoFiled(ws: WorkspaceId, id: string): Promise<{ recordId: Id }> {
    const [kind, subject] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        if (kind === 'link') {
          const link = await this.store.getLink(ws, subject)
          if (!link || !isFiledLink(link)) throw new LinkError('That was not filed automatically')
          await this.#decide(ctx, link, 'proposed', null)
          const back = await this.store.getLink(ws, subject)
          await this.store.saveLink({ ...(back as Link), scores: { ...(back?.scores ?? {}), noAuto: 1 } })
          return { recordId: link.toId }
        }
        const o = await this.store.getOverride(ws, subject)
        const record = await this.store.getRecord(ws, subject)
        if (kind !== 'record' || !o || o.updatedBy !== AUTO_FILED || !record) throw new LinkError('That was not filed automatically')
        const { kind: _k, category: _c, ...rest } = o
        await this.store.saveOverride({ ...rest, updatedBy: AUTO_UNDONE, updatedAt: this.now() })
        await this.#repost(ctx, record)
        await this.#repostLinked(ctx, record.id)
        return { recordId: record.id }
      }),
    )
  }

  /** The workspace's history was last matched by an older matcher (a workspace never recorded starts current). */
  async #matcherBehind(ws: WorkspaceId): Promise<boolean> {
    const v = await this.store.matchedWith(ws)
    if (v === null) {
      await this.store.setMatchedWith(ws, MATCHER_VERSION, this.now())
      return false
    }
    return v < MATCHER_VERSION
  }

  /** Match the whole history once with the current matcher (rows still waiting in Review get its new answers). */
  async #rematchAll(ctx: Ctx): Promise<void> {
    ctx.dirty ??= new Set()
    await this.#grossProcessorLinks(ctx)
    await this.#applyMatches(ctx, await this.#matches(ctx))
    await this.#repostUtilities(ctx)
    for (const acc of ctx.dirty) await this.#refreshOpening(ctx, acc)
    await this.store.setMatchedWith(ctx.ws, MATCHER_VERSION, this.now())
  }

  /**
   * Utilities were posted to Rent before they had their own account (matcher 5): rows whose provider category is a
   * utility are planned again. Last month's power bill then sits with this month's, not in rent. A category someone
   * set (an override) or a rule still decides; a row whose entries come out the same writes nothing.
   */
  async #repostUtilities(ctx: Ctx): Promise<void> {
    for (const r of await this.store.listRecords(ctx.ws, { eventTypes: ['txn.upsert'], statuses: ['posted'] })) {
      if (r.event.type === 'txn.upsert' && r.event.categoryHint && UTILITY_HINT.test(r.event.categoryHint)) await this.#repost(ctx, r)
    }
  }

  /**
   * Invoice links to a processor charge made before a link counted the charge's gross carry its net: the invoice then
   * looked short by the fee (AGFN: \$38.54 "open" on three paid Stripe invoices). Corrected to the gross, capped at
   * what the invoice is for.
   */
  async #grossProcessorLinks(ctx: Ctx): Promise<void> {
    const links = (await this.store.listLinks(ctx.ws, { types: ['invoice_payment'], statuses: ['confirmed'] })).filter((l) => l.amount)
    if (links.length === 0) return
    const recs = new Map((await this.store.getRecords(ctx.ws, [...new Set(links.flatMap((l) => [l.fromId, l.toId]))])).map((r) => [r.id, r]))
    for (const l of links) {
      const [inv, charge] = [recs.get(l.fromId), recs.get(l.toId)]
      if (!inv || !charge || inv.event.type !== 'invoice.upsert' || charge.event.type !== 'processor.balance_txn' || !l.amount) continue
      const { gross, net } = charge.event
      if (gross.minor === net.minor || Math.abs(l.amount.minor) !== Math.abs(net.minor) || gross.currency !== l.amount.currency) continue
      const minor = Math.min(Math.abs(gross.minor), Math.abs(inv.event.total.minor))
      await this.store.saveLink({ ...l, amount: { minor, currency: gross.currency } })
    }
  }

  /** Re-plan these entities' equity records with an amount (few per company); unchanged ones write nothing. */
  async #repostEquity(ctx: Ctx, entityIds: EntityId[]): Promise<void> {
    ctx.booksStart = new Map()
    for (const r of await this.store.listRecords(ctx.ws, { entityIds, eventTypes: ['equity.event'], statuses: ['posted'] })) {
      if (r.event.type === 'equity.event' && r.event.amount) await this.#repost(ctx, r)
    }
  }

  async #postOne(ctx: Ctx, ev: NormalizedEvent, opts: PostOptions): Promise<{ result: PostResult; record: SourceRecord | null }> {
    const ws = ctx.ws
    const find = async (e: NormalizedEvent): Promise<SourceRecord | null> => {
      const known = ctx.existing?.get(`${e.connectionId}|${e.type}|${e.externalId}`)
      return known !== undefined ? known : this.store.findRecord(ws, e.connectionId, e.type, e.externalId)
    }
    let existing = await find(ev)
    // Connectors keep one balance per UTC day. The workspace's day can end inside that one: a morning read must not
    // replace the last read of the day before, or month-end loses its closing balance.
    if (ev.type === 'balance.snapshot' && existing && existing.date !== eventDate(ev, ctx.timeZone)) {
      ev = { ...ev, externalId: `${ev.externalId}~${eventDate(ev, ctx.timeZone)}` }
      existing = await find(ev)
    }
    const hash = contentHash(ev)
    const key = `${ev.connectionId}|${ev.type}|${ev.externalId}`
    if (existing && existing.contentHash === hash) {
      const active = await this.store.activeEntriesForSource(ws, existing.id)
      return { result: { journalEntryId: active[0]?.id ?? null, status: 'duplicate' }, record: null }
    }
    const now = this.now()
    if (existing?.sourceAccountId) noteDirty(ctx, existing.sourceAccountId, existing.date)
    let resolved = await this.#resolve(ctx, ev, opts.entityId ?? existing?.entityId ?? null)
    // The tail of a sync that was running when its connection was disconnected: nothing new counts, and what the
    // disconnect took out stays out (rows it already had and kept, after a plain disconnect, keep counting).
    if ((!existing || existing.status === 'excluded') && (await this.#disconnected(ctx, ev.connectionId))) resolved = { ...resolved, status: 'excluded' }
    const record: SourceRecord = {
      id: existing?.id ?? newId(),
      workspaceId: ws,
      connectionId: ev.connectionId,
      eventType: ev.type,
      externalId: ev.externalId,
      contentHash: hash,
      event: ev,
      origin: existing?.origin ?? opts.origin ?? 'connector',
      createdBy: existing?.createdBy ?? opts.createdBy ?? null,
      sourceAccountId: resolved.sourceAccountId,
      entityId: resolved.entityId,
      status: resolved.status,
      date: eventDate(ev, ctx.timeZone),
      amount: eventAmount(ev),
      postingHash: null,
      provenance: existing?.provenance ?? opts.provenance ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.store.saveRecord(record)
    ctx.existing?.set(key, record)
    if (!existing) {
      ctx.entries?.set(record.id, [])
      ctx.unlinked?.add(record.id)
      ;(ctx.ruleApplied ??= new Map()).set(record.id, new Set())
    }
    // A provider void (Plaid "removed", a superseded payroll estimate, a deleted payment) unwinds its links,
    // so the money it explained can be matched again.
    if (record.status === 'void' && existing && existing.status !== 'void') await this.#unwindLinks(ctx, record.id)
    if (ev.type === 'account.upsert' && resolved.sourceAccountId) {
      await this.#reprocessAccount(ctx, resolved.sourceAccountId)
    }
    if (ev.type === 'subscription.upsert') await this.#trackMrr(ctx, existing, record)
    await this.#repost(ctx, record)
    await this.#repostLinked(ctx, record.id)
    const active = ctx.entries?.get(record.id) ?? (await this.store.activeEntriesForSource(ws, record.id))
    const status: PostResult['status'] = record.status === 'unassigned' ? 'unassigned' : active.length > 0 ? 'posted' : 'recorded'
    return { result: { journalEntryId: active[0]?.id ?? null, status }, record }
  }

  async #resolve(ctx: Ctx, ev: NormalizedEvent, fallbackEntityId: EntityId | null = null): Promise<{ sourceAccountId: Id | null; entityId: EntityId | null; status: SourceRecord['status'] }> {
    const ws = ctx.ws
    switch (ev.type) {
      case 'account.upsert': {
        const acc = await this.directory.upsertSourceAccount(ws, ev)
        ctx.accounts.set(acc.id, acc)
        return { sourceAccountId: acc.id, entityId: acc.entityId, status: 'recorded' }
      }
      case 'txn.upsert':
      case 'balance.snapshot':
      case 'processor.balance_txn': {
        const acc = this.#accountByExternal(ctx, ev.connectionId, ev.accountExternalId) ?? (await this.directory.findSourceAccount(ws, ev.connectionId, ev.accountExternalId))
        if (!acc) return { sourceAccountId: null, entityId: null, status: 'unassigned' }
        ctx.accounts.set(acc.id, acc)
        // A second source for an account we already have: its rows post into that account (the rows both sources
        // report are linked as duplicates); its balances are the primary's, so they don't count twice.
        let entityId = acc.entityId
        if (acc.duplicateOf) {
          if (ev.type === 'balance.snapshot') return { sourceAccountId: acc.id, entityId: acc.entityId, status: 'excluded' }
          const primary = ctx.accounts.get(acc.duplicateOf) ?? (await this.directory.getSourceAccount(ws, acc.duplicateOf))
          if (!primary) return { sourceAccountId: acc.id, entityId: acc.entityId, status: 'excluded' }
          ctx.accounts.set(primary.id, primary)
          entityId = primary.entityId ?? acc.entityId
        }
        if (!entityId) return { sourceAccountId: acc.id, entityId: null, status: 'unassigned' }
        if (ev.type === 'balance.snapshot') return { sourceAccountId: acc.id, entityId, status: 'recorded' }
        if (ev.type === 'txn.upsert' && ev.status === 'void') return { sourceAccountId: acc.id, entityId, status: 'void' }
        if (ev.type === 'txn.upsert' && ev.status === 'pending') return { sourceAccountId: acc.id, entityId, status: 'recorded' }
        // Points or crypto with no ISO code: kept, never posted (no rate converts it, and one such row failed its batch).
        if (eventAmount(ev)?.currency === NOT_MONEY) return { sourceAccountId: acc.id, entityId, status: 'recorded' }
        return { sourceAccountId: acc.id, entityId, status: 'posted' }
      }
      default: {
        if (INFORMATIONAL.has(ev.type)) {
          const conn = await this.#connection(ctx, ev.connectionId)
          return { sourceAccountId: null, entityId: conn?.entityId ?? fallbackEntityId, status: 'recorded' }
        }
        const conn = await this.#connection(ctx, ev.connectionId)
        const entityId = conn?.entityId ?? (fallbackEntityId && ctx.entities.has(fallbackEntityId) ? fallbackEntityId : null)
        if (!entityId) return { sourceAccountId: null, entityId: null, status: 'unassigned' }
        const voided =
          (ev.type === 'invoice.upsert' && ev.status === 'void') ||
          (ev.type === 'payroll.run' && ev.status === 'void') ||
          (ev.type === 'payment.applied' && (ev as { status?: string }).status === 'void') ||
          (ev.type === 'journal.upsert' && ev.status === 'void')
        return { sourceAccountId: null, entityId, status: voided ? 'void' : 'posted' }
      }
    }
  }

  /** Keep each change in a subscription's monthly value, dated, so MRR movements and past MRR can be told. */
  async #trackMrr(ctx: Ctx, existing: SourceRecord | null, record: SourceRecord): Promise<void> {
    const ev = record.event as SubscriptionUpsert
    const ws = ctx.ws
    const points = existing ? (await this.store.listMrrPoints(ws, [record.id])).map((p) => ({ date: p.date, minor: p.mrr.minor })) : []
    const add: Array<{ date: IsoDate; minor: number }> = []
    const today = localDate(this.now(), ctx.timeZone)
    if (points.length === 0) {
      // First sight, or recorded before history was kept: what its earlier state implies, then this change.
      const base = existing ? initialPoints(existing.event as SubscriptionUpsert, ctx.timeZone) : initialPoints(ev, ctx.timeZone, today)
      add.push(...base)
      points.push(...base)
    } else if (existing) {
      // Changes the provider lists that are newer than what's kept (a re-sync lists the same ones again: skipped).
      for (const c of changePoints(ev, today, ctx.timeZone)) {
        const last = points[points.length - 1] as { date: IsoDate; minor: number }
        if (c.date <= last.date || c.minor === last.minor) continue
        add.push(c)
        points.push(c)
      }
    }
    if (existing) {
      const next = nextPoint(points, ev, localDate(this.now(), ctx.timeZone), ctx.timeZone)
      if (next) add.push(next)
    }
    const now = this.now()
    for (const p of add) await this.store.addMrrPoint({ id: newId(), workspaceId: ws, recordId: record.id, date: p.date, mrr: { minor: p.minor, currency: ev.mrr.currency }, createdAt: now })
  }

  /** Call when S0 assigns an account to a company (or marks it a duplicate): re-resolves and reposts its records. */
  async accountChanged(ws: WorkspaceId, sourceAccountId: Id): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        this.#forgetCtx(ws)
        const ctx = await this.#ctx(ws)
        await this.#reprocessAccount(ctx, sourceAccountId)
        await this.#refreshOpening(ctx, sourceAccountId)
      }),
    )
  }

  /** Review's "which company?": assign an unassigned account and post the rows it was holding. */
  async assignAccount(ws: WorkspaceId, sourceAccountId: Id, entityId: EntityId): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        this.#forgetCtx(ws)
        if (!(await this.directory.getEntity(ws, entityId))) throw new PostingError(`Unknown entity ${entityId}`)
        const acc = await this.directory.getSourceAccount(ws, sourceAccountId)
        if (!acc) throw new PostingError(`Unknown account ${sourceAccountId}`)
        if (acc.entityId === entityId) return
        if (acc.entityId || !(await this.directory.assignSourceAccount(ws, sourceAccountId, entityId))) throw new PostingError(`${acc.name} already belongs to a company`)
        const ctx = await this.#ctx(ws)
        await this.#reprocessAccount(ctx, sourceAccountId)
        await this.#refreshOpening(ctx, sourceAccountId)
      }),
    )
  }

  /** Companies, names, currencies or the time zone changed: results derived from them are computed afresh. */
  async directoryChanged(ws: WorkspaceId): Promise<void> {
    // The time zone may be what changed: instants (balances, processor rows) then fall on other local days.
    forgetZone(this.directory, ws)
    await this.redate(ws)
  }

  /**
   * Put balance reads and processor rows on the workspace's local day (after a time zone change, or for records
   * kept before the workspace had one), reposting only those whose day moved. Returns how many moved.
   */
  async redate(ws: WorkspaceId): Promise<number> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        this.#forgetCtx(ws)
        const ctx = await this.#ctx(ws)
        const recs = await this.store.listRecords(ws, { eventTypes: ['balance.snapshot', 'processor.balance_txn'] })
        const moved: SourceRecord[] = []
        const accounts = new Set<Id>()
        for (const r of recs) {
          const day = eventDate(r.event, ctx.timeZone)
          if (day === r.date) continue
          const updated = { ...r, date: day, updatedAt: this.now() }
          await this.store.saveRecord(updated)
          await this.#repost(ctx, updated)
          await this.#repostLinked(ctx, updated.id)
          moved.push(updated)
          if (updated.sourceAccountId) accounts.add(updated.sourceAccountId)
        }
        for (const acc of accounts) await this.#refreshOpening(ctx, acc)
        return moved.length
      }),
    )
  }

  /** A connection removed with its data: everything it brought stops counting. See retireRecords. */
  async connectionRemoved(ws: WorkspaceId, connectionId: Id): Promise<number> {
    return this.retireRecords(ws, { connectionId })
  }

  /**
   * Some providers' terms (Wefunder) require their data deleted when the person disconnects. First it stops counting
   * exactly as connectionRemoved does (links unwind, the other side of each, a bank row, is posted again on its own),
   * then its records and everything posted from them are deleted. What other sources posted stays. Safe to run again.
   */
  async connectionErased(ws: WorkspaceId, connectionId: Id): Promise<number> {
    if (!this.store.eraseConnection) throw new Error('This ledger store cannot delete a connection\'s data')
    await this.retireRecords(ws, { connectionId })
    const n = await this.#exclusive(ws, () => this.store.transaction(() => this.store.eraseConnection!(ws, connectionId)))
    this.#forgetCtx(ws)
    this.#derived.delete(ws)
    return n
  }

  /**
   * A connection's records stop counting: it was removed with its data, or a newer connection now reads the same
   * provider company or accounts. `sourceAccountIds` limits it to some of its accounts; `from` keeps the history
   * before it (balance reads go either way: the newer source has its own). Records become excluded, entries reverse
   * like any other change (in a closed period the reversal lands on the first open day), links unwind and what they
   * explained is matched again. Kept for the audit trail, never deleted; while the connection is disconnected
   * nothing brings them back. Returns how many records it took out.
   */
  async retireRecords(ws: WorkspaceId, filter: { connectionId: Id; sourceAccountIds?: Id[]; from?: IsoDate }): Promise<number> {
    const connectionId = filter.connectionId
    const only = filter.sourceAccountIds ? new Set(filter.sourceAccountIds) : null
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        ctx.removed = new Set([connectionId])
        const recs = await this.store.listRecords(ws, { connectionId })
        const accounts = new Set<Id>()
        let n = 0
        for (const r of recs) {
          if (r.status === 'excluded' || r.eventType === 'account.upsert') continue
          if (only && !(r.sourceAccountId && only.has(r.sourceAccountId))) continue
          if (filter.from && r.date < filter.from && r.eventType !== 'balance.snapshot') continue
          await this.#unwindLinks(ctx, r.id)
          const updated = { ...r, status: 'excluded' as const, updatedAt: this.now() }
          await this.store.saveRecord(updated)
          await this.#repost(ctx, updated)
          if (r.sourceAccountId) accounts.add(r.sourceAccountId)
          n++
        }
        for (const acc of accounts) await this.#refreshOpening(ctx, acc)
        // What those links had explained (bank rows, payouts) can find its match elsewhere now.
        const others = (await Promise.all([...ctx.relink].map((id) => this.store.getRecord(ws, id)))).filter((r): r is SourceRecord => r !== null && r.connectionId !== connectionId)
        await this.#autoLink(ctx, others)
        return n
      }),
    )
  }

  /** Call when a connection is assigned to a company (invoices, payroll, equity arrive per connection). */
  async connectionChanged(ws: WorkspaceId, connectionId: Id): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        this.#forgetCtx(ws)
        const ctx = await this.#ctx(ws)
        const recs = await this.store.listRecords(ws, { connectionId })
        for (const r of recs) if (!r.sourceAccountId && r.eventType !== 'account.upsert') await this.#reresolve(ctx, r)
        await this.#autoLink(ctx, recs)
      }),
    )
  }

  async #reprocessAccount(ctx: Ctx, accountId: Id): Promise<void> {
    const acc = await this.directory.getSourceAccount(ctx.ws, accountId)
    if (!acc) return
    ctx.accounts.set(acc.id, acc)
    const recs = acc.connectionId ? await this.store.listRecords(ctx.ws, { connectionId: acc.connectionId }) : []
    const mine = recs.filter((r) => {
      const ev = r.event
      return r.sourceAccountId === accountId || ((ev.type === 'txn.upsert' || ev.type === 'balance.snapshot' || ev.type === 'processor.balance_txn') && ev.accountExternalId === acc.externalId)
    })
    for (const r of mine) await this.#reresolve(ctx, r)
    await this.#autoLink(ctx, mine)
  }

  async #reresolve(ctx: Ctx, r: SourceRecord): Promise<void> {
    if (r.status === 'void' && r.provenance) return // voided by a person/AI: stays void until restored
    // Gone at the provider (a completed listing left it out): stays void until a sync carries it again.
    if (r.status === 'void' && r.contentHash.startsWith(GONE_PREFIX)) return
    // Its connection was removed with its data: it stays out (a disconnected connection sends nothing new).
    if (r.status === 'excluded' && (ctx.removed?.has(r.connectionId) || (await this.#connection(ctx, r.connectionId))?.status === 'disconnected')) return
    const res = await this.#resolve(ctx, r.event, r.entityId)
    if (res.entityId !== r.entityId || res.status !== r.status || res.sourceAccountId !== r.sourceAccountId) {
      const updated = { ...r, ...res, updatedAt: this.now() }
      await this.store.saveRecord(updated)
      await this.#repost(ctx, updated)
      await this.#repostLinked(ctx, updated.id)
    }
  }

  async #unwindLinks(ctx: Ctx, recordId: Id): Promise<void> {
    const now = this.now()
    for (const l of await this.store.listLinks(ctx.ws, { recordId, statuses: ['confirmed', 'proposed'] })) {
      await this.store.saveLink({ ...l, status: 'rejected', decidedBy: 'void', decidedAt: now })
      const other = await this.store.getRecord(ctx.ws, l.fromId === recordId ? l.toId : l.fromId)
      if (other && l.status === 'confirmed') await this.#repost(ctx, other)
      if (other) ctx.relink.add(other.id)
    }
  }

  async #repostLinked(ctx: Ctx, recordId: Id): Promise<void> {
    // New in this operation and not linked yet: nothing hangs off it.
    if (ctx.unlinked?.has(recordId)) return
    const links = await this.store.listLinks(ctx.ws, { recordId, statuses: ['confirmed'] })
    for (const l of links) {
      const otherId = l.fromId === recordId ? l.toId : l.fromId
      const other = await this.store.getRecord(ctx.ws, otherId)
      if (other) await this.#repost(ctx, other)
    }
  }

  /** Rebuild one record's entries: plan both views, then reverse + insert only if something changed. */
  async #repost(ctx: Ctx, record: SourceRecord): Promise<void> {
    if (record.sourceAccountId) noteDirty(ctx, record.sourceAccountId, record.date)
    const planned = record.status === 'posted' && record.entityId ? await this.#planRecord(ctx, record) : []
    await this.#writeSource(ctx, record.id, planned, record.entityId)
    // An investment event changes the cost left for the rest of its position: they re-plan (unchanged ones write
    // nothing). Once per position per operation, not again from inside.
    if (record.event.type === 'investment.event' && record.entityId) {
      const key = `${record.entityId}|${record.event.positionId}`
      const busy = (ctx.positionsReposting ??= new Set())
      if (busy.has(key)) return
      busy.add(key)
      try {
        for (const r of await this.#position(ctx, record.entityId, record.event.positionId)) if (r.id !== record.id) await this.#repost(ctx, r)
      } finally {
        busy.delete(key)
      }
    }
  }

  async #planContext(ctx: Ctx, record: SourceRecord): Promise<PlanContext> {
    const ws = ctx.ws
    const entity = ctx.entities.get(record.entityId as EntityId)
    if (!entity) throw new PostingError(`Entity ${record.entityId} not found for record ${record.id}`)
    const isNew = ctx.unlinked?.has(record.id) ?? false
    const override = isNew ? null : await this.store.getOverride(ws, record.id)
    const rules = record.event.type === 'txn.upsert' ? applyRules(ctx.rules, record, record.sourceAccountId ? ctx.accounts.get(record.sourceAccountId) : null) : null
    const touching = isNew ? [] : await this.store.listLinks(ws, { recordId: record.id, statuses: ['confirmed', 'proposed'] })
    const linkRows = touching.filter((l) => l.status === 'confirmed')
    const heldAsCopy = touching.some((l) => l.toId === record.id && holdsCopy(l))
    const links: LinkedRecord[] = []
    for (const link of linkRows) {
      const other = await this.store.getRecord(ws, link.fromId === record.id ? link.toId : link.fromId)
      if (!other || other.status === 'void' || other.status === 'excluded') continue
      links.push({ link, other, otherAccount: this.#ledgerAccountOf(ctx, other.sourceAccountId) })
    }
    const personal = [...ctx.entities.values()].filter((e) => e.kind === 'personal')
    const accounts = [...ctx.accounts.values()]
    return {
      record,
      entity,
      account: this.#ledgerAccountOf(ctx, record.sourceAccountId),
      heldAsCopy,
      entities: ctx.entities,
      override,
      rules,
      links,
      soleOwnerEntityId: personal.length === 1 ? (personal[0] as EntityInfo).id : null,
      entityHasCard: (id) => accounts.some((a) => a.entityId === id && a.accountType === 'credit_card' && !a.duplicateOf),
      entityHasProcessor: (id) => accounts.some((a) => a.entityId === id && a.accountType === 'processor_balance' && !a.duplicateOf),
      baseAt: async (amount, date, entityId, fx) => {
        const e = ctx.entities.get(entityId)
        if (!e) throw new PostingError(`Entity ${entityId} not found`)
        if (fxFits(fx, amount.currency, e.baseCurrency)) return convert(amount, e.baseCurrency, fx.rate).minor
        return (await this.#toCurrency(amount, e.baseCurrency, date)).minor
      },
      classify: async (other) => this.#classify(ctx, other),
      booksStart: async (entityId) => this.#booksStart(ctx, entityId),
      position: async (entityId, positionId) => this.#position(ctx, entityId, positionId),
      document: async (connectionId, externalId) => this.store.findRecord(ctx.ws, connectionId, 'invoice.upsert', externalId),
    }
  }

  /** Every live investment.event of one position (few per position); remembers the issuer to name its account. */
  async #position(ctx: Ctx, entityId: EntityId, positionId: string): Promise<SourceRecord[]> {
    const rows = (await this.store.listRecords(ctx.ws, { entityIds: [entityId], eventTypes: ['investment.event'], statuses: ['posted'] })).filter(
      (r) => r.event.type === 'investment.event' && r.event.positionId === positionId,
    )
    const first = rows.find((r) => r.event.type === 'investment.event')
    if (first && first.event.type === 'investment.event') (ctx.issuers ??= new Map()).set(positionId, first.event.issuer)
    return rows
  }

  /** The entity's earliest bank, card or processor row, read once per operation. */
  async #booksStart(ctx: Ctx, entityId: EntityId): Promise<IsoDate | null> {
    const m = (ctx.booksStart ??= new Map())
    const known = m.get(entityId)
    if (known !== undefined) return known
    const [first] = await this.store.listRecords(ctx.ws, { entityIds: [entityId], eventTypes: [...MONEY_HISTORY], statuses: ['posted', 'recorded'], limit: 1 })
    const start = first?.date ?? null
    m.set(entityId, start)
    return start
  }

  /** The account whose ledger lines a source account's rows land in: itself, or the primary it duplicates. */
  #ledgerAccountOf(ctx: Ctx, id: Id | null): SourceAccountInfo | null {
    const a = id ? ctx.accounts.get(id) : undefined
    if (!a) return null
    return (a.duplicateOf ? ctx.accounts.get(a.duplicateOf) : undefined) ?? a
  }

  async #classify(ctx: Ctx, record: SourceRecord): Promise<Classification | null> {
    if (record.event.type !== 'txn.upsert' || !record.entityId) return null
    const pc = await this.#planContext(ctx, record)
    return classifyTxn(pc, record.event)
  }

  async #planRecord(ctx: Ctx, record: SourceRecord): Promise<Array<PlannedEntry & { basis: EntryBasis }>> {
    const pc = await this.#planContext(ctx, record)
    const [cash, accrual] = await Promise.all([plan(pc, 'cash'), plan(pc, 'accrual')])
    // Record which rules decided this record (once per rule and record).
    if (pc.rules && pc.rules.ruleIds.length > 0 && record.event.type === 'txn.upsert') await this.#recordRuleHits(ctx, record, pc.rules.ruleIds, pc.override)
    return mergeViews(cash, accrual)
  }

  async #recordRuleHits(ctx: Ctx, record: SourceRecord, ruleIds: string[], override: RecordOverride | null): Promise<void> {
    void override
    // A record this operation created has only the applications it added here (a page of new rows: no read each).
    const existing = ctx.ruleApplied?.get(record.id) ?? new Set((await this.store.listRuleApplications(ctx.ws, record.id)).map((a) => a.ruleId))
    for (const ruleId of ruleIds) {
      if (existing.has(ruleId)) continue
      existing.add(ruleId)
      const now = this.now()
      await this.store.addRuleApplication({ id: newId(), workspaceId: ctx.ws, ruleId, recordId: record.id, appliedAt: now })
      const rule = ctx.rules.find((r) => r.id === ruleId)
      if (rule) {
        rule.hitCount += 1
        rule.lastHitAt = now
        await this.store.saveRule(rule)
      }
    }
  }

  async #toCurrency(amount: { minor: number; currency: string }, to: string, date: string): Promise<{ minor: number; currency: string; rate: string }> {
    if (amount.currency === to) return { ...amount, rate: '1' }
    const rate = await this.#rate(date, amount.currency, to, true)
    return { ...convert(amount, to, rate as string), rate: rate as string }
  }

  /** In a transaction, from the cache only: `required` rolls back to fetch it; otherwise null, fetched after commit. */
  async #rate(date: string, from: string, to: string, required: boolean): Promise<string | null> {
    const tx = this.#tx.getStore()
    if (!tx || !this.rates.cached) return this.rates.rate(date, from, to)
    const hit = await this.rates.cached(date, from, to)
    if (hit) return hit
    if (required) throw new RateNeeded({ date, from, to })
    tx.missing.set(`${date}|${from}|${to}`, { date, from, to })
    return null
  }

  async #ledgerAccount(ctx: Ctx, entityId: EntityId, role: string): Promise<LedgerAccount> {
    const def = defineRole(role, this.#roleNames(ctx, role))
    const key = `${entityId}|${def.role}`
    if (!ctx.ledgerAccounts) {
      // The workspace's chart in one read (a few hundred accounts at most), instead of one lookup per role.
      ctx.ledgerAccounts = new Map()
      for (const a of await this.store.listLedgerAccounts(ctx.ws)) ctx.ledgerAccounts.set(`${a.entityId}|${a.role}`, a)
      if (ctx.base) ctx.base.ledgerAccounts = ctx.ledgerAccounts
    }
    const cached = ctx.ledgerAccounts.get(key)
    if (cached) return cached
    const acc: LedgerAccount = {
      id: newId(),
      workspaceId: ctx.ws,
      entityId,
      role: def.role,
      code: def.code,
      name: def.name,
      type: def.type,
      normalBalance: def.normalBalance,
      createdAt: this.now(),
    }
    await this.store.createLedgerAccount(acc)
    ctx.ledgerAccounts.set(key, acc)
    return acc
  }

  #roleNames(ctx: Ctx, role: string): { sourceAccountName?: string; entityName?: string } {
    const param = role.includes(':') ? role.slice(role.indexOf(':') + 1) : ''
    if (!param) return {}
    const acc = ctx.accounts.get(param)
    const ent = ctx.entities.get(param)
    const out: { sourceAccountName?: string; entityName?: string } = {}
    if (role.startsWith('investment:')) {
      const issuer = ctx.issuers?.get(param)
      return issuer ? { sourceAccountName: issuer } : {}
    }
    if (acc) out.sourceAccountName = acc.mask ? `${acc.name} ··${acc.mask}` : acc.name
    if (ent) out.entityName = ent.name
    return out
  }

  /** Resolve planned lines to journal entries (base amounts, rounding, FX plug); replace active entries if they differ. */
  async #writeSource(ctx: Ctx, sourceId: Id, planned: Array<PlannedEntry & { basis: EntryBasis }>, _entityId: EntityId | null): Promise<void> {
    const ws = ctx.ws
    const fresh: JournalEntry[] = []
    for (const p of planned) fresh.push(await this.#resolveEntry(ctx, sourceId, p))
    const active = ctx.entries?.get(sourceId) ?? (await this.store.activeEntriesForSource(ws, sourceId))
    if (sameEntries(active, fresh)) {
      ctx.entries?.set(sourceId, active)
      return
    }
    // A closed period stays as it was reported: what changed in it posts on the first open day instead.
    if (ctx.locks.size > 0) {
      for (const [i, e] of fresh.entries()) fresh[i] = intoOpenPeriod(e, ctx.locks)
      if (sameEntries(active, fresh)) {
        ctx.entries?.set(sourceId, active)
        return
      }
    }
    for (const e of active) {
      const rev = intoOpenPeriod(reversal(e, newId(), this.now()), ctx.locks)
      await this.store.insertEntry(rev)
      await this.store.markReversed(ws, e.id, rev.id)
    }
    for (const e of fresh) await this.store.insertEntry(e)
    ctx.entries?.set(sourceId, fresh)
  }

  async #resolveEntry(ctx: Ctx, sourceId: Id, p: PlannedEntry & { basis: EntryBasis }): Promise<JournalEntry> {
    const entity = ctx.entities.get(p.entityId)
    if (!entity) throw new PostingError(`Entity ${p.entityId} not found`)
    const base = entity.baseCurrency
    const entryId = newId()
    type Draft = { role: string; minor: number; currency: string; base: number; rate: string; explicit: boolean; bucketId: string | null; memo: string | null }
    const drafts: Draft[] = []
    for (const l of p.lines) {
      if (l.baseMinor !== undefined) {
        const rate = l.amount.minor === 0 ? '0' : impliedRate(l.amount, { minor: l.baseMinor, currency: base })
        drafts.push({ role: l.role, minor: l.amount.minor, currency: l.amount.currency, base: l.baseMinor, rate, explicit: true, bucketId: l.bucketId ?? null, memo: l.memo ?? null })
      } else if (fxFits(p.fx, l.amount.currency, base)) {
        // The provider's own rate for this document, so it matches their books to the cent.
        const conv = convert(l.amount, base, p.fx.rate)
        drafts.push({ role: l.role, minor: l.amount.minor, currency: l.amount.currency, base: conv.minor, rate: p.fx.rate, explicit: false, bucketId: l.bucketId ?? null, memo: l.memo ?? null })
      } else {
        const conv = await this.#toCurrency(l.amount, base, p.date)
        drafts.push({ role: l.role, minor: l.amount.minor, currency: l.amount.currency, base: conv.minor, rate: conv.rate, explicit: false, bucketId: l.bucketId ?? null, memo: l.memo ?? null })
      }
    }
    const residual = drafts.reduce((s, d) => s + d.base, 0)
    if (residual !== 0) {
      if (drafts.some((d) => d.explicit)) {
        // Realized FX: settling at a different rate than the one it was booked at.
        drafts.push({ role: 'fx_gain_loss', minor: -residual, currency: base, base: -residual, rate: '1', explicit: true, bucketId: null, memo: 'Realized FX' })
      } else {
        const candidates = drafts.filter((d) => d.currency !== base)
        if (candidates.length === 0 || Math.abs(residual) > drafts.length) {
          throw new PostingError(`Entry for ${sourceId} is out of balance by ${residual} after conversion`)
        }
        // Rounding from converting each line separately: absorb it in the largest foreign line.
        const target = candidates.reduce((a, b) => (Math.abs(b.base) > Math.abs(a.base) ? b : a))
        target.base -= residual
      }
    }
    const lines: JournalLine[] = []
    for (const d of drafts) {
      if (d.minor === 0 && d.base === 0) continue
      const acct = await this.#ledgerAccount(ctx, p.entityId, d.role)
      // A line whose original amount and base amount have opposite signs (rare FX edge) is split by sign on each side.
      lines.push({
        id: newId(),
        entryId,
        ledgerAccountId: acct.id,
        debitMinor: Math.max(d.minor, 0),
        creditMinor: Math.max(-d.minor, 0),
        currency: d.currency,
        baseDebitMinor: Math.max(d.base, 0),
        baseCreditMinor: Math.max(-d.base, 0),
        fxRate: d.rate,
        bucketId: d.bucketId,
        memo: d.memo,
      })
    }
    return {
      id: entryId,
      workspaceId: ctx.ws,
      entityId: p.entityId,
      date: p.date,
      basis: p.basis,
      kind: p.kind,
      sourceId,
      memo: p.memo,
      reversesId: null,
      reversedById: null,
      createdAt: this.now(),
      lines,
    }
  }

  /**
   * Void (or restore) a record that a person or AI added. Its entries are reversed and its links unwound.
   * Synced records can't be voided; they're marked duplicate or excluded instead.
   */
  async setVoided(ws: WorkspaceId, recordId: Id, voided: boolean): Promise<SourceRecord> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        const r = await this.store.getRecord(ws, recordId)
        if (!r) throw new PostingError(`Record ${recordId} not found`)
        const now = this.now()
        let updated: SourceRecord
        if (voided) {
          updated = { ...r, status: 'void', updatedAt: now }
          await this.store.saveRecord(updated)
          await this.#unwindLinks(ctx, recordId)
        } else {
          const res = await this.#resolve(ctx, r.event, r.entityId)
          updated = { ...r, ...res, updatedAt: now }
          await this.store.saveRecord(updated)
          for (const l of await this.store.listLinks(ws, { recordId })) {
            if (l.decidedBy === 'void') {
              await this.store.saveLink({ ...l, status: 'confirmed', decidedBy: 'restored', decidedAt: now })
              const other = await this.store.getRecord(ws, l.fromId === recordId ? l.toId : l.fromId)
              if (other) await this.#repost(ctx, other)
            }
          }
        }
        await this.#repost(ctx, updated)
        if (updated.sourceAccountId) await this.#refreshOpening(ctx, updated.sourceAccountId)
        return updated
      }),
    )
  }

  /** Replace a record's override wholesale (used by undo). null removes it. */
  async restoreOverride(ws: WorkspaceId, recordId: Id, previous: RecordOverride | null): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        const record = await this.store.getRecord(ws, recordId)
        if (!record) return
        await this.store.saveOverride(previous ?? { recordId, workspaceId: ws, updatedBy: null, updatedAt: this.now() })
        await this.#repost(ctx, record)
        await this.#repostLinked(ctx, recordId)
      }),
    )
  }

  // ---------------------------------------------------------------------------------------------
  // Opening balances: the first provider balance fixes where the ledger starts.
  // ---------------------------------------------------------------------------------------------

  async #refreshOpening(ctx: Ctx, accountId: Id): Promise<void> {
    const acc = await this.directory.getSourceAccount(ctx.ws, accountId)
    if (!acc) return
    const sourceId = `opening:${accountId}`
    if (!acc.entityId || acc.duplicateOf || acc.currency === NOT_MONEY) {
      await this.#writeSource(ctx, sourceId, [], null)
      // Its rows moved the primary's history, so the primary's opening balance may change.
      if (acc.duplicateOf && acc.duplicateOf !== accountId) await this.#refreshOpening(ctx, acc.duplicateOf)
      return
    }
    // The first day's snapshots only; the earliest `at` wins.
    const early = await this.store.listRecords(ctx.ws, { sourceAccountId: accountId, eventTypes: ['balance.snapshot'], statuses: ['recorded'], limit: 10 })
    const first = early
      .filter((r) => r.event.type === 'balance.snapshot' && r.date === early[0]?.date)
      .sort((a, b) => ((a.event as { at: string }).at < (b.event as { at: string }).at ? -1 : 1))[0]
    if (!first || first.event.type !== 'balance.snapshot') {
      await this.#writeSource(ctx, sourceId, [], null)
      return
    }
    const role = cashRole(acc.id, acc.accountType)
    const snap = first.event
    const snapDate = first.date
    // Only changes on or before the first balance read move the opening: a page of later rows leaves it alone.
    const from = ctx.dirtyFrom?.get(accountId)
    if (from !== undefined && from > snapDate) return
    const ledgerAcct = await this.#ledgerAccount(ctx, acc.entityId, role)
    // Movements up to the snapshot (in its currency), and the earliest movement in any currency.
    const totals = await this.store.accountTotals(ctx.ws, { basis: 'cash', ledgerAccountIds: [ledgerAcct.id], toDate: snapDate, excludeSourceId: sourceId })
    const moved = totals.filter((t) => t.currency === snap.current.currency).reduce((s, t) => s + t.debitMinor - t.creditMinor, 0)
    const opening = snap.current.minor - moved
    const earliest = totals.reduce<string | null>((m, t) => (t.firstDate !== null && (m === null || t.firstDate < m) ? t.firstDate : m), null)
    const date = earliest && earliest <= snapDate ? dayBefore(earliest) : snapDate
    const cur = snap.current.currency
    const planned: Array<PlannedEntry & { basis: EntryBasis }> =
      opening === 0
        ? []
        : [
            {
              entityId: acc.entityId,
              date,
              kind: 'other',
              memo: `Opening balance from ${acc.name}`,
              basis: 'both',
              lines: [
                { role, amount: { minor: opening, currency: cur } },
                { role: 'opening_balance_equity', amount: { minor: -opening, currency: cur } },
              ],
            },
          ]
    await this.#writeSource(ctx, sourceId, planned, acc.entityId)
  }

  // ---------------------------------------------------------------------------------------------
  // Links
  // ---------------------------------------------------------------------------------------------

  /** Contract: record a link. exact_id/human/agent links and rule/fuzzy at ≥ 0.95 are confirmed; the rest are proposed for Review. */
  async link(ws: WorkspaceId, proposal: LinkProposal, opts: { createdBy?: string | null; scores?: Record<string, number> } = {}): Promise<{ linkId: Id; status: 'confirmed' | 'proposed' }> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        return this.#link(ctx, proposal, opts.createdBy ?? null, opts.scores ?? null)
      }),
    )
  }

  async #link(ctx: Ctx, p: LinkProposal, createdBy: string | null, scores: Record<string, number> | null): Promise<{ linkId: Id; status: 'confirmed' | 'proposed' }> {
    const ws = ctx.ws
    if (p.fromId === p.toId) throw new LinkError('A record cannot link to itself')
    if (!(p.confidence >= 0 && p.confidence <= 1)) throw new LinkError('confidence must be between 0 and 1')
    const [from, to] = await Promise.all([this.store.getRecord(ws, p.fromId), this.store.getRecord(ws, p.toId)])
    if (!from || !to) throw new LinkError('Both records must exist in this workspace')
    checkLinkShape(p, from, to)
    const existing = (await this.store.listLinks(ws, { recordId: p.fromId })).find((l) => l.type === p.type && l.fromId === p.fromId && l.toId === p.toId)
    const autoConfirm = p.method === 'exact_id' || p.method === 'human' || p.method === 'agent' || p.confidence >= AUTO_CONFIRM
    if (existing) {
      if (existing.status === 'rejected' && (p.method === 'human' || p.method === 'agent')) {
        return this.#decide(ctx, existing, 'confirmed', createdBy)
      }
      // A filing the person undid stays a question: only they can confirm it again.
      const undone = existing.scores?.['noAuto'] === 1 && p.method !== 'human' && p.method !== 'agent'
      if (existing.status === 'proposed' && autoConfirm && !undone) return this.#decide(ctx, existing, 'confirmed', createdBy)
      return { linkId: existing.id, status: existing.status === 'confirmed' ? 'confirmed' : 'proposed' }
    }
    // Without an explicit amount, a link explains the smaller of the two sightings (one debit of a payroll run). A
    // processor row counts at gross: a charge pays an invoice in full, its fee comes out of the balance after.
    const sighting = (r: SourceRecord): Money | null => (r.event.type === 'processor.balance_txn' ? r.event.gross : r.amount)
    const [fa, ta] = [sighting(from), sighting(to)]
    const implied =
      !p.amount && fa && ta && fa.currency === ta.currency && p.type !== 'duplicate' && p.type !== 'pending_posted'
        ? { minor: Math.min(Math.abs(fa.minor), Math.abs(ta.minor)), currency: fa.currency }
        : null
    const link: Link = {
      id: newId(),
      workspaceId: ws,
      type: p.type,
      fromId: p.fromId,
      toId: p.toId,
      amount: p.amount ?? implied,
      confidence: p.confidence,
      method: p.method,
      status: 'proposed',
      scores,
      createdBy,
      decidedBy: null,
      decidedAt: null,
      createdAt: this.now(),
    }
    if (autoConfirm) {
      await this.#assertCapacity(ctx, link, from, to)
      link.status = 'confirmed'
      link.decidedBy = p.method === 'human' || p.method === 'agent' ? createdBy : `auto:${p.method}`
      link.decidedAt = this.now()
    }
    await this.store.saveLink(link)
    ctx.unlinked?.delete(link.fromId)
    ctx.unlinked?.delete(link.toId)
    if (link.status === 'confirmed' || holdsCopy(link)) await this.#afterLinkChange(ctx, link)
    return { linkId: link.id, status: link.status === 'confirmed' ? 'confirmed' : 'proposed' }
  }

  /** Confirm or reject a proposed link (Review), or unlink a confirmed one (status 'rejected'). */
  async decideLink(ws: WorkspaceId, linkId: Id, decision: 'confirmed' | 'rejected' | 'proposed', decidedBy: string | null): Promise<{ linkId: Id; status: Link['status'] }> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        const link = await this.store.getLink(ws, linkId)
        if (!link) throw new LinkError(`Link ${linkId} not found`)
        const r = await this.#decide(ctx, link, decision, decidedBy)
        // No to a move is no for these two rows, whichever type an older proposal gave them.
        if (decision === 'rejected' && (link.type === 'transfer' || link.type === 'card_payment' || link.type === 'intercompany')) {
          for (const other of await this.store.listLinks(ws, { recordId: link.fromId, statuses: ['proposed'] })) {
            if (other.id !== link.id && other.fromId === link.fromId && other.toId === link.toId) await this.#decide(ctx, other, 'rejected', decidedBy)
          }
        }
        // One payment of two invoices is one answer: its other half follows.
        if (link.scores?.['pair'] === 1) {
          for (const other of await this.store.listLinks(ws, { recordId: link.toId })) {
            if (other.id !== link.id && other.toId === link.toId && other.type === link.type && other.scores?.['pair'] === 1 && other.status !== decision) await this.#decide(ctx, other, decision, decidedBy)
          }
        }
        return { linkId: r.linkId, status: decision }
      }),
    )
  }

  async #decide(ctx: Ctx, link: Link, decision: 'confirmed' | 'rejected' | 'proposed', by: string | null): Promise<{ linkId: Id; status: 'confirmed' | 'proposed' }> {
    if (link.status === decision) return { linkId: link.id, status: decision === 'confirmed' ? 'confirmed' : 'proposed' }
    if (decision === 'confirmed') {
      const [from, to] = await Promise.all([this.store.getRecord(ctx.ws, link.fromId), this.store.getRecord(ctx.ws, link.toId)])
      if (!from || !to) throw new LinkError('Linked records no longer exist')
      await this.#assertCapacity(ctx, link, from, to)
    }
    const wasConfirmed = link.status === 'confirmed'
    const updated: Link = decision === 'proposed' ? { ...link, status: 'proposed', decidedBy: null, decidedAt: null } : { ...link, status: decision, decidedBy: by, decidedAt: this.now() }
    await this.store.saveLink(updated)
    ctx.unlinked?.delete(updated.fromId)
    ctx.unlinked?.delete(updated.toId)
    if (wasConfirmed || decision === 'confirmed' || holdsCopy(link)) await this.#afterLinkChange(ctx, updated)
    return { linkId: link.id, status: decision === 'confirmed' ? 'confirmed' : 'proposed' }
  }

  async #assertCapacity(ctx: Ctx, link: Link, from: SourceRecord, to: SourceRecord): Promise<void> {
    if (link.type === 'duplicate' || link.type === 'pending_posted') return
    for (const r of [from, to]) {
      // A processor charge pays an invoice with its gross (the fee comes out after), not its net.
      const total = Math.abs(r.event.type === 'processor.balance_txn' ? r.event.gross.minor : (r.amount?.minor ?? 0))
      if (total === 0) continue
      // A record's own side can be split across several links up to its amount (one payment, many invoices).
      const confirmed = (await this.store.listLinks(ctx.ws, { recordId: r.id, statuses: ['confirmed'] })).filter(
        (l) => l.id !== link.id && l.type !== 'duplicate' && l.type !== 'pending_posted',
      )
      const used = confirmed.reduce((s, l) => s + (l.amount ? Math.abs(l.amount.minor) : total), 0)
      const want = link.amount ? Math.abs(link.amount.minor) : total
      if (used + want > total) throw new LinkError(`Record ${r.id} is already explained by other links (${used} of ${total})`)
    }
  }

  async #afterLinkChange(ctx: Ctx, link: Link): Promise<void> {
    for (const id of [link.fromId, link.toId]) {
      const r = await this.store.getRecord(ctx.ws, id)
      if (r) {
        await this.#repost(ctx, r)
        if (r.sourceAccountId) {
          if (ctx.dirty) ctx.dirty.add(r.sourceAccountId)
          else await this.#refreshOpening(ctx, r.sourceAccountId)
        }
      }
    }
  }

  /** Contract: every match the engine can see (exact, rule, fuzzy), without writing anything. */
  async suggestLinks(ws: WorkspaceId, since?: IsoTimestamp): Promise<LinkProposal[]> {
    const ctx = await this.#ctx(ws)
    return (await this.#matches(ctx, since)).map(({ reason: _r, scores: _s, ...p }) => p)
  }

  /**
   * Suggestions touching these records only (a write just added them). Bank and processor rows use the same focused
   * read a sync page does: other bank and processor rows near their dates, everything else whole. The whole-workspace pass took most of add_entry
   * on a year of demo books.
   */
  async suggestLinksFor(ws: WorkspaceId, records: SourceRecord[]): Promise<LinkProposal[]> {
    if (!records.length) return []
    const ctx = await this.#ctx(ws)
    const ids = new Set(records.map((r) => r.id))
    // An invoice, payment or equity event can match bank money far from its own date: those keep the whole pass.
    const focus = records.every((r) => (WINDOWED_TYPES as readonly string[]).includes(r.eventType)) ? records : undefined
    return (await this.#matches(ctx, undefined, focus)).filter((m) => ids.has(m.fromId) || ids.has(m.toId)).map(({ reason: _r, scores: _s, ...p }) => p)
  }

  /**
   * Matching input. With `focus` (the records a sync page touched), bank and processor rows are read only within
   * MATCH_WINDOW_DAYS of them; invoices, payments, payroll and equity are always read whole, since an old invoice can
   * be paid today. Every pass looks at most a few days apart, except invoices, so nothing is missed.
   */
  async #matches(ctx: Ctx, since?: IsoTimestamp, focus?: SourceRecord[]): Promise<Proposal[]> {
    const ws = ctx.ws
    const statuses: SourceRecord['status'][] = ['posted', 'recorded']
    let all: SourceRecord[]
    let links: Link[]
    const dates = (focus ?? []).map((r) => r.date).sort()
    if (focus && dates.length) {
      const fromDate = addDays(dates[0] as string, -MATCH_WINDOW_DAYS)
      const toDate = addDays(dates[dates.length - 1] as string, MATCH_WINDOW_DAYS)
      const [rows, other] = await Promise.all([
        this.store.listRecords(ws, { statuses, eventTypes: [...WINDOWED_TYPES], fromDate, toDate }),
        this.store.listRecords(ws, { statuses, excludeEventTypes: [...WINDOWED_TYPES, 'balance.snapshot', 'account.upsert'] }),
      ])
      const byId = new Map([...rows, ...other].map((r) => [r.id, r]))
      for (const r of focus) if (statuses.includes(r.status) && !byId.has(r.id)) byId.set(r.id, r)
      all = [...byId.values()]
      links = await this.store.listLinks(ws, { recordIds: all.map((r) => r.id) })
    } else {
      all = await this.store.listRecords(ws, { statuses })
      links = await this.store.listLinks(ws)
    }
    const records = all.filter((r) => r.entityId !== null && r.eventType !== 'account.upsert' && r.eventType !== 'balance.snapshot')
    const reportingCurrency = await this.directory.reportingCurrency(ws)
    const reportingMinor = new Map<Id, number>()
    for (const r of records) {
      if (r.eventType !== 'txn.upsert' || !r.amount) continue
      if (r.amount.currency === reportingCurrency) {
        reportingMinor.set(r.id, r.amount.minor)
        continue
      }
      // No rate at hand: this record just won't match across currencies this time.
      const rate = await this.#rate(r.date, r.amount.currency, reportingCurrency, false).catch(() => null)
      if (rate) reportingMinor.set(r.id, convert(r.amount, reportingCurrency, rate).minor)
    }
    const uploadConns = new Set([...(await this.#connections(ctx)).values()].filter((c) => c.connectorKey === 'files').map((c) => c.id))
    const uploadedAccounts = new Set([...ctx.accounts.values()].filter((a) => a.connectionId !== null && uploadConns.has(a.connectionId)).map((a) => a.id))
    // All history, not this pass's window: the last confirmed move between two accounts can be months old.
    const confirmedMoves = (await this.store.listLinks(ws, { types: ['transfer'], statuses: ['confirmed'] })).filter((l) => l.decidedBy && !l.decidedBy.startsWith('auto:'))
    const moveRows = new Map((await this.store.getRecords(ws, [...new Set(confirmedMoves.flatMap((l) => [l.fromId, l.toId]))])).map((r) => [r.id, r.sourceAccountId]))
    const knownPairs = new Set(confirmedMoves.map((l) => accountPair(moveRows.get(l.fromId) ?? null, moveRows.get(l.toId) ?? null)))
    const found = await findMatchesYielding({ knownPairs, records, accounts: ctx.accounts, entities: ctx.entities, links, reportingMinor, uploadedAccounts })
    // What a person already said this money is ("Revenue", a category) isn't asked again as a guessed match.
    const answered = new Set((await this.store.listOverrides(ws)).filter((o) => o.kind !== undefined || o.category !== undefined).map((o) => o.recordId))
    // Only synced rows: a hand-added entry's category is part of what it is, and it may still be a duplicate.
    for (const r of records) if (r.origin !== 'connector') answered.delete(r.id)
    const proposals = answered.size ? found.filter((p) => p.method === 'exact_id' || (!answered.has(p.fromId) && !answered.has(p.toId))) : found
    if (!since) return proposals
    const recent = new Set(records.filter((r) => r.updatedAt >= since).map((r) => r.id))
    return proposals.filter((p) => recent.has(p.fromId) || recent.has(p.toId))
  }

  /** Run matching and apply it: auto-confirm what clears the bar, store the rest as proposals for Review. */
  async reconcile(ws: WorkspaceId, since?: IsoTimestamp): Promise<{ confirmed: number; proposed: number }> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        ctx.dirty = new Set()
        const out = await this.#applyMatches(ctx, await this.#matches(ctx, since))
        for (const acc of ctx.dirty) await this.#refreshOpening(ctx, acc)
        return out
      }),
    )
  }

  async #applyMatches(ctx: Ctx, proposals: Proposal[]): Promise<{ confirmed: number; proposed: number }> {
    let confirmed = 0
    let proposed = 0
    // Every record a proposal touches gets its links read now, in a few queries; linking and reposting then reads
    // them from the store's per-transaction cache instead of one query per record.
    if (proposals.length > 1) {
      const ids = [...new Set(proposals.flatMap((p) => [p.fromId, p.toId]))]
      await this.store.listLinks(ctx.ws, { recordIds: ids })
      // Their records and current entries too: each link reposts both sides.
      await this.store.prefetchRecords?.(ctx.ws, ids)
      await this.store.prefetchActiveEntries?.(ctx.ws, ids)
    }
    for (const p of proposals) {
      try {
        const res = await this.#link(ctx, p, null, p.scores ?? null)
        if (res.status === 'confirmed') confirmed++
        else proposed++
      } catch (err) {
        if (!(err instanceof LinkError)) throw err
        // Lost a race with another link for the same amount: leave it for Review as a proposal.
        await this.#link(ctx, { ...p, confidence: Math.min(p.confidence, 0.94), method: p.method === 'exact_id' ? 'rule' : p.method }, null, p.scores ?? null)
        proposed++
      }
    }
    return { confirmed, proposed }
  }

  async #autoLink(ctx: Ctx, touched: SourceRecord[]): Promise<void> {
    if (touched.length === 0) return
    const ids = new Set(touched.map((t) => t.id))
    const matches = (await this.#matches(ctx, undefined, touched)).filter((p) => ids.has(p.fromId) || ids.has(p.toId))
    // Certain matches are confirmed; the rest are stored as proposals so they show up in Review right away.
    await this.#applyMatches(ctx, matches)
  }

  // ---------------------------------------------------------------------------------------------
  // Overrides: what a person or AI said about a record (whose money, kind, category, bucket, exclude).
  // ---------------------------------------------------------------------------------------------

  async setOverride(ws: WorkspaceId, recordId: Id, patch: Omit<Partial<RecordOverride>, 'recordId' | 'workspaceId' | 'updatedAt' | 'updatedBy'>, updatedBy: string | null): Promise<RecordOverride> {
    const next = await this.#setOverride(ws, recordId, patch, updatedBy)
    // The same answer given by hand a few times becomes a suggested rule in Review. A failed suggestion never fails
    // the answer itself.
    if (patch.category || patch.kind || patch.bucketId || patch.forEntityId) await this.suggestRules(ws).catch(() => [])
    return next
  }

  async #setOverride(ws: WorkspaceId, recordId: Id, patch: Omit<Partial<RecordOverride>, 'recordId' | 'workspaceId' | 'updatedAt' | 'updatedBy'>, updatedBy: string | null): Promise<RecordOverride> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        const record = await this.store.getRecord(ws, recordId)
        if (!record) throw new PostingError(`Record ${recordId} not found`)
        if (patch.category) defineRole(patch.category)
        for (const e of [patch.forEntityId, patch.ownerEntityId]) {
          if (e && !ctx.entities.has(e)) throw new PostingError(`Unknown entity ${e}`)
        }
        if (patch.ownerEntityId && ctx.entities.get(patch.ownerEntityId)?.kind !== 'personal') throw new PostingError('ownerEntityId must be a personal entity')
        if (patch.bucketId && !(await this.store.getBucket(ws, patch.bucketId))) throw new PostingError(`Unknown bucket ${patch.bucketId}`)
        const prev = await this.store.getOverride(ws, recordId)
        const next: RecordOverride = { ...(prev ?? {}), ...stripUndefined(patch), recordId, workspaceId: ws, updatedBy, updatedAt: this.now() }
        await this.store.saveOverride(next)
        await this.#repost(ctx, record)
        await this.#repostLinked(ctx, record.id)
        return next
      }),
    )
  }

  // ---------------------------------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------------------------------

  async createRule(ws: WorkspaceId, input: Pick<Rule, 'name' | 'conditions' | 'actions'> & Partial<Pick<Rule, 'priority' | 'origin' | 'createdBy' | 'status'>>): Promise<Rule> {
    validateRule(input.conditions, input.actions)
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        if (input.actions.forEntityId && !ctx.entities.has(input.actions.forEntityId)) throw new PostingError(`Unknown entity ${input.actions.forEntityId}`)
        if (input.actions.bucketId && !(await this.store.getBucket(ws, input.actions.bucketId))) throw new PostingError(`Unknown bucket ${input.actions.bucketId}`)
        const rule: Rule = {
          id: newId(),
          workspaceId: ws,
          name: input.name,
          // Without a priority, a new rule runs after every existing one (first match wins, so older rules lead).
          priority: input.priority ?? Math.max(100, ...ctx.rules.map((r) => r.priority + 1)),
          conditions: input.conditions,
          actions: input.actions,
          status: input.status ?? 'active',
          origin: input.origin ?? 'user',
          createdBy: input.createdBy ?? null,
          hitCount: 0,
          lastHitAt: null,
          createdAt: this.now(),
        }
        await this.store.saveRule(rule)
        this.#forgetCtx(ws)
        if (rule.status === 'active') await this.#repostAllTxns(await this.#ctx(ws))
        return rule
      }),
    )
  }

  async setRuleStatus(ws: WorkspaceId, ruleId: Id, status: Rule['status']): Promise<Rule> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const rule = await this.store.getRule(ws, ruleId)
        if (!rule) throw new PostingError(`Rule ${ruleId} not found`)
        const changedActive = (rule.status === 'active') !== (status === 'active')
        rule.status = status
        await this.store.saveRule(rule)
        this.#forgetCtx(ws)
        if (changedActive) await this.#repostAllTxns(await this.#ctx(ws))
        return rule
      }),
    )
  }

  /** Patterns people/AIs repeated by hand; stored as 'suggested' rules for Review (idempotent). */
  async suggestRules(ws: WorkspaceId): Promise<Rule[]> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        // Only rows someone answered by hand can teach a rule: read those, not every transaction.
        const [overrides, rules] = await Promise.all([this.store.listOverrides(ws), this.store.listRules(ws)])
        const records = overrides.length ? (await this.store.getRecords(ws, overrides.map((o) => o.recordId))).filter((r) => r.eventType === 'txn.upsert') : []
        const found: RuleSuggestion[] = suggestRules(records, new Map(overrides.map((o) => [o.recordId, o])), rules, this.ruleSuggestThreshold)
        const created: Rule[] = []
        for (const s of found) {
          const rule: Rule = {
            id: newId(),
            workspaceId: ws,
            name: s.name,
            priority: 100,
            conditions: s.conditions,
            actions: s.actions,
            status: 'suggested',
            origin: 'learned',
            createdBy: null,
            hitCount: 0,
            lastHitAt: null,
            createdAt: this.now(),
          }
          await this.store.saveRule(rule)
          this.#forgetCtx(ws)
          created.push(rule)
        }
        return created
      }),
    )
  }

  async #repostAllTxns(ctx: Ctx): Promise<void> {
    const recs = await this.store.listRecords(ctx.ws, { eventTypes: ['txn.upsert'], statuses: ['posted'] })
    for (const r of recs) await this.#repost(ctx, r)
  }

  /** Rebuild every entry from source records (after a posting-rule change, or to verify determinism). */
  async rebuild(ws: WorkspaceId): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const ctx = await this.#ctx(ws)
        for (const r of await this.store.listRecords(ws)) await this.#repost(ctx, r)
        for (const a of ctx.accounts.values()) await this.#refreshOpening(ctx, a.id)
      }),
    )
  }

  // ---------------------------------------------------------------------------------------------
  // Metrics
  // ---------------------------------------------------------------------------------------------

  async metric(name: MetricName, scope: MetricScope): Promise<CoreMetricAnswer> {
    // One request: shared reads (balances, coverage) once across the metric's parts.
    return computeMetric(name, scope, { ...this.metricContext(scope.workspaceId), memo: new Map() })
  }

  registerMetricProvider(name: MetricName, provider: MetricProvider): void {
    this.metricProviders.set(name, provider)
  }

  metricContext(ws: WorkspaceId): MetricContext {
    return {
      ws,
      store: this.store,
      directory: this.directory,
      now: this.now(),
      toCurrency: (amount, to, date) => this.#toCurrency(amount, to, date),
      engine: this,
      ...(this.#setAsides ? { setAsides: true } : {}),
      ...(this.#shareDerived ? { shared: this.#sharedFor(ws) } : {}),
    }
  }

  /**
   * One read context's shared-cache lookups: the workspace version is read once and reused for a moment, not once per
   * lookup (a cold overview read it 21 times, a round trip each on a pool of 3). A context that outlives the moment, or
   * this process writing meanwhile, reads it again.
   */
  #sharedFor(ws: WorkspaceId): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
    let held: { at: number; version: Promise<number> } | undefined
    const version = (): Promise<number> => {
      if (!held || Date.now() - held.at > VERSION_REUSE_MS) held = { at: Date.now(), version: this.#versionNow(ws) }
      const v = held.version
      v.catch(() => (held = undefined))
      return v
    }
    return (key, fn) => this.#shared(ws, key, fn, version)
  }

  /** Cash (the `cash` metric's rule) on each of these days, one pass: for trend lines. Reused until the next write. */
  async cashHistory(ws: WorkspaceId, opts: { entityIds: EntityId[]; days: IsoDate[] }): Promise<Array<Money | null>> {
    const rc = { ...this.metricContext(ws), memo: new Map<string, Promise<unknown>>() }
    const run = () => cashHistory(rc, opts.entityIds, opts.days)
    return rc.shared ? rc.shared(`cashHistory|${[...opts.entityIds].sort().join(',')}|${opts.days.join(',')}`, run) : run()
  }

  async checks(ws: WorkspaceId, opts: CheckOptions = {}): Promise<CheckResult[]> {
    return runChecks(this.metricContext(ws), opts)
  }

  /**
   * The current books as journal entries, for plain-text export (Beancount, hledger) and audits: no reversed entries
   * or reversals, each entry balanced in its company's base currency, lines carrying their account and both amounts.
   * Except changes to a closed period: the entry as reported and its reversal on the first open day both stay, so the
   * export agrees with the reports for every period.
   */
  async journal(ws: WorkspaceId, opts: { entityIds?: EntityId[]; from?: IsoDate; to?: IsoDate; basis?: Basis } = {}): Promise<JournalExport[]> {
    const basis = opts.basis ?? 'accrual'
    const f = { basis, ...(opts.entityIds ? { entityIds: opts.entityIds } : {}), ...(opts.from ? { fromDate: opts.from } : {}), ...(opts.to ? { toDate: opts.to } : {}) }
    const [active, moved] = await Promise.all([this.store.listActiveEntries(ws, f), this.store.listMovedReversals(ws, f)])
    const entries = moved.length === 0 ? active : [...active, ...moved].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    const accounts = new Map((await this.store.listLedgerAccounts(ws, opts.entityIds)).map((a) => [a.id, a]))
    return entries.map((e) => ({
      id: e.id,
      entityId: e.entityId,
      date: e.date,
      kind: e.kind,
      memo: e.memo,
      sourceId: e.sourceId,
      lines: e.lines.map((l) => {
        const a = accounts.get(l.ledgerAccountId)
        return {
          account: { id: l.ledgerAccountId, code: a?.code ?? '', name: a?.name ?? '', role: a?.role ?? '', type: a?.type ?? 'expense' },
          debitMinor: l.debitMinor,
          creditMinor: l.creditMinor,
          currency: l.currency,
          baseDebitMinor: l.baseDebitMinor,
          baseCreditMinor: l.baseCreditMinor,
          memo: l.memo,
        }
      }),
    }))
  }

  /**
   * Pin a balance: "this account held X on date D" (from a statement, a person or an AI). Nothing is posted; it
   * becomes a check that fails while the ledger disagrees. For cards and loans, X is the amount owed.
   */
  async addBalanceAssertion(
    ws: WorkspaceId,
    input: { accountId: Id; date: IsoDate; balance: Money; source?: string | null; createdBy?: string | null; provenance?: Provenance | null },
  ): Promise<BalanceAssertion> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new PostingError('date must be YYYY-MM-DD')
    if (!Number.isSafeInteger(input.balance.minor)) throw new PostingError('balance must be integer minor units')
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const acc = await this.directory.getSourceAccount(ws, input.accountId)
        if (!acc) throw new PostingError(`Unknown account ${input.accountId}`)
        const primary = acc.duplicateOf ? ((await this.directory.getSourceAccount(ws, acc.duplicateOf)) ?? acc) : acc
        if (input.balance.currency !== primary.currency) throw new PostingError(`${primary.name} is in ${primary.currency}, not ${input.balance.currency}`)
        const a: BalanceAssertion = {
          id: newId(),
          workspaceId: ws,
          accountId: primary.id,
          date: input.date,
          balance: input.balance,
          source: input.source?.trim().slice(0, 200) || null,
          createdBy: input.createdBy ?? null,
          provenance: input.provenance ?? null,
          createdAt: this.now(),
          removedAt: null,
        }
        await this.store.saveAssertion(a)
        return a
      }),
    )
  }

  async removeBalanceAssertion(ws: WorkspaceId, id: Id): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const a = await this.store.getAssertion(ws, id)
        if (!a) throw new PostingError(`Unknown balance assertion ${id}`)
        if (!a.removedAt) await this.store.saveAssertion({ ...a, removedAt: this.now() })
      }),
    )
  }

  async balanceAssertions(ws: WorkspaceId, accountIds?: Id[]): Promise<BalanceAssertion[]> {
    return this.store.listAssertions(ws, accountIds)
  }

  /**
   * Close a company's books through a date (a finished month, a filed return). Nothing already posted moves; a later
   * change to anything dated in the closed period posts as an adjustment on the first open day.
   */
  async lockPeriod(ws: WorkspaceId, input: { entityId: EntityId; through: IsoDate; note?: string | null; createdBy?: string | null; provenance?: Provenance | null }): Promise<PeriodLock> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.through) || Number.isNaN(Date.parse(input.through))) throw new PostingError('through must be YYYY-MM-DD')
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const entity = await this.directory.getEntity(ws, input.entityId)
        if (!entity) throw new PostingError(`Unknown entity ${input.entityId}`)
        const today = await todayFor(this.metricContext(ws))
        if (input.through >= today) throw new PostingError(`Only past days can be closed (today is ${today})`)
        const now = this.now()
        for (const old of await this.store.listPeriodLocks(ws)) if (old.entityId === input.entityId) await this.store.savePeriodLock({ ...old, removedAt: now })
        const lock: PeriodLock = {
          id: newId(),
          workspaceId: ws,
          entityId: input.entityId,
          through: input.through,
          note: input.note?.trim().slice(0, 200) || null,
          createdBy: input.createdBy ?? null,
          provenance: input.provenance ?? null,
          createdAt: now,
          removedAt: null,
        }
        await this.store.savePeriodLock(lock)
        this.#forgetCtx(ws)
        return lock
      }),
    )
  }

  /** Reopen a company's books. Adjustments already posted stay where they are. */
  async unlockPeriod(ws: WorkspaceId, entityId: EntityId): Promise<void> {
    await this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        this.#forgetCtx(ws)
        const now = this.now()
        for (const l of await this.store.listPeriodLocks(ws)) if (l.entityId === entityId) await this.store.savePeriodLock({ ...l, removedAt: now })
      }),
    )
  }

  /** The lock in force per company. */
  async periodLocks(ws: WorkspaceId): Promise<PeriodLock[]> {
    const current = new Map<EntityId, PeriodLock>()
    for (const l of await this.store.listPeriodLocks(ws)) current.set(l.entityId, l)
    return [...current.values()]
  }

  /** Per account and month: covered, missing, mismatched, in progress or not expected. */
  async coverage(ws: WorkspaceId, opts: CoverageOptions = {}): Promise<AccountCoverage[]> {
    return coverage(this.metricContext(ws), opts)
  }

  /**
   * MRR month by month: start, new, expansion, reactivation, contraction, churn, end, and churn rates, per customer.
   * In the workspace's reporting currency unless one is given.
   */
  async mrrMovements(ws: WorkspaceId, opts: { entityIds?: EntityId[]; from: string; to: string; currency?: string }): Promise<MrrMonth[]> {
    const rc = this.metricContext(ws)
    const entityIds = opts.entityIds ?? (await this.directory.listEntities(ws)).map((e) => e.id)
    return mrrMovements(rc, { entityIds, from: opts.from, to: opts.to, currency: opts.currency ?? (await this.directory.reportingCurrency(ws)) })
  }

  /** "Anything odd": duplicate charges, price rises, double billing, unusually large spend, missed payments. */
  async anomalies(ws: WorkspaceId, opts: AnomalyOptions = {}): Promise<Anomaly[]> {
    return findAnomalies(this.metricContext(ws), opts)
  }

  /** Monday note for the S9 sender: at most five plain lines, or null when there's nothing to say yet. */
  async weeklyDigest(ws: WorkspaceId, asOf: Date = new Date(this.now())): Promise<{ subject: string; lines: string[] } | null> {
    const d = await this.weeklyDigestDetail(ws, localDate(asOf.toISOString(), await zoneOf({ ws, directory: this.directory })))
    return d.hasData ? { subject: d.subject, lines: [...d.lines] } : null
  }

  /** The digest with the numbers behind each line. */
  async weeklyDigestDetail(ws: WorkspaceId, asOf?: string, entityIds: EntityId[] | 'all' = 'all'): Promise<WeeklyDigest> {
    return buildDigest({ ...this.metricContext(ws), memo: new Map() }, asOf, entityIds)
  }

  /** The Workspace's quiet "needs review" line, with counts and the items behind it. */
  async dataHealth(ws: WorkspaceId, entityIds: EntityId[] | 'all' = 'all'): Promise<DataHealth> {
    return dataHealth(this.metricContext(ws), entityIds)
  }

  async reviewItems(ws: WorkspaceId, opts: { entityIds?: EntityId[] } = {}): Promise<ReviewItem[]> {
    return listReviewItems(this.metricContext(ws), opts)
  }

  async profitAndLoss(ws: WorkspaceId, opts: Parameters<typeof profitAndLoss>[1]): Promise<ProfitAndLoss> {
    return profitAndLoss(this.metricContext(ws), opts)
  }

  async balanceSheet(ws: WorkspaceId, opts: Parameters<typeof balanceSheet>[1]): Promise<BalanceSheet> {
    return balanceSheet(this.metricContext(ws), opts)
  }

  async cashFlow(ws: WorkspaceId, opts: Parameters<typeof cashFlow>[1]): Promise<CashFlow> {
    return cashFlow(this.metricContext(ws), opts)
  }

  // ---------------------------------------------------------------------------------------------
  // Buckets
  // ---------------------------------------------------------------------------------------------

  async createBucket(
    ws: WorkspaceId,
    input: { entityId: EntityId; name: string; fields?: BucketField[]; values?: Record<string, unknown>; schedule?: BucketSchedule | null; setAside?: SetAside | null; origin?: WriteOrigin; createdBy?: string | null },
  ): Promise<Bucket> {
    const name = input.name.trim()
    if (!name || name.length > 100) throw new PostingError('Bucket name must be 1-100 characters')
    const fields = input.fields ?? []
    validateFields(fields)
    const values = validateValues(fields, input.values ?? {})
    if (input.schedule) validateSchedule(input.schedule)
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const entity = await this.directory.getEntity(ws, input.entityId)
        if (!entity) throw new PostingError(`Unknown entity ${input.entityId}`)
        if (input.setAside) validateSetAside(input.setAside, await this.directory.listSourceAccounts(ws), await this.store.listBuckets(ws))
        const now = this.now()
        const bucket: Bucket = {
          id: newId(),
          workspaceId: ws,
          entityId: input.entityId,
          name,
          fields,
          values,
          schedule: input.schedule ?? null,
          ...(input.setAside ? { setAside: input.setAside } : {}),
          createdBy: input.createdBy ?? null,
          origin: input.origin ?? 'ui',
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
        }
        await this.store.saveBucket(bucket)
        return bucket
      }),
    )
  }

  async updateBucket(ws: WorkspaceId, bucketId: Id, patch: { name?: string; fields?: BucketField[]; values?: Record<string, unknown>; schedule?: BucketSchedule | null; setAside?: SetAside | null; archived?: boolean }): Promise<Bucket> {
    return this.#exclusive(ws, () =>
      this.store.transaction(async () => {
        const b = await this.store.getBucket(ws, bucketId)
        if (!b) throw new PostingError(`Bucket ${bucketId} not found`)
        const fields = patch.fields ?? b.fields
        validateFields(fields)
        const values = validateValues(fields, patch.values ? { ...b.values, ...patch.values } : Object.fromEntries(Object.entries(b.values).filter(([k]) => fields.some((f) => f.key === k))))
        if (patch.schedule) validateSchedule(patch.schedule)
        const name = patch.name?.trim() ?? b.name
        if (!name || name.length > 100) throw new PostingError('Bucket name must be 1-100 characters')
        if (patch.setAside) validateSetAside(patch.setAside, await this.directory.listSourceAccounts(ws), (await this.store.listBuckets(ws)).filter((o) => o.id !== b.id))
        const updated: Bucket = {
          ...b,
          name,
          fields,
          values,
          schedule: patch.schedule === undefined ? b.schedule : patch.schedule,
          setAside: patch.setAside === undefined ? (b.setAside ?? null) : patch.setAside,
          archivedAt: patch.archived === undefined ? b.archivedAt : patch.archived ? (b.archivedAt ?? this.now()) : null,
          updatedAt: this.now(),
        }
        await this.store.saveBucket(updated)
        return updated
      }),
    )
  }

  async getBucket(ws: WorkspaceId, bucketId: Id, asOf?: string): Promise<BucketView | null> {
    const b = await this.store.getBucket(ws, bucketId)
    if (!b) return null
    return bucketView(this.metricContext(ws), b, asOf ?? (await todayFor(this.metricContext(ws))))
  }

  async listBuckets(ws: WorkspaceId, entityIds?: EntityId[], asOf?: string): Promise<BucketView[]> {
    const rc = this.metricContext(ws)
    const out: BucketView[] = []
    for (const b of await this.store.listBuckets(ws, entityIds)) if (!b.archivedAt) out.push(await bucketView(rc, b, asOf ?? (await todayFor(rc))))
    return out
  }

  /** The ledger record id for a posted event (for explicit links from other slices). */
  async recordIdFor(ws: WorkspaceId, connectionId: Id, type: NormalizedEvent['type'], externalId: string): Promise<Id | null> {
    return (await this.store.findRecord(ws, connectionId, type, externalId))?.id ?? null
  }

  /** Kind of the active entries for a record (for read APIs). */
  async entriesFor(ws: WorkspaceId, recordId: Id): Promise<JournalEntry[]> {
    return this.store.activeEntriesForSource(ws, recordId)
  }
}

// ---------- helpers ----------

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Content hash of an event, ignoring the raw payload pointer (a re-fetch with identical content is a duplicate). */
export function contentHash(ev: NormalizedEvent): string {
  const { rawRef: _raw, ...rest } = ev as NormalizedEvent & { rawRef?: string }
  return createHash('sha256').update(stableJson(rest)).digest('hex')
}

/** The record's calendar day. Instants (balances, processor rows) fall on the workspace's local day. */
export function eventDate(ev: NormalizedEvent, timeZone = 'UTC'): string {
  switch (ev.type) {
    case 'txn.upsert':
    case 'payment.applied':
    case 'credit_note.upsert':
    case 'equity.event':
    case 'investment.event':
    case 'journal.upsert':
      return ev.date
    case 'balance.snapshot':
    case 'processor.balance_txn':
      return localDate(ev.at, timeZone)
    case 'invoice.upsert':
      return ev.issueDate
    case 'payroll.run':
      return ev.payDate
    case 'report.snapshot':
      return ev.to
    default: {
      const e = ev as { date?: string; at?: string; startedAt?: string }
      return (e.date ?? e.at ?? e.startedAt ?? '1970-01-01').slice(0, 10)
    }
  }
}

export function eventAmount(ev: NormalizedEvent): { minor: number; currency: string } | null {
  switch (ev.type) {
    case 'txn.upsert':
    case 'payment.applied':
    case 'credit_note.upsert':
      return ev.amount
    case 'processor.balance_txn':
      return ev.net
    case 'invoice.upsert':
      return ev.total
    case 'payroll.run':
      return ev.companyDebit ?? ev.gross
    case 'equity.event':
    case 'investment.event':
      return ev.amount ?? null
    case 'balance.snapshot':
      return ev.current
    case 'journal.upsert': {
      // The debit side, in the first line's currency: what the journal moves.
      const cur = ev.lines[0]?.amount.currency ?? 'USD'
      return { minor: ev.lines.reduce((s, l) => s + (l.amount.currency === cur && l.amount.minor > 0 ? l.amount.minor : 0), 0), currency: cur }
    }
    default:
      return null
  }
}

function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Cash and accrual plans that agree become one 'both' entry; the rest keep their view. */
function mergeViews(cash: PlannedEntry[], accrual: PlannedEntry[]): Array<PlannedEntry & { basis: EntryBasis }> {
  const out: Array<PlannedEntry & { basis: EntryBasis }> = []
  // Each plan serialized once (not once per comparison): this ran for every posting.
  const rest = accrual.map((a) => ({ a, key: stableJson(a) }))
  for (const c of cash) {
    const key = stableJson(c)
    const i = rest.findIndex((r) => r.key === key)
    if (i >= 0) {
      rest.splice(i, 1)
      out.push({ ...c, basis: 'both' })
    } else out.push({ ...c, basis: 'cash' })
  }
  for (const { a } of rest) out.push({ ...a, basis: 'accrual' })
  return out
}

function entryShape(e: JournalEntry): string {
  return stableJson({
    entityId: e.entityId,
    date: e.date,
    basis: e.basis,
    kind: e.kind,
    memo: e.memo,
    lines: e.lines
      .map((l) => stableJson({ a: l.ledgerAccountId, d: l.debitMinor, c: l.creditMinor, cur: l.currency, bd: l.baseDebitMinor, bc: l.baseCreditMinor, b: l.bucketId, m: l.memo }))
      .sort((x, y) => (x < y ? -1 : 1)),
  })
}

/** An entry dated in a closed period, moved to the day after the lock (the original date kept in the memo). */
function intoOpenPeriod(e: JournalEntry, locks: Map<EntityId, IsoDate>): JournalEntry {
  const through = locks.get(e.entityId)
  if (!through || e.date > through) return e
  const memo = `Change to closed period (${e.date})${e.memo ? `: ${e.memo}` : ''}`
  return { ...e, date: addDays(through, 1), memo }
}

type RateNeed = { date: string; from: string; to: string }
type CtxBase = { entities: Map<EntityId, EntityInfo>; accounts: Map<Id, SourceAccountInfo>; rules: Rule[]; locks: Map<EntityId, IsoDate>; timeZone: string; ledgerAccounts?: Map<string, LedgerAccount>; connections?: Map<Id, ConnectionInfo> }
/**
 * One ledger transaction's state. Writes nested in it (a writer apply, the demo tidy) reuse what the first one loaded
 * (entities, accounts, rules, locks, chart) and take the workspace lock and bump the version only once: on a hosted
 * database each of those is a round trip.
 */
type TxState = { missing: Map<string, RateNeed>; base?: Map<WorkspaceId, CtxBase>; locked?: Set<WorkspaceId>; bumped?: Set<WorkspaceId> }

/** A posting needs a rate the cache doesn't have: the transaction is rolled back, the rate fetched, the work rerun. */
class RateNeeded extends Error {
  override name = 'RateNeeded'
  readonly need: RateNeed
  constructor(need: RateNeed) {
    super(`No ${need.from}->${need.to} rate for ${need.date}`)
    this.need = need
  }
}

function isListingComplete(e: NormalizedEvent): e is ListingComplete {
  return e.type === 'listing.complete'
}

function validateListing(l: ListingComplete): void {
  if (!Array.isArray(l.kinds) || l.kinds.length === 0 || l.kinds.some((k) => !(k in LISTING_TYPES))) throw new PostingError('listing.complete needs kinds (invoice, bill, journal, payment, txn, credit_note, investment)')
  if (typeof l.startedAt !== 'string' || Number.isNaN(Date.parse(l.startedAt))) throw new PostingError('listing.complete needs startedAt (ISO time the listing began)')
}

const LISTING_TYPES: Record<ListingKind, SourceRecord['eventType']> = { invoice: 'invoice.upsert', bill: 'invoice.upsert', journal: 'journal.upsert', payment: 'payment.applied', txn: 'txn.upsert', credit_note: 'credit_note.upsert', investment: 'investment.event' }
/** Provider free text kept with a record is display only and capped (a processor row's description: 500 characters). */
const DESCRIPTION_MAX = 500
function capText(ev: NormalizedEvent): NormalizedEvent {
  if (ev.type === 'processor.balance_txn' && typeof ev.description === 'string' && ev.description.length > DESCRIPTION_MAX) return { ...ev, description: ev.description.slice(0, DESCRIPTION_MAX) }
  return ev
}

/** A listing never voids more than this many records of a kind at once (more is reported, not applied). */
const LISTING_MAX_VOIDS = 500
/** Marks a record voided because a listing left it out: its content no longer matches, so if it comes back it posts. */
const GONE_PREFIX = 'gone:'

/**
 * Planner statistics after imports (Postgres). Trailing edge: a fill settles page after page, and statistics taken at
 * its first settle describe nearly empty tables (estimates of one row, nested loops that take seconds). So they are
 * refreshed once settles stop for STATS_QUIET_MS, and STATS_MAX_WAIT_MS into a long burst, but such a forced run never
 * sooner than STATS_MIN_GAP_MS after the last (staging: four ANALYZEs in one demo fill took 12 s of a one-CPU database).
 * One timer per engine.
 */
const STATS_QUIET_MS = Number(process.env.AGFN_STATS_QUIET_MS ?? 5_000)
const STATS_MAX_WAIT_MS = Number(process.env.AGFN_STATS_MAX_WAIT_MS ?? 30_000)
const STATS_MIN_GAP_MS = Number(process.env.AGFN_STATS_MIN_GAP_MS ?? 30_000)
type StatsState = { timer?: ReturnType<typeof setTimeout>; firstAsk?: number; running?: Promise<unknown>; again?: boolean; lastDone?: number }

/** Rows that are the money history itself: the earliest one is where a company's books start. */
const MONEY_HISTORY: ReadonlySet<SourceRecord['eventType']> = new Set(['txn.upsert', 'balance.snapshot', 'processor.balance_txn'])

function noteDirty(ctx: Ctx, accountId: Id, date: string): void {
  const m = (ctx.dirtyFrom ??= new Map())
  const was = m.get(accountId)
  if (was === undefined || date < was) m.set(accountId, date)
}

function sameEntries(a: JournalEntry[], b: JournalEntry[]): boolean {
  if (a.length !== b.length) return false
  const x = a.map(entryShape).sort()
  const y = b.map(entryShape).sort()
  return x.every((s, i) => s === y[i])
}

function reversal(e: JournalEntry, id: Id, now: IsoTimestamp): JournalEntry {
  return {
    ...e,
    id,
    reversesId: e.id,
    reversedById: null,
    memo: `Reversal${e.memo ? `: ${e.memo}` : ''}`,
    createdAt: now,
    lines: e.lines.map((l) => ({
      ...l,
      id: newId(),
      entryId: id,
      debitMinor: l.creditMinor,
      creditMinor: l.debitMinor,
      baseDebitMinor: l.baseCreditMinor,
      baseCreditMinor: l.baseDebitMinor,
    })),
  }
}

const LINK_SHAPES: Record<LinkProposal['type'], Array<[string[], string[]]>> = {
  pending_posted: [[['txn.upsert'], ['txn.upsert']]],
  transfer: [[['txn.upsert'], ['txn.upsert']]],
  card_payment: [[['txn.upsert'], ['txn.upsert']]],
  intercompany: [[['txn.upsert'], ['txn.upsert']]],
  reimbursement: [[['txn.upsert'], ['txn.upsert']]],
  cash_deposit: [[['txn.upsert'], ['txn.upsert']]],
  duplicate: [[['txn.upsert'], ['txn.upsert']], [['invoice.upsert'], ['invoice.upsert']]],
  payout: [[['processor.balance_txn'], ['txn.upsert']]],
  invoice_payment: [[['invoice.upsert', 'payment.applied'], ['txn.upsert', 'processor.balance_txn']]],
  payroll_settlement: [[['payroll.run'], ['txn.upsert']]],
  equity_cash: [[['equity.event'], ['txn.upsert']]],
  investment_cash: [[['investment.event'], ['txn.upsert']]],
  refund: [[['txn.upsert', 'processor.balance_txn', 'credit_note.upsert'], ['txn.upsert', 'processor.balance_txn']]],
}

function checkLinkShape(p: LinkProposal, from: SourceRecord, to: SourceRecord): void {
  const ok = LINK_SHAPES[p.type].some(([f, t]) => f.includes(from.eventType) && t.includes(to.eventType))
  if (!ok) throw new LinkError(`A ${p.type} link can't go from ${from.eventType} to ${to.eventType}`)
  if (p.amount && p.amount.minor <= 0) throw new LinkError('Link amount must be positive')
  const oneWay: Partial<Record<LinkProposal['type'], true>> = { transfer: true, card_payment: true, intercompany: true, reimbursement: true }
  if (oneWay[p.type]) {
    if ((from.amount?.minor ?? 0) >= 0 || (to.amount?.minor ?? 0) <= 0) throw new LinkError(`${p.type} goes from the money-out row to the money-in row`)
  }
  if (from.entityId && to.entityId && from.entityId !== to.entityId && !['intercompany', 'reimbursement', 'transfer', 'duplicate'].includes(p.type)) {
    throw new LinkError(`${p.type} links stay within one company`)
  }
}

export type { Basis, TxnKind, SystemRole }
