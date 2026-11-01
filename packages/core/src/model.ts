// Internal ledger records. Persisted by a LedgerStore (Kysely or in-memory); see store.ts.
import type {
  AccountType,
  Currency,
  EntityId,
  EntityKind,
  Id,
  IsoDate,
  IsoTimestamp,
  LinkProposal,
  LinkType,
  Money,
  Provenance,
  NormalizedEvent,
  TxnKind,
  WorkspaceId,
  WriteOrigin,
} from '@agfn/contracts'
import type { LedgerAccountType, SystemRole } from './coa.ts'

export type Basis = 'cash' | 'accrual'
/** Which views an entry belongs to. Most entries are 'both'. */
export type EntryBasis = Basis | 'both'

// ---------- Directory (implemented over S0's entities/accounts tables) ----------

export interface EntityInfo {
  id: EntityId
  kind: EntityKind
  name: string
  baseCurrency: Currency
  /** For a personal entity, the person it belongs to. */
  ownerPersonId: string | null
}

export interface SourceAccountInfo {
  /** accounts.id */
  id: Id
  connectionId: Id | null
  externalId: string | null
  entityId: EntityId | null
  name: string
  accountType: AccountType
  currency: Currency
  includeInCash: boolean
  mask: string | null
  institution: string | null
  /** Set when this account is a second sighting of another (e.g. same Mercury account via Plaid and direct API). */
  duplicateOf: Id | null
  /** The provider's guess whose it is (Plaid: a 401k or HSA is personal). Only ever a suggestion. */
  businessHint?: 'business' | 'personal' | 'unknown' | null
}

// ---------- Source records: one per posted event ----------

export type RecordStatus = 'posted' | 'recorded' | 'unassigned' | 'void' | 'excluded'

export interface SourceRecord {
  id: Id
  workspaceId: WorkspaceId
  connectionId: Id
  /** NormalizedEvent type; newer event types (e.g. subscription.upsert) are stored before the union knows them. */
  eventType: NormalizedEvent['type'] | (string & {})
  externalId: string
  /** Hash of the event's content; a re-sync with the same hash is a duplicate. */
  contentHash: string
  event: NormalizedEvent
  origin: WriteOrigin
  /** Who wrote it when origin is agent/ui (grant or person id). */
  createdBy: string | null
  /** The source account (txn/balance/processor events), when known. */
  sourceAccountId: Id | null
  /** Owning entity, resolved from the source account or the connection. */
  entityId: EntityId | null
  status: RecordStatus
  /** Business date used for matching and ordering. */
  date: IsoDate
  /** Signed amount (txn amount, processor net, invoice total…) used for matching. */
  amount: Money | null
  /** Hash of the last posting plan, so reposting is a no-op when nothing changed. */
  postingHash: string | null
  /** Who wrote it, for AI/UI writes (write request, grant, label, reason, file hash). */
  provenance: Provenance | null
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

// ---------- Ledger ----------

export interface LedgerAccount {
  id: Id
  workspaceId: WorkspaceId
  entityId: EntityId
  role: SystemRole
  code: string
  name: string
  type: LedgerAccountType
  normalBalance: 'debit' | 'credit'
  createdAt: IsoTimestamp
}

export interface JournalLine {
  id: Id
  entryId: Id
  ledgerAccountId: Id
  /** Original-currency amounts; exactly one of debit/credit is non-zero. */
  debitMinor: number
  creditMinor: number
  currency: Currency
  /** Same line in the entity's base currency. Entries balance on these. */
  baseDebitMinor: number
  baseCreditMinor: number
  /** Rate used (base per original unit), as a decimal string; "1" when currencies match. */
  fxRate: string
  bucketId: Id | null
  memo: string | null
}

export interface JournalEntry {
  id: Id
  workspaceId: WorkspaceId
  entityId: EntityId
  date: IsoDate
  basis: EntryBasis
  kind: TxnKind
  /** The source record or link this entry was derived from. */
  sourceId: Id
  memo: string | null
  /** When this entry reverses another. */
  reversesId: Id | null
  /** Set on an entry once it has been reversed. */
  reversedById: Id | null
  createdAt: IsoTimestamp
  lines: JournalLine[]
}

// ---------- Links ----------

export type LinkStatus = 'proposed' | 'confirmed' | 'rejected'

export interface Link {
  id: Id
  workspaceId: WorkspaceId
  type: LinkType
  /** Source record ids. Direction conventions are documented on each LinkType in links.ts. */
  fromId: Id
  toId: Id
  amount: Money | null
  confidence: number
  method: LinkProposal['method']
  status: LinkStatus
  scores: Record<string, number> | null
  createdBy: string | null
  decidedBy: string | null
  decidedAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}

// ---------- Overrides (what a person or AI said about a record) ----------

export interface RecordOverride {
  recordId: Id
  workspaceId: WorkspaceId
  /** Whose money: the entity this was for, when it differs from the paying account's entity. */
  forEntityId?: EntityId
  kind?: TxnKind
  /** Counter-account role key (an expense/income role, or e.g. 'owner_contributions'). */
  category?: string
  bucketId?: Id
  note?: string
  /** For founder deposits: the person entity the money came from. */
  ownerEntityId?: EntityId
  /** Leave this record out of the ledger entirely (e.g. a known duplicate). */
  excluded?: boolean
  updatedBy: string | null
  updatedAt: IsoTimestamp
}

// ---------- Rules ----------

export interface RuleConditions {
  /** Case-insensitive glob on description/counterparty ("*" = anything). Any pattern may match. */
  textPatterns?: string[]
  counterparty?: string
  direction?: 'in' | 'out'
  /** Absolute amount bounds in minor units, inclusive. */
  minAbsMinor?: number
  maxAbsMinor?: number
  currency?: Currency
  sourceAccountIds?: Id[]
  entityIds?: EntityId[]
  /** Only records first seen after this time (a rule created without "apply to existing"). */
  createdAfter?: IsoTimestamp
  /** The same query language as transaction search, e.g. `counterparty:"AWS" amount>500 -refund`. */
  query?: string
}

export interface RuleActions {
  forEntityId?: EntityId
  kind?: TxnKind
  category?: string
  bucketId?: Id
  /** Show this counterparty name instead of what the bank sent (the raw text is kept). */
  renameTo?: string
  /** Rules after this one (lower priority) don't apply to rows this rule matched. */
  stop?: boolean
}

export type RuleStatus = 'active' | 'suggested' | 'rejected' | 'disabled'

export interface Rule {
  id: Id
  workspaceId: WorkspaceId
  name: string
  priority: number
  conditions: RuleConditions
  actions: RuleActions
  status: RuleStatus
  origin: 'user' | 'agent' | 'learned'
  createdBy: string | null
  hitCount: number
  lastHitAt: IsoTimestamp | null
  createdAt: IsoTimestamp
}

export interface RuleApplication {
  id: Id
  workspaceId: WorkspaceId
  ruleId: Id
  recordId: Id
  appliedAt: IsoTimestamp
}

// ---------- Buckets ----------

export type BucketFieldType = 'text' | 'number' | 'money' | 'date' | 'boolean' | 'select'

export interface BucketField {
  key: string
  label: string
  type: BucketFieldType
  required?: boolean
  options?: string[]
}

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annual'

export interface BucketSchedule {
  amount: Money
  direction: 'in' | 'out'
  cadence: Cadence
  /** Monthly/quarterly/annual: day of month (1-31, clamped to month end). Weekly/biweekly: ignored (start date sets the weekday). */
  dueDay?: number
  startDate: IsoDate
  endDate?: IsoDate
  /** Days after the due date before an unpaid occurrence counts as missed. Default 5. */
  graceDays?: number
  /** Payment may differ from the scheduled amount by this much and still count as paid. Default 0. */
  toleranceMinor?: number
}

export interface Bucket {
  id: Id
  workspaceId: WorkspaceId
  entityId: EntityId
  name: string
  fields: BucketField[]
  values: Record<string, unknown>
  schedule: BucketSchedule | null
  createdBy: string | null
  origin: WriteOrigin
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  archivedAt: IsoTimestamp | null
}

/** One applied AI/UI write, kept so it can be undone within 30 days. */
export interface WriteLogEntry {
  id: Id
  workspaceId: WorkspaceId
  op: string
  /** Records (or buckets/rules/links) the write created or changed; the first is the one reported back. */
  recordIds: Id[]
  /** What to restore on undo (e.g. the previous override). */
  before: unknown
  createdAt: IsoTimestamp
  revertedAt: IsoTimestamp | null
}

export type { Money }

/** A subscription's monthly value from a day on (until its next point). */
export interface MrrPoint {
  id: Id
  workspaceId: WorkspaceId
  recordId: Id
  date: IsoDate
  mrr: Money
  createdAt: IsoTimestamp
}

/** A company's books closed through a date: later changes to that period post as adjustments on the next day. */
export interface PeriodLock {
  id: Id
  workspaceId: WorkspaceId
  entityId: EntityId
  /** The last closed day. */
  through: IsoDate
  note: string | null
  createdBy: string | null
  provenance: Provenance | null
  createdAt: IsoTimestamp
  removedAt: IsoTimestamp | null
}

/** "This account held X on date D", per a statement, a person or an AI. Checked against the ledger, never posted. */
export interface BalanceAssertion {
  id: Id
  workspaceId: WorkspaceId
  accountId: Id
  date: IsoDate
  /** As the statement shows it; for cards and loans, the amount owed (positive). */
  balance: Money
  /** Where it came from, e.g. "September statement". */
  source: string | null
  createdBy: string | null
  provenance: Provenance | null
  createdAt: IsoTimestamp
  removedAt: IsoTimestamp | null
}
