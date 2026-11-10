// In-memory LedgerStore and AccountDirectory, for unit tests and the demo workspace. Not for production data.
import type { AccountUpsert, Currency, EntityId, Id, IsoDate, IsoTimestamp, NormalizedEvent, WorkspaceId } from '@agfn/contracts'
import type { SystemRole } from './coa.ts'
import { newId } from '@agfn/db'
import type {
  BalanceAssertion,
  PeriodLock,
  MrrPoint,
  Basis,
  Bucket,
  EntityInfo,
  JournalEntry,
  LedgerAccount,
  Link,
  RecordOverride,
  Rule,
  RuleApplication,
  SourceAccountInfo,
  SourceRecord,
  WriteLogEntry,
} from './model.ts'
import type {
  AccountDirectory,
  AccountTotal,
  ConnectionInfo,
  DuplicateDismissal,
  LedgerStore,
  LineFilter,
  LineRow,
  LinkFilter,
  ListingOutcome,
  RecordFilter,
} from './store.ts'
import { sortKey } from './store.ts'
import { assertEntryBalanced, inView } from './validate.ts'

interface State {
  records: Map<Id, SourceRecord>
  accounts: Map<Id, LedgerAccount>
  entries: Map<Id, JournalEntry>
  links: Map<Id, Link>
  overrides: Map<Id, RecordOverride>
  rules: Map<Id, Rule>
  ruleApps: RuleApplication[]
  buckets: Map<Id, Bucket>
  rates: Map<string, string>
  writes: WriteLogEntry[]
  versions: Map<WorkspaceId, number>
  assertions: Map<Id, BalanceAssertion>
  locks: Map<Id, PeriodLock>
  mrr: MrrPoint[]
  settle: Map<string, IsoTimestamp>
  seen: Map<Id, IsoTimestamp>
  listings: Map<string, ListingOutcome>
  dupDismissals: Map<string, DuplicateDismissal>
  matched: Map<WorkspaceId, number>
}

function emptyState(): State {
  return {
    records: new Map(),
    accounts: new Map(),
    entries: new Map(),
    links: new Map(),
    overrides: new Map(),
    rules: new Map(),
    ruleApps: [],
    buckets: new Map(),
    rates: new Map(),
    writes: [],
    versions: new Map(),
    assertions: new Map(),
    locks: new Map(),
    mrr: [],
    settle: new Map(),
    seen: new Map(),
    listings: new Map(),
    dupDismissals: new Map(),
    matched: new Map(),
  }
}

const clone = <T>(v: T): T => structuredClone(v)

export class MemoryLedgerStore implements LedgerStore {
  #s: State = emptyState()
  #inTx = false

  inTransaction(): boolean {
    return this.#inTx
  }

  // readOnly is accepted for interface parity; the in-memory store has no SQL layer to enforce it (the Postgres path
  // enforces it, and the dry run writes nothing by construction regardless).
  async transaction<T>(fn: (store: LedgerStore) => Promise<T>, _opts: { readOnly?: boolean } = {}): Promise<T> {
    if (this.#inTx) return fn(this)
    const snapshot = clone(this.#s)
    this.#inTx = true
    try {
      return await fn(this)
    } catch (err) {
      this.#s = snapshot
      throw err
    } finally {
      this.#inTx = false
    }
  }

  async lockWorkspace(_ws: WorkspaceId): Promise<void> {}

  async findRecordsByKeys(ws: WorkspaceId, keys: Array<{ connectionId: Id; eventType: SourceRecord['eventType']; externalId: string }>): Promise<SourceRecord[]> {
    const want = new Set(keys.map((k) => `${k.connectionId}|${k.eventType}|${k.externalId}`))
    return [...this.#s.records.values()].filter((r) => r.workspaceId === ws && want.has(`${r.connectionId}|${r.eventType}|${r.externalId}`)).map(clone)
  }

  async eventTypesPresent(ws: WorkspaceId, entityIds: EntityId[]): Promise<Set<SourceRecord['eventType']>> {
    const want = new Set(entityIds)
    const out = new Set<SourceRecord['eventType']>()
    for (const r of this.#s.records.values()) if (r.workspaceId === ws && r.entityId && want.has(r.entityId)) out.add(r.eventType)
    return out
  }

  async recordSortKeys(ws: WorkspaceId, ids?: Id[]): Promise<Map<Id, string>> {
    const out = new Map<Id, string>()
    for (const id of ids ?? this.#s.records.keys()) {
      const r = this.#s.records.get(id)
      if (r && r.workspaceId === ws) out.set(id, sortKey(r.date, r.eventType, r.externalId))
    }
    return out
  }

  async getRecords(ws: WorkspaceId, ids: Id[]): Promise<SourceRecord[]> {
    const out: SourceRecord[] = []
    for (const id of new Set(ids)) {
      const r = this.#s.records.get(id)
      if (r && r.workspaceId === ws) out.push(clone(r))
    }
    return out
  }

  async latestRecordsByAccount(ws: WorkspaceId, accountIds: Id[], eventTypes: SourceRecord['eventType'][], toDate?: IsoDate): Promise<SourceRecord[]> {
    const want = new Set(accountIds)
    const rows = [...this.#s.records.values()].filter(
      (r) => r.workspaceId === ws && eventTypes.includes(r.eventType) && r.sourceAccountId && want.has(r.sourceAccountId) && (r.status === 'recorded' || r.status === 'posted') && (!toDate || r.date <= toDate),
    )
    const newest = new Map<Id, string>()
    for (const r of rows) if ((newest.get(r.sourceAccountId as Id) ?? '') < r.date) newest.set(r.sourceAccountId as Id, r.date)
    return rows.filter((r) => newest.get(r.sourceAccountId as Id) === r.date).map(clone)
  }

  async addedByHand(ws: WorkspaceId): Promise<Map<Id, SourceRecord['status']>> {
    return new Map([...this.#s.records.values()].filter((r) => r.workspaceId === ws && r.origin !== 'connector').map((r) => [r.id, r.status]))
  }

  async monthlyRowCounts(ws: WorkspaceId, accountIds: Id[]): Promise<Array<{ accountId: Id; month: string; rows: number }>> {
    const counts = new Map<string, number>()
    for (const r of this.#s.records.values()) {
      if (r.workspaceId !== ws || !r.sourceAccountId || !accountIds.includes(r.sourceAccountId)) continue
      if ((r.eventType !== 'txn.upsert' && r.eventType !== 'processor.balance_txn') || (r.status !== 'posted' && r.status !== 'recorded')) continue
      const k = `${r.sourceAccountId}|${r.date.slice(0, 7)}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts].map(([k, rows]) => ({ accountId: k.split('|')[0] as Id, month: k.split('|')[1] as string, rows }))
  }

  async lastRowDates(ws: WorkspaceId, accountIds: Id[], onOrBefore?: string): Promise<Array<{ accountId: Id; date: string }>> {
    const latest = new Map<Id, string>()
    for (const r of this.#s.records.values()) {
      if (r.workspaceId !== ws || !r.sourceAccountId || !accountIds.includes(r.sourceAccountId)) continue
      if ((r.eventType !== 'txn.upsert' && r.eventType !== 'processor.balance_txn') || (r.status !== 'posted' && r.status !== 'recorded')) continue
      if (onOrBefore && r.date > onOrBefore) continue
      const prev = latest.get(r.sourceAccountId)
      if (!prev || r.date > prev) latest.set(r.sourceAccountId, r.date)
    }
    return [...latest].map(([accountId, date]) => ({ accountId, date }))
  }

  async addMrrPoint(p: MrrPoint): Promise<void> {
    this.#s.mrr.push(clone(p))
  }

  async listMrrPoints(ws: WorkspaceId, recordIds?: Id[]): Promise<MrrPoint[]> {
    const want = recordIds ? new Set(recordIds) : null
    return this.#s.mrr
      .filter((p) => p.workspaceId === ws && (!want || want.has(p.recordId)))
      .sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt < b.createdAt ? -1 : 1))
      .map(clone)
  }

  async savePeriodLock(l: PeriodLock): Promise<void> {
    this.#s.locks.set(l.id, clone(l))
  }

  async markUnsettled(ws: WorkspaceId, connectionId: Id, since: IsoTimestamp): Promise<void> {
    const key = `${ws}|${connectionId}`
    if (!this.#s.settle.has(key)) this.#s.settle.set(key, since)
  }

  async unsettledSince(ws: WorkspaceId, connectionId: Id): Promise<IsoTimestamp | null> {
    return this.#s.settle.get(`${ws}|${connectionId}`) ?? null
  }

  async clearUnsettled(ws: WorkspaceId, connectionId: Id): Promise<void> {
    this.#s.settle.delete(`${ws}|${connectionId}`)
  }

  async matchedWith(ws: WorkspaceId): Promise<number | null> {
    return this.#s.matched.get(ws) ?? null
  }

  async setMatchedWith(ws: WorkspaceId, version: number): Promise<void> {
    this.#s.matched.set(ws, version)
  }

  async listPeriodLocks(ws: WorkspaceId): Promise<PeriodLock[]> {
    return [...this.#s.locks.values()]
      .filter((l) => l.workspaceId === ws && !l.removedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map(clone)
  }

  async saveAssertion(a: BalanceAssertion): Promise<void> {
    this.#s.assertions.set(a.id, clone(a))
  }

  async listAssertions(ws: WorkspaceId, accountIds?: Id[]): Promise<BalanceAssertion[]> {
    return [...this.#s.assertions.values()]
      .filter((a) => a.workspaceId === ws && !a.removedAt && (!accountIds || accountIds.includes(a.accountId)))
      .sort((a, b) => (a.accountId !== b.accountId ? (a.accountId < b.accountId ? -1 : 1) : a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1))
      .map(clone)
  }

  async getAssertion(ws: WorkspaceId, id: Id): Promise<BalanceAssertion | null> {
    const a = this.#s.assertions.get(id)
    return a && a.workspaceId === ws ? clone(a) : null
  }

  async bumpVersion(ws: WorkspaceId, _at: string): Promise<void> {
    this.#s.versions.set(ws, (this.#s.versions.get(ws) ?? 0) + 1)
  }

  async version(ws: WorkspaceId): Promise<number> {
    return this.#s.versions.get(ws) ?? 0
  }

  async getRecord(ws: WorkspaceId, id: Id): Promise<SourceRecord | null> {
    const r = this.#s.records.get(id)
    return r && r.workspaceId === ws ? clone(r) : null
  }

  async findRecord(ws: WorkspaceId, connectionId: Id, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord | null> {
    for (const r of this.#s.records.values()) {
      if (r.workspaceId === ws && r.connectionId === connectionId && r.eventType === eventType && r.externalId === externalId) return clone(r)
    }
    return null
  }

  async findRecordsByExternalId(ws: WorkspaceId, eventType: SourceRecord['eventType'], externalId: string): Promise<SourceRecord[]> {
    return [...this.#s.records.values()]
      .filter((r) => r.workspaceId === ws && r.eventType === eventType && r.externalId === externalId)
      .map(clone)
  }

  async saveRecord(record: SourceRecord): Promise<void> {
    for (const r of this.#s.records.values()) {
      if (
        r.id !== record.id &&
        r.workspaceId === record.workspaceId &&
        r.connectionId === record.connectionId &&
        r.eventType === record.eventType &&
        r.externalId === record.externalId
      ) {
        throw new Error(`Duplicate source record ${record.connectionId}/${record.eventType}/${record.externalId}`)
      }
    }
    // Only an insert is a sighting (as in the SQL store); markSeen records later ones.
    if (!this.#s.records.has(record.id) && record.origin === 'connector') this.#s.seen.set(record.id, record.updatedAt)
    this.#s.records.set(record.id, clone(record))
  }

  async markSeen(_ws: WorkspaceId, ids: Id[], at: IsoTimestamp): Promise<void> {
    for (const id of ids) if (this.#s.records.has(id)) this.#s.seen.set(id, at)
  }

  async lastSeen(ws: WorkspaceId, connectionId: Id, eventTypes: string[]): Promise<Map<Id, IsoTimestamp>> {
    const out = new Map<Id, IsoTimestamp>()
    for (const r of this.#s.records.values()) {
      if (r.workspaceId === ws && r.connectionId === connectionId && eventTypes.includes(r.eventType)) out.set(r.id, this.#s.seen.get(r.id) ?? r.createdAt)
    }
    return out
  }

  async saveListing(l: ListingOutcome): Promise<void> {
    this.#s.listings.set(`${l.workspaceId}|${l.connectionId}|${l.kind}`, clone(l))
  }

  async listListings(ws: WorkspaceId): Promise<ListingOutcome[]> {
    return [...this.#s.listings.values()].filter((l) => l.workspaceId === ws).sort((a, b) => (a.connectionId < b.connectionId ? -1 : a.connectionId > b.connectionId ? 1 : a.kind < b.kind ? -1 : 1)).map(clone)
  }

  async saveDuplicateDismissal(d: DuplicateDismissal): Promise<void> {
    this.#s.dupDismissals.set(`${d.workspaceId}|${d.subjectId}|${d.relatedId}`, clone(d))
  }

  async listDuplicateDismissals(ws: WorkspaceId): Promise<DuplicateDismissal[]> {
    return [...this.#s.dupDismissals.values()].filter((d) => d.workspaceId === ws).map(clone)
  }

  async listRecords(ws: WorkspaceId, f: RecordFilter = {}): Promise<SourceRecord[]> {
    return [...this.#s.records.values()]
      .filter(
        (r) =>
          r.workspaceId === ws &&
          (!f.entityIds || (r.entityId !== null && f.entityIds.includes(r.entityId))) &&
          (!f.eventTypes || f.eventTypes.includes(r.eventType)) &&
          (!f.excludeEventTypes || !f.excludeEventTypes.includes(r.eventType)) &&
          (!f.sourceAccountId || r.sourceAccountId === f.sourceAccountId) &&
          (!f.connectionId || r.connectionId === f.connectionId) &&
          (!f.statuses || f.statuses.includes(r.status)) &&
          (!f.fromDate || r.date >= f.fromDate) &&
          (!f.toDate || r.date <= f.toDate) &&
          (!f.updatedSince || r.updatedAt >= f.updatedSince),
      )
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1) * (f.latestFirst ? -1 : 1))
      .slice(0, f.limit)
      .map(clone)
  }

  async findLedgerAccount(ws: WorkspaceId, entityId: EntityId, role: SystemRole): Promise<LedgerAccount | null> {
    for (const a of this.#s.accounts.values()) {
      if (a.workspaceId === ws && a.entityId === entityId && a.role === role) return clone(a)
    }
    return null
  }

  async createLedgerAccount(account: LedgerAccount): Promise<void> {
    if (await this.findLedgerAccount(account.workspaceId, account.entityId, account.role)) {
      throw new Error(`Ledger account ${account.role} already exists for ${account.entityId}`)
    }
    this.#s.accounts.set(account.id, clone(account))
  }

  async listLedgerAccounts(ws: WorkspaceId, entityIds?: EntityId[]): Promise<LedgerAccount[]> {
    return [...this.#s.accounts.values()]
      .filter((a) => a.workspaceId === ws && (!entityIds || entityIds.includes(a.entityId)))
      .sort((a, b) => (a.code + a.name < b.code + b.name ? -1 : 1))
      .map(clone)
  }

  async insertEntry(entry: JournalEntry): Promise<void> {
    assertEntryBalanced(entry)
    if (this.#s.entries.has(entry.id)) throw new Error(`Entry ${entry.id} exists`)
    for (const l of entry.lines) {
      const acct = this.#s.accounts.get(l.ledgerAccountId)
      if (!acct || acct.entityId !== entry.entityId) throw new Error(`Line account ${l.ledgerAccountId} is not in entity ${entry.entityId}`)
    }
    this.#s.entries.set(entry.id, clone(entry))
  }

  async listActiveEntries(ws: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]> {
    return [...this.#s.entries.values()]
      .filter(
        (e) =>
          e.workspaceId === ws &&
          inView(e.basis, f.basis) &&
          e.reversedById === null &&
          e.reversesId === null &&
          (!f.entityIds || f.entityIds.includes(e.entityId)) &&
          (!f.fromDate || e.date >= f.fromDate) &&
          (!f.toDate || e.date <= f.toDate),
      )
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
      .map(clone)
  }

  async listMovedReversals(ws: WorkspaceId, f: { entityIds?: EntityId[]; basis: Basis; fromDate?: IsoDate; toDate?: IsoDate }): Promise<JournalEntry[]> {
    const all = this.#s.entries
    const out: JournalEntry[] = []
    for (const r of all.values()) {
      if (r.workspaceId !== ws || !r.reversesId || !inView(r.basis, f.basis) || (f.entityIds && !f.entityIds.includes(r.entityId))) continue
      const o = all.get(r.reversesId)
      if (!o || o.date === r.date) continue
      for (const e of [o, r]) if ((!f.fromDate || e.date >= f.fromDate) && (!f.toDate || e.date <= f.toDate)) out.push(clone(e))
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  }

  async activeEntriesForSource(ws: WorkspaceId, sourceId: Id): Promise<JournalEntry[]> {
    return [...this.#s.entries.values()]
      .filter((e) => e.workspaceId === ws && e.sourceId === sourceId && e.reversedById === null && e.reversesId === null)
      .map(clone)
  }

  async activeEntryKinds(ws: WorkspaceId, sourceIds: Id[]): Promise<Map<Id, JournalEntry['kind']>> {
    const want = new Set(sourceIds)
    const out = new Map<Id, JournalEntry['kind']>()
    for (const e of this.#s.entries.values()) {
      if (e.workspaceId === ws && want.has(e.sourceId) && e.reversedById === null && e.reversesId === null && !out.has(e.sourceId)) out.set(e.sourceId, e.kind)
    }
    return out
  }

  async markReversed(ws: WorkspaceId, entryId: Id, reversedById: Id): Promise<void> {
    const e = this.#s.entries.get(entryId)
    if (!e || e.workspaceId !== ws) throw new Error(`Entry ${entryId} not found`)
    if (e.reversedById) throw new Error(`Entry ${entryId} is already reversed`)
    e.reversedById = reversedById
  }

  async getEntry(ws: WorkspaceId, id: Id): Promise<JournalEntry | null> {
    const e = this.#s.entries.get(id)
    return e && e.workspaceId === ws ? clone(e) : null
  }

  async listLines(ws: WorkspaceId, f: LineFilter): Promise<LineRow[]> {
    const rows: LineRow[] = []
    for (const e of this.#s.entries.values()) {
      if (e.workspaceId !== ws || !inView(e.basis, f.basis)) continue
      if (f.entityIds && !f.entityIds.includes(e.entityId)) continue
      if (f.fromDate && e.date < f.fromDate) continue
      if (f.toDate && e.date > f.toDate) continue
      if (f.sourceIds && !f.sourceIds.includes(e.sourceId)) continue
      for (const l of e.lines) {
        if (f.ledgerAccountIds && !f.ledgerAccountIds.includes(l.ledgerAccountId)) continue
        if (f.bucketId && l.bucketId !== f.bucketId) continue
        if (f.excludeSourceId && e.sourceId === f.excludeSourceId) continue
        rows.push({ ...clone(l), entityId: e.entityId, date: e.date, basis: e.basis, kind: e.kind, sourceId: e.sourceId })
      }
    }
    return rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  }

  async accountTotals(ws: WorkspaceId, f: LineFilter): Promise<AccountTotal[]> {
    const totals = new Map<string, AccountTotal>()
    for (const l of await this.listLines(ws, f)) {
      const key = `${l.ledgerAccountId}|${l.currency}`
      const t = totals.get(key) ?? { ledgerAccountId: l.ledgerAccountId, currency: l.currency, debitMinor: 0, creditMinor: 0, baseDebitMinor: 0, baseCreditMinor: 0, firstDate: l.date }
      t.debitMinor += l.debitMinor
      t.creditMinor += l.creditMinor
      t.baseDebitMinor += l.baseDebitMinor
      t.baseCreditMinor += l.baseCreditMinor
      if (t.firstDate === null || l.date < t.firstDate) t.firstDate = l.date
      totals.set(key, t)
    }
    return [...totals.values()]
  }

  async unbalancedEntries(ws: WorkspaceId): Promise<Id[]> {
    const out: Id[] = []
    for (const e of this.#s.entries.values()) {
      if (e.workspaceId !== ws) continue
      const d = e.lines.reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0)
      if (d !== 0) out.push(e.id)
    }
    return out
  }

  async saveLink(link: Link): Promise<void> {
    this.#s.links.set(link.id, clone(link))
  }

  async getLink(ws: WorkspaceId, id: Id): Promise<Link | null> {
    const l = this.#s.links.get(id)
    return l && l.workspaceId === ws ? clone(l) : null
  }

  async listLinks(ws: WorkspaceId, f: LinkFilter = {}): Promise<Link[]> {
    const ids = f.recordIds ? new Set(f.recordIds) : null
    return [...this.#s.links.values()]
      .filter(
        (l) =>
          l.workspaceId === ws &&
          (!f.recordId || l.fromId === f.recordId || l.toId === f.recordId) &&
          (!ids || ids.has(l.fromId) || ids.has(l.toId)) &&
          (!f.statuses || f.statuses.includes(l.status)) &&
          (!f.types || f.types.includes(l.type)),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(clone)
  }

  async getOverride(ws: WorkspaceId, recordId: Id): Promise<RecordOverride | null> {
    const o = this.#s.overrides.get(recordId)
    return o && o.workspaceId === ws ? clone(o) : null
  }

  async saveOverride(o: RecordOverride): Promise<void> {
    this.#s.overrides.set(o.recordId, clone(o))
  }

  async listOverrides(ws: WorkspaceId): Promise<RecordOverride[]> {
    return [...this.#s.overrides.values()].filter((o) => o.workspaceId === ws).map(clone)
  }

  async saveRule(rule: Rule): Promise<void> {
    this.#s.rules.set(rule.id, clone(rule))
  }

  async getRule(ws: WorkspaceId, id: Id): Promise<Rule | null> {
    const r = this.#s.rules.get(id)
    return r && r.workspaceId === ws ? clone(r) : null
  }

  async listRules(ws: WorkspaceId): Promise<Rule[]> {
    return [...this.#s.rules.values()]
      .filter((r) => r.workspaceId === ws)
      .sort((a, b) => a.priority - b.priority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
      .map(clone)
  }

  async addRuleApplication(app: RuleApplication): Promise<void> {
    this.#s.ruleApps.push(clone(app))
  }

  async listRuleApplications(ws: WorkspaceId, recordId?: Id): Promise<RuleApplication[]> {
    return this.#s.ruleApps.filter((a) => a.workspaceId === ws && (!recordId || a.recordId === recordId)).map(clone)
  }

  async saveBucket(bucket: Bucket): Promise<void> {
    this.#s.buckets.set(bucket.id, clone(bucket))
  }

  async getBucket(ws: WorkspaceId, id: Id): Promise<Bucket | null> {
    const b = this.#s.buckets.get(id)
    return b && b.workspaceId === ws ? clone(b) : null
  }

  async listBuckets(ws: WorkspaceId, entityIds?: EntityId[]): Promise<Bucket[]> {
    return [...this.#s.buckets.values()]
      .filter((b) => b.workspaceId === ws && (!entityIds || entityIds.includes(b.entityId)))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map(clone)
  }

  async saveWrite(entry: WriteLogEntry): Promise<void> {
    const i = this.#s.writes.findIndex((w) => w.id === entry.id)
    if (i >= 0) this.#s.writes[i] = clone(entry)
    else this.#s.writes.push(clone(entry))
  }

  async latestWriteFor(ws: WorkspaceId, recordId: Id): Promise<WriteLogEntry | null> {
    const hits = this.#s.writes.filter((w) => w.workspaceId === ws && !w.revertedAt && w.recordIds.includes(recordId))
    return hits.length ? clone(hits[hits.length - 1] as WriteLogEntry) : null
  }

  async getRate(date: string, from: Currency, to: Currency): Promise<string | null> {
    return this.#s.rates.get(`${date}|${from}|${to}`) ?? null
  }

  async saveRate(date: string, from: Currency, to: Currency, rate: string): Promise<void> {
    this.#s.rates.set(`${date}|${from}|${to}`, rate)
  }
}

/** In-memory directory for tests: entities, source accounts and connections set up by hand. */
export class MemoryDirectory implements AccountDirectory {
  #reporting = new Map<WorkspaceId, Currency>()
  #entities = new Map<string, EntityInfo & { workspaceId: WorkspaceId }>()
  #accounts = new Map<Id, SourceAccountInfo & { workspaceId: WorkspaceId }>()
  #connections = new Map<Id, ConnectionInfo & { workspaceId: WorkspaceId }>()

  setReportingCurrency(ws: WorkspaceId, currency: Currency): void {
    this.#reporting.set(ws, currency)
  }

  addEntity(ws: WorkspaceId, e: Partial<EntityInfo> & Pick<EntityInfo, 'id' | 'name'>): EntityInfo {
    const full: EntityInfo = { kind: 'company', baseCurrency: 'USD', ownerPersonId: null, ...e }
    this.#entities.set(e.id, { ...full, workspaceId: ws })
    return full
  }

  addConnection(ws: WorkspaceId, c: Partial<ConnectionInfo> & Pick<ConnectionInfo, 'id'>): ConnectionInfo {
    const full: ConnectionInfo = { connectorKey: 'test', displayName: c.connectorKey ?? 'test', status: 'active', lastSuccessAt: null, entityId: null, ...c }
    this.#connections.set(c.id, { ...full, workspaceId: ws })
    return full
  }

  setConnectionStatus(connectionId: Id, status: string): void {
    const c = this.#connections.get(connectionId)
    if (c) c.status = status
  }

  setConnectionSuccess(connectionId: Id, at: string): void {
    const c = this.#connections.get(connectionId)
    if (c) c.lastSuccessAt = at
  }

  addAccount(ws: WorkspaceId, a: Partial<SourceAccountInfo> & Pick<SourceAccountInfo, 'id' | 'name'>): SourceAccountInfo {
    const full: SourceAccountInfo = {
      connectionId: null,
      externalId: null,
      entityId: null,
      accountType: 'depository',
      currency: 'USD',
      includeInCash: true,
      mask: null,
      institution: null,
      duplicateOf: null,
      ...a,
    }
    this.#accounts.set(a.id, { ...full, workspaceId: ws })
    return full
  }

  assignAccount(accountId: Id, entityId: EntityId): void {
    const a = this.#accounts.get(accountId)
    if (!a) throw new Error(`No account ${accountId}`)
    a.entityId = entityId
  }

  updateAccount(accountId: Id, patch: Partial<SourceAccountInfo>): void {
    const a = this.#accounts.get(accountId)
    if (!a) throw new Error(`No account ${accountId}`)
    Object.assign(a, patch)
  }

  async reportingCurrency(ws: WorkspaceId): Promise<Currency> {
    return this.#reporting.get(ws) ?? 'USD'
  }

  #zones = new Map<WorkspaceId, string>()

  setTimeZone(ws: WorkspaceId, zone: string | null): void {
    if (zone) this.#zones.set(ws, zone)
    else this.#zones.delete(ws)
  }

  async timeZone(ws: WorkspaceId): Promise<string | null> {
    return this.#zones.get(ws) ?? null
  }

  async getEntity(ws: WorkspaceId, id: EntityId): Promise<EntityInfo | null> {
    const e = this.#entities.get(id)
    return e && e.workspaceId === ws ? strip(e) : null
  }

  async listEntities(ws: WorkspaceId): Promise<EntityInfo[]> {
    return [...this.#entities.values()].filter((e) => e.workspaceId === ws).map(strip)
  }

  async getSourceAccount(ws: WorkspaceId, id: Id): Promise<SourceAccountInfo | null> {
    const a = this.#accounts.get(id)
    return a && a.workspaceId === ws ? strip(a) : null
  }

  async findSourceAccount(ws: WorkspaceId, connectionId: Id, externalId: string): Promise<SourceAccountInfo | null> {
    for (const a of this.#accounts.values()) {
      if (a.workspaceId === ws && a.connectionId === connectionId && a.externalId === externalId) return strip(a)
    }
    return null
  }

  async listSourceAccounts(ws: WorkspaceId): Promise<SourceAccountInfo[]> {
    return [...this.#accounts.values()].filter((a) => a.workspaceId === ws).map(strip)
  }

  async upsertSourceAccount(ws: WorkspaceId, ev: AccountUpsert): Promise<SourceAccountInfo> {
    const existing = await this.findSourceAccount(ws, ev.connectionId, ev.externalId)
    if (existing) {
      this.updateAccount(existing.id, { name: ev.name, accountType: ev.accountType, currency: ev.currency, mask: ev.mask ?? null, institution: ev.institution ?? null, businessHint: ev.businessHint ?? null })
      return (await this.getSourceAccount(ws, existing.id)) as SourceAccountInfo
    }
    return this.addAccount(ws, {
      id: newId(),
      name: ev.name,
      connectionId: ev.connectionId,
      externalId: ev.externalId,
      accountType: ev.accountType,
      currency: ev.currency,
      mask: ev.mask ?? null,
      institution: ev.institution ?? null,
      includeInCash: defaultIncludeInCash(ev.accountType),
      businessHint: ev.businessHint ?? null,
    })
  }

  async getConnection(ws: WorkspaceId, id: Id): Promise<ConnectionInfo | null> {
    const c = this.#connections.get(id)
    return c && c.workspaceId === ws ? strip(c) : null
  }

  async listConnections(ws: WorkspaceId): Promise<ConnectionInfo[]> {
    return [...this.#connections.values()].filter((c) => c.workspaceId === ws).map(strip)
  }

  async assignSourceAccount(ws: WorkspaceId, accountId: Id, entityId: EntityId): Promise<boolean> {
    const a = this.#accounts.get(accountId)
    if (!a || a.workspaceId !== ws || a.entityId) return false
    a.entityId = entityId
    return true
  }

  async ensureManualAccount(ws: WorkspaceId, entityId: EntityId, type: 'cash_on_hand' | 'other', name: string): Promise<SourceAccountInfo> {
    let conn = [...this.#connections.values()].find((c) => c.workspaceId === ws && c.connectorKey === 'manual')
    if (!conn) {
      this.addConnection(ws, { id: newId(), connectorKey: 'manual', displayName: 'Added by hand', lastSuccessAt: null })
      conn = [...this.#connections.values()].find((c) => c.workspaceId === ws && c.connectorKey === 'manual')
    }
    const externalId = `${type}:${entityId}`
    const existing = await this.findSourceAccount(ws, (conn as ConnectionInfo).id, externalId)
    if (existing) return existing
    return this.addAccount(ws, { id: newId(), name, connectionId: (conn as ConnectionInfo).id, externalId, entityId, accountType: type, currency: (await this.getEntity(ws, entityId))?.baseCurrency ?? 'USD', includeInCash: type === 'cash_on_hand' })
  }
}

function strip<T extends { workspaceId: WorkspaceId }>(v: T): Omit<T, 'workspaceId'> {
  const { workspaceId: _ws, ...rest } = v
  return clone(rest)
}

/** Which account types count toward "cash" by default (the person can change it). */
export function defaultIncludeInCash(type: SourceAccountInfo['accountType']): boolean {
  return type === 'depository' || type === 'cash_on_hand' || type === 'processor_balance'
}
