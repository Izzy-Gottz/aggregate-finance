// Shared contracts (MASTER.md §12). Every slice codes against these types.
// Changing a type here is a coordination event: announce it to all sessions and the integrator (meridn-f8) first.

// ---------- Primitives ----------

/** ISO 4217 code, upper case, e.g. "USD". */
export type Currency = string

/** Money in integer minor units (cents). Never use floats for money. */
export interface Money {
  minor: number
  currency: Currency
}

/** Wire format for MCP/REST answers: decimal string, e.g. {amount: "1234.56", currency: "USD"}. */
export interface MoneyWire {
  amount: string
  currency: Currency
}

/** Sortable unique ids (ULID-style strings). */
export type Id = string
export type WorkspaceId = Id
export type EntityId = Id
export type PersonId = Id
export type GrantId = Id
export type ConnectionId = Id
export type AccountId = Id

/** ISO 8601 date (YYYY-MM-DD) or timestamp. */
export type IsoDate = string
export type IsoTimestamp = string

// ---------- Entities and data types ----------

export type EntityKind = 'company' | 'personal'

/** Data types used by permissions, grants and tool listing. */
export type DataType =
  | 'balances'
  | 'transactions'
  | 'invoices'
  | 'bills'
  | 'buckets'
  | 'payroll'
  | 'equity'
  | 'documents'
  | 'reports'
  | 'personal'

export type AccountType =
  | 'depository'
  | 'credit_card'
  | 'processor_balance'
  | 'cash_on_hand'
  | 'loan'
  | 'investment'
  | 'crypto'
  | 'owner_payable'
  | 'intercompany'
  | 'clearing'
  | 'other'

// ---------- Connector contract ----------

export type ConnectorGroup = 'banks' | 'payments' | 'spend' | 'accounting' | 'payroll' | 'equity' | 'other' | 'files'

export interface ConnectorDescription {
  /** Stable key, e.g. "plaid", "stripe", "quickbooks". */
  key: string
  name: string
  group: ConnectorGroup
  provides: DataType[]
  /** Human text shown in the UI, e.g. "updates within minutes via webhooks". */
  freshness: string
  auth: 'oauth' | 'link_widget' | 'api_key' | 'file' | 'none'
  /**
   * Bump when an upgrade changes WHAT a sync fetches or how it maps it (new entity types, new scopes, fixed mapping).
   * Existing connections then re-import everything once from the start; posting is idempotent, so unchanged records
   * are no-ops and changed ones are corrected.
   */
  dataVersion?: number
  /** How to make this connector work on this server; set on connectors that need setup (self-hosted servers). */
  setup?: ConnectorSetup
  /** May also be linked inside a demo workspace on this server (the challenge's sandbox Plaid; AGFN_DEMO_EXTRA_CONNECTORS). */
  demoAllowed?: boolean
  /**
   * The provider's terms cap how old its data may be when shown (Etsy's API Terms: 24 hours). Past this many hours since
   * the connection's last successful sync, its current figures are marked out of date and left out of totals until the
   * next good sync; closed past periods stay as recorded. Unset: the general limits apply.
   */
  staleAfterHours?: number
}

/** Setup guide for a connector that needs keys on this server (one source for the web, `agfn doctor` and docs). */
export interface ConnectorSetup {
  /** False: the keys are missing on this server, so connecting would fail. */
  configured: boolean
  /** app: needs your own developer app (OAuth, Plaid). key: a token pasted per connection. none: nothing to set. */
  kind: 'app' | 'key' | 'none'
  /** Where to create the app. */
  register?: { name: string; url: string }
  /** The exact redirect URI to register for THIS server. */
  redirectUri?: string
  /** Environment variables to set (names only). */
  env?: string[]
  /** 3–5 plain sentences. */
  steps?: string[]
  docsUrl?: string
}

export interface ConnectionRef {
  id: ConnectionId
  workspaceId: WorkspaceId
  connectorKey: string
  /** Decrypted secret, only ever held in memory by the sync worker. */
  secret: unknown
  config: Record<string, unknown>
  /** The workspace's IANA time zone, when set: the company's "today", so month periods match the provider's. */
  timeZone?: string
}

export interface SyncResult {
  events: NormalizedEvent[]
  /** Opaque cursor persisted by the sync engine; null = start over / full backfill. */
  cursor: string | null
  hasMore: boolean
  /** Rotated credentials (e.g. QuickBooks/Xero refresh tokens); the sync worker re-seals and saves them with the cursor. */
  updatedSecret?: unknown
  /** Non-fatal notes in plain words ("Apple hasn't published yesterday's report yet"), shown on the connection row. */
  warnings?: string[]
  /**
   * The provider is still preparing data (e.g. Plaid's history right after linking): sync this connection again after
   * this many ms instead of waiting for the next scheduled round or a webhook.
   */
  syncAgainInMs?: number
  /** How fresh the provider says its data is (Plaid's Item status, balance timestamps). Saved on the connection. */
  freshness?: ProviderFreshness
}

/**
 * The provider's own word on how current its data is, stored per connection (connections.freshness_json) and shown by
 * MCP reads as data_as_of. Every field is optional: left out when the provider doesn't say. ISO timestamps.
 */
export interface ProviderFreshness {
  /** Plaid /item/get status.transactions.last_successful_update. */
  transactionsLastSuccessAt?: IsoTimestamp
  /** Plaid status.transactions.last_failed_update. */
  transactionsLastFailedAt?: IsoTimestamp
  /** Plaid status.investments.last_successful_update. */
  investmentsLastSuccessAt?: IsoTimestamp
  /** The provider's error code for this connection, e.g. Plaid's item.error.error_code ("ITEM_LOGIN_REQUIRED"). Code only. */
  providerErrorCode?: string
  /** The OLDEST balance timestamp across the connection's accounts, so data_as_of never claims fresher than the stalest. */
  balancesUpdatedAt?: IsoTimestamp
  /** Each account's balance timestamp, by accountExternalId, where the provider gives one. */
  balancesUpdatedAtByAccount?: Record<string, IsoTimestamp>
  /** When Aggregate read these. */
  checkedAt?: IsoTimestamp
}

export interface ConnectorHealth {
  status: 'ok' | 'needs_reauth' | 'error' | 'rate_limited'
  message?: string
  lastSuccessAt?: IsoTimestamp
}

/** Where connectors store exactly what a provider sent (backed by raw_records). Returns the raw record id for `rawRef`. */
export interface RawSink {
  put(connectionId: ConnectionId, kind: string, externalId: string, payload: unknown): Promise<Id>
}

/** First step of connecting, shown by the UI: open a provider widget, redirect to OAuth, ask for a key, or take a file. */
export type ConnectBegin =
  | { kind: 'link_widget'; provider: string; token: string }
  | { kind: 'oauth'; url: string }
  | {
      kind: 'api_key'
      label: string
      helpUrl: string
      placeholder: string
      /** Multi-field credentials (e.g. PayPal client id + secret). When present, the UI shows one input per field and
       *  finishes with {state, [field.name]: value...}; when absent, a single `apiKey` input. */
      fields?: ConnectField[]
      /** Guided key paste: short plain steps ("Open Stripe → Developers → API keys", …), shown numbered above the form. */
      steps?: string[]
      /** The minimum read-only permissions to tick when creating the key, shown as a checklist. */
      permissions?: string[]
    }
  | { kind: 'upload'; accept: string }

export interface ConnectField {
  name: string
  label: string
  placeholder?: string
  /** Mask the input and never echo it back. */
  secret?: boolean
  /** Textarea (PEM keys, service-account JSON). */
  multiline?: boolean
  optional?: boolean
  /** Fixed choices (e.g. live | sandbox); first is the default. */
  options?: string[]
}

export interface ConnectBeginContext {
  workspaceId: WorkspaceId
  /** Where OAuth providers send the person back (our /api/connectors/:key/callback). */
  redirectUri: string
  /** Opaque CSRF state the server verifies on finish; connectors put it in the OAuth URL. */
  state: string
  /** Stable, non-PII id for the person (e.g. Plaid client_user_id). */
  userRef: string
  /** Set when re-authenticating an existing connection (Plaid update mode, OAuth re-consent). */
  connection?: ConnectionRef
  /** With `connection`: also let the person pick accounts opened since (Plaid NEW_ACCOUNTS_AVAILABLE). */
  accountSelection?: boolean
  /** A new Plaid link for a login with only brokerage/retirement accounts: Investments required, Transactions consented. */
  investmentsFirst?: boolean
}

/** Something a connection's grant can reach but that isn't connected yet (Connector.listShared). */
export interface SharedOffer {
  id: string
  name: string
  match: { field: string; value: string }
}

export interface ConnectResult {
  secret: unknown
  config: Record<string, unknown>
  additional?: Array<{ secret: unknown; config: Record<string, unknown> }>
}

export interface Connector {
  describe(): ConnectorDescription
  /** Optional first step; connectors without it are 'api_key' or 'upload' per describe().auth. */
  begin?(ctx: ConnectBeginContext): Promise<ConnectBegin>
  /**
   * Exchange auth input (OAuth code, public token, API key) for a stored secret + config. `additional`: more
   * connections from the same sign-in (e.g. each Xero organisation the person ticked), each saved on its own. Configs
   * that share one rotating token carry the same `sharedSecretKey`, so a refreshed secret reaches all of them.
   */
  connect(input: Record<string, unknown>): Promise<ConnectResult>
  sync(conn: ConnectionRef, cursor: string | null): Promise<SyncResult>
  health(conn: ConnectionRef): Promise<ConnectorHealth>
  /**
   * Optional: revoke our access at the provider when the person disconnects (Plaid /item/remove, OAuth token revoke).
   * Called with the still-decrypted secret before it is wiped. Must be safe to call twice. `notRevoked`: the access
   * can't be ended from here (a pasted key, or a provider with no such call): what the person must do at the provider.
   */
  disconnect?(conn: ConnectionRef): Promise<void | { notRevoked: string }>
  /**
   * Set when revoking ends the provider account for everyone, and that account can be connected in several workspaces
   * (a Shopify store). The engine then sets `config.liveElsewhere` on the ref given to `disconnect`.
   */
  accountKey?(config: Record<string, unknown>): string | undefined
  /**
   * Optional: what else this connection's grant can reach (each Xero organisation the person ever shared with
   * Aggregate). `match` names the config field that identifies one, so the caller can leave out ones it has.
   */
  listShared?(conn: ConnectionRef): Promise<SharedOffer[]>
  /** Optional: one of listShared's offers as its own connection on the same grant (no new consent). */
  connectShared?(conn: ConnectionRef, id: string): Promise<ConnectResult>
  /**
   * Optional: read balances live from the institution right now (Plaid /accounts/balance/get). Slow and billed per
   * call by some providers, so it only runs on an explicit request, never on a schedule. Returns balance snapshots.
   */
  refreshBalances?(conn: ConnectionRef): Promise<NormalizedEvent[]>
}

// ---------- Normalized events (connectors emit, the ledger posts) ----------
// Sign rule: positive = money in to the account, negative = money out. Connectors convert at the boundary.

/**
 * A provider's exchange rate for a document in a currency other than its books' home currency (QuickBooks
 * ExchangeRate, Xero CurrencyRate): `rate` home units per 1 unit of the document's currency, as a decimal string.
 * The ledger uses it only when `home` is the entity's base currency; otherwise its market rate, as without it.
 */
export interface ProviderFx {
  rate: string
  home: Currency
}

interface EventBase {
  /** Provider's stable id for this object, unique per connection. */
  externalId: string
  connectionId: ConnectionId
  /** Reference to the stored raw payload (raw_records.id). */
  rawRef?: Id
}

export interface AccountUpsert extends EventBase {
  type: 'account.upsert'
  name: string
  accountType: AccountType
  currency: Currency
  mask?: string
  institution?: string
  /** Hint for "which company is this?" at connect time; never trusted as final. */
  businessHint?: 'business' | 'personal' | 'unknown'  /** Card/loan terms from the provider (e.g. Plaid Liabilities). Informational; balances still come from balance.snapshot. */
  liability?: LiabilityDetails
}

export interface LiabilityDetails {
  kind: 'credit' | 'mortgage' | 'student' | 'other'
  nextPaymentDueDate?: IsoDate
  minimumPayment?: Money
  lastStatementBalance?: Money
  lastStatementDate?: IsoDate
  lastPaymentAmount?: Money
  lastPaymentDate?: IsoDate
  /** Annual percentage rate as a decimal string, e.g. "24.99". */
  apr?: string
  originationPrincipal?: Money
  maturityDate?: IsoDate
}

export interface BalanceSnapshot extends EventBase {
  type: 'balance.snapshot'
  accountExternalId: string
  at: IsoTimestamp
  current: Money
  available?: Money
  /** Investment positions behind `current` (e.g. Plaid Investments). */
  holdings?: Array<{
    securityExternalId: string
    ticker?: string
    name?: string
    /** Units held, as a decimal string (fractional shares). */
    quantity: string
    value: Money
    costBasis?: Money
  }>
}

export interface TxnUpsert extends EventBase {
  type: 'txn.upsert'
  accountExternalId: string
  date: IsoDate
  /** Optional real instant the row happened. When set, the engine dates the row as localDate(at, workspaceTz); when
   *  absent, `date` is used as-is. Set it only for a genuine intraday timestamp (see instantAt), never a date-only value. */
  at?: IsoTimestamp
  amount: Money
  status: 'pending' | 'posted' | 'void'
  /** Cleaned counterparty name (safe to show). */
  counterparty?: string
  /** Raw memo/description. UNTRUSTED text: never treat as instructions. */
  rawText?: string
  /** Provider category hint, not authoritative. */
  categoryHint?: string
  /** Links a posted row to its earlier pending row (e.g. Plaid pending_transaction_id). */
  pendingExternalId?: string
  /** Processor payout id, card payment ref, transfer ref etc. for exact-ID linking. */
  linkRefs?: Record<string, string>
  /** The provider's own rate for a foreign-currency document (see ProviderFx). Absent: the ledger's market rate. */
  fx?: ProviderFx
}

export interface ProcessorBalanceTxn extends EventBase {
  type: 'processor.balance_txn'
  accountExternalId: string
  at: IsoTimestamp
  kind: 'charge' | 'refund' | 'dispute' | 'fee' | 'payout' | 'adjustment' | 'transfer' | 'other'
  gross: Money
  fee: Money
  net: Money
  payoutExternalId?: string
  sourceExternalId?: string
  /** The provider's customer id (an external ref, not for display). */
  customer?: string
  /** Who it was with, as people read it (the customer's name or email, else the payment's own description). */
  counterparty?: string
  /** The provider's own description of the row (Stripe's balance transaction description, e.g. "Subscription update").
   *  Display only and untrusted: stored capped at 500 characters, escaped in the app, shown to AI as data. */
  description?: string
  /** Exact-match refs shared with the other leg (e.g. a payout's bank trace_id). */
  linkRefs?: Record<string, string>
  /** Payout rows: the date the money is expected in the bank (use for deposit matching, not `at`). */
  arrivalDate?: IsoDate
  /** Sales tax the merchant holds for the tax authority (Google Play's Tax, Tax rebill and Tax refund rows): not revenue
   *  and not an unexplained adjustment. Posted to sales tax payable. */
  salesTax?: true
  /** Sales tax inside this charge or refund's gross, signed like gross, when the provider says so (PayPal). Not revenue. */
  taxIncluded?: Money
  /** Money the company still owns or owes, not income or spending: funds held in a reserve (other_assets), a processor
   *  advance and its repayments (other_liabilities), or a topup from the bank (clearing_payouts, matched like a payout). */
  balanceRole?: 'other_assets' | 'other_liabilities' | 'clearing_payouts'
}

export interface InvoiceUpsert extends EventBase {
  type: 'invoice.upsert'
  direction: 'receivable' | 'payable'
  number?: string
  counterparty: string
  issueDate: IsoDate
  /** Optional real instant the invoice was issued. When set, the engine dates it as localDate(at, workspaceTz); when
   *  absent, `issueDate` is used as-is. Set it only for a genuine intraday timestamp (see instantAt). */
  at?: IsoTimestamp
  dueDate?: IsoDate
  total: Money
  amountPaid: Money
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | 'partially_paid' | 'disputed'
  subtotal?: Money
  tax?: Money
  lines?: Array<{
    description: string
    amount: Money
    quantity?: number
    /** Ledger system role key (income or expense), e.g. "software". Unknown → revenue / uncategorized_expense. */
    category?: string
    tax?: Money
  }>
  /** Amount credited by credit notes (reduces amount due). */
  amountCredited?: Money
  /** The provider's own rate for a foreign-currency document (see ProviderFx). Absent: the ledger's market rate. */
  fx?: ProviderFx
  /** Provider ids of the payments that paid it (Stripe payment intents). A processor charge carrying one in
   *  linkRefs.payment_intent settles this invoice (accrual: clears AR) instead of being new revenue. */
  paymentRefs?: string[]
}

export interface PayrollRun extends EventBase {
  type: 'payroll.run'
  payDate: IsoDate
  /** Optional real instant the run was paid. When set, the engine dates it as localDate(at, workspaceTz); when absent,
   *  `payDate` is used as-is. Set it only for a genuine intraday timestamp (see instantAt). */
  at?: IsoTimestamp
  gross: Money
  employerTaxes: Money
  net: Money
  employeeCount?: number
  estimated?: boolean
  source?: 'provider' | 'bank_detected' | 'register_upload'
  status?: 'scheduled' | 'processed' | 'paid' | 'void'
  periodStart?: IsoDate
  periodEnd?: IsoDate
  employeeTaxes?: Money
  employerBenefits?: Money
  reimbursements?: Money
  /** Total debited from the company bank account(s). */
  companyDebit?: Money
  settlementTxnExternalIds?: string[]
  /** Provider name, e.g. "Gusto", "Rippling". */
  provider?: string
  /** Per-person detail is 'payroll' data and permission-gated. */
  lines?: Array<{ person: string; gross: Money; net: Money; kind: 'employee' | 'contractor' }>
}

export interface EquityEvent extends EventBase {
  type: 'equity.event'
  kind: 'issuance' | 'safe' | 'convertible_note' | 'option_grant' | 'exercise' | 'transfer' | 'cancellation' | 'conversion'
  date: IsoDate
  stakeholder: string
  /** Open Cap Format object, when available. */
  ocf?: Record<string, unknown>
  amount?: Money
  shares?: number
}

export interface PaymentApplied extends EventBase {
  type: 'payment.applied'
  direction: 'receivable' | 'payable'
  date: IsoDate
  amount: Money
  method?: string
  counterparty?: string
  applications: Array<{ invoiceExternalId: string; amount: Money }>
  unapplied?: Money
  bankTxnRef?: string
  /** Check number / memo reference, used for matching. */
  reference?: string
  /** 'void' = the provider deleted or voided the payment; the ledger reverses its applications. */
  status?: 'posted' | 'void'
  /** The provider's own rate for a foreign-currency document (see ProviderFx). Absent: the ledger's market rate. */
  fx?: ProviderFx
}

export interface CreditNoteUpsert extends EventBase {
  type: 'credit_note.upsert'
  direction: 'receivable' | 'payable'
  invoiceExternalId?: string
  number?: string
  date: IsoDate
  amount: Money
  appliedTo: 'invoice' | 'customer_credit' | 'refund' | 'out_of_band'
  counterparty?: string
  status?: 'open' | 'applied' | 'void'
  /** Allocation across several invoices. When present it is authoritative; invoiceExternalId is the first one. */
  applications?: Array<{ invoiceExternalId: string; amount: Money }>
  /** Sales tax inside `amount`: a customer credit gives back revenue net of tax and the tax itself; a supplier credit
   * takes back the expense net of tax and the tax (send it only when that supplier's bills put their tax on sales tax
   * owed, as Xero's do). */
  tax?: Money
  /** The provider's own rate for a foreign-currency document (see ProviderFx). Absent: the ledger's market rate. */
  fx?: ProviderFx
}

/**
 * Recurring revenue input for MRR/ARR (Stripe, Paddle, Lemon Squeezy...). Informational: recorded, never posted as a
 * journal entry. Sent on every status change (including canceled) so churn and movements can be derived from history.
 */
export interface SubscriptionUpsert extends EventBase {
  type: 'subscription.upsert'
  customer: string
  status: 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused' | 'canceled' | 'incomplete' | 'incomplete_expired'
  /** Monthly-normalized recurring amount after discounts, excluding tax and metered usage (Stripe's MRR definition).
   *  Always >= 0, in the subscription's own currency; 0 unless status is active or past_due. */
  mrr: Money
  interval: 'day' | 'week' | 'month' | 'year'
  intervalCount: number
  startedAt: IsoTimestamp
  currentPeriodEnd?: IsoTimestamp
  cancelAtPeriodEnd?: boolean
  canceledAt?: IsoTimestamp
  endedAt?: IsoTimestamp
  items?: Array<{ priceExternalId: string; product?: string; quantity: number; amount: Money }>
  /** Past MRR values the provider knows (plan or quantity changes before this snapshot), oldest first, each `at` no
   *  later than the snapshot: MRR was `mrr` from `at` on. The first is the value it started at. Lets a backfill date an
   *  upgrade in the month it happened instead of the day it was imported. Absent: only start, end and now are known. */
  changes?: Array<{ at: IsoTimestamp; mrr: Money }>
}

/** A provider's own report (e.g. QuickBooks/Xero P&L shown as "Books"). Informational; never posted to the ledger. */
export interface ReportSnapshot extends EventBase {
  type: 'report.snapshot'
  kind: 'profit_and_loss' | 'balance_sheet'
  from: IsoDate
  to: IsoDate
  basis: 'cash' | 'accrual'
  currency: Currency
  rows: Array<{ account: string; amount: Money; section?: string; depth?: number; accountExternalId?: string }>
  /** P&L totals as the provider's own report states them (its summary rows), for cross-checking ours per period. */
  totals?: { income?: Money; cogs?: Money; expenses?: Money; otherIncome?: Money; otherExpenses?: Money; netIncome: Money }
  /**
   * What the provider's report includes that the connector can't read (e.g. payroll), shown when the totals differ.
   * `withPayroll` replaces `text` when the company's payroll already comes from another connection in that period.
   */
  notCovered?: { text: string; withPayroll?: string }
}

/**
 * A journal entry made in the books (QuickBooks JournalEntry, Xero manual journal, cost of goods sold on a sale).
 * Lines name Aggregate roles the connector mapped from the provider's chart. Never bank, card, processor, loan,
 * cash-on-hand or clearing accounts: money at the bank comes only from bank feeds, so a provider journal that
 * touches a bank account mirrors a bank row and the connector skips it. Posted on both bases, as given.
 */
export interface JournalUpsert extends EventBase {
  type: 'journal.upsert'
  date: IsoDate
  memo?: string
  status?: 'posted' | 'void'
  /** + debit, − credit; lines must sum to zero in each currency. */
  lines: Array<{ role: string; amount: Money; memo?: string; accountExternalId?: string }>
  /** The provider's own rate for a foreign-currency document (see ProviderFx). Absent: the ledger's market rate. */
  fx?: ProviderFx
}

/** Provider chart-of-accounts entry, used to map provider categories to Aggregate's chart. Recorded, never posted. */
export interface LedgerAccountUpsert extends EventBase {
  type: 'ledger_account.upsert'
  name: string
  code?: string
  classification: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  subtype?: string
  currency?: Currency
  active: boolean
}

export type NormalizedEvent =
  | AccountUpsert
  | BalanceSnapshot
  | TxnUpsert
  | ProcessorBalanceTxn
  | InvoiceUpsert
  | PayrollRun
  | EquityEvent
  | InvestmentEvent
  | PaymentApplied
  | CreditNoteUpsert
  | ReportSnapshot
  | SubscriptionUpsert
  | LedgerAccountUpsert
  | JournalUpsert
  | ListingComplete

/**
 * What a completed full listing covers: invoice/bill are invoice.upsert by direction; payment = payment.applied;
 * credit_note = credit_note.upsert of both directions (every path that emits one must be in the same pass).
 */
export type ListingKind = 'invoice' | 'bill' | 'journal' | 'payment' | 'txn' | 'credit_note' | 'investment'

/**
 * Sent once a connector has listed every record of `kinds` it has (a full pass that finished, with no page cap or
 * skipped entity). `externalId` is unique per listing (e.g. `listing:<startedAt>`). The ledger voids this connection's records of those kinds not seen since `startedAt` (they were
 * deleted at the provider), with safety limits. Not a record itself.
 */
export interface ListingComplete extends EventBase {
  type: 'listing.complete'
  kinds: ListingKind[]
  /** When the full pass began, before its first page request. */
  startedAt: IsoTimestamp
  /** Only records whose external id starts with this (e.g. 'je:'). */
  scope?: string
}

// ---------- Ledger API (packages/core) ----------

export type TxnKind =
  | 'revenue'
  | 'expense'
  | 'cash_income'
  | 'reimbursement'
  | 'owner_loan'
  | 'owner_contribution'
  | 'owner_money_unspecified'
  | 'equity_financing'
  | 'intercompany'
  | 'transfer'
  | 'card_payment'
  | 'payout'
  | 'refund'
  | 'fee'
  | 'payroll'
  | 'tax'
  | 'other'

/**
 * An investment the company holds in another company (a fund's portfolio, or a company's own stake), books at cost.
 * One position per holding (`positionId`, stable); every event on it carries the position's security fields so any
 * one can create it. Field names follow Open Cap Format and Carta's export where one exists (security type, issue
 * date, cost, shares, valuation cap, discount), so an importer maps onto them.
 * - invest: money paid (`amount` = cost) for `shares` (priced, common) or on terms (`valuationCap`, `discountPct`);
 *   a later invest on the same position adds to it (a follow-on).
 * - mark: what the whole position is worth on `date` (`amount`), from `markSource`. Shown, never posted.
 * - distribution: money received from it (`amount`); returns cost first, the rest is a realized gain.
 * - write_off: the remaining cost is lost. exit: sold or closed for `amount` (0 allowed: a loss); the position ends.
 *   An exit with no `amount` left without money (distributed in kind, transferred away): out at cost to the owners,
 *   no gain or loss, and its MOIC is unknown.
 *   A partial sale is a distribution (cost first, then gain); only exit ends the position.
 * - convert: a SAFE or note converting at a priced round. Sets the new securityType, series and shares; cost carries
 *   over, nothing is posted, and the earlier events keep the old terms.
 * Units: discountPct and interestPct are percents as term sheets write them (20 = 20%); shares may be fractional.
 * Currency: a position has one currency, its first invest's; an event in another currency is rejected.
 */
export interface InvestmentEvent extends EventBase {
  type: 'investment.event'
  kind: 'invest' | 'mark' | 'distribution' | 'write_off' | 'exit' | 'convert'
  positionId: string
  /** The portfolio company. */
  issuer: string
  /** OCF stock / convertible / warrant classes, flattened. */
  securityType: 'safe' | 'convertible_note' | 'preferred_stock' | 'common_stock' | 'warrant' | 'other'
  /** Issue date for invest; the event's date otherwise. */
  date: IsoDate
  amount?: Money
  shares?: number
  /** Round or share class name ("Seed", "Series A Preferred"). */
  series?: string
  valuationCap?: Money
  discountPct?: number
  interestPct?: number
  maturityDate?: IsoDate
  markSource?: string
  /** This position's page at the platform it was read from (its "Via …" link); connectors set it, never people. */
  sourceUrl?: string
  /** Open Cap Format object, when imported. */
  ocf?: Record<string, unknown>
}

/** One position, as of a day: cost basis, what it's worth, what came back. */
/**
 * Investment totals per company and currency, as of a day: what the page and get_investments show above the positions
 * (one definition: never added up in a browser or a tool). Never summed across currencies.
 */
export interface InvestmentTotals {
  entityId: EntityId
  currency: Currency
  positions: number
  active: number
  /** Total cost, every invest. */
  invested: Money
  /** Sum of position values (latest mark, else cost left; 0 once exited or written off). */
  value: Money
  /** Money back: distributions and exit proceeds. */
  distributed: Money
  /** Cost of positions written off (what went to write-offs). */
  writtenOff: Money
  /** (value + distributed) ÷ invested over the positions whose MOIC is known, to 2 places; null when none. */
  moic: number | null
  /** Positions left out of moic: exited in kind, what came back isn't known. */
  moicExcludes: number
}

export interface InvestmentView {
  positionId: string
  entityId: EntityId
  issuer: string
  securityType: InvestmentEvent['securityType']
  series?: string
  firstInvested: IsoDate
  /** Total cost (every invest). */
  invested: Money
  shares?: number
  valuationCap?: Money
  discountPct?: number
  /** Latest mark on or before the day, else cost; 0 once written off or exited. */
  value: Money
  valueSource: 'cost' | 'mark' | 'written_off' | 'exited'
  markedAt?: IsoDate
  /** Money received: distributions and exit proceeds. */
  distributed: Money
  /** (value + distributed) ÷ invested; null when nothing was invested. */
  moic: number | null
  status: 'active' | 'written_off' | 'exited'
  /** The investment and distribution events behind it, for get_record. */
  recordIds: Id[]
  /** The platform it was read from, for a "Via Wefunder ↗" link (absent when added by hand or from a bank). */
  source?: { name: string; url: string }
}

export type LinkType =
  | 'transfer'
  | 'card_payment'
  | 'payout'
  | 'cash_deposit'
  | 'pending_posted'
  | 'duplicate'
  | 'invoice_payment'
  | 'reimbursement'
  | 'intercompany'
  | 'payroll_settlement'
  | 'equity_cash'
  | 'investment_cash'
  | 'refund'

export interface LinkProposal {
  type: LinkType
  fromId: Id
  toId: Id
  amount?: Money
  confidence: number
  method: 'exact_id' | 'rule' | 'fuzzy' | 'human' | 'agent'
}

export type MetricName =
  | 'cash'
  | 'card_balances'
  | 'net_cash'
  | 'available_cash'
  | 'gross_burn'
  | 'net_burn'
  | 'runway'
  | 'mrr'
  | 'arr'
  | 'revenue'
  | 'ar_open'
  | 'ar_overdue'
  | 'ap_due'
  | 'payroll_cost'
  | 'recurring_spend'
  | 'owner_balance'
  | 'intercompany_balance'
  | 'fully_diluted'
  | 'data_health'
  /** Last complete month: (churned + contraction MRR) / MRR at its start, as a fraction. */
  | 'mrr_churn_rate'
  /** Last complete month: new + expansion + reactivation − contraction − churn. */
  | 'net_new_mrr'

export interface MetricScope {
  workspaceId: WorkspaceId
  entityIds: EntityId[] | 'all'
  from?: IsoDate
  to?: IsoDate
  basis?: 'cash' | 'accrual'
  /**
   * Internal only, never from a tool input or request body: just the figure and its state. failedChecks,
   * pendingReviewCount and staleSources come back empty (the workspace-wide checks and review aren't run). For the write
   * pipeline's large-change alert. No cache holds whole answers by scope, so a figure-only answer is never served to a
   * full read.
   */
  figureOnly?: boolean
}

export interface MetricAnswer {
  name: MetricName
  value: Money | number | null
  /**
   * unknown: value is null because a source is missing (never reported, a month with no data, not synced through the
   * period); stale: value uses the last known balances, some older than they should be. Both say why in unknownReason.
   */
  state?: 'ok' | 'not_burning' | 'not_enough_history' | 'no_data' | 'unknown' | 'stale'
  unknownReason?: string
  /** The reason includes a failing check, not only old balances. Internal: not in any tool output. */
  checkCaveat?: boolean
  /** data_health only: the counts behind the number (so an AI can say "12 checks pass, 1 needs a look"). */
  health?: { passedChecks: number; failedChecks: number; warnings: number; pendingReview: number; staleSources: number; /** The Workspace's own line, e.g. "6 things need a look: 2 to review, 4 balances don't match". */ line?: string }
  /** What the answer could see: each account's newest balance and how far its source has synced, plus gaps. */
  coverage?: MetricCoverage
  basis: 'cash' | 'accrual'
  asOf: IsoTimestamp
  includedAccounts: AccountId[]
  excludedAccounts: Array<{ id: AccountId; reason: string }>
  staleSources: ConnectionId[]
  pendingReviewCount: number
  agentEntriesIncluded: number
  rowIds: Id[]
  formula: string
  /**
   * mrr and arr only: the product names (subscription items) the value is made of, by contribution, highest first,
   * then by name; at most 10, the rest counted in productsMore. [] when the subscriptions carry no product names; left
   * out when there are no subscriptions.
   */
  products?: string[]
  productsMore?: number
}

export interface MetricCoverage {
  accounts: Array<{ accountId: AccountId; name: string; balanceAsOf: IsoDate | null; syncedThrough: IsoDate | null; stale: boolean }>
  /** Plain lines for missing or mismatched months in the period, e.g. "Chase ··4411: August has no transactions". */
  gaps: string[]
}

/**
 * posted: a journal entry was written. recorded: stored but no entry (account.upsert, snapshots, pending txns, option grants).
 * duplicate: already posted (idempotent). unassigned: the source account has no company yet; held until "which company?" is answered.
 */
export interface PostResult {
  journalEntryId: Id | null
  status: 'posted' | 'recorded' | 'duplicate' | 'unassigned'
}

export interface Ledger {
  /** Post a normalized event as a balanced journal entry. Idempotent per (connectionId, externalId). */
  post(workspaceId: WorkspaceId, event: NormalizedEvent): Promise<PostResult>
  /** Many events in one transaction (a sync page), results in order. Same semantics as post for each. */
  postBatch?(workspaceId: WorkspaceId, events: readonly NormalizedEvent[], opts?: { settleLater?: boolean }): Promise<PostResult[]>
  /**
   * Pages posted with `settleLater` skip matching and opening balances; this does both once for the connection
   * (call it when a sync run ends, ok or not). A no-op when nothing waits.
   */
  settle?(workspaceId: WorkspaceId, connectionId: ConnectionId): Promise<void>
  /**
   * Run several ledger writes as one transaction (one lock, one directory read and one version bump for all of
   * them); writes made inside join it. Only ledger calls belong inside: work on other database connections can wait
   * on this one (PGlite has a single connection). `fn` may run again if the transaction retries, so it must be safe
   * to repeat.
   */
  transaction?<T>(fn: () => Promise<T>): Promise<T>
  link(workspaceId: WorkspaceId, proposal: LinkProposal): Promise<{ linkId: Id; status: 'confirmed' | 'proposed' }>
  suggestLinks(workspaceId: WorkspaceId, since?: IsoTimestamp): Promise<LinkProposal[]>
  metric(name: MetricName, scope: MetricScope): Promise<MetricAnswer>
  /** Called when an account's company or duplicate status changes, so held ('unassigned') rows can post. */
  accountChanged?(workspaceId: WorkspaceId, accountId: AccountId): Promise<void>
  /** Record that the person judged a possible-duplicate pair to be two different accounts, so the data-health check
   *  stops flagging it (keyed by dupKey: the pair and the evidence kind, so only new evidence re-raises it). */
  dismissDuplicate?(workspaceId: WorkspaceId, dismissal: { subjectId: AccountId; relatedId: AccountId; dupKey: string }): Promise<void>
  /**
   * Maintenance: re-post already-posted records of the given event types on the given connections so their date and
   * journal entries match today's dating/posting rules, re-dating any left stale by a rule change. Idempotent (a second
   * run changes nothing); dryRun writes nothing and only counts. Returns the count of changed records per connection id.
   */
  repostToRules?(workspaceId: WorkspaceId, opts: { connectionIds: ConnectionId[]; eventTypes: Array<NormalizedEvent['type']>; dryRun: boolean }): Promise<Record<string, number>>
  /** Called when a connection's company changes. */
  connectionChanged?(workspaceId: WorkspaceId, connectionId: ConnectionId): Promise<void>
  /** A connection was removed with its data: what it brought stops counting (kept for the audit trail, not deleted). */
  connectionRemoved?(workspaceId: WorkspaceId, connectionId: ConnectionId): Promise<number>
  /**
   * A connection whose provider's terms require its data deleted on disconnect (ERASE_ON_DISCONNECT): what it brought
   * stops counting as with connectionRemoved, then its records and everything posted from them are deleted. Returns
   * how many records were deleted.
   */
  connectionErased?(workspaceId: WorkspaceId, connectionId: ConnectionId): Promise<number>
  /**
   * A disconnected connection's records stop counting (all of them, or some accounts' from a date on), reversed in the
   * open period. Returns how many records were retired.
   */
  retireRecords?(workspaceId: WorkspaceId, filter: { connectionId: ConnectionId; sourceAccountIds?: AccountId[]; from?: IsoDate }): Promise<number>
  /** Called after a company is added or edited, or the workspace's time zone changes: cached totals are recomputed. */
  directoryChanged?(workspaceId: WorkspaceId): Promise<void>
}

// ---------- Permissions (packages/auth) ----------

export type Action = 'view' | 'add' | 'edit' | 'manage'

export type Actor =
  | { kind: 'person'; personId: PersonId; workspaceId: WorkspaceId }
  | { kind: 'grant'; grantId: GrantId; personId: PersonId; workspaceId: WorkspaceId }
  | { kind: 'system'; workspaceId: WorkspaceId; reason: string }

/** The single permission check used by UI, REST and MCP alike. A grant can never exceed its person. */
export type Can = (actor: Actor, action: Action, entityId: EntityId, dataType: DataType) => Promise<boolean>

export interface GrantShape {
  entityIds: EntityId[] | 'all'
  dataTypes: DataType[]
  write: boolean
  /** Yisrael's default: changes apply immediately. */
  reviewMode: 'instant' | 'review_all'
  dailyWriteCap?: number
  expiresAt: IsoTimestamp | null
}

// ---------- Writes (every UI/REST/MCP write goes through write_requests) ----------

export type WriteOrigin = 'ui' | 'agent' | 'import' | 'rule' | 'connector' | 'email'

export interface WriteRequest<P = Record<string, unknown>> {
  idempotencyKey: string
  actor: Actor
  origin: WriteOrigin
  op: string
  payload: P
  /** Why the agent is writing (from the conversation), stored as provenance. */
  reason?: string
  fileSha256?: string
}

export interface WriteResult {
  status: 'applied' | 'pending_review' | 'rejected' | 'duplicate'
  recordId?: Id
  undoUntil?: IsoTimestamp
  suggestedLinks?: LinkProposal[]
  message?: string
  /** One plain sentence describing what was recorded (UI toasts). */
  summary?: string
  /** Records this may duplicate; present only when non-empty. */
  possibleDuplicates?: Id[]
}

// ---------- Audit ----------

export interface AuditEvent {
  workspaceId: WorkspaceId
  actor: Actor
  at: IsoTimestamp
  action: string
  target?: { type: string; id: Id }
  /** Arguments with amounts redacted. */
  args?: Record<string, unknown>
}

// ---------- Read and write ports (S1 implements, S7 consumes) ----------
// Money is minor units. Third-party strings arrive raw; S7 cleans and labels them before they reach an AI.
// Every view carries entityId so callers can drop anything outside the caller's scope.


export interface EntityInfo {
  id: EntityId
  name: string
  kind: EntityKind
  /** Home currency of the entity. */
  currency: string
  /** Personal spaces: whose they are. */
  ownerPersonId?: PersonId
}

/** Already permission-filtered: the reader may trust these ids. */
export interface ReadScope {
  workspaceId: WorkspaceId
  entityIds: EntityId[]
}

export interface Page<T> {
  rows: T[]
  totalCount: number
  nextCursor: string | null
}

export interface SourceStatus {
  connectionId: ConnectionId
  name: string
  entityIds: EntityId[]
  lastSyncAt: IsoTimestamp | null
  stale: boolean
  health: 'ok' | 'needs_reauth' | 'error' | 'rate_limited'
}

/** Who added a record: a sync, a person, a rule, or an AI (with its grant). */
export interface AddedBy {
  kind: 'sync' | 'person' | 'agent' | 'rule' | 'import' | 'email'
  name: string
  grantId?: Id
}

// ---------- Views ----------

export interface OverviewEntity {
  entityId: EntityId
  cash: Money
  cardDebt: Money
  netBurn3mo: Money | null
  runwayMonths: number | null
  runwayState: 'ok' | 'not_burning' | 'not_enough_history' | 'no_data' | 'unknown' | 'stale'
  mrr: Money | null
  owedToYou: { total: Money; overdue: Money }
  billsDue30d: Money
  nextPayroll: { date: IsoDate; estimate: Money } | null
  /** Figures that are unknown (show "unknown", not the 0 above) or use stale balances (show the caveat). */
  caveats?: Array<{ figure: 'cash' | 'cardDebt' | 'netBurn3mo' | 'runwayMonths'; state: 'unknown' | 'stale'; reason: string }>
  /** Figures with no invoices or bills behind them: a 0 above means no data, not nothing owed. */
  noData?: Array<'owedToYou' | 'billsDue30d'>
}

export interface AttentionItem {
  kind: 'overdue_invoice' | 'low_runway' | 'failed_check' | 'stale_source' | 'needs_review' | 'large_change' | 'suspicious_text'
  entityId?: EntityId
  /** Built by the reader from its own data; may embed counterparty names (S7 cleans it). */
  text: string
  recordId?: Id
}

export interface Overview {
  asOf: IsoTimestamp
  homeCurrency: string
  entities: OverviewEntity[]
  attention: AttentionItem[]
  /** Reconciliation checks that currently fail ("needs review" line). */
  failingChecks: Array<{ entityId?: EntityId; check: string; detail: string }>
}

export interface AccountView {
  id: AccountId
  entityId: EntityId
  name: string
  institution?: string
  mask?: string
  type: AccountType
  currency: string
  balance: Money | null
  available: Money | null
  limit: Money | null
  lastSyncAt: IsoTimestamp | null
  closed: boolean
}

export interface AccountFilter {
  type?: AccountType
  includeClosed?: boolean
}

export interface TxnView {
  id: Id
  entityId: EntityId
  accountId: AccountId | null
  date: IsoDate
  amount: Money
  status: 'pending' | 'posted' | 'expected' | 'void'
  counterparty?: string
  category?: string
  kind?: TxnKind
  bucketId?: Id
  /** Raw memo, only returned to an AI on request and always labeled untrusted. */
  rawText?: string
  paidByEntityId?: EntityId
  forEntityId?: EntityId
  addedBy: AddedBy
  links: Array<{ type: LinkProposal['type']; recordId: Id }>
  needsReview: boolean
}

export interface TxnQuery {
  /**
   * The query language shared with rules, e.g. `counterparty:"AWS" amount>500 date:2026-09 -refund`. Combined with
   * the other fields (all must hold).
   */
  q?: string
  text?: string
  accountId?: AccountId
  from?: IsoDate
  to?: IsoDate
  /** Absolute amount bounds, minor units in the account currency. */
  minAbsMinor?: number
  maxAbsMinor?: number
  direction?: 'in' | 'out'
  category?: string
  counterparty?: string
  source?: 'bank' | 'card' | 'processor' | 'manual' | 'agent'
  status?: 'pending' | 'posted' | 'expected'
  needsReview?: boolean
  limit: number
  cursor?: string
}

export interface TxnSearchResult extends Page<TxnView> {
  /** Sum of matching rows per currency (all pages), so the AI never adds up rows itself. */
  sums: Money[]
}

export interface InvoiceView {
  id: Id
  entityId: EntityId
  direction: 'receivable' | 'payable'
  number?: string
  counterparty: string
  issueDate: IsoDate
  dueDate?: IsoDate
  total: Money
  amountPaid: Money
  status: 'draft' | 'open' | 'overdue' | 'paid' | 'partially_paid' | 'void' | 'uncollectible' | 'disputed'
  daysOverdue: number
  source: string
  hasAttachment: boolean
  lines?: Array<{ description: string; amount: Money; quantity?: number }>
  /**
   * The payments matched to it (confirmed links), oldest first. `amount` is what was applied to THIS invoice, not the
   * whole payment (one payment can settle several bills). `recordId` is the bank or processor row that paid it when
   * known, else the invoicing tool's payment record. [] when none; left out when the reader doesn't know.
   */
  payments?: Array<{ date: IsoDate; amount: Money; recordId: Id }>
  note?: string
  addedBy: AddedBy
}

export interface InvoiceQuery {
  direction?: 'receivable' | 'payable'
  status?: InvoiceView['status']
  counterparty?: string
  number?: string
  dueBefore?: IsoDate
  overdueDaysMin?: number
  /** Find likely duplicates: amount within ± this many minor units. */
  amountMinor?: number
  amountToleranceMinor?: number
  limit: number
  cursor?: string
}

export interface AgingBuckets {
  currency: string
  current: Money
  d1_30: Money
  d31_60: Money
  d61_90: Money
  d90_plus: Money
}

export interface InvoiceSearchResult extends Page<InvoiceView> {
  totals: Array<{ direction: 'receivable' | 'payable'; open: Money; overdue: Money }>
  aging: Array<AgingBuckets & { direction: 'receivable' | 'payable' }>
}

export type RecordType =
  | 'transaction'
  | 'invoice'
  | 'entry'
  | 'payroll_run'
  | 'equity_event'
  | 'bucket'
  | 'rule'
  | 'document'
  | 'account'
  | 'balance_assertion'
  | 'period_lock'

export interface AuditTrailItem {
  at: IsoTimestamp
  actor: AddedBy
  action: string
  changes?: Record<string, { from: unknown; to: unknown }>
}

export interface RecordView {
  id: Id
  type: RecordType
  entityId: EntityId
  /** Which grant data type this record belongs to (drives the permission check). */
  dataType: DataType
  data: Record<string, unknown>
  links: Array<{ type: LinkProposal['type']; recordId: Id; confirmed: boolean }>
  audit: AuditTrailItem[]
  addedBy: AddedBy
  voided: boolean
}

export interface CounterpartyView {
  id: Id
  name: string
  entityIds: EntityId[]
  paidToThemYtd: Money[]
  receivedFromThemYtd: Money[]
  paidToThemAllTime: Money[]
  receivedFromThemAllTime: Money[]
  openInvoices: InvoiceView[]
  lastPayments: TxnView[]
  averageDaysToPay: number | null
}

export interface UpcomingItem {
  date: IsoDate
  entityId: EntityId
  kind: 'bill' | 'payroll' | 'subscription' | 'expected_income' | 'tax' | 'loan_payment' | 'bucket_schedule'
  what: string
  amount: Money
  confidence: 'scheduled' | 'recurring_detected' | 'estimated'
  /** Set on a card or loan payment due (kind 'loan_payment'): which, so it isn't counted again as a bill. */
  paymentOf?: 'card' | 'loan'
  recordId?: Id
}

/** A recurring bill or subscription detected from bank and card rows (S4/S5 recurring). */
/** A card or loan's terms as the provider reported them (Plaid Liabilities); balances stay in AccountView. */
export interface LiabilityView extends LiabilityDetails {
  accountId: AccountId
  entityId: EntityId
  accountName: string
  institution?: string
  /** When the provider last reported these terms. */
  asOf: IsoTimestamp
}

/** One position in an investment account on a day (the latest on or before the asked date). */
export interface HoldingView {
  accountId: AccountId
  entityId: EntityId
  accountName: string
  securityId: string
  ticker?: string
  name?: string
  /** Units held, as a decimal string (fractional shares). */
  quantity: string
  /** value / quantity, when quantity isn't zero. */
  price?: Money
  value: Money
  costBasis?: Money
  asOf: IsoDate
}

export interface RecurringView {
  id: string
  entityId: EntityId
  counterparty: string
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'
  /** suggested: seen twice; active: three or more times; ended: no charge for two full periods. */
  status: 'suggested' | 'active' | 'ended'
  /** Current price per charge (positive). */
  amount: Money
  monthly: Money
  occurrences: number
  firstDate: IsoDate
  lastDate: IsoDate
  nextDue: IsoDate
  /** The next charge is past due and hasn't shown up. */
  late: boolean
  events: Array<{ kind: 'price_increase' | 'price_decrease' | 'trial_converted'; date: IsoDate; from: Money; to: Money; pct?: number }>
  recordIds: Id[]
}

export interface OwnerBalanceView {
  personId: PersonId
  entityId: EntityId
  /** + = the company owes the person. */
  balance: Money
  loans: Money
  contributions: Money
  unreimbursedExpenses: Money
  unspecified: Money
  rowIds: Id[]
}

/** What a bucket holds back. Cut to the accounts a reader may see before it's shown (core scopedSetAside). */
export interface SetAsideView {
  countsInCash: boolean
  /** Total held, in the bucket's company currency, over the accounts listed. */
  held: Money
  perAccount: Array<{ accountId: Id; accountName: string; entityId: EntityId | null; held: Money; heldBase: Money }>
  goal?: { target: Money; by?: IsoDate; progressPercent: number; onPace?: boolean }
  note?: string
}

/**
 * The view limited to accounts in these companies (null: all), with totals and goal progress worked out from what's
 * left, so a held total or a progress line can't reveal an account the reader can't see.
 */
export function scopedSetAside(v: SetAsideView, entityIds: readonly EntityId[] | null, startedOn: IsoDate, asOf: IsoDate): SetAsideView {
  const perAccount = entityIds ? v.perAccount.filter((p) => p.entityId !== null && entityIds.includes(p.entityId)) : v.perAccount
  const held = { minor: perAccount.reduce((t, p) => t + p.heldBase.minor, 0), currency: v.held.currency }
  const out: SetAsideView = { ...v, perAccount, held }
  if (v.goal) {
    const day = (d: IsoDate) => Date.parse(`${d}T00:00:00Z`)
    const progressPercent = Math.min(100, Math.floor((held.minor / v.goal.target.minor) * 100))
    const { onPace: _old, ...goal } = v.goal
    out.goal = { ...goal, progressPercent }
    if (v.goal.by && v.goal.by > startedOn) out.goal.onPace = held.minor >= Math.floor(v.goal.target.minor * Math.min(1, Math.max(0, (day(asOf) - day(startedOn)) / (day(v.goal.by) - day(startedOn)))))
  }
  return out
}

/** One plain sentence for tools and screens, so nobody is told to subtract by hand. */
export function setAsideSentence(v: Pick<SetAsideView, 'countsInCash'>): string {
  return v.countsInCash ? 'This still counts in cash: nothing is subtracted.' : "Already left out of available_cash and the overview, so don't subtract it by hand. The cash figure stays the bank's total."
}

export interface BucketView {
  id: Id
  entityId: EntityId
  name: string
  fields: Array<{ key: string; label: string; type: 'text' | 'number' | 'money' | 'date' | 'boolean' }>
  values: Record<string, unknown>
  schedule: { amount: Money; cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'; dueDay?: number; endDate?: IsoDate } | null
  rules: Array<{ id: Id; description: string }>
  status: { paid: number; upcoming: number; missed: number }
  payments?: Array<{ date: IsoDate; amount: Money; state: 'paid' | 'upcoming' | 'missed'; txnId?: Id }>
  setAside?: SetAsideView
  /** Day the bucket was made: where a goal's straight line starts. */
  createdOn?: IsoDate
  addedBy: AddedBy
}

export interface CapTableView {
  entityId: EntityId
  asOf: IsoDate
  fullyDilutedShares: number
  holders: Array<{ name: string; class: string; shares: number; fullyDilutedPct: number }>
  classes: Array<{ name: string; authorized: number | null; issued: number }>
  safesAndNotes: Array<{ holder: string; kind: 'safe' | 'convertible_note'; amount: Money; cap?: Money; discountPct?: number; /** In homeCurrency; null when there's no FX rate. */ amountHome?: Money | null }>
  optionPool: { size: number; granted: number; available: number } | null
  last409a: { date: IsoDate; pricePerShare: Money } | null
  /** The company's own currency (totals are in it). */
  homeCurrency?: string
  /** RSUs: granted, vested so far, released (settled into shares) and still outstanding. */
  rsus?: { granted: number; vested: number; released: number; outstanding: number }
  /** Live and expired warrants; `shares` is what's left to exercise. */
  warrants?: Array<{ holder: string; class: string; shares: number; exercisePrice: Money | null; expires: IsoDate | null; expired: boolean }>
}

export interface PayrollView {
  entityId: EntityId
  runs: Array<{ id: Id; payDate: IsoDate; gross: Money; employerTaxes: Money; net: Money; employerCost: Money; estimated: boolean }>
  nextRun: { date: IsoDate; estimate: Money } | null
  headcount: number | null
  contractors: number | null
  /** Only filled when per-person detail is allowed. */
  people?: Array<{ person: string; kind: 'employee' | 'contractor'; gross: Money; net: Money }>
}

export interface ReviewItemView {
  id: Id
  /** Null for "which company?" items: the account has no company yet. */
  entityId: EntityId | null
  /** The account a "which company?" item asks about. */
  accountId?: Id
  kind: 'agent_write' | 'suggested_match' | 'possible_duplicate' | 'suggested_rule' | 'whose_money' | 'unread_document' | 'suspicious_text' | 'which_company' | 'underfunded_set_aside'
  title: string
  detail?: string
  createdAt: IsoTimestamp
  recordIds: Id[]
  /** Allowed resolutions for resolve_review_item. */
  options: Array<'confirm' | 'reject' | 'edit'>
  /** The plain question ("Did you move $500 from Capital One to Ally on Oct 22?"). Falls back to title. */
  question?: string
  /** The names from outside that question quotes; the rest of it is our own words. */
  questionNames?: string[]
  /** What Confirm does, in words: "Confirm: a card payment", or "Yes" where the question says it. Present wherever 'confirm' is an option. */
  confirmLabel?: string
  /** "No" where the question is a yes-or-no one. */
  rejectLabel?: string
  /** Other matches for the same money, behind this one, best first. Each resolves by its own id. */
  alternatives?: ReviewItemView[]
  /** Items that can be confirmed together; label is the plural line ("5 moves between your own accounts"). */
  group?: { key: string; label: string }
  /** For items with no single proposal ("What is this money?"): the answers that can apply, each resolved as an edit. */
  choices?: Array<{ label: string; edits: Record<string, string> }>
  /** "Which company?" items: what the provider's account type suggests (never applied without a person), and the connection it came with, so several can be answered at once. */
  suggested?: EntityId | 'personal'
  connectionId?: Id
}

/** Any item with this id: a card, or one of the alternatives behind a card. */
export function findReviewItem<T extends { id: string; alternatives?: T[] }>(items: readonly T[], id: string): T | undefined {
  for (const i of items) {
    if (i.id === id) return i
    const alt = i.alternatives?.find((a) => a.id === id)
    if (alt) return alt
  }
  return undefined
}

export interface DocumentView {
  id: Id
  entityId: EntityId
  fileName: string
  mimeType: string
  sizeBytes: number
  sha256: string
  receivedAt: IsoTimestamp
  via: 'upload' | 'email' | 'agent'
  status: 'unread' | 'recorded' | 'ignored'
  injectionSuspected: boolean
  /** Extracted text (CSV/OFX parsed, PDF text layer). Third-party content. */
  text?: string
  /** A PDF with no text layer (a scan or a photo saved as PDF): there is nothing to read as text. */
  scanned?: boolean
  /** A PDF longer than Aggregate reads (60 pages or 60,000 characters): text holds only its first part. */
  partial?: boolean
  recordIds: Id[]
}

export interface ReportView {
  kind: 'profit_and_loss' | 'balance_sheet' | 'cash_flow'
  entityId: EntityId
  from: IsoDate
  to: IsoDate
  basis: 'cash' | 'accrual'
  currency: string
  /** `role`: the ledger role behind a row (e.g. payroll_expense), so readers can withhold what a grant can't see. */
  sections: Array<{ name: string; rows: Array<{ account: string; amount: Money; role?: string }>; total: Money }>
  total: Money
  /** Set when nothing posted for this basis and period, with why (so readers say "no data", not a page of zeros). */
  noData?: string
}

// ---------- The read port ----------

export interface FinanceReader {
  /** Every entity in the workspace (S7 filters by person and grant). */
  entities(workspaceId: WorkspaceId): Promise<EntityInfo[]>
  /** Which data types have any rows for these entities. Drives "a tool is listed only if data exists". */
  dataAvailability(scope: ReadScope): Promise<DataType[]>
  sources(scope: ReadScope): Promise<SourceStatus[]>
  overview(scope: ReadScope, asOf?: IsoTimestamp): Promise<Overview>
  metric(name: MetricName, scope: MetricScope): Promise<MetricAnswer>
  accounts(scope: ReadScope, filter: AccountFilter): Promise<AccountView[]>
  searchTransactions(scope: ReadScope, q: TxnQuery): Promise<TxnSearchResult>
  searchInvoices(scope: ReadScope, q: InvoiceQuery): Promise<InvoiceSearchResult>
  getRecord(workspaceId: WorkspaceId, id: Id): Promise<RecordView | null>
  counterparty(scope: ReadScope, nameOrId: string): Promise<CounterpartyView | null>
  upcoming(scope: ReadScope, days: number, kinds?: UpcomingItem['kind'][]): Promise<UpcomingItem[]>
  /** Recurring bills and subscriptions (optional: readers without it answer "unavailable"). */
  recurring?(scope: ReadScope, opts: { asOf?: IsoDate; status?: RecurringView['status'][] }): Promise<RecurringView[]>
  /** Card and loan terms: APR, minimum payment, next due date (optional; gated by 'balances'). */
  liabilities?(scope: ReadScope): Promise<LiabilityView[]>
  /** Investment positions, latest snapshot on or before `asOf` (optional; gated by 'balances'). */
  holdings?(scope: ReadScope, opts?: { accountId?: AccountId; asOf?: IsoDate }): Promise<HoldingView[]>
  ownerBalances(scope: ReadScope, personId: PersonId): Promise<OwnerBalanceView[]>
  buckets(scope: ReadScope): Promise<BucketView[]>
  bucket(workspaceId: WorkspaceId, id: Id): Promise<BucketView | null>
  capTable(scope: ReadScope): Promise<CapTableView[]>
  payroll(scope: ReadScope, opts: { from?: IsoDate; to?: IsoDate; people: boolean }): Promise<PayrollView[]>
  reviewItems(scope: ReadScope, kinds?: ReviewItemView['kind'][]): Promise<ReviewItemView[]>
  /** What was filed for the person, newest first (undo with resolve_review_item on "filed:<id>"). */
  filedItems?(scope: ReadScope): Promise<Array<{ id: string; entityId: EntityId | null; text: string; filedAt: IsoTimestamp }>>
  documents(scope: ReadScope, status?: DocumentView['status']): Promise<DocumentView[]>
  document(workspaceId: WorkspaceId, id: Id): Promise<DocumentView | null>
  reports(scope: ReadScope, kind: ReportView['kind'], from: IsoDate, to: IsoDate, basis: 'cash' | 'accrual'): Promise<ReportView[]>
  /** Per account and month, did we get the history? Months are 'YYYY-MM' (optional: readers without it answer "unavailable"). */
  coverage?(scope: ReadScope, from?: string, to?: string): Promise<CoverageView[]>
  /** Books closed through a date, per company (none: open). Changes to a closed period post on the next day. */
  periodLocks?(scope: ReadScope): Promise<PeriodLockView[]>
  /** MRR movements month by month, 'YYYY-MM' to 'YYYY-MM' (subscription data: gate as 'transactions', like mrr). */
  mrrMovements?(scope: ReadScope, from: string, to: string): Promise<MrrMovementView[]>
  /** Investment positions per company, as of a day (default today). Gate as 'equity'. */
  investments?(scope: ReadScope, asOf?: IsoDate): Promise<InvestmentView[]>
  /** Totals per company and currency over investments() (gate as 'equity'). */
  investmentTotals?(scope: ReadScope, asOf?: IsoDate): Promise<InvestmentTotals[]>
}

/** One month of MRR movements, counted per customer: start + new + expansion + reactivation − contraction − churn = end. */
export interface MrrMovementView {
  /** 'YYYY-MM' */
  month: string
  start: Money
  new: Money
  expansion: Money
  reactivation: Money
  contraction: Money
  churn: Money
  end: Money
  customersStart: number
  customersEnd: number
  newCustomers: number
  churnedCustomers: number
  /** (churn + contraction) / start; null when the month started at zero. */
  revenueChurnRate: number | null
  /** Customers lost / customers at the start; null when there were none. */
  customerChurnRate: number | null
  /** The products MRR at the month's end is made of, as MetricAnswer.products (with productsMore). */
  products?: string[]
  productsMore?: number
}

export interface PeriodLockView {
  entityId: EntityId
  /** The last closed day. */
  through: IsoDate
  note: string | null
  createdAt: IsoTimestamp
}

export interface CoverageView {
  accountId: AccountId
  entityId: EntityId
  name: string
  mask: string | null
  months: Array<{
    month: string
    /** missing: no rows where some were expected, or no statement uploaded; mismatched: balances and rows disagree. */
    status: 'covered' | 'missing' | 'mismatched' | 'in_progress' | 'not_expected'
    rows: number
    detail?: string
  }>
  /** One plain line per gap or mismatch, e.g. "Chase ··4411: August statement missing". */
  problems: string[]
  /** The exact day this account has data through (balance/statement as-of, else last transaction date), not the month. */
  dataThrough?: IsoDate
}

// ---------- The write port ----------

/** Who and what is behind a write, stored on every record it creates (MASTER §9 provenance). */
export interface Provenance {
  writeRequestId: Id
  actorKind: 'person' | 'agent' | 'system'
  personId?: PersonId
  grantId?: Id
  /** "Claude · Yisrael", shown as "added by …". */
  label: string
  reason?: string
  fileSha256?: string
  sourceDocumentId?: Id
}

export type WriteOp =
  | 'add_entry'
  | 'add_invoice'
  | 'record_payment'
  | 'create_bucket'
  | 'update_bucket'
  | 'create_rule'
  | 'update_record'
  | 'record_equity_event'
  /**
   * An investment the company holds (InvestmentEvent): payload { event: Omit<InvestmentEvent, 'type' | 'externalId' |
   * 'connectionId' | 'rawRef'> with positionId optional for invest (a new position), bankTransactionId? }. Fields left
   * out of a later event (issuer, securityType) come from its position.
   */
  | 'record_investment'
  | 'resolve_review_item'
  | 'void_record'
  /** "This account held X on date D" (a statement, a person, an AI). Never posts; checked against the ledger. */
  | 'pin_balance'
  /**
   * Close a company's books through a date / reopen them. Consequential: an AI's request is always held for a
   * person's approval, whatever the grant's review mode. People (managers) do it directly in the app.
   */
  | 'close_period'
  | 'reopen_period'

/** Payloads are the validated, normalized tool inputs (money already in minor units, company resolved to entityId). */
export interface WriteCommand {
  op: WriteOp
  workspaceId: WorkspaceId
  entityId: EntityId
  payload: Record<string, unknown>
}

export interface AppliedWrite {
  recordId: Id
  recordType: RecordType
  /** Net change to cash per entity caused by this write (for the "> 10% of cash" alert). */
  cashImpact: Array<{ entityId: EntityId; amount: Money }>
  suggestedLinks: LinkProposal[]
  /** Possible duplicates the writer found (it still applied the write). */
  possibleDuplicates: Id[]
  summary: string
  /** record_investment: the position the event belongs to (minted for a new one). */
  positionId?: string
  /** pin_balance: the pinned balance against the ledger on that day (cards and loans as amounts owed, positive). */
  balanceCheck?: { matches: boolean; stated: Money; ledger: Money; difference: Money }
}

export interface RecordWriter {
  /** Apply a validated command. Must be atomic. Throws WriteRejected for business-rule failures. */
  apply(cmd: WriteCommand, provenance: Provenance): Promise<AppliedWrite>
  /**
   * Optional dry run: what apply would record (summary, cash effect, duplicates, links) with nothing kept. Throws
   * WriteRejected exactly as apply would. Writers without it still get a dry run of every check before the ledger.
   */
  preview?(cmd: WriteCommand, provenance: Provenance): Promise<AppliedWrite>
  /** Optional: refusals to give at submit, before a write is held. Throws WriteRejected. */
  precheck?(cmd: WriteCommand): Promise<void>
  /** Undo a write this pipeline applied (soft: records are voided, never deleted; links unwound). */
  revert(workspaceId: WorkspaceId, recordId: Id, provenance: Provenance): Promise<void>
}

/** Business-rule rejection from the writer (unknown invoice, overpayment, synced field edit…). Message is shown to the AI. */
export class WriteRejected extends Error {
  override name = 'WriteRejected'
  readonly code: string
  constructor(message: string, code = 'rejected') {
    super(message)
    this.code = code
  }
}

// ---------- Helpers ----------

export function toWire(m: Money, exponent = 2): MoneyWire {
  const neg = m.minor < 0
  const abs = Math.abs(m.minor)
  // Per-share prices are kept to 1/100 of a minor unit (a $0.6522 warrant is minor 65.22): up to two more decimals.
  if (!Number.isInteger(abs)) {
    const scaled = Math.round(abs * 100)
    const unit = 10 ** (exponent + 2)
    let frac = String(scaled % unit).padStart(exponent + 2, '0')
    while (frac.length > exponent && frac.endsWith('0')) frac = frac.slice(0, -1) // 0.6500 → 0.65, 0.0125 stays
    return { amount: `${neg ? '-' : ''}${Math.floor(scaled / unit)}${frac ? '.' + frac : ''}`, currency: m.currency }
  }
  const unit = 10 ** exponent
  const whole = Math.floor(abs / unit)
  const frac = exponent > 0 ? '.' + String(abs % unit).padStart(exponent, '0') : ''
  return { amount: `${neg ? '-' : ''}${whole}${frac}`, currency: m.currency }
}

/**
 * The AI-provider disclosure (Intuit's 10-27 guidance: say plainly that the customer's chosen AI gets their data). The
 * consent page shows `text` with {client} filled in; every connect drawer shows `connectText`. Grants record `version`
 * (and a hash of the text), so change the words only together with a new version.
 */
export const AI_DISCLOSURE = {
  version: '2026-10-27',
  text: 'Your financial data will be sent to {client} and handled under that provider’s terms. Aggregate never trains on it.',
  connectText: 'Data from here goes only to the AI assistants you connect, under each provider’s terms. Aggregate never trains on it.',
  /** Settings → "A key for a bot": no client is known yet, so the key's holder. */
  keyText: 'Your financial data will be sent to whichever AI or bot uses this key, and handled under that provider’s terms. Aggregate never trains on it.',
} as const

/** The consent page's line for one AI client. */
export const aiDisclosure = (client: string): string => AI_DISCLOSURE.text.replace('{client}', client)
