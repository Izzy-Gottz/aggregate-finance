// Storage ports. KyselyLedgerStore (kysely-store.ts) is production; MemoryLedgerStore (memory-store.ts) backs fast tests.
// Both run the same contract tests (store.contract.test.ts).
import type { AccountUpsert, Currency, EntityId, Id, IsoDate, IsoTimestamp, LinkType, NormalizedEvent, WorkspaceId } from '@agfn/contracts'
import type { SystemRole } from './coa.ts'
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
  RecordStatus,
  Rule,
  RuleApplication,
  SourceAccountInfo,
  SourceRecord,
  WriteLogEntry,
} from './model.ts'

export interface RecordFilter {
  entityIds?: EntityId[]
  eventTypes?: Array<NormalizedEvent['type'] | (string & {})>
  excludeEventTypes?: Array<NormalizedEvent['type'] | (string & {})>
  sourceAccountId?: Id
  connectionId?: Id
  statuses?: RecordStatus[]
  fromDate?: IsoDate
  toDate?: IsoDate
  updatedSince?: IsoTimestamp
  /** Newest first (date, id descending). */
  latestFirst?: boolean
  limit?: number
}

export interface LineFilter {
  entityIds?: EntityId[]
  /** View: 'cash' reads entries with basis cash|both, 'accrual' reads accrual|both. */
  basis: Basis
  fromDate?: IsoDate
  toDate?: IsoDate
  ledgerAccountIds?: Id[]
  bucketId?: Id
  /** Only entries of these sources (records). */
  sourceIds?: Id[]
  /** Leave out the entries of one source (e.g. the opening balance being recomputed). */
  excludeSourceId?: string
}

/** A journal line joined with its entry (for reports, metrics and drill-down). */
export interface LineRow extends JournalLine {
  entityId: EntityId
  date: IsoDate
  basis: JournalEntry['basis']
  kind: JournalEntry['kind']
  sourceId: Id
}

/** Per-account sums over a LineFilter. Base amounts are in each entity's base currency. */
export interface AccountTotal {
  ledgerAccountId: Id
  currency: Currency
  debitMinor: number
  creditMinor: number
  baseDebitMinor: number
  baseCreditMinor: number
  /** Earliest entry date among the summed lines. */
  firstDate: IsoDate | null
}

export interface LinkFilter {
  recordId?: Id
  /** Links touching any of these records. */
  recordIds?: Id[]
  statuses?: LinkStatus[]
  types?: LinkType[]
}

export interface LedgerStore {
  /** Run `fn` atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: (store: LedgerStore) => Promise<T>): Promise<T>
  /** True while inside transaction() (diagnostics and tests). */
  inTransaction?(): boolean
  /**
   * Serialize ledger writes for one workspace across processes, until the current transaction ends
   * (Postgres advisory lock; SQLite already has a single writer; memory is single-process).
   */
  lockWorkspace(workspaceId: WorkspaceId): Promise<void>
  /** Posted or recorded bank/processor rows per account per month ('YYYY-MM'). */
  monthlyRowCounts(workspaceId: WorkspaceId, accountIds: Id[]): Promise<Array<{ accountId: Id; month: string; rows: number }>>
  saveAssertion(a: BalanceAssertion): Promise<void>
  savePeriodLock(l: PeriodLock): Promise<void>
  addMrrPoint(p: MrrPoint): Promise<void>
  /** Points for these subscription records (all when omitted), by record then date. */
  listMrrPoints(workspaceId: WorkspaceId, recordIds?: Id[]): Promise<MrrPoint[]>
  /** Locks in force (not removed), oldest first; the newest per entity is the one that counts. */
  listPeriodLocks(workspaceId: WorkspaceId): Promise<PeriodLock[]>
  /** A connection's records wait for settling (matching, openings) since `since`; an earlier mark is kept. */
  /** Optional: refresh the database's query-planner statistics for the ledger tables (after a big import); true when done. */
  refreshStats?(): Promise<boolean>
  /** Optional, inside a transaction: read these into its caches in a few queries (later single reads hit them). */
  prefetchRecords?(workspaceId: WorkspaceId, ids: Id[]): Promise<void>
  prefetchActiveEntries?(workspaceId: WorkspaceId, sourceIds: Id[]): Promise<void>
  /** A sync carried these records now (unchanged ones included). */
  markSeen(workspaceId: WorkspaceId, ids: Id[], at: IsoTimestamp): Promise<void>
  /** When each of a connection's records of these types was last carried by a sync (insert time if never since). */
  lastSeen(workspaceId: WorkspaceId, connectionId: Id, eventTypes: string[]): Promise<Map<Id, IsoTimestamp>>
  saveListing(l: ListingOutcome): Promise<void>
  listListings(workspaceId: WorkspaceId): Promise<ListingOutcome[]>
  markUnsettled(workspaceId: WorkspaceId, connectionId: Id, since: IsoTimestamp): Promise<void>
  unsettledSince(workspaceId: WorkspaceId, connectionId: Id): Promise<IsoTimestamp | null>
  clearUnsettled(workspaceId: WorkspaceId, connectionId: Id): Promise<void>
  /** The matcher version that last matched the workspace's whole history; null for a workspace never recorded. */
  matchedWith(workspaceId: WorkspaceId): Promise<number | null>
  setMatchedWith(workspaceId: WorkspaceId, version: number, at: IsoTimestamp): Promise<void>
  /** Assertions still in force (not removed), by account and date. */
  listAssertions(workspaceId: WorkspaceId, accountIds?: Id[]): Promise<BalanceAssertion[]>
  getAssertion(workspaceId: WorkspaceId, id: Id): Promise<BalanceAssertion | null>
  /** Write counter: bumped at the end of every engine write, inside its transaction. */
  bumpVersion(workspaceId: WorkspaceId, at: string): Promise<void>
  version(workspaceId: WorkspaceId): Promise<number>

  getRecord(workspaceId: WorkspaceId, id: Id): Promise<SourceRecord | null>
  /** Many records by id (missing ids are skipped; order not guaranteed). */
  getRecords(workspaceId: WorkspaceId, ids: Id[]): Promise<SourceRecord[]>
  /**
   * Per record id, a key that is the same on every run and database: "<date>|<event type>:<external id>". Ids are random,
   * so lists that tie (same day) are ordered by this instead. Without `ids`, every record of the workspace (one light
   * read). Missing ids are skipped.
   */
  recordSortKeys(workspaceId: WorkspaceId, ids?: Id[]): Promise<Map<Id, string>>
  /**
   * A derived result (engine #shared) computed at this ledger version, no older than `since`; JSON. Optional: a store
   * without it (memory) keeps derived results in the process only.
   */
  getDerived?(workspaceId: WorkspaceId, keyHash: string, version: number, since: IsoTimestamp): Promise<string | null>
  /** Keep a derived result for other processes, and prune the workspace's rows older than this version or `staleBefore`. */
  putDerived?(workspaceId: WorkspaceId, key: string, keyHash: string, version: number, valueJson: string, at: IsoTimestamp, staleBefore: IsoTimestamp): Promise<void>
  /** Every workspace's derived results written since `since` (a starting process loads them; run across workspaces). */
  recentDerived?(since: IsoTimestamp): Promise<Array<{ workspaceId: WorkspaceId; key: string; version: number; valueJson: string; at: IsoTimestamp }>>
  /** Delete one connection's records and everything kept for them (entries, links, overrides, rule hits, MRR points, the
   *  write log about them only) and the workspace's stored derived results. Returns how many records went. */
  eraseConnection?(workspaceId: WorkspaceId, connectionId: Id): Promise<number>
  /** Which event types the entities' records include (presence only, one light read). */
  eventTypesPresent(workspaceId: WorkspaceId, entityIds: EntityId[]): Promise<Set<SourceRecord['eventType']>>
  /** Records an AI or a person wrote (origin other than a connector), with their status: few, next to what syncs bring in. */
  addedByHand(workspaceId: WorkspaceId): Promise<Map<Id, SourceRecord['status']>>
  /** Recorded/posted records of these types on each account's newest day with one, on or before `toDate` (all of that day's, for the caller to pick). */
  latestRecordsByAccount(workspaceId: WorkspaceId, accountIds: Id[], eventTypes: SourceRecord['eventType'][], toDate?: IsoDate): Promise<SourceRecord[]>
  findRecord(workspaceId: WorkspaceId, connectionId: Id, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord | null>
  /** Many findRecord lookups at once (a sync page); missing keys are simply absent. */
  findRecordsByKeys(workspaceId: WorkspaceId, keys: Array<{ connectionId: Id; eventType: SourceRecord['eventType']; externalId: string }>): Promise<SourceRecord[]>
  /** Same external id on any connection (e.g. a bank txn referenced by an invoicing tool). */
  findRecordsByExternalId(workspaceId: WorkspaceId, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord[]>
  saveRecord(record: SourceRecord): Promise<void>
  listRecords(workspaceId: WorkspaceId, filter?: RecordFilter): Promise<SourceRecord[]>

  findLedgerAccount(workspaceId: WorkspaceId, entityId: EntityId, role: SystemRole): Promise<LedgerAccount | null>
  createLedgerAccount(account: LedgerAccount): Promise<void>
  listLedgerAccounts(workspaceId: WorkspaceId, entityIds?: EntityId[]): Promise<LedgerAccount[]>

  /** Insert a balanced entry with its lines. Implementations must reject an unbalanced entry. */
  insertEntry(entry: JournalEntry): Promise<void>
  /** Entries for a source that have not been reversed (and aren't reversals). */
  activeEntriesForSource(workspaceId: WorkspaceId, sourceId: Id): Promise<JournalEntry[]>
  /** The kind of each source's first active entry (as activeEntriesForSource orders them), for many sources in a few reads. For reads outside a ledger transaction: a reversal marked inside one isn't written until it flushes. */
  activeEntryKinds(workspaceId: WorkspaceId, sourceIds: Id[]): Promise<Map<Id, JournalEntry['kind']>>
  /** The current books: entries in the view and range that aren't reversed or reversals, by date, with lines. */
  listActiveEntries(workspaceId: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]>
  /** Reversed entries and their reversals where the reversal is on another day (a change to a closed period): both sides. */
  listMovedReversals(workspaceId: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]>
  markReversed(workspaceId: WorkspaceId, entryId: Id, reversedById: Id): Promise<void>
  getEntry(workspaceId: WorkspaceId, id: Id): Promise<JournalEntry | null>
  listLines(workspaceId: WorkspaceId, filter: LineFilter): Promise<LineRow[]>
  accountTotals(workspaceId: WorkspaceId, filter: LineFilter): Promise<AccountTotal[]>
  /** Optional: base-currency debits minus credits per company (the company of each entry), in one pass. */
  entityNets?(workspaceId: WorkspaceId, filter: LineFilter): Promise<Map<EntityId, number>>
  /** Every entry's per-entry base sums, for the trial-balance check. Returns entries whose debits != credits. */
  unbalancedEntries(workspaceId: WorkspaceId): Promise<Id[]>

  saveLink(link: Link): Promise<void>
  getLink(workspaceId: WorkspaceId, id: Id): Promise<Link | null>
  listLinks(workspaceId: WorkspaceId, filter?: LinkFilter): Promise<Link[]>

  getOverride(workspaceId: WorkspaceId, recordId: Id): Promise<RecordOverride | null>
  saveOverride(override: RecordOverride): Promise<void>
  listOverrides(workspaceId: WorkspaceId): Promise<RecordOverride[]>

  saveRule(rule: Rule): Promise<void>
  getRule(workspaceId: WorkspaceId, id: Id): Promise<Rule | null>
  listRules(workspaceId: WorkspaceId): Promise<Rule[]>
  addRuleApplication(app: RuleApplication): Promise<void>
  listRuleApplications(workspaceId: WorkspaceId, recordId?: Id): Promise<RuleApplication[]>

  saveBucket(bucket: Bucket): Promise<void>
  getBucket(workspaceId: WorkspaceId, id: Id): Promise<Bucket | null>
  listBuckets(workspaceId: WorkspaceId, entityIds?: EntityId[]): Promise<Bucket[]>

  /** Cached FX rates (date, from, to) → decimal string. */
  saveWrite(entry: WriteLogEntry): Promise<void>
  /** The most recent not-yet-reverted write that touched this id. */
  latestWriteFor(workspaceId: WorkspaceId, recordId: Id): Promise<WriteLogEntry | null>

  getRate(date: IsoDate, from: Currency, to: Currency): Promise<string | null>
  saveRate(date: IsoDate, from: Currency, to: Currency, rate: string, source: string): Promise<void>
}

export interface ConnectionInfo {
  id: Id
  connectorKey: string
  status: string
  displayName: string
  lastSuccessAt: IsoTimestamp | null
  /** The company a whole connection belongs to (invoices, payroll, equity), when there is one. */
  entityId: EntityId | null
  /** When it was connected (a first import within a day isn't "stale"). */
  createdAt?: IsoTimestamp
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Not synced in over a day: last success more than a day ago, or never, once it's been connected for a day. A
 * connection added minutes ago that is still on its first import isn't stale (43's e2e: a new demo company read
 * "hasn't synced in over a day"). Status is the caller's rule.
 */
export function syncedLongAgo(c: Pick<ConnectionInfo, 'lastSuccessAt' | 'createdAt'>, nowMs: number): boolean {
  if (c.lastSuccessAt) return nowMs - Date.parse(c.lastSuccessAt) > STALE_AFTER_MS
  return !c.createdAt || nowMs - Date.parse(c.createdAt) > STALE_AFTER_MS
}

/** Read access to S0's entities, accounts and connections. */
export interface AccountDirectory {
  reportingCurrency(workspaceId: WorkspaceId): Promise<Currency>
  /** IANA time zone; null = not set (treated as America/New_York). */
  timeZone?(workspaceId: WorkspaceId): Promise<string | null>
  getEntity(workspaceId: WorkspaceId, entityId: EntityId): Promise<EntityInfo | null>
  listEntities(workspaceId: WorkspaceId): Promise<EntityInfo[]>
  getSourceAccount(workspaceId: WorkspaceId, accountId: Id): Promise<SourceAccountInfo | null>
  findSourceAccount(workspaceId: WorkspaceId, connectionId: Id, externalId: string): Promise<SourceAccountInfo | null>
  listSourceAccounts(workspaceId: WorkspaceId): Promise<SourceAccountInfo[]>
  /** Create or update an account from a connector's account.upsert. Never changes an existing entity assignment. */
  upsertSourceAccount(workspaceId: WorkspaceId, event: AccountUpsert): Promise<SourceAccountInfo>
  getConnection(workspaceId: WorkspaceId, connectionId: Id): Promise<ConnectionInfo | null>
  listConnections(workspaceId: WorkspaceId): Promise<ConnectionInfo[]>
  /**
   * An account for money no connection shows (cash on hand, paid personally), on the workspace's "Added by hand"
   * connection, assigned to the entity. Created once, then reused.
   */
  ensureManualAccount(workspaceId: WorkspaceId, entityId: EntityId, type: 'cash_on_hand' | 'other', name: string): Promise<SourceAccountInfo>
  /** Answer "which company?" for an account no one has assigned yet. False when it already has a company. */
  assignSourceAccount(workspaceId: WorkspaceId, accountId: Id, entityId: EntityId): Promise<boolean>
}

/** Daily FX rates. Implementations: MemoryRateSource (tests, fixed tables) and FrankfurterRateSource (ECB via frankfurter). */
export interface RateSource {
  /** Units of `to` per one unit of `from` on `date` (or the closest earlier business day). */
  rate(date: IsoDate, from: Currency, to: Currency): Promise<string>
  /**
   * A rate already at hand (no network), or null. Sources that can go to the network implement it: the engine asks
   * only this inside a database transaction, so a transaction never waits on an outside service.
   */
  cached?(date: IsoDate, from: Currency, to: Currency): Promise<string | null>
  /** Fetch and keep many rates at once (one ranged request per currency pair). Outside any transaction. */
  prefetch?(needs: ReadonlyArray<{ date: IsoDate; from: Currency; to: Currency }>): Promise<void>
}

export type { ListingKind } from '@agfn/contracts'
import type { ListingKind } from '@agfn/contracts'

/** The latest full listing applied for a connection and kind: what it voided, or why it didn't. */
export interface ListingOutcome {
  workspaceId: WorkspaceId
  connectionId: Id
  kind: ListingKind
  startedAt: IsoTimestamp
  appliedAt: IsoTimestamp
  /** Live records of that kind the listing carried. */
  seen: number
  voided: number
  /** Set when the safety limits stopped the void (nothing was voided). */
  skippedReason: string | null
}

/** See LedgerStore.recordSortKeys. */
export function sortKey(date: string, eventType: string, externalId: string): string {
  return `${date}|${eventType}:${externalId}`
}
