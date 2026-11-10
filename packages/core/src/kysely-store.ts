// Production LedgerStore and AccountDirectory on Kysely (SQLite via node:sqlite, or Postgres).
// Transactions are scoped with AsyncLocalStorage, so every query inside store.transaction() — from the store
// and the directory alike — runs on the same connection (SQLite has a single one).
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AccountType, AccountUpsert, Currency, EntityId, Id, IsoDate, IsoTimestamp, LinkType, NormalizedEvent, WorkspaceId } from '@agfn/contracts'
import { holdingConnection, newId, nowIso, withBypass, type CoreTables } from '@agfn/db'
import { PostgresAdapter, sql, type Kysely, type Transaction } from 'kysely'
import type { SystemRole } from './coa.ts'
import { defaultIncludeInCash } from './memory-store.ts'
import type {
  BalanceAssertion,
  PeriodLock,
  MrrPoint,
  Basis,
  Bucket,
  EntityInfo,
  JournalEntry,
  JournalLine,
  LedgerAccount,
  Link,
  LinkStatus,
  RecordOverride,
  Rule,
  RuleApplication,
  SourceAccountInfo,
  SourceRecord,
  WriteLogEntry,
} from './model.ts'
import type { AccountDirectory, AccountTotal, ConnectionInfo, DuplicateDismissal, LedgerStore, LineFilter, LineRow, LinkFilter, ListingKind, ListingOutcome, RecordFilter } from './store.ts'
import { sortKey } from './store.ts'
import { assertEntryBalanced } from './validate.ts'
import { mapYielding } from './yield.ts'

// ---------- Table types ----------

export interface LedgerRecordsTable {
  id: string
  workspace_id: string
  connection_id: string
  event_type: string
  external_id: string
  content_hash: string
  event_json: string
  origin: string
  created_by: string | null
  source_account_id: string | null
  entity_id: string | null
  status: string
  date: string
  amount_minor: number | null
  currency: string | null
  posting_hash: string | null
  provenance_json: string | null
  created_at: string
  updated_at: string
  /** When a sync last carried this record (set on insert and by markSeen; never by a later save). */
  last_seen_at?: string | null
}

export interface LedgerListingsTable {
  workspace_id: string
  connection_id: string
  kind: string
  started_at: string
  applied_at: string
  seen: number
  voided: number
  skipped_reason: string | null
}

export interface LedgerAccountsTable {
  id: string
  workspace_id: string
  entity_id: string
  role: string
  code: string
  name: string
  type: string
  normal_balance: string
  created_at: string
}

export interface JournalEntriesTable {
  id: string
  workspace_id: string
  entity_id: string
  date: string
  basis: string
  kind: string
  source_id: string
  memo: string | null
  reverses_id: string | null
  reversed_by_id: string | null
  created_at: string
}

export interface JournalLinesTable {
  id: string
  workspace_id: string
  entry_id: string
  ledger_account_id: string
  debit_minor: number
  credit_minor: number
  currency: string
  base_debit_minor: number
  base_credit_minor: number
  fx_rate: string
  bucket_id: string | null
  memo: string | null
  line_no: number
  created_at: string
}

export interface LedgerLinksTable {
  id: string
  workspace_id: string
  type: string
  from_id: string
  to_id: string
  amount_minor: number | null
  currency: string | null
  confidence: number
  method: string
  status: string
  scores_json: string | null
  created_by: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}

export interface LedgerOverridesTable {
  record_id: string
  workspace_id: string
  data_json: string
  updated_by: string | null
  updated_at: string
  created_at: string
}

export interface LedgerRulesTable {
  id: string
  workspace_id: string
  name: string
  priority: number
  conditions_json: string
  actions_json: string
  status: string
  origin: string
  created_by: string | null
  hit_count: number
  last_hit_at: string | null
  created_at: string
}

export interface LedgerRuleApplicationsTable {
  id: string
  workspace_id: string
  rule_id: string
  record_id: string
  applied_at: string
  created_at: string
}

export interface LedgerBucketsTable {
  id: string
  workspace_id: string
  entity_id: string
  name: string
  fields_json: string
  values_json: string
  schedule_json: string | null
  set_aside_json: string | null
  origin: string
  created_by: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface LedgerWritesTable {
  id: string
  workspace_id: string
  op: string
  record_ids_json: string
  before_json: string | null
  created_at: string
  reverted_at: string | null
}

export interface LedgerWriteTargetsTable {
  write_id: string
  workspace_id: string
  target_id: string
  created_at: string
}

export interface LedgerAssertionsTable {
  id: string
  workspace_id: string
  account_id: string
  date: string
  balance_minor: number
  currency: string
  source: string | null
  created_by: string | null
  provenance_json: string | null
  created_at: string
  removed_at: string | null
}

export interface LedgerPeriodLocksTable {
  id: string
  workspace_id: string
  entity_id: string
  through_date: string
  note: string | null
  created_by: string | null
  provenance_json: string | null
  created_at: string
  removed_at: string | null
}

export interface LedgerMrrPointsTable {
  id: string
  workspace_id: string
  record_id: string
  date: string
  mrr_minor: number
  currency: string
  created_at: string
}

export interface LedgerDerivedTable {
  workspace_id: string
  key_hash: string
  cache_key: string
  version: number
  value_json: string
  created_at: string
}

export interface LedgerMatcherRunsTable {
  workspace_id: string
  version: number
  ran_at: string
}

export interface LedgerSettleMarksTable {
  workspace_id: string
  connection_id: string
  since: string
}

export interface LedgerVersionsTable {
  workspace_id: string
  version: number
  updated_at: string
}

export interface FxRatesTable {
  date: string
  from_currency: string
  to_currency: string
  rate: string
  source: string
  created_at: string
}

export interface LedgerTables {
  ledger_records: LedgerRecordsTable
  ledger_accounts: LedgerAccountsTable
  journal_entries: JournalEntriesTable
  journal_lines: JournalLinesTable
  ledger_links: LedgerLinksTable
  ledger_overrides: LedgerOverridesTable
  ledger_rules: LedgerRulesTable
  ledger_rule_applications: LedgerRuleApplicationsTable
  ledger_buckets: LedgerBucketsTable
  fx_rates: FxRatesTable
  ledger_writes: LedgerWritesTable
  ledger_write_targets: LedgerWriteTargetsTable
  ledger_versions: LedgerVersionsTable
  ledger_assertions: LedgerAssertionsTable
  ledger_period_locks: LedgerPeriodLocksTable
  ledger_mrr_points: LedgerMrrPointsTable
  ledger_settle_marks: LedgerSettleMarksTable
  ledger_listings: LedgerListingsTable
  ledger_matcher_runs: LedgerMatcherRunsTable
  ledger_derived: LedgerDerivedTable
}

type DB = CoreTables & LedgerTables
type Q = Kysely<DB> | Transaction<DB>

type TxWatch = { trx: Transaction<DB>; started: number; last: number; maxGap: number; resumedAt: string | null; beforeCommit: Array<() => Promise<void>> }

/** A pause this long between statements inside a transaction is logged (hosted Postgres ends idle transactions). */
const SLOW_GAP_MS = Number(process.env.AGFN_TX_SLOW_GAP_MS ?? 5_000)

/** The ledger tables whose planner statistics an import outruns (refreshStats). */
// The two journal tables only: the big joins read them, and ANALYZE of all four took 5–9 s on a busy hosted database.
const STATS_TABLES = ['journal_lines', 'journal_entries']
/**
 * Past this many rows (the planner's own estimate) the tables are left to autoanalyze. On hosted that means a fresh
 * tenant's fill (~15k lines) never refreshes them (2% of 1.6M is ~32k changes), so every tenant-scoped query on these
 * tables must not depend on the row estimate: plain statements matched in JS, or a materialized CTE, never a join the
 * planner may turn into a nested loop on a 1-row guess (latestRecordsByAccount, 23 s on staging).
 */
const STATS_SKIP_ROWS = 100_000
/** Entry ids per statement when lines are read by entry (Postgres listLines with no account or bucket filter). */
const LINE_ENTRY_CHUNK = 10_000
/**
 * Ids per IN list for reads that may cover a whole workspace (entry kinds, links by record): a page of transactions
 * asks for every record's, so 400-500 per read meant dozens of round trips. 4,000 ids is 8,002 parameters for the
 * two-sided links probe, well under SQLite's 32,766 and Postgres's 65,535.
 */
const ID_CHUNK = 4_000
let statsOwnerWarned = false

/** Shared transaction scope for a store and a directory over the same database. */
export class DbScope {
  readonly db: Kysely<DB>
  readonly #als = new AsyncLocalStorage<TxWatch>()

  constructor(db: Kysely<DB>) {
    this.db = db
  }

  q(): Q {
    const w = this.#als.getStore()
    if (!w) return this.db
    // Time since the previous statement began: its own run time plus whatever JS ran before this one.
    const now = performance.now()
    const gap = now - w.last
    if (gap > w.maxGap) {
      w.maxGap = gap
      if (gap >= SLOW_GAP_MS) w.resumedAt = (new Error().stack ?? '').split('\n').slice(2, 6).map((l) => l.trim()).join(' < ')
    }
    w.last = now
    return w.trx
  }

  inTransaction(): boolean {
    return this.#als.getStore() !== undefined
  }

  /** The open transaction (an identity for per-transaction buffers), if any. */
  current(): object | undefined {
    return this.#als.getStore()
  }

  /** Work to finish inside the open transaction just before it commits (write-behind buffers). */
  beforeCommit(fn: () => Promise<void>): void {
    this.#als.getStore()?.beforeCommit.push(fn)
  }

  async transaction<T>(fn: () => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    if (this.#als.getStore()) return fn()
    const t0 = performance.now()
    let watch: TxWatch | undefined
    // SET TRANSACTION READ ONLY makes any write inside the transaction fail; only Postgres supports it (SQLite has no
    // such statement, and a read-only dry run there writes nothing by construction anyway).
    const readOnly = !!opts.readOnly && this.db.getExecutor().adapter instanceof PostgresAdapter
    try {
      return await this.db.transaction().execute((trx) => {
        const w: TxWatch = { trx, started: t0, last: performance.now(), maxGap: 0, resumedAt: null, beforeCommit: [] }
        watch = w
        return holdingConnection(() => this.#als.run(w, async () => {
          if (readOnly) await sql`set transaction read only`.execute(trx)
          const out = await fn()
          for (const f of w.beforeCommit) await f()
          return out
        }))
      })
    } finally {
      if (watch && watch.maxGap >= SLOW_GAP_MS) {
        console.warn(`[agfn] ledger transaction paused ${Math.round(watch.maxGap)} ms between statements (${Math.round(performance.now() - t0)} ms in all); resumed at ${watch.resumedAt ?? '?'}`)
      }
    }
  }
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string') return Number(v)
  return 0
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))
const parse = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T))

function toAssertion(r: LedgerAssertionsTable): BalanceAssertion {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    accountId: r.account_id,
    date: r.date,
    balance: { minor: num(r.balance_minor), currency: r.currency },
    source: r.source,
    createdBy: r.created_by,
    provenance: r.provenance_json ? (JSON.parse(r.provenance_json) as BalanceAssertion['provenance']) : null,
    createdAt: r.created_at,
    removedAt: r.removed_at,
  }
}

function toRecord(r: LedgerRecordsTable): SourceRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    connectionId: r.connection_id,
    eventType: r.event_type,
    externalId: r.external_id,
    contentHash: r.content_hash,
    event: JSON.parse(r.event_json) as NormalizedEvent,
    origin: r.origin as SourceRecord['origin'],
    createdBy: r.created_by,
    sourceAccountId: r.source_account_id,
    entityId: r.entity_id,
    status: r.status as SourceRecord['status'],
    date: r.date,
    amount: r.amount_minor === null || r.currency === null ? null : { minor: num(r.amount_minor), currency: r.currency },
    postingHash: r.posting_hash,
    provenance: parse<SourceRecord['provenance']>(r.provenance_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function toAccount(r: LedgerAccountsTable): LedgerAccount {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    entityId: r.entity_id,
    role: r.role as SystemRole,
    code: r.code,
    name: r.name,
    type: r.type as LedgerAccount['type'],
    normalBalance: r.normal_balance as LedgerAccount['normalBalance'],
    createdAt: r.created_at,
  }
}

function toLine(r: JournalLinesTable): JournalLine {
  return {
    id: r.id,
    entryId: r.entry_id,
    ledgerAccountId: r.ledger_account_id,
    debitMinor: num(r.debit_minor),
    creditMinor: num(r.credit_minor),
    currency: r.currency,
    baseDebitMinor: num(r.base_debit_minor),
    baseCreditMinor: num(r.base_credit_minor),
    fxRate: r.fx_rate,
    bucketId: r.bucket_id,
    memo: r.memo,
  }
}

function toLink(r: LedgerLinksTable): Link {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    type: r.type as Link['type'],
    fromId: r.from_id,
    toId: r.to_id,
    amount: r.amount_minor === null || r.currency === null ? null : { minor: num(r.amount_minor), currency: r.currency },
    confidence: num(r.confidence),
    method: r.method as Link['method'],
    status: r.status as Link['status'],
    scores: parse<Record<string, number>>(r.scores_json),
    createdBy: r.created_by,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  }
}

function toRule(r: LedgerRulesTable): Rule {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    priority: num(r.priority),
    conditions: JSON.parse(r.conditions_json) as Rule['conditions'],
    actions: JSON.parse(r.actions_json) as Rule['actions'],
    status: r.status as Rule['status'],
    origin: r.origin as Rule['origin'],
    createdBy: r.created_by,
    hitCount: num(r.hit_count),
    lastHitAt: r.last_hit_at,
    createdAt: r.created_at,
  }
}

function toBucket(r: LedgerBucketsTable): Bucket {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    entityId: r.entity_id,
    name: r.name,
    fields: JSON.parse(r.fields_json) as Bucket['fields'],
    values: JSON.parse(r.values_json) as Bucket['values'],
    schedule: parse<Bucket['schedule']>(r.schedule_json),
    setAside: r.set_aside_json ? parse<NonNullable<Bucket['setAside']>>(r.set_aside_json) : null,
    origin: r.origin as Bucket['origin'],
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    archivedAt: r.archived_at,
  }
}

/** settings-table key prefix for a dismissed possible-duplicate pair (one row per pair). */
const DUP_DISMISS_PREFIX = 'dup_dismiss:'

export class KyselyLedgerStore implements LedgerStore {
  readonly scope: DbScope

  constructor(scope: DbScope | Kysely<DB>) {
    this.scope = scope instanceof DbScope ? scope : new DbScope(scope)
  }

  #q(): Q {
    return this.scope.q()
  }

  transaction<T>(fn: (store: LedgerStore) => Promise<T>, opts: { readOnly?: boolean } = {}): Promise<T> {
    return this.scope.transaction(() => fn(this), opts)
  }

  inTransaction(): boolean {
    return this.scope.inTransaction()
  }

  async lockWorkspace(ws: WorkspaceId): Promise<void> {
    if (!(this.scope.db.getExecutor().adapter instanceof PostgresAdapter)) return
    // Held until the surrounding transaction commits or rolls back.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`agfn-ledger:${ws}`}, 0))`.execute(this.#q())
  }

  /**
   * Postgres only: refresh the planner's statistics for the ledger tables. A big import fills them faster than
   * autovacuum notices, and with stale numbers the planner picks plans that take seconds instead of milliseconds.
   * Needs the tables' owner: anyone else gets only a warning per table and nothing changes, which went unnoticed once
   * (the restricted app role). So it checks first and says so in the log. Resolves true when the statistics were refreshed.
   */
  async refreshStats(): Promise<boolean> {
    if (!(this.scope.db.getExecutor().adapter instanceof PostgresAdapter)) return false
    // Its own checkout from the owner's pool under a named bypass, never a held transaction's connection: requests run
    // as the restricted app role.
    return withBypass('perf:analyze', async () => {
      const db = this.scope.db
      const who = await sql<{ me: string; owns: boolean; rows: number | string | null }>`
        select current_user as me, coalesce(bool_and(pg_has_role(current_user, c.relowner, 'USAGE')), false) as owns, max(c.reltuples)::float8 as rows
        from pg_class c where c.relnamespace = current_schema()::regnamespace and c.relname in (${sql.join(STATS_TABLES)})`.execute(db)
      const row = who.rows[0]
      // Big tables (hosted): autoanalyze keeps up (f8's per-table settings), and an ANALYZE's sample on a small compute
      // pushed the hot pages out of its cache: the next big read took 13.8 s with the plan that took 300 ms after
      // (staging, 2026-10-12). The refresh is for a fresh or small database, where a first fill outruns the statistics.
      if (Number(row?.rows ?? 0) > STATS_SKIP_ROWS) return false
      if (!row?.owns) {
        if (!statsOwnerWarned) console.warn('[agfn] planner statistics not refreshed: the ledger tables are not owned by', row?.me ?? 'this role')
        statsOwnerWarned = true
        return false
      }
      await sql`analyze ${sql.join(STATS_TABLES.map((t) => sql.id(t)))}`.execute(db)
      return true
    })
  }

  async findRecordsByKeys(ws: WorkspaceId, keys: Array<{ connectionId: Id; eventType: SourceRecord['eventType']; externalId: string }>): Promise<SourceRecord[]> {
    await this.#flushRecords()
    const groups = new Map<string, { connectionId: Id; eventType: string; ids: string[] }>()
    for (const k of keys) {
      const g = groups.get(`${k.connectionId}|${k.eventType}`) ?? { connectionId: k.connectionId, eventType: k.eventType, ids: [] }
      g.ids.push(k.externalId)
      groups.set(`${k.connectionId}|${k.eventType}`, g)
    }
    const out: SourceRecord[] = []
    for (const g of groups.values()) {
      for (let i = 0; i < g.ids.length; i += 500) {
        const rows = await this.#q()
          .selectFrom('ledger_records')
          .selectAll()
          .where('workspace_id', '=', ws)
          .where('connection_id', '=', g.connectionId)
          .where('event_type', '=', g.eventType)
          .where('external_id', 'in', g.ids.slice(i, i + 500))
          .execute()
        for (const r of rows) out.push(toRecord(r))
      }
    }
    return out
  }

  async getRecords(ws: WorkspaceId, ids: Id[]): Promise<SourceRecord[]> {
    await this.#flushRecords()
    const out: SourceRecord[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.#q().selectFrom('ledger_records').selectAll().where('workspace_id', '=', ws).where('id', 'in', ids.slice(i, i + 500)).execute()
      for (const r of rows) out.push(toRecord(r))
    }
    return out
  }

  async eventTypesPresent(ws: WorkspaceId, entityIds: EntityId[]): Promise<Set<SourceRecord['eventType']>> {
    await this.#flushRecords()
    if (!entityIds.length) return new Set()
    const rows = await this.#q().selectFrom('ledger_records').select('event_type').distinct().where('workspace_id', '=', ws).where('entity_id', 'in', entityIds).execute()
    return new Set(rows.map((r) => r.event_type as SourceRecord['eventType']))
  }

  async recordSortKeys(ws: WorkspaceId, ids?: Id[]): Promise<Map<Id, string>> {
    await this.#flushRecords()
    const out = new Map<Id, string>()
    if (!ids) {
      const rows = await this.#q().selectFrom('ledger_records').select(['id', 'date', 'event_type', 'external_id']).where('workspace_id', '=', ws).execute()
      for (const r of rows) out.set(r.id, sortKey(r.date, r.event_type, r.external_id))
      return out
    }
    const want = [...new Set(ids)]
    for (let i = 0; i < want.length; i += 500) {
      const rows = await this.#q().selectFrom('ledger_records').select(['id', 'date', 'event_type', 'external_id']).where('workspace_id', '=', ws).where('id', 'in', want.slice(i, i + 500)).execute()
      for (const r of rows) out.set(r.id, sortKey(r.date, r.event_type, r.external_id))
    }
    return out
  }

  async latestRecordsByAccount(ws: WorkspaceId, accountIds: Id[], eventTypes: SourceRecord['eventType'][], toDate?: IsoDate): Promise<SourceRecord[]> {
    await this.#flushRecords()
    const want = [...new Set(accountIds)]
    const out: SourceRecord[] = []
    const pg = this.scope.db.getExecutor().adapter instanceof PostgresAdapter
    for (let i = 0; i < want.length; i += 500) {
      const ids = want.slice(i, i + 500)
      if (pg) {
        // Postgres: two plain statements, so no estimate can make them a loop. The single join used before, planned on a
        // new tenant's estimate of one row inside a big shared table, re-ran the per-account max for every row (O(n²):
        // 5–18 s on staging and live). First each account's newest day, then that day's rows, matched here.
        const newest = await this.#q()
          .selectFrom('ledger_records')
          .select(['source_account_id', (eb) => eb.fn.max('date').as('d')])
          .where('workspace_id', '=', ws)
          .where('event_type', 'in', eventTypes)
          .where('status', 'in', ['recorded', 'posted'])
          .where('source_account_id', 'in', ids)
          .$if(toDate !== undefined, (q) => q.where('date', '<=', toDate as IsoDate))
          .groupBy('source_account_id')
          .execute()
        const day = new Map(newest.map((n) => [n.source_account_id as string, n.d as string]))
        if (day.size === 0) continue
        const rows = await this.#q()
          .selectFrom('ledger_records')
          .selectAll()
          .where('workspace_id', '=', ws)
          .where('event_type', 'in', eventTypes)
          .where('status', 'in', ['recorded', 'posted'])
          .where('source_account_id', 'in', [...day.keys()])
          .where('date', 'in', [...new Set(day.values())])
          .execute()
        for (const r of rows) if (r.source_account_id && day.get(r.source_account_id) === r.date) out.push(toRecord(r as LedgerRecordsTable))
        continue
      }
      const newest = this.#q()
        .selectFrom('ledger_records')
        .select(['source_account_id', (eb) => eb.fn.max('date').as('d')])
        .where('workspace_id', '=', ws)
        .where('event_type', 'in', eventTypes)
        .where('status', 'in', ['recorded', 'posted'])
        .where('source_account_id', 'in', ids)
        .$if(toDate !== undefined, (q) => q.where('date', '<=', toDate as IsoDate))
        .groupBy('source_account_id')
        .as('n')
      const rows = await this.#q()
        .selectFrom('ledger_records as r')
        .innerJoin(newest, (j) => j.onRef('n.source_account_id', '=', 'r.source_account_id').onRef('n.d', '=', 'r.date'))
        .selectAll('r')
        .where('r.workspace_id', '=', ws)
        .where('r.event_type', 'in', eventTypes)
        .where('r.status', 'in', ['recorded', 'posted'])
        .execute()
      for (const r of rows) out.push(toRecord(r as LedgerRecordsTable))
    }
    return out
  }

  async addedByHand(ws: WorkspaceId): Promise<Map<Id, SourceRecord['status']>> {
    await this.#flushRecords()
    const rows = await this.#q().selectFrom('ledger_records').select(['id', 'status']).where('workspace_id', '=', ws).where('origin', '!=', 'connector').execute()
    return new Map(rows.map((r) => [r.id, r.status as SourceRecord['status']]))
  }

  async monthlyRowCounts(ws: WorkspaceId, accountIds: Id[]): Promise<Array<{ accountId: Id; month: string; rows: number }>> {
    await this.#flushRecords()
    if (accountIds.length === 0) return []
    const rows = await this.#q()
      .selectFrom('ledger_records')
      .select((eb) => ['source_account_id', sql<string>`substr(date, 1, 7)`.as('month'), eb.fn.countAll<number>().as('n')])
      .where('workspace_id', '=', ws)
      .where('source_account_id', 'in', accountIds)
      .where('event_type', 'in', ['txn.upsert', 'processor.balance_txn'])
      .where('status', 'in', ['posted', 'recorded'])
      .groupBy(['source_account_id', sql`substr(date, 1, 7)`])
      .execute()
    return rows.map((r) => ({ accountId: r.source_account_id as Id, month: r.month, rows: num(r.n) }))
  }

  async lastRowDates(ws: WorkspaceId, accountIds: Id[], onOrBefore?: string): Promise<Array<{ accountId: Id; date: string }>> {
    await this.#flushRecords()
    if (accountIds.length === 0) return []
    let q = this.#q()
      .selectFrom('ledger_records')
      .select((eb) => ['source_account_id', eb.fn.max<string>('date').as('last')])
      .where('workspace_id', '=', ws)
      .where('source_account_id', 'in', accountIds)
      .where('event_type', 'in', ['txn.upsert', 'processor.balance_txn'])
      .where('status', 'in', ['posted', 'recorded'])
    if (onOrBefore) q = q.where('date', '<=', onOrBefore)
    const rows = await q.groupBy('source_account_id').execute()
    return rows.map((r) => ({ accountId: r.source_account_id as Id, date: r.last })).filter((r) => !!r.date)
  }

  async addMrrPoint(p: MrrPoint): Promise<void> {
    const row: LedgerMrrPointsTable = { id: p.id, workspace_id: p.workspaceId, record_id: p.recordId, date: p.date, mrr_minor: p.mrr.minor, currency: p.mrr.currency, created_at: p.createdAt }
    // In a transaction (a page of subscriptions): written together at commit, or before they're read.
    const tx = this.scope.current()
    if (tx) {
      let buf = this.#pendingMrr.get(tx)
      if (!buf) {
        this.#pendingMrr.set(tx, (buf = []))
        this.scope.beforeCommit(() => this.#flushMrr())
      }
      buf.push(row)
      return
    }
    await this.#q().insertInto('ledger_mrr_points').values(row).execute()
  }

  readonly #pendingMrr = new WeakMap<object, LedgerMrrPointsTable[]>()

  #flushMrr(): Promise<void> {
    return this.#inOrder('mrr', async () => {
      const tx = this.scope.current()
      const buf = tx ? this.#pendingMrr.get(tx) : undefined
      if (!buf?.length) return
      const rows = buf.splice(0, buf.length)
      await this.#flushRecords() // points reference records
      for (let i = 0; i < rows.length; i += 500) await this.#q().insertInto('ledger_mrr_points').values(rows.slice(i, i + 500)).execute()
    })
  }

  async listMrrPoints(ws: WorkspaceId, recordIds?: Id[]): Promise<MrrPoint[]> {
    if (recordIds && recordIds.length === 0) return []
    await this.#flushMrr()
    const rows: LedgerMrrPointsTable[] = []
    const chunks = recordIds ? Array.from({ length: Math.ceil(recordIds.length / 500) }, (_, i) => recordIds.slice(i * 500, i * 500 + 500)) : [null]
    for (const ids of chunks) {
      let q = this.#q().selectFrom('ledger_mrr_points').selectAll().where('workspace_id', '=', ws)
      if (ids) q = q.where('record_id', 'in', ids)
      rows.push(...(await q.execute()))
    }
    return rows
      .map((r) => ({ id: r.id, workspaceId: r.workspace_id as WorkspaceId, recordId: r.record_id, date: r.date, mrr: { minor: Number(r.mrr_minor), currency: r.currency }, createdAt: r.created_at }))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
  }

  async savePeriodLock(l: PeriodLock): Promise<void> {
    const row: LedgerPeriodLocksTable = {
      id: l.id,
      workspace_id: l.workspaceId,
      entity_id: l.entityId,
      through_date: l.through,
      note: l.note,
      created_by: l.createdBy,
      provenance_json: l.provenance ? JSON.stringify(l.provenance) : null,
      created_at: l.createdAt,
      removed_at: l.removedAt,
    }
    await this.#q().insertInto('ledger_period_locks').values(row).onConflict((oc) => oc.column('id').doUpdateSet({ removed_at: row.removed_at })).execute()
  }

  async markSeen(ws: WorkspaceId, ids: Id[], at: IsoTimestamp): Promise<void> {
    if (ids.length === 0) return
    await this.#flushRecords()
    for (let i = 0; i < ids.length; i += 500) {
      await this.#q().updateTable('ledger_records').set({ last_seen_at: at }).where('workspace_id', '=', ws).where('id', 'in', ids.slice(i, i + 500)).execute()
    }
  }

  async lastSeen(ws: WorkspaceId, connectionId: Id, eventTypes: string[]): Promise<Map<Id, IsoTimestamp>> {
    await this.#flushRecords()
    const rows = await this.#q()
      .selectFrom('ledger_records')
      .select(['id', 'last_seen_at', 'created_at'])
      .where('workspace_id', '=', ws)
      .where('connection_id', '=', connectionId)
      .where('event_type', 'in', eventTypes)
      .execute()
    return new Map(rows.map((r) => [r.id, (r.last_seen_at ?? r.created_at) as IsoTimestamp]))
  }

  async saveListing(l: ListingOutcome): Promise<void> {
    const row: LedgerListingsTable = { workspace_id: l.workspaceId, connection_id: l.connectionId, kind: l.kind, started_at: l.startedAt, applied_at: l.appliedAt, seen: l.seen, voided: l.voided, skipped_reason: l.skippedReason }
    const { workspace_id: _w, connection_id: _c, kind: _k, ...update } = row
    await this.#q().insertInto('ledger_listings').values(row).onConflict((oc) => oc.columns(['workspace_id', 'connection_id', 'kind']).doUpdateSet(update)).execute()
  }

  async listListings(ws: WorkspaceId): Promise<ListingOutcome[]> {
    const rows = await this.#q().selectFrom('ledger_listings').selectAll().where('workspace_id', '=', ws).orderBy('connection_id').orderBy('kind').execute()
    return rows.map((r) => ({ workspaceId: r.workspace_id as WorkspaceId, connectionId: r.connection_id, kind: r.kind as ListingKind, startedAt: r.started_at, appliedAt: r.applied_at, seen: Number(r.seen), voided: Number(r.voided), skippedReason: r.skipped_reason }))
  }

  // Dismissals ride the settings table (one row per pair, keyed by the accounts), so no migration is needed for a
  // rarely-written, low-cardinality signal.
  async saveDuplicateDismissal(d: DuplicateDismissal): Promise<void> {
    const key = `${DUP_DISMISS_PREFIX}${d.subjectId}:${d.relatedId}`
    const value_json = JSON.stringify(d)
    await this.#q()
      .insertInto('settings')
      .values({ workspace_id: d.workspaceId, key, value_json, updated_at: nowIso() })
      .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json, updated_at: nowIso() }))
      .execute()
  }

  async listDuplicateDismissals(ws: WorkspaceId): Promise<DuplicateDismissal[]> {
    const rows = await this.#q().selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', 'like', `${DUP_DISMISS_PREFIX}%`).execute()
    return rows.map((r) => JSON.parse(r.value_json) as DuplicateDismissal)
  }

  async markUnsettled(ws: WorkspaceId, connectionId: Id, since: IsoTimestamp): Promise<void> {
    await this.#q().insertInto('ledger_settle_marks').values({ workspace_id: ws, connection_id: connectionId, since }).onConflict((oc) => oc.columns(['workspace_id', 'connection_id']).doNothing()).execute()
  }

  async unsettledSince(ws: WorkspaceId, connectionId: Id): Promise<IsoTimestamp | null> {
    const row = await this.#q().selectFrom('ledger_settle_marks').select('since').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).executeTakeFirst()
    return (row?.since as IsoTimestamp | undefined) ?? null
  }

  async clearUnsettled(ws: WorkspaceId, connectionId: Id): Promise<void> {
    await this.#q().deleteFrom('ledger_settle_marks').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute()
  }

  async matchedWith(ws: WorkspaceId): Promise<number | null> {
    const row = await this.#q().selectFrom('ledger_matcher_runs').select('version').where('workspace_id', '=', ws).executeTakeFirst()
    return row ? Number(row.version) : null
  }

  async setMatchedWith(ws: WorkspaceId, version: number, at: IsoTimestamp): Promise<void> {
    await this.#q().insertInto('ledger_matcher_runs').values({ workspace_id: ws, version, ran_at: at }).onConflict((oc) => oc.column('workspace_id').doUpdateSet({ version, ran_at: at })).execute()
  }

  async eraseConnection(ws: WorkspaceId, connectionId: Id): Promise<number> {
    // Everything this transaction still holds goes down first, so the deletes see it.
    await this.#flushRecords()
    await this.#flushEntries()
    await this.#flushLinks()
    await this.#flushApps()
    await this.#flushMrr()
    const ids = (await this.#q().selectFrom('ledger_records').select('id').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute()).map((r) => r.id)
        for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      // Entries posted from these records (their reversals too: same source), lines first.
      const entries = (await this.#q().selectFrom('journal_entries').select('id').where('workspace_id', '=', ws).where('source_id', 'in', chunk).execute()).map((e) => e.id)
      for (let j = 0; j < entries.length; j += 500) {
        const ec = entries.slice(j, j + 500)
        await this.#q().deleteFrom('journal_lines').where('workspace_id', '=', ws).where('entry_id', 'in', ec).execute()
        // An entry of another source never points at these (a reversal shares its source); cleared anyway, never broken.
        await this.#q().updateTable('journal_entries').set({ reversed_by_id: null }).where('workspace_id', '=', ws).where('reversed_by_id', 'in', ec).execute()
        // A reversal points at the entry it reverses (a foreign key), possibly in another chunk.
        await this.#q().updateTable('journal_entries').set({ reverses_id: null }).where('workspace_id', '=', ws).where('id', 'in', ec).execute()
      }
      for (let j = 0; j < entries.length; j += 500) await this.#q().deleteFrom('journal_entries').where('workspace_id', '=', ws).where('id', 'in', entries.slice(j, j + 500)).execute()
      await this.#q().deleteFrom('ledger_links').where('workspace_id', '=', ws).where((eb) => eb.or([eb('from_id', 'in', chunk), eb('to_id', 'in', chunk)])).execute()
      await this.#q().deleteFrom('ledger_overrides').where('workspace_id', '=', ws).where('record_id', 'in', chunk).execute()
      await this.#q().deleteFrom('ledger_rule_applications').where('workspace_id', '=', ws).where('record_id', 'in', chunk).execute()
      await this.#q().deleteFrom('ledger_mrr_points').where('workspace_id', '=', ws).where('record_id', 'in', chunk).execute()
      // The write log (undo) about these records only; an entry that also names another record stays (ids only there).
      const targets = await this.#q().selectFrom('ledger_write_targets').select(['write_id']).where('workspace_id', '=', ws).where('target_id', 'in', chunk).execute()
      for (const { write_id } of targets) {
        const all = await this.#q().selectFrom('ledger_write_targets').select('target_id').where('write_id', '=', write_id).execute()
        if (all.every((t) => ids.includes(t.target_id))) {
          await this.#q().deleteFrom('ledger_write_targets').where('write_id', '=', write_id).execute()
          await this.#q().deleteFrom('ledger_writes').where('id', '=', write_id).execute()
        } else await this.#q().deleteFrom('ledger_write_targets').where('write_id', '=', write_id).where('target_id', 'in', chunk).execute()
      }
      await this.#q().deleteFrom('ledger_records').where('workspace_id', '=', ws).where('id', 'in', chunk).execute()
    }
    await this.#q().deleteFrom('ledger_listings').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute()
    await this.#q().deleteFrom('ledger_settle_marks').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).execute()
    // Stored overviews and checks may carry its numbers: computed again on the next read.
    await this.#q().deleteFrom('ledger_derived').where('workspace_id', '=', ws).execute()
    this.#recordCache()?.clear()
    return ids.length
  }

  async getDerived(ws: WorkspaceId, keyHash: string, version: number, since: IsoTimestamp): Promise<string | null> {
    const row = await this.#q().selectFrom('ledger_derived').select('value_json').where('workspace_id', '=', ws).where('key_hash', '=', keyHash).where('version', '=', version).where('created_at', '>=', since).executeTakeFirst()
    return row?.value_json ?? null
  }

  async putDerived(ws: WorkspaceId, key: string, keyHash: string, version: number, valueJson: string, at: IsoTimestamp, staleBefore: IsoTimestamp): Promise<void> {
    await this.#q()
      .insertInto('ledger_derived')
      .values({ workspace_id: ws, key_hash: keyHash, cache_key: key, version, value_json: valueJson, created_at: at })
      .onConflict((oc) => oc.columns(['workspace_id', 'key_hash']).doUpdateSet({ cache_key: key, version, value_json: valueJson, created_at: at }))
      .execute()
    // What no reader can use any more: older versions, or past the reuse window. Once per workspace, version and
    // window start in this process, not after every result (a cold overview writes ~14: a delete each was ~13
    // statements of its ~230). Readers never depend on it: they ask for their version and window.
    const mark = `${version}|${staleBefore}`
    if (this.#pruned.get(ws) === mark) return
    if (this.#pruned.size > 10_000) this.#pruned.clear()
    this.#pruned.set(ws, mark)
    try {
      await this.#q().deleteFrom('ledger_derived').where('workspace_id', '=', ws).where((eb) => eb.or([eb('version', '<', version), eb('created_at', '<', staleBefore)])).execute()
    } catch (err) {
      if (this.#pruned.get(ws) === mark) this.#pruned.delete(ws)
      throw err
    }
  }
  #pruned = new Map<WorkspaceId, string>()

  async recentDerived(since: IsoTimestamp): Promise<Array<{ workspaceId: WorkspaceId; key: string; version: number; valueJson: string; at: IsoTimestamp }>> {
    const rows = await this.#q().selectFrom('ledger_derived').select(['workspace_id', 'cache_key', 'version', 'value_json', 'created_at']).where('created_at', '>=', since).execute()
    return rows.map((r) => ({ workspaceId: r.workspace_id as WorkspaceId, key: r.cache_key, version: Number(r.version), valueJson: r.value_json, at: r.created_at as IsoTimestamp }))
  }

  async listPeriodLocks(ws: WorkspaceId): Promise<PeriodLock[]> {
    const rows = await this.#q().selectFrom('ledger_period_locks').selectAll().where('workspace_id', '=', ws).where('removed_at', 'is', null).orderBy('created_at').orderBy('id').execute()
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id as WorkspaceId,
      entityId: r.entity_id as EntityId,
      through: r.through_date,
      note: r.note,
      createdBy: r.created_by,
      provenance: r.provenance_json ? (JSON.parse(r.provenance_json) as PeriodLock['provenance']) : null,
      createdAt: r.created_at,
      removedAt: r.removed_at,
    }))
  }

  async saveAssertion(a: BalanceAssertion): Promise<void> {
    const row: LedgerAssertionsTable = {
      id: a.id,
      workspace_id: a.workspaceId,
      account_id: a.accountId,
      date: a.date,
      balance_minor: a.balance.minor,
      currency: a.balance.currency,
      source: a.source,
      created_by: a.createdBy,
      provenance_json: a.provenance ? JSON.stringify(a.provenance) : null,
      created_at: a.createdAt,
      removed_at: a.removedAt,
    }
    await this.#q().insertInto('ledger_assertions').values(row).onConflict((oc) => oc.column('id').doUpdateSet({ removed_at: row.removed_at })).execute()
  }

  async listAssertions(ws: WorkspaceId, accountIds?: Id[]): Promise<BalanceAssertion[]> {
    let q = this.#q().selectFrom('ledger_assertions').selectAll().where('workspace_id', '=', ws).where('removed_at', 'is', null)
    if (accountIds) q = accountIds.length ? q.where('account_id', 'in', accountIds) : q.where(sql<boolean>`1 = 0`)
    return (await q.orderBy('account_id').orderBy('date').orderBy('id').execute()).map(toAssertion)
  }

  async getAssertion(ws: WorkspaceId, id: Id): Promise<BalanceAssertion | null> {
    const r = await this.#q().selectFrom('ledger_assertions').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? toAssertion(r) : null
  }

  async bumpVersion(ws: WorkspaceId, at: string): Promise<void> {
    await this.#q()
      .insertInto('ledger_versions')
      .values({ workspace_id: ws, version: 1, updated_at: at })
      .onConflict((oc) => oc.column('workspace_id').doUpdateSet({ version: sql<number>`ledger_versions.version + 1`, updated_at: at }))
      .execute()
  }

  async version(ws: WorkspaceId): Promise<number> {
    const r = await this.#q().selectFrom('ledger_versions').select('version').where('workspace_id', '=', ws).executeTakeFirst()
    return r ? num(r.version) : 0
  }

  async getRecord(ws: WorkspaceId, id: Id): Promise<SourceRecord | null> {
    // Within a transaction a record is read once: every write to it goes through saveRecord, which keeps this current.
    const cache = this.#recordCache()
    const hit = cache?.get(id)
    if (hit && hit.workspaceId === ws) return structuredClone(hit)
    const r = await this.#q().selectFrom('ledger_records').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    const rec = r ? toRecord(r) : null
    if (rec) cache?.set(id, structuredClone(rec))
    return rec
  }

  /** Inside a transaction: read these records into its cache in a few queries (later getRecord calls hit it). */
  async prefetchRecords(ws: WorkspaceId, ids: Id[]): Promise<void> {
    const cache = this.#recordCache()
    if (!cache) return
    const missing = [...new Set(ids)].filter((id) => !cache.has(id))
    if (missing.length === 0) return
    await this.#flushRecords()
    for (let i = 0; i < missing.length; i += 500) {
      const rows = await this.#q().selectFrom('ledger_records').selectAll().where('workspace_id', '=', ws).where('id', 'in', missing.slice(i, i + 500)).execute()
      for (const r of rows) if (!cache.has(r.id)) cache.set(r.id, toRecord(r))
    }
  }

  readonly #records = new WeakMap<object, Map<Id, SourceRecord>>()

  #recordCache(): Map<Id, SourceRecord> | undefined {
    const tx = this.scope.current()
    if (!tx) return undefined
    let m = this.#records.get(tx)
    if (!m) {
      m = new Map()
      this.#records.set(tx, m)
    }
    return m
  }

  async findRecord(ws: WorkspaceId, connectionId: Id, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord | null> {
    await this.#flushRecords()
    const r = await this.#q()
      .selectFrom('ledger_records')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('connection_id', '=', connectionId)
      .where('event_type', '=', eventType)
      .where('external_id', '=', externalId)
      .executeTakeFirst()
    return r ? toRecord(r) : null
  }

  async findRecordsByExternalId(ws: WorkspaceId, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord[]> {
    await this.#flushRecords()
    const rows = await this.#q().selectFrom('ledger_records').selectAll().where('workspace_id', '=', ws).where('event_type', '=', eventType).where('external_id', '=', externalId).execute()
    return rows.map(toRecord)
  }

  async saveRecord(r: SourceRecord): Promise<void> {
    const row: LedgerRecordsTable = {
      id: r.id,
      workspace_id: r.workspaceId,
      connection_id: r.connectionId,
      event_type: r.eventType,
      external_id: r.externalId,
      content_hash: r.contentHash,
      event_json: JSON.stringify(r.event),
      origin: r.origin,
      created_by: r.createdBy,
      source_account_id: r.sourceAccountId,
      entity_id: r.entityId,
      status: r.status,
      date: r.date,
      amount_minor: r.amount?.minor ?? null,
      currency: r.amount?.currency ?? null,
      posting_hash: r.postingHash,
      provenance_json: r.provenance ? JSON.stringify(r.provenance) : null,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      // Only an insert takes it (the upsert's update leaves it alone): a later save isn't a sighting.
      last_seen_at: r.origin === 'connector' ? r.updatedAt : null,
    }
    const tx = this.scope.current()
    if (!tx) return this.#writeRecords([row])
    // Written behind, like journal entries: one multi-row upsert when the table is next read or at commit.
    let buf = this.#recordBufs.get(tx)
    if (!buf) {
      buf = new Map()
      this.#recordBufs.set(tx, buf)
      this.scope.beforeCommit(() => this.#flushRecords())
    }
    buf.set(r.id, row)
    this.#recordCache()?.set(r.id, structuredClone(r))
  }

  readonly #recordBufs = new WeakMap<object, Map<Id, LedgerRecordsTable>>()

  /**
   * Flushes of one buffer, one after another per transaction. A read that finds the buffer already emptied by another
   * read's flush, still writing, must wait for that write: the overview's reads run together, and on Postgres the
   * second one read the books without the transaction's own entries (SQLite's driver hid it by being synchronous).
   */
  readonly #flushing = new WeakMap<object, Map<string, Promise<void>>>()
  async #inOrder(kind: string, run: () => Promise<void>): Promise<void> {
    const tx = this.scope.current()
    if (!tx) return run()
    let chains = this.#flushing.get(tx)
    if (!chains) this.#flushing.set(tx, (chains = new Map()))
    const prev = chains.get(kind)
    const next = prev ? prev.catch(() => undefined).then(run) : run()
    chains.set(kind, next)
    try {
      await next
    } finally {
      if (chains.get(kind) === next) chains.delete(kind)
    }
  }

  #flushRecords(): Promise<void> {
    return this.#inOrder('records', () => this.#flushRecordsNow())
  }

  async #flushRecordsNow(): Promise<void> {
    const tx = this.scope.current()
    const buf = tx ? this.#recordBufs.get(tx) : undefined
    if (!buf || buf.size === 0) return
    const rows = [...buf.values()]
    buf.clear()
    await this.#writeRecords(rows)
  }

  async #writeRecords(rows: LedgerRecordsTable[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 300) {
      await this.#q()
        .insertInto('ledger_records')
        .values(rows.slice(i, i + 300))
        .onConflict((oc) =>
          oc.column('id').doUpdateSet((eb) => ({
            connection_id: eb.ref('excluded.connection_id'),
            event_type: eb.ref('excluded.event_type'),
            external_id: eb.ref('excluded.external_id'),
            content_hash: eb.ref('excluded.content_hash'),
            event_json: eb.ref('excluded.event_json'),
            origin: eb.ref('excluded.origin'),
            created_by: eb.ref('excluded.created_by'),
            source_account_id: eb.ref('excluded.source_account_id'),
            entity_id: eb.ref('excluded.entity_id'),
            status: eb.ref('excluded.status'),
            date: eb.ref('excluded.date'),
            amount_minor: eb.ref('excluded.amount_minor'),
            currency: eb.ref('excluded.currency'),
            posting_hash: eb.ref('excluded.posting_hash'),
            provenance_json: eb.ref('excluded.provenance_json'),
            updated_at: eb.ref('excluded.updated_at'),
          })),
        )
        .execute()
    }
  }

  async listRecords(ws: WorkspaceId, f: RecordFilter = {}): Promise<SourceRecord[]> {
    await this.#flushRecords()
    let q = this.#q().selectFrom('ledger_records').selectAll().where('workspace_id', '=', ws)
    if (f.entityIds) q = f.entityIds.length ? q.where('entity_id', 'in', f.entityIds) : q.where(sql<boolean>`1 = 0`)
    if (f.eventTypes) q = f.eventTypes.length ? q.where('event_type', 'in', f.eventTypes) : q.where(sql<boolean>`1 = 0`)
    if (f.excludeEventTypes?.length) q = q.where('event_type', 'not in', f.excludeEventTypes)
    if (f.sourceAccountId) q = q.where('source_account_id', '=', f.sourceAccountId)
    if (f.connectionId) q = q.where('connection_id', '=', f.connectionId)
    if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`1 = 0`)
    if (f.fromDate) q = q.where('date', '>=', f.fromDate)
    if (f.toDate) q = q.where('date', '<=', f.toDate)
    if (f.updatedSince) q = q.where('updated_at', '>=', f.updatedSince)
    q = f.latestFirst ? q.orderBy('date', 'desc').orderBy('id', 'desc') : q.orderBy('date').orderBy('id')
    if (f.limit !== undefined) q = q.limit(f.limit)
    // Parsed in chunks: a whole ledger is ~10k rows of JSON (see yield.ts).
    return mapYielding(await q.execute(), toRecord)
  }

  async findLedgerAccount(ws: WorkspaceId, entityId: EntityId, role: SystemRole): Promise<LedgerAccount | null> {
    const r = await this.#q().selectFrom('ledger_accounts').selectAll().where('workspace_id', '=', ws).where('entity_id', '=', entityId).where('role', '=', role).executeTakeFirst()
    return r ? toAccount(r) : null
  }

  async createLedgerAccount(a: LedgerAccount): Promise<void> {
    await this.#q()
      .insertInto('ledger_accounts')
      .values({ id: a.id, workspace_id: a.workspaceId, entity_id: a.entityId, role: a.role, code: a.code, name: a.name, type: a.type, normal_balance: a.normalBalance, created_at: a.createdAt })
      .execute()
  }

  async listLedgerAccounts(ws: WorkspaceId, entityIds?: EntityId[]): Promise<LedgerAccount[]> {
    let q = this.#q().selectFrom('ledger_accounts').selectAll().where('workspace_id', '=', ws)
    if (entityIds) q = entityIds.length ? q.where('entity_id', 'in', entityIds) : q.where(sql<boolean>`1 = 0`)
    return (await q.orderBy('code').orderBy('name').execute()).map(toAccount)
  }

  /**
   * Inside a transaction, entries are written behind: kept in order and inserted many rows per statement when the
   * journal is next read or the transaction commits (a sync page posts thousands of rows; each round trip to a hosted
   * Postgres costs a millisecond or two). Outside one, written at once.
   */
  async insertEntry(e: JournalEntry): Promise<void> {
    assertEntryBalanced(e)
    const tx = this.scope.current()
    if (!tx) return this.#writeEntries([e])
    let buf = this.#pending.get(tx)
    if (!buf) {
      buf = []
      this.#pending.set(tx, buf)
      this.scope.beforeCommit(() => this.#flushEntries())
    }
    buf.push(e)
    const active = this.#activeCache()
    if (active && e.reversesId === null && e.reversedById === null && active.bySource.has(e.sourceId)) {
      active.bySource.get(e.sourceId)?.push(structuredClone(e))
      active.sourceOf.set(e.id, e.sourceId)
    }
  }

  readonly #pending = new WeakMap<object, JournalEntry[]>()
  /** Reversal marks written behind with the entries: entry id → [the reversing entry's id, workspace, the entry's source]. */
  readonly #pendingMarks = new WeakMap<object, Map<Id, [Id, WorkspaceId, Id]>>()

  #holds(match: (e: JournalEntry) => boolean): boolean {
    const tx = this.scope.current()
    if (!tx) return false
    for (const [id, [, ws, sourceId]] of this.#pendingMarks.get(tx) ?? []) if (match({ id, workspaceId: ws, sourceId } as JournalEntry)) return true
    return this.#pending.get(tx)?.some(match) ?? false
  }

  /**
   * Per transaction: the active (not reversed, not a reversal) entries of the sources read so far, kept current by
   * insertEntry and markReversed, so reposting a record reads its entries once, or not at all after a prefetch.
   */
  readonly #active = new WeakMap<object, { bySource: Map<Id, JournalEntry[]>; sourceOf: Map<Id, Id> }>()

  #activeCache(): { bySource: Map<Id, JournalEntry[]>; sourceOf: Map<Id, Id> } | undefined {
    const tx = this.scope.current()
    if (!tx) return undefined
    let c = this.#active.get(tx)
    if (!c) {
      c = { bySource: new Map(), sourceOf: new Map() }
      this.#active.set(tx, c)
    }
    return c
  }

  /** Inside a transaction: read these sources' active entries into its cache in a few queries. */
  async prefetchActiveEntries(ws: WorkspaceId, sourceIds: Id[]): Promise<void> {
    const c = this.#activeCache()
    if (!c) return
    const missing = [...new Set(sourceIds)].filter((id) => !c.bySource.has(id))
    if (missing.length === 0) return
    const want = new Set(missing)
    if (this.#holds((e) => want.has(e.sourceId))) await this.#flushEntries()
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500)
      const rows = await this.#q()
        .selectFrom('journal_entries')
        .selectAll()
        .where('workspace_id', '=', ws)
        .where('source_id', 'in', chunk)
        .where('reversed_by_id', 'is', null)
        .where('reverses_id', 'is', null)
        .orderBy('id')
        .execute()
      for (const id of chunk) c.bySource.set(id, [])
      for (const e of await this.#withLines(rows)) {
        c.bySource.get(e.sourceId)?.push(e)
        c.sourceOf.set(e.id, e.sourceId)
      }
    }
  }

  #flushEntries(): Promise<void> {
    return this.#inOrder('entries', () => this.#flushEntriesNow())
  }

  async #flushEntriesNow(): Promise<void> {
    const tx = this.scope.current()
    const buf = tx ? this.#pending.get(tx) : undefined
    const marks = tx ? this.#pendingMarks.get(tx) : undefined
    if (buf?.length) await this.#writeEntries(buf.splice(0, buf.length))
    if (marks?.size) {
      const all = [...marks]
      marks.clear()
      // Many marks per statement; each must find its entry still unreversed.
      for (let i = 0; i < all.length; i += 400) {
        const chunk = all.slice(i, i + 400)
        const ws = chunk[0]?.[1][1] as WorkspaceId
        if (chunk.some(([, [, w]]) => w !== ws)) throw new Error('Reversal marks for several workspaces in one transaction')
        const res = await this.#q()
          .updateTable('journal_entries')
          .set({ reversed_by_id: sql<string>`case id ${sql.join(chunk.map(([id, by]) => sql`when ${id} then ${by[0]}`), sql` `)} end` })
          .where('workspace_id', '=', ws)
          .where('id', 'in', chunk.map(([id]) => id))
          .where('reversed_by_id', 'is', null)
          .executeTakeFirst()
        if (Number(res.numUpdatedRows) !== chunk.length) throw new Error('Entry not found or already reversed')
      }
    }
  }


  async #writeEntries(entries: JournalEntry[]): Promise<void> {
    const ids = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.ledgerAccountId)))]
    const entityOf = new Map<string, string>()
    for (let i = 0; i < ids.length; i += 900) {
      for (const a of await this.#q().selectFrom('ledger_accounts').select(['id', 'entity_id']).where('id', 'in', ids.slice(i, i + 900)).execute()) entityOf.set(a.id, a.entity_id)
    }
    for (const e of entries) for (const l of e.lines) if (entityOf.get(l.ledgerAccountId) !== e.entityId) throw new Error(`Line account ${l.ledgerAccountId} is not in entity ${e.entityId}`)
    for (let i = 0; i < entries.length; i += 400) {
      await this.#q()
        .insertInto('journal_entries')
        .values(
          entries.slice(i, i + 400).map((e) => ({
            id: e.id,
            workspace_id: e.workspaceId,
            entity_id: e.entityId,
            date: e.date,
            basis: e.basis,
            kind: e.kind,
            source_id: e.sourceId,
            memo: e.memo,
            reverses_id: e.reversesId,
            reversed_by_id: e.reversedById,
            created_at: e.createdAt,
          })),
        )
        .execute()
    }
    const lines = entries.flatMap((e) =>
      e.lines.map((l, i) => ({
        id: l.id,
        workspace_id: e.workspaceId,
        entry_id: e.id,
        ledger_account_id: l.ledgerAccountId,
        debit_minor: l.debitMinor,
        credit_minor: l.creditMinor,
        currency: l.currency,
        base_debit_minor: l.baseDebitMinor,
        base_credit_minor: l.baseCreditMinor,
        fx_rate: l.fxRate,
        bucket_id: l.bucketId,
        memo: l.memo,
        line_no: i,
        created_at: e.createdAt,
      })),
    )
    for (let i = 0; i < lines.length; i += 1_000) await this.#q().insertInto('journal_lines').values(lines.slice(i, i + 1_000)).execute()
  }

  async #withLines(rows: JournalEntriesTable[]): Promise<JournalEntry[]> {
    if (rows.length === 0) return []
    const lines = await this.#q()
      .selectFrom('journal_lines')
      .selectAll()
      .where(
        'entry_id',
        'in',
        rows.map((r) => r.id),
      )
      .orderBy('entry_id')
      .orderBy('line_no')
      .execute()
    const byEntry = new Map<string, JournalLine[]>()
    for (const l of lines) byEntry.set(l.entry_id, [...(byEntry.get(l.entry_id) ?? []), toLine(l)])
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      entityId: r.entity_id,
      date: r.date,
      basis: r.basis as JournalEntry['basis'],
      kind: r.kind as JournalEntry['kind'],
      sourceId: r.source_id,
      memo: r.memo,
      reversesId: r.reverses_id,
      reversedById: r.reversed_by_id,
      createdAt: r.created_at,
      lines: byEntry.get(r.id) ?? [],
    }))
  }

  async listActiveEntries(ws: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]> {
    await this.#flushEntries()
    let q = this.#q()
      .selectFrom('journal_entries')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('basis', 'in', [f.basis, 'both'])
      .where('reversed_by_id', 'is', null)
      .where('reverses_id', 'is', null)
    if (f.entityIds) q = f.entityIds.length ? q.where('entity_id', 'in', f.entityIds) : q.where(sql<boolean>`1 = 0`)
    if (f.fromDate) q = q.where('date', '>=', f.fromDate)
    if (f.toDate) q = q.where('date', '<=', f.toDate)
    const rows = await q.orderBy('date').orderBy('id').execute()
    const out: JournalEntry[] = []
    for (let i = 0; i < rows.length; i += 500) out.push(...(await this.#withLines(rows.slice(i, i + 500))))
    return out
  }

  async listMovedReversals(ws: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]> {
    await this.#flushEntries()
    if (f.entityIds && f.entityIds.length === 0) return []
    let q = this.#q()
      .selectFrom('journal_entries as r')
      .innerJoin('journal_entries as o', 'o.id', 'r.reverses_id')
      .select(['r.id as rid', 'o.id as oid'])
      .where('r.workspace_id', '=', ws)
      .where('r.basis', 'in', [f.basis, 'both'])
      .whereRef('r.date', '<>', 'o.date')
    if (f.entityIds) q = q.where('r.entity_id', 'in', f.entityIds)
    const pairs = await q.execute()
    const ids = pairs.flatMap((p) => [p.rid, p.oid])
    const out: JournalEntry[] = []
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.#q().selectFrom('journal_entries').selectAll().where('workspace_id', '=', ws).where('id', 'in', ids.slice(i, i + 500)).execute()
      out.push(...(await this.#withLines(rows.filter((r) => (!f.fromDate || r.date >= f.fromDate) && (!f.toDate || r.date <= f.toDate)))))
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  }

  async activeEntriesForSource(ws: WorkspaceId, sourceId: Id): Promise<JournalEntry[]> {
    const c = this.#activeCache()
    const hit = c?.bySource.get(sourceId)
    if (hit && (hit[0] === undefined || hit[0].workspaceId === ws)) return structuredClone(hit).sort((a, b) => (a.id < b.id ? -1 : 1))
    if (this.#holds((e) => e.sourceId === sourceId)) await this.#flushEntries()
    const rows = await this.#q()
      .selectFrom('journal_entries')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('source_id', '=', sourceId)
      .where('reversed_by_id', 'is', null)
      .where('reverses_id', 'is', null)
      .orderBy('id')
      .execute()
    const out = await this.#withLines(rows)
    if (c) {
      c.bySource.set(sourceId, structuredClone(out))
      for (const e of out) c.sourceOf.set(e.id, sourceId)
    }
    return out
  }

  async activeEntryKinds(ws: WorkspaceId, sourceIds: Id[]): Promise<Map<Id, JournalEntry['kind']>> {
    const want = [...new Set(sourceIds)]
    const out = new Map<Id, JournalEntry['kind']>()
    const wanted = new Set(want)
    if (this.#holds((e) => wanted.has(e.sourceId))) await this.#flushEntries()
    // Chunked so the IN list stays well under the parameter limit; ordered by id like activeEntriesForSource.
    for (let i = 0; i < want.length; i += ID_CHUNK) {
      const rows = await this.#q()
        .selectFrom('journal_entries')
        .select(['source_id', 'kind'])
        .where('workspace_id', '=', ws)
        .where('source_id', 'in', want.slice(i, i + ID_CHUNK))
        .where('reversed_by_id', 'is', null)
        .where('reverses_id', 'is', null)
        .orderBy('id')
        .execute()
      for (const r of rows) if (!out.has(r.source_id)) out.set(r.source_id, r.kind as JournalEntry['kind'])
    }
    return out
  }

  async markReversed(ws: WorkspaceId, entryId: Id, reversedById: Id): Promise<void> {
    // Still in the write-behind buffer: mark it there.
    const tx = this.scope.current()
    const held = tx ? this.#pending.get(tx)?.find((e) => e.id === entryId) : undefined
    if (held) {
      if (held.reversedById !== null) throw new Error(`Entry ${entryId} not found or already reversed`)
      held.reversedById = reversedById
      this.#dropActive(entryId)
      return
    }
    // Known active in this transaction (read through the cache): the mark is written behind with the entries.
    const c = this.#activeCache()
    if (tx && c?.sourceOf.has(entryId)) {
      let marks = this.#pendingMarks.get(tx)
      if (!marks) {
        marks = new Map()
        this.#pendingMarks.set(tx, marks)
        this.scope.beforeCommit(() => this.#flushEntries())
      }
      if (marks.has(entryId)) throw new Error(`Entry ${entryId} not found or already reversed`)
      marks.set(entryId, [reversedById, ws, c.sourceOf.get(entryId) as Id])
      this.#dropActive(entryId)
      return
    }
    const res = await this.#q()
      .updateTable('journal_entries')
      .set({ reversed_by_id: reversedById })
      .where('workspace_id', '=', ws)
      .where('id', '=', entryId)
      .where('reversed_by_id', 'is', null)
      .executeTakeFirst()
    if (Number(res.numUpdatedRows) !== 1) throw new Error(`Entry ${entryId} not found or already reversed`)
  }

  #dropActive(entryId: Id): void {
    const c = this.#activeCache()
    const src = c?.sourceOf.get(entryId)
    if (!c || src === undefined) return
    c.sourceOf.delete(entryId)
    const list = c.bySource.get(src)
    if (list) c.bySource.set(src, list.filter((e) => e.id !== entryId))
  }

  async getEntry(ws: WorkspaceId, id: Id): Promise<JournalEntry | null> {
    if (this.#holds((e) => e.id === id)) await this.#flushEntries()
    const rows = await this.#q().selectFrom('journal_entries').selectAll().where('workspace_id', '=', ws).where('id', '=', id).execute()
    return (await this.#withLines(rows))[0] ?? null
  }

  #lineQuery(ws: WorkspaceId, f: LineFilter) {
    let q = this.#q()
      .selectFrom('journal_lines as l')
      .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
      .where('e.workspace_id', '=', ws)
      .where('e.basis', 'in', [f.basis, 'both'])
    // With a company filter, start from entries (company + date index) and reach lines by entry id. Only without one
    // may an account or bucket filter use the lines' own index. Lines always share their entry's workspace, so the
    // extra condition is left out where it would tempt a planner without statistics (SQLite, a fresh Postgres) into
    // walking every line in the workspace.
    if (!f.entityIds && (f.ledgerAccountIds || f.bucketId)) q = q.where('l.workspace_id', '=', ws)
    if (f.entityIds) q = f.entityIds.length ? q.where('e.entity_id', 'in', f.entityIds) : q.where(sql<boolean>`1 = 0`)
    if (f.fromDate) q = q.where('e.date', '>=', f.fromDate)
    if (f.toDate) q = q.where('e.date', '<=', f.toDate)
    if (f.ledgerAccountIds) q = f.ledgerAccountIds.length ? q.where('l.ledger_account_id', 'in', f.ledgerAccountIds) : q.where(sql<boolean>`1 = 0`)
    if (f.bucketId) q = q.where('l.bucket_id', '=', f.bucketId)
    if (f.excludeSourceId) q = q.where('e.source_id', '!=', f.excludeSourceId)
    if (f.sourceIds) q = f.sourceIds.length ? q.where('e.source_id', 'in', f.sourceIds) : q.where(sql<boolean>`1 = 0`)
    return q
  }

  /**
   * Postgres: entries and lines as plain statements, joined here by entry id. Any SQL join of the two let the planner
   * pick a nested loop on a new workspace's 1-row guess: first over the row-security filter (staging: ~300 ms), then,
   * as a materialized CTE, lines x entries re-scanned (staging: 13.6 s for 15k lines after a write, f8 2026-10-12),
   * and the company-filtered join 9.4 s for 23k lines under load (af, 2026-10-12). A single-table read can't go
   * quadratic, whatever the estimate. Lines come by account or bucket when filtered so, else by the entries' ids.
   */
  async #splitLines(ws: WorkspaceId, f: LineFilter): Promise<LineRow[]> {
    let e = this.#q().selectFrom('journal_entries').select(['id', 'entity_id', 'date', 'basis', 'kind', 'source_id']).where('workspace_id', '=', ws).where('basis', 'in', [f.basis, 'both'])
    if (f.entityIds) e = e.where('entity_id', 'in', f.entityIds)
    if (f.fromDate) e = e.where('date', '>=', f.fromDate)
    if (f.toDate) e = e.where('date', '<=', f.toDate)
    if (f.excludeSourceId) e = e.where('source_id', '!=', f.excludeSourceId)
    if (f.sourceIds) e = e.where('source_id', 'in', f.sourceIds)
    const lineQuery = () => {
      let l = this.#q().selectFrom('journal_lines').selectAll().where('workspace_id', '=', ws)
      if (f.ledgerAccountIds) l = l.where('ledger_account_id', 'in', f.ledgerAccountIds)
      if (f.bucketId) l = l.where('bucket_id', '=', f.bucketId)
      return l
    }
    let entries: Awaited<ReturnType<typeof e.execute>>
    let lines: JournalLinesTable[]
    if (f.ledgerAccountIds || f.bucketId) [entries, lines] = await Promise.all([e.execute(), lineQuery().execute()])
    else {
      entries = await e.execute()
      lines = []
      // One array parameter per chunk, however many entries.
      for (let i = 0; i < entries.length; i += LINE_ENTRY_CHUNK) {
        const ids = entries.slice(i, i + LINE_ENTRY_CHUNK).map((x) => x.id)
        lines.push(...(await lineQuery().where(sql<boolean>`entry_id = any(${ids}::text[])`).execute()))
      }
    }
    const byId = new Map(entries.map((x) => [x.id, x]))
    const out: LineRow[] = []
    for (const r of lines) {
      const x = byId.get(r.entry_id)
      if (!x) continue
      out.push({ ...toLine(r), entityId: x.entity_id, date: x.date, basis: x.basis as LineRow['basis'], kind: x.kind as LineRow['kind'], sourceId: x.source_id })
    }
    // The order the SQL gave: by date, then line id.
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async listLines(ws: WorkspaceId, f: LineFilter): Promise<LineRow[]> {
    await this.#flushEntries()
    if (this.scope.db.getExecutor().adapter instanceof PostgresAdapter) {
      if (f.entityIds?.length === 0 || f.ledgerAccountIds?.length === 0 || f.sourceIds?.length === 0) return []
      return this.#splitLines(ws, f)
    }
    const rows = await this.#lineQuery(ws, f)
      .selectAll('l')
      .select(['e.entity_id', 'e.date', 'e.basis', 'e.kind', 'e.source_id'])
      .orderBy('e.date')
      .orderBy('l.id')
      .execute()
    return rows.map((r) => ({
      ...toLine(r),
      entityId: r.entity_id,
      date: r.date,
      basis: r.basis as LineRow['basis'],
      kind: r.kind as LineRow['kind'],
      sourceId: r.source_id,
    }))
  }

  async entityNets(ws: WorkspaceId, f: LineFilter): Promise<Map<EntityId, number>> {
    await this.#flushEntries()
    const rows = await this.#lineQuery(ws, f)
      .select((eb) => ['e.entity_id', eb.fn.sum<number>('l.base_debit_minor').as('bd'), eb.fn.sum<number>('l.base_credit_minor').as('bc')])
      .groupBy('e.entity_id')
      .execute()
    return new Map(rows.map((r) => [r.entity_id as EntityId, num(r.bd) - num(r.bc)]))
  }

  async accountTotals(ws: WorkspaceId, f: LineFilter): Promise<AccountTotal[]> {
    await this.#flushEntries()
    const rows = await this.#lineQuery(ws, f)
      .select((eb) => [
        'l.ledger_account_id',
        'l.currency',
        eb.fn.sum<number>('l.debit_minor').as('d'),
        eb.fn.sum<number>('l.credit_minor').as('c'),
        eb.fn.sum<number>('l.base_debit_minor').as('bd'),
        eb.fn.sum<number>('l.base_credit_minor').as('bc'),
        eb.fn.min<string>('e.date').as('first'),
      ])
      .groupBy(['l.ledger_account_id', 'l.currency'])
      .execute()
    return rows.map((r) => ({
      ledgerAccountId: r.ledger_account_id,
      currency: r.currency,
      debitMinor: num(r.d),
      creditMinor: num(r.c),
      baseDebitMinor: num(r.bd),
      baseCreditMinor: num(r.bc),
      firstDate: r.first ?? null,
    }))
  }

  async unbalancedEntries(ws: WorkspaceId): Promise<Id[]> {
    await this.#flushEntries()
    const rows = await this.#q()
      .selectFrom('journal_lines')
      .select((eb) => ['entry_id', eb.fn.sum<number>('base_debit_minor').as('d'), eb.fn.sum<number>('base_credit_minor').as('c')])
      .where('workspace_id', '=', ws)
      .groupBy('entry_id')
      .having(sql<boolean>`sum(base_debit_minor) <> sum(base_credit_minor)`)
      .execute()
    return rows.filter((r) => num(r.d) !== num(r.c)).map((r) => r.entry_id)
  }

  async saveLink(l: Link): Promise<void> {
    const row: LedgerLinksTable = {
      id: l.id,
      workspace_id: l.workspaceId,
      type: l.type,
      from_id: l.fromId,
      to_id: l.toId,
      amount_minor: l.amount?.minor ?? null,
      currency: l.amount?.currency ?? null,
      confidence: l.confidence,
      method: l.method,
      status: l.status,
      scores_json: l.scores ? JSON.stringify(l.scores) : null,
      created_by: l.createdBy,
      decided_by: l.decidedBy,
      decided_at: l.decidedAt,
      created_at: l.createdAt,
    }
    const tx = this.scope.current()
    if (!tx) {
      const { id: _id, workspace_id: _ws, created_at: _c, ...update } = row
      await this.#q().insertInto('ledger_links').values(row).onConflict((oc) => oc.column('id').doUpdateSet(update)).execute()
    } else {
      // Written behind, many rows per statement, before any read of links and at commit.
      let buf = this.#pendingLinks.get(tx)
      if (!buf) {
        buf = new Map()
        this.#pendingLinks.set(tx, buf)
        this.scope.beforeCommit(() => this.#flushLinks())
      }
      const prev = buf.get(row.id)
      buf.set(row.id, prev ? { ...row, created_at: prev.created_at } : row)
    }
    // Keep cached link lists current (the row was just written in this transaction; created_at stays the first one).
    const cache = this.#txMap(this.#linkCaches)
    for (const end of new Set([row.from_id, row.to_id])) {
      const list = cache?.get(end)
      if (!list) continue
      let found = false
      for (const [i, x] of list.entries()) {
        if (x.id !== row.id) continue
        list[i] = { ...row, created_at: x.created_at }
        found = true
      }
      if (!found) list.push(row)
    }
  }

  readonly #pendingLinks = new WeakMap<object, Map<Id, LedgerLinksTable>>()

  #flushLinks(): Promise<void> {
    return this.#inOrder('links', () => this.#flushLinksNow())
  }

  async #flushLinksNow(): Promise<void> {
    const tx = this.scope.current()
    const buf = tx ? this.#pendingLinks.get(tx) : undefined
    if (!buf || buf.size === 0) return
    const rows = [...buf.values()]
    buf.clear()
    await this.#flushRecords() // links reference records
    for (let i = 0; i < rows.length; i += 300) {
      await this.#q()
        .insertInto('ledger_links')
        .values(rows.slice(i, i + 300))
        .onConflict((oc) =>
          oc.column('id').doUpdateSet((eb) => ({
            type: eb.ref('excluded.type'),
            from_id: eb.ref('excluded.from_id'),
            to_id: eb.ref('excluded.to_id'),
            amount_minor: eb.ref('excluded.amount_minor'),
            currency: eb.ref('excluded.currency'),
            confidence: eb.ref('excluded.confidence'),
            method: eb.ref('excluded.method'),
            status: eb.ref('excluded.status'),
            scores_json: eb.ref('excluded.scores_json'),
            created_by: eb.ref('excluded.created_by'),
            decided_by: eb.ref('excluded.decided_by'),
            decided_at: eb.ref('excluded.decided_at'),
          })),
        )
        .execute()
    }
  }

  readonly #linkCaches = new WeakMap<object, Map<Id, LedgerLinksTable[]>>()
  readonly #overrideCaches = new WeakMap<object, Map<Id, RecordOverride | null>>()

  /** A per-transaction map (reads repeated within one sync page come from memory; writes keep it current). */
  #txMap<V>(caches: WeakMap<object, Map<Id, V>>): Map<Id, V> | undefined {
    const tx = this.scope.current()
    if (!tx) return undefined
    let m = caches.get(tx)
    if (!m) {
      m = new Map()
      caches.set(tx, m)
    }
    return m
  }

  async getLink(ws: WorkspaceId, id: Id): Promise<Link | null> {
    await this.#flushLinks()
    const r = await this.#q().selectFrom('ledger_links').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? toLink(r) : null
  }

  async listLinks(ws: WorkspaceId, f: LinkFilter = {}): Promise<Link[]> {
    const ids = f.recordIds ?? (f.recordId ? [f.recordId] : null)
    if (!ids) {
      await this.#flushLinks()
      let q = this.#q().selectFrom('ledger_links').selectAll().where('workspace_id', '=', ws)
      if (f.statuses) q = f.statuses.length ? q.where('status', 'in', f.statuses) : q.where(sql<boolean>`1 = 0`)
      if (f.types) q = f.types.length ? q.where('type', 'in', f.types) : q.where(sql<boolean>`1 = 0`)
      return (await q.orderBy('id').execute()).map(toLink)
    }
    // Either end: two probes on the from/to indexes. Status and type are filtered here, not in SQL, so the
    // planner can't prefer the (workspace, status) index and scan every link.
    const byId = new Map<string, LedgerLinksTable>()
    const cache = this.#txMap(this.#linkCaches)
    const missing: Id[] = []
    for (const id of ids) {
      const hit = cache?.get(id)
      if (hit) for (const r of hit) byId.set(r.id, r)
      else missing.push(id)
    }
    if (missing.length) await this.#flushLinks()
    for (let i = 0; i < missing.length; i += ID_CHUNK) {
      const chunk = missing.slice(i, i + ID_CHUNK)
      // One round trip: both probes in a union (each side still uses its own index).
      const rows = await this.#q()
        .selectFrom('ledger_links')
        .selectAll()
        .where('workspace_id', '=', ws)
        .where('from_id', 'in', chunk)
        .unionAll(this.#q().selectFrom('ledger_links').selectAll().where('workspace_id', '=', ws).where('to_id', 'in', chunk))
        .execute()
      // A link with both ends in this chunk comes back from both probes: keep one row per link, or the cache holds
      // two copies, saveLink updates one, and the stale one wins (a confirmed bill payment reposted as unlinked).
      const unique = new Map(rows.map((r) => [r.id, r]))
      for (const r of unique.values()) byId.set(r.id, r)
      if (cache) {
        const per = new Map<Id, LedgerLinksTable[]>(chunk.map((id) => [id, []]))
        for (const r of unique.values()) {
          per.get(r.from_id)?.push(r)
          if (r.to_id !== r.from_id) per.get(r.to_id)?.push(r)
        }
        for (const [id, rs] of per) cache.set(id, rs)
      }
    }
    return [...byId.values()]
      .filter((r) => (!f.statuses || f.statuses.includes(r.status as LinkStatus)) && (!f.types || f.types.includes(r.type as LinkType)))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(toLink)
  }

  async getOverride(ws: WorkspaceId, recordId: Id): Promise<RecordOverride | null> {
    const cache = this.#txMap(this.#overrideCaches)
    if (!cache) {
      const r = await this.#q().selectFrom('ledger_overrides').selectAll().where('workspace_id', '=', ws).where('record_id', '=', recordId).executeTakeFirst()
      return r ? (JSON.parse(r.data_json) as RecordOverride) : null
    }
    // In a transaction: the workspace's overrides (people's edits, few) in one read, then from memory.
    const loaded = `loaded:${ws}`
    if (!cache.has(loaded)) {
      for (const r of await this.#q().selectFrom('ledger_overrides').selectAll().where('workspace_id', '=', ws).execute()) cache.set(r.record_id, JSON.parse(r.data_json) as RecordOverride)
      cache.set(loaded, null)
    }
    return structuredClone(cache.get(recordId) ?? null)
  }

  async saveOverride(o: RecordOverride): Promise<void> {
    const now = nowIso()
    await this.#flushRecords() // overrides reference records
    await this.#q()
      .insertInto('ledger_overrides')
      .values({ record_id: o.recordId, workspace_id: o.workspaceId, data_json: JSON.stringify(o), updated_by: o.updatedBy, updated_at: o.updatedAt, created_at: now })
      .onConflict((oc) => oc.column('record_id').doUpdateSet({ data_json: JSON.stringify(o), updated_by: o.updatedBy, updated_at: o.updatedAt }))
      .execute()
    this.#txMap(this.#overrideCaches)?.set(o.recordId, structuredClone(o))
  }

  async listOverrides(ws: WorkspaceId): Promise<RecordOverride[]> {
    return (await this.#q().selectFrom('ledger_overrides').selectAll().where('workspace_id', '=', ws).execute()).map((r) => JSON.parse(r.data_json) as RecordOverride)
  }

  async saveRule(r: Rule): Promise<void> {
    const row: LedgerRulesTable = {
      id: r.id,
      workspace_id: r.workspaceId,
      name: r.name,
      priority: r.priority,
      conditions_json: JSON.stringify(r.conditions),
      actions_json: JSON.stringify(r.actions),
      status: r.status,
      origin: r.origin,
      created_by: r.createdBy,
      hit_count: r.hitCount,
      last_hit_at: r.lastHitAt,
      created_at: r.createdAt,
    }
    // In a transaction (a page of a sync counting its rule hits): kept and written once per rule at commit.
    const tx = this.scope.current()
    if (tx) {
      let buf = this.#pendingRules.get(tx)
      if (!buf) {
        this.#pendingRules.set(tx, (buf = new Map()))
        this.scope.beforeCommit(() => this.#flushRules())
      }
      buf.set(row.id, row)
      return
    }
    await this.#writeRules([row])
  }

  readonly #pendingRules = new WeakMap<object, Map<Id, LedgerRulesTable>>()
  readonly #pendingApps = new WeakMap<object, LedgerRuleApplicationsTable[]>()

  #flushRules(): Promise<void> {
    return this.#inOrder('rules', async () => {
      const tx = this.scope.current()
      const buf = tx ? this.#pendingRules.get(tx) : undefined
      if (!buf?.size) return
      const rows = [...buf.values()]
      buf.clear()
      await this.#writeRules(rows)
    })
  }

  async #writeRules(rows: LedgerRulesTable[]): Promise<void> {
    for (const row of rows) {
      const { id: _id, workspace_id: _ws, created_at: _c, ...update } = row
      await this.#q().insertInto('ledger_rules').values(row).onConflict((oc) => oc.column('id').doUpdateSet(update)).execute()
    }
  }

  #flushApps(): Promise<void> {
    return this.#inOrder('apps', async () => {
      const tx = this.scope.current()
      const buf = tx ? this.#pendingApps.get(tx) : undefined
      if (!buf?.length) return
      const rows = buf.splice(0, buf.length)
      // Applications reference their record and rule.
      await this.#flushRecords()
      await this.#flushRules()
      for (let i = 0; i < rows.length; i += 500) await this.#q().insertInto('ledger_rule_applications').values(rows.slice(i, i + 500)).execute()
    })
  }

  async getRule(ws: WorkspaceId, id: Id): Promise<Rule | null> {
    await this.#flushRules()
    const r = await this.#q().selectFrom('ledger_rules').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? toRule(r) : null
  }

  async listRules(ws: WorkspaceId): Promise<Rule[]> {
    await this.#flushRules()
    return (await this.#q().selectFrom('ledger_rules').selectAll().where('workspace_id', '=', ws).orderBy('priority').orderBy('created_at').orderBy('id').execute()).map(toRule)
  }

  async addRuleApplication(a: RuleApplication): Promise<void> {
    const row = { id: a.id, workspace_id: a.workspaceId, rule_id: a.ruleId, record_id: a.recordId, applied_at: a.appliedAt, created_at: a.appliedAt }
    // In a transaction: written together at commit (or before they're read).
    const tx = this.scope.current()
    if (tx) {
      let buf = this.#pendingApps.get(tx)
      if (!buf) {
        this.#pendingApps.set(tx, (buf = []))
        this.scope.beforeCommit(() => this.#flushApps())
      }
      buf.push(row)
      return
    }
    await this.#flushRecords() // applications reference records
    await this.#q().insertInto('ledger_rule_applications').values(row).execute()
  }

  async listRuleApplications(ws: WorkspaceId, recordId?: Id): Promise<RuleApplication[]> {
    await this.#flushApps()
    let q = this.#q().selectFrom('ledger_rule_applications').selectAll().where('workspace_id', '=', ws)
    if (recordId) q = q.where('record_id', '=', recordId)
    return (await q.orderBy('id').execute()).map((r) => ({ id: r.id, workspaceId: r.workspace_id, ruleId: r.rule_id, recordId: r.record_id, appliedAt: r.applied_at }))
  }

  async saveBucket(b: Bucket): Promise<void> {
    const row: LedgerBucketsTable = {
      id: b.id,
      workspace_id: b.workspaceId,
      entity_id: b.entityId,
      name: b.name,
      fields_json: JSON.stringify(b.fields),
      values_json: JSON.stringify(b.values),
      schedule_json: b.schedule ? JSON.stringify(b.schedule) : null,
      set_aside_json: b.setAside ? JSON.stringify(b.setAside) : null,
      origin: b.origin,
      created_by: b.createdBy,
      created_at: b.createdAt,
      updated_at: b.updatedAt,
      archived_at: b.archivedAt,
    }
    const { id: _id, workspace_id: _ws, created_at: _c, ...update } = row
    await this.#q().insertInto('ledger_buckets').values(row).onConflict((oc) => oc.column('id').doUpdateSet(update)).execute()
  }

  async getBucket(ws: WorkspaceId, id: Id): Promise<Bucket | null> {
    const r = await this.#q().selectFrom('ledger_buckets').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? toBucket(r) : null
  }

  async listBuckets(ws: WorkspaceId, entityIds?: EntityId[]): Promise<Bucket[]> {
    let q = this.#q().selectFrom('ledger_buckets').selectAll().where('workspace_id', '=', ws)
    if (entityIds) q = entityIds.length ? q.where('entity_id', 'in', entityIds) : q.where(sql<boolean>`1 = 0`)
    return (await q.orderBy('created_at').orderBy('id').execute()).map(toBucket)
  }

  async saveWrite(w: WriteLogEntry): Promise<void> {
    const row: LedgerWritesTable = {
      id: w.id,
      workspace_id: w.workspaceId,
      op: w.op,
      record_ids_json: JSON.stringify(w.recordIds),
      before_json: w.before === undefined ? null : JSON.stringify(w.before),
      created_at: w.createdAt,
      reverted_at: w.revertedAt,
    }
    await this.#q().insertInto('ledger_writes').values(row).onConflict((oc) => oc.column('id').doUpdateSet({ reverted_at: row.reverted_at, record_ids_json: row.record_ids_json, before_json: row.before_json })).execute()
    for (const target of w.recordIds) {
      await this.#q()
        .insertInto('ledger_write_targets')
        .values({ write_id: w.id, workspace_id: w.workspaceId, target_id: target, created_at: w.createdAt })
        .onConflict((oc) => oc.columns(['write_id', 'target_id']).doNothing())
        .execute()
    }
  }

  async latestWriteFor(ws: WorkspaceId, recordId: Id): Promise<WriteLogEntry | null> {
    const r = await this.#q()
      .selectFrom('ledger_write_targets as t')
      .innerJoin('ledger_writes as w', 'w.id', 't.write_id')
      .selectAll('w')
      .where('t.workspace_id', '=', ws)
      .where('t.target_id', '=', recordId)
      .where('w.reverted_at', 'is', null)
      .orderBy('w.created_at', 'desc')
      .orderBy('w.id', 'desc')
      .executeTakeFirst()
    if (!r) return null
    return { id: r.id, workspaceId: r.workspace_id, op: r.op, recordIds: JSON.parse(r.record_ids_json) as Id[], before: parse<unknown>(r.before_json), createdAt: r.created_at, revertedAt: r.reverted_at }
  }

  async getRate(date: string, from: Currency, to: Currency): Promise<string | null> {
    const r = await this.#q().selectFrom('fx_rates').select('rate').where('date', '=', date).where('from_currency', '=', from).where('to_currency', '=', to).executeTakeFirst()
    return r?.rate ?? null
  }

  async saveRate(date: string, from: Currency, to: Currency, rate: string, source: string): Promise<void> {
    await this.#q()
      .insertInto('fx_rates')
      .values({ date, from_currency: from, to_currency: to, rate, source, created_at: nowIso() })
      .onConflict((oc) => oc.columns(['date', 'from_currency', 'to_currency']).doNothing())
      .execute()
  }
}

/** AccountDirectory over S0's tables (workspaces, entities, accounts, connections). */
export class KyselyDirectory implements AccountDirectory {
  readonly scope: DbScope
  readonly #staleAfterHours: (connectorKey: string) => number | undefined

  /** staleAfterHours: each connector's cap on data age (the server reads it from the connector's description). */
  constructor(scope: DbScope | Kysely<DB>, opts: { staleAfterHours?: (connectorKey: string) => number | undefined } = {}) {
    this.scope = scope instanceof DbScope ? scope : new DbScope(scope)
    this.#staleAfterHours = opts.staleAfterHours ?? (() => undefined)
  }

  #q(): Q {
    return this.scope.q()
  }

  async reportingCurrency(ws: WorkspaceId): Promise<Currency> {
    const r = await this.#q().selectFrom('workspaces').select('base_currency').where('id', '=', ws).executeTakeFirst()
    return r?.base_currency ?? 'USD'
  }

  async timeZone(ws: WorkspaceId): Promise<string | null> {
    const r = await this.#q().selectFrom('workspaces').select('time_zone').where('id', '=', ws).executeTakeFirst()
    return r?.time_zone ?? null
  }

  #entity(r: CoreTables['entities']): EntityInfo {
    return { id: r.id, kind: r.kind, name: r.name, baseCurrency: r.base_currency, ownerPersonId: r.owner_person_id }
  }

  async getEntity(ws: WorkspaceId, id: EntityId): Promise<EntityInfo | null> {
    const r = await this.#q().selectFrom('entities').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? this.#entity(r) : null
  }

  async listEntities(ws: WorkspaceId): Promise<EntityInfo[]> {
    const rows = await this.#q().selectFrom('entities').selectAll().where('workspace_id', '=', ws).where('archived_at', 'is', null).orderBy('created_at').orderBy('id').execute()
    return rows.map((r) => this.#entity(r))
  }

  #account(r: CoreTables['accounts']): SourceAccountInfo {
    return {
      id: r.id,
      connectionId: r.connection_id,
      externalId: r.external_id,
      entityId: r.entity_id,
      name: r.name,
      accountType: r.account_type as AccountType,
      currency: r.currency,
      includeInCash: num(r.include_in_cash) === 1,
      mask: r.mask,
      institution: r.institution,
      duplicateOf: r.duplicate_of,
      businessHint: (r.business_hint as SourceAccountInfo['businessHint']) ?? null,
    }
  }

  async getSourceAccount(ws: WorkspaceId, id: Id): Promise<SourceAccountInfo | null> {
    const r = await this.#q().selectFrom('accounts').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? this.#account(r) : null
  }

  async findSourceAccount(ws: WorkspaceId, connectionId: Id, externalId: string): Promise<SourceAccountInfo | null> {
    const r = await this.#q().selectFrom('accounts').selectAll().where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('external_id', '=', externalId).executeTakeFirst()
    return r ? this.#account(r) : null
  }

  async listSourceAccounts(ws: WorkspaceId): Promise<SourceAccountInfo[]> {
    const rows = await this.#q().selectFrom('accounts').selectAll().where('workspace_id', '=', ws).where('closed_at', 'is', null).orderBy('created_at').orderBy('name').orderBy('external_id').orderBy('id').execute()
    return rows.map((r) => this.#account(r))
  }

  async upsertSourceAccount(ws: WorkspaceId, ev: AccountUpsert): Promise<SourceAccountInfo> {
    const existing = await this.findSourceAccount(ws, ev.connectionId, ev.externalId)
    if (existing) {
      await this.#q()
        .updateTable('accounts')
        .set({ name: ev.name, account_type: ev.accountType, currency: ev.currency, mask: ev.mask ?? null, institution: ev.institution ?? null, business_hint: ev.businessHint ?? null })
        .where('id', '=', existing.id)
        .execute()
      return (await this.getSourceAccount(ws, existing.id)) as SourceAccountInfo
    }
    const id = newId()
    await this.#q()
      .insertInto('accounts')
      .values({
        id,
        workspace_id: ws,
        entity_id: null,
        connection_id: ev.connectionId,
        external_id: ev.externalId,
        name: ev.name,
        account_type: ev.accountType,
        currency: ev.currency,
        mask: ev.mask ?? null,
        institution: ev.institution ?? null,
        business_hint: ev.businessHint ?? null,
        include_in_cash: defaultIncludeInCash(ev.accountType) ? 1 : 0,
        duplicate_of: null,
        created_at: nowIso(),
        closed_at: null,
      })
      .execute()
    return (await this.getSourceAccount(ws, id)) as SourceAccountInfo
  }

  #connection(r: CoreTables['connections']): ConnectionInfo {
    const limit = this.#staleAfterHours(r.connector_key)
    return { id: r.id, connectorKey: r.connector_key, displayName: r.display_name, status: r.status, lastSuccessAt: r.last_success_at, entityId: r.entity_id ?? null, createdAt: r.created_at, ...(limit ? { staleAfterHours: limit } : {}) }
  }

  async getConnection(ws: WorkspaceId, id: Id): Promise<ConnectionInfo | null> {
    const r = await this.#q().selectFrom('connections').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()
    return r ? this.#connection(r) : null
  }

  async listConnections(ws: WorkspaceId): Promise<ConnectionInfo[]> {
    const rows = await this.#q().selectFrom('connections').selectAll().where('workspace_id', '=', ws).orderBy('id').execute()
    return rows.map((r) => this.#connection(r))
  }

  async assignSourceAccount(ws: WorkspaceId, accountId: Id, entityId: EntityId): Promise<boolean> {
    const res = await this.#q()
      .updateTable('accounts')
      .set({ entity_id: entityId })
      .where('workspace_id', '=', ws)
      .where('id', '=', accountId)
      .where('entity_id', 'is', null)
      .executeTakeFirst()
    return Number(res.numUpdatedRows) === 1
  }

  async ensureManualAccount(ws: WorkspaceId, entityId: EntityId, type: 'cash_on_hand' | 'other', name: string): Promise<SourceAccountInfo> {
    const now = nowIso()
    let conn = await this.#q().selectFrom('connections').select('id').where('workspace_id', '=', ws).where('connector_key', '=', 'manual').orderBy('created_at').executeTakeFirst()
    if (!conn) {
      const id = newId()
      await this.#q()
        .insertInto('connections')
        .values({ id, workspace_id: ws, connector_key: 'manual', display_name: 'Added by hand', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: now, entity_id: null })
        .execute()
      conn = { id }
    }
    const externalId = `${type}:${entityId}`
    const existing = await this.findSourceAccount(ws, conn.id, externalId)
    if (existing) return existing
    const entity = await this.getEntity(ws, entityId)
    if (!entity) throw new Error(`Unknown entity ${entityId}`)
    const id = newId()
    await this.#q()
      .insertInto('accounts')
      .values({
        id,
        workspace_id: ws,
        entity_id: entityId,
        connection_id: conn.id,
        external_id: externalId,
        name,
        account_type: type,
        currency: entity.baseCurrency,
        mask: null,
        institution: null,
        business_hint: null,
        include_in_cash: type === 'cash_on_hand' ? 1 : 0,
        duplicate_of: null,
        created_at: now,
        closed_at: null,
      })
      .execute()
    return (await this.getSourceAccount(ws, id)) as SourceAccountInfo
  }
}
