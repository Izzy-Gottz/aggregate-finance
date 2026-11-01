// The web app's view of the server. Every screen reads and writes only through `AgfnApi`.
// Two implementations: `MockApi` (in-memory demo workspace, used until S0/S7 routes land, and for tests/screenshots)
// and `HttpApi` (REST under /api, see ROUTES in http.ts). Types reuse @agfn/contracts wherever one exists.

import type { EquityDetail } from '@agfn/equity/math'
import type {
  ConnectorDescription,
  DataType,
  EntityId,
  EntityKind,
  GrantId,
  GrantShape,
  Id,
  IsoDate,
  IsoTimestamp,
  MetricAnswer,
  Money,
  WriteResult,
} from '@agfn/contracts'

/**
 * Self-hosting: a connector that needs the server's own developer app (QuickBooks, Xero, Plaid…) says how to set it up.
 * `configured: false` means its keys aren't on this server yet; the UI shows the steps instead of a Connect button.
 */
export interface ConnectorSetup {
  configured: boolean
  kind: 'app' | 'key' | 'none'
  register?: { name: string; url: string }
  /** The exact redirect URL for this server, to paste into the provider's app settings. */
  redirectUri?: string
  /** Environment variable names the keys go in, e.g. QUICKBOOKS_CLIENT_ID. */
  env?: string[]
  /** 3–5 plain sentences, the same ones the docs use. */
  steps?: string[]
  docsUrl?: string
}
export type Connector = ConnectorDescription & {
  setup?: ConnectorSetup
  /** Built to the provider's documentation but not yet tried with a real account: shown with a "Beta" chip. */
  beta?: boolean
}
/** Shown as "Needs your own … app" with setup steps, never as a Connect button that can't work. */
export const needsSetup = (c: Connector): boolean => c.setup?.configured === false && c.setup.kind === 'app'

// ---------- People and workspace ----------

export interface Me {
  personId: Id
  name: string
  email: string
  workspaceId: Id
  /** The one link people paste into their AI. */
  mcpUrl: string
  /** True when the server runs on the person's own machine (no public URL for claude.ai / ChatGPT). */
  selfHosted: boolean
  /** Demo workspace (self-host first run, before real keys). */
  demo: boolean
  /** With demo: false while the made-up data is still filling in. */
  demoReady?: boolean
  /** With demo, while it waits for a fill slot (hosted fills one demo at a time): its place in line (1 = next) and about how long. */
  demoQueue?: { position: number; minutes: number }
  /** Directory reviewers: a resettable demo where account, people, connection and sign-in changes are refused. */
  reviewerDemo?: boolean
  /** The no-sign-up web demo (app.aggregate.finance/demo): read-only, no account. */
  publicDemo?: boolean
  /** The no-sign-up demo's AI link, where this server offers it: onboarding's "try it on the demo books first". */
  demoMcpUrl?: string
  /** Investment positions are served here (AGFN_INVESTMENTS): the company drawer offers "Investments". */
  investments?: boolean
  /** A creator-link signup's perk, e.g. { label: '3 months free' }. */
  perk?: { label: string }
  /** Free time on this workspace, every grant in one line (YC Deal, creator link, a date): "12 months free (YC Deal)". */
  freeGrant?: { label: string }
  /** "Verified by Aggregate" badges are on for this server (AGFN_BADGES). */
  badges?: boolean
  /** A Shopify App Store install arrived while signed out: finish it with a full-page visit to the resume URL. */
  pendingInstall?: 'shopify'
  /** Sign-in methods this server offers (Apple/Google only when configured). */
  signInMethods?: SignInMethod[]
  /** Signed in but no workspace yet: onboarding creates it with the first company. Workspace routes return 409 until then. */
  needsOnboarding?: boolean
  /** Every workspace this person belongs to; more than one shows a switcher. */
  workspaces?: Array<{ id: Id; name: string; role?: string }>
}

export interface EntitySummary {
  id: EntityId
  kind: EntityKind
  name: string
  currency: string
  /** Null when there is no cash data yet. */
  cash: Money | null
  /** unknown: no honest total (cash is null); stale: the total leans on old balances. `reason` says which and why. */
  cashCaveat?: { state: 'unknown' | 'stale'; reason: string }
  /** Personal shows "private" on the overview; the amount appears only inside its drawer. */
  hidden: boolean
}

export type ConnectionStatus = 'ok' | 'syncing' | 'needs_reauth' | 'error' | 'paused'

export interface ConnectionSummary {
  id: Id
  connectorKey: string
  /** "Chase", "Stripe". */
  name: string
  /** Companies this connection feeds, by name. */
  entityNames: string[]
  status: ConnectionStatus
  lastSyncAt: IsoTimestamp | null
  accountCount: number
  message?: string
  /** Accounts that still need "which company?"; their transactions wait until then. */
  needsCompany?: number
  /** Still syncing, but act soon: `message` says what ("reconnect within 7 days", "new accounts… choose which"). */
  attention?: Array<'reconnect_soon' | 'new_accounts'>
}

/** live: a fresh check ran. Not live: capped (15-minute cooldown or the workspace's daily cap); `message` says when. */
export type BalanceRefresh =
  | { ok: true; live: true; at: IsoTimestamp }
  | { ok: true; live: false; reason: 'cooldown' | 'daily_cap'; refreshedAt: IsoTimestamp | null; retryAt: IsoTimestamp; message: string }

export type ReconnectStart = { kind: 'plaid_link'; linkToken: string; state: string; connectionId: Id } | { kind: 'connect'; connectorKey: string }

export interface AiSummary {
  grantId: GrantId
  /** "Claude", "ChatGPT", "Cursor", or the name given to a key. */
  client: string
  personName: string
  shape: GrantShape
  lastUsedAt: IsoTimestamp | null
  paused: boolean
}

export interface InboundAddress {
  entityId: EntityId
  address: string
}

export interface Workspace {
  me: Me
  entities: EntitySummary[]
  connections: ConnectionSummary[]
  /** Connectors offered as one-click rows under Connections (not yet connected). */
  suggested: ConnectorDescription[]
  ais: AiSummary[]
  aiPaused: boolean
  inbound: InboundAddress[]
  /** Items waiting in Review. The nav shows Review only when > 0 or review mode is on. */
  reviewCount: number
  reviewModeOn: boolean
  /** One grey line under Money (S1 data health). null when there is nothing to check yet. */
  health?: WorkspaceHealth | null
}

export interface WorkspaceHealth {
  status: 'ok' | 'needs_review'
  /** "All reconciled" or "3 things need a look: 2 to review, 1 balance doesn't match". */
  line: string
  /** Up to 10, most important first. */
  items: Array<{ kind: 'failed_check' | 'review' | 'in_transit' | 'unexplained' | 'stale_source' | 'missing_statement'; entityId: string | null; text: string; refId: string | null }>
}

// ---------- Company drawer ----------

/** A number that can explain itself: value + the contract's MetricAnswer + the rows behind it. */
export interface Explained {
  label: string
  answer: MetricAnswer
  rows: Array<{ id: Id; label: string; detail?: string; amount: Money }>
}

export interface AccountTerms {
  kind: 'credit' | 'mortgage' | 'student' | 'other'
  /** Percent as a decimal string, e.g. "24.9". */
  apr?: string
  minimumPayment?: Money
  nextPaymentDueDate?: IsoDate
}

export interface AccountRow {
  id: Id
  name: string
  institution: string
  mask?: string
  kind: 'bank' | 'card' | 'payments' | 'cash' | 'loan' | 'investment' | 'crypto'
  /** null: the provider has never reported one (shown as unknown, never $0). */
  balance: Money | null
  asOf: IsoTimestamp
  stale: boolean
  addedBy?: string
  /** The company (or Personal) it counts toward; sent with a connection's accounts. */
  entityId?: Id
  /** Card or loan terms from the provider (Plaid Liabilities); absent when there are none. */
  terms?: AccountTerms
}

export interface InvoiceRow {
  id: Id
  counterparty: string
  number?: string
  total: Money
  open: Money
  dueDate: IsoDate
  source: string
}

export interface BillRow {
  id: Id
  name: string
  amount: Money
  dueDate: IsoDate
  detail: string
}

export interface BucketSummary {
  id: Id
  name: string
  /** One grey line, e.g. "$2,980 monthly · next Nov 1". */
  line: string
  status: 'ok' | 'upcoming' | 'missed'
}

export interface PayrollSummary {
  nextRun?: { date: IsoDate; amount: Money; provider: string }
  /** payroll_cost for its default period: the last calendar month (workspace-local), named so the label says it. */
  lastMonth: { month: string; amount: Money | null }
  headcount: { employees: number; contractors: number }
  runs: Array<{ id: Id; date: IsoDate; gross: Money; net: Money; provider: string }>
}

export interface EquitySummary {
  fullyDilutedShares: number
  holders: Array<{ name: string; role: string; percent: number }>
  convertibles: Array<{ id: Id; investor: string; kind: 'SAFE' | 'Note'; amount: Money; cap?: Money; discountPct?: number; date: IsoDate }>
}

export interface WhoseMoneyRow {
  id: Id
  /** "Acme owes you", "You owe Acme", "Acme owes Bluebird Studio". */
  label: string
  amount: Money
  detail: string
}

export interface OddRow {
  id: Id
  label: string
  detail: string
  tone: 'red' | 'amber' | 'grey'
  /** The records behind it (S1 anomalies); the row opens them. */
  recordIds?: Id[]
}

export interface CompanyDetail {
  entity: EntitySummary
  asOf: IsoTimestamp
  cash: Explained | null
  runway: { months: number | null; state: MetricAnswer['state']; explained: Explained } | null
  /** 12 monthly cash points, oldest first. One sparkline per company, max. */
  trend: number[]
  accounts: AccountRow[]
  owedToYou: { total: Money; overdue: Money; aging: Array<{ label: string; amount: Money }>; invoices: InvoiceRow[] } | null
  bills: { dueSoon: Money; rows: BillRow[] } | null
  buckets: BucketSummary[]
  payroll: PayrollSummary | null
  equity: EquitySummary | null
  whoseMoney: WhoseMoneyRow[]
  odd: OddRow[]
  hasTransactions: boolean
  /** Books closed through this day (changes to it post on the next open day). */
  periodLock?: { through: IsoDate; note: string | null } | null
  /** Owners and admins may close or reopen. */
  canClosePeriod?: boolean
  /** Owners only: null when it can be deleted, else why not ("Disconnect QuickBooks first."). */
  deleteBlocked?: string | null
  /** Recurring revenue, only for companies with subscriptions. Each part has a value, or why it isn't known. */
  mrr?: { value: Money; month: string; netNew: { value?: Money; reason?: string } | null; churn: { value?: number; reason?: string } | null } | null
  /** Brokerage positions (Personal, mostly), newest snapshot per account. Absent or empty: no section. */
  holdings?: HoldingRow[] | null
  /** The holdings' value per currency, from the server (never added across currencies). */
  holdingsTotal?: Money[]
}

export interface HoldingRow {
  id: Id
  /** Ticker when there is one, else the security name. */
  name: string
  detail: string
  /** Units, as a decimal string (fractional shares). */
  quantity: string
  value: Money
  account: string
}

export type { MrrMovementView } from '@agfn/contracts'

export interface TxnRow {
  id: Id
  date: IsoDate
  description: string
  amount: Money
  account: string
  detail: string
  addedBy?: string
  kind?: 'transfer' | 'normal'
}

// ---------- Buckets ----------

export type FieldType = 'text' | 'money' | 'date' | 'number'

export interface BucketField {
  key: string
  label: string
  type: FieldType
  value: string
}

export interface BucketDetail {
  id: Id
  entityId: EntityId
  name: string
  fields: BucketField[]
  schedule: { amount: Money; cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'; dueDay: number; endDate: IsoDate | null } | null
  rules: Array<{ id: Id; text: string }>
  payments: Array<{ id: Id; date: IsoDate; amount: Money; status: 'paid' | 'upcoming' | 'missed'; detail: string }>
  createdBy: { name: string; isAi: boolean; at: IsoTimestamp }
  undoUntil: IsoTimestamp | null
}

// ---------- Connect your AI ----------

export interface AiActivity {
  id: Id
  grantId: GrantId
  client: string
  at: IsoTimestamp
  kind: 'read' | 'write' | 'blocked'
  /** "asked for cash by company". Plain words, amounts allowed (UI only; the audit log redacts). */
  summary: string
  result: string
  recordId?: Id
  status?: 'applied' | 'pending_review' | 'undone' | 'rejected'
  undoUntil?: IsoTimestamp
}

export interface AiDetail extends AiSummary {
  connectedAt: IsoTimestamp
  via: string
  activity: AiActivity[]
}

export interface ConsentInfo {
  /** "Claude", "ChatGPT", from the OAuth client registration. */
  clientName: string
  /** Proposed grant: the person's defaults, narrowed to the requested scope. */
  shape: GrantShape
  /** What the person themselves can reach; the AI can't be given more. */
  allowedEntityIds: EntityId[] | 'all'
}

export type AiClient = 'claude' | 'chatgpt' | 'cursor' | 'claude_code' | 'other'

// ---------- Review ----------

export type ReviewKind = 'ai_write' | 'match' | 'duplicate' | 'rule' | 'whose_money' | 'document'

export interface ReviewItem {
  id: Id
  kind: ReviewKind
  title: string
  detail: string
  entityName: string
  amount?: Money
  createdAt: IsoTimestamp
  /** Labels for the two actions. Defaults: Confirm / Reject. */
  confirmLabel?: string
  rejectLabel?: string
  /** Editable fields when the person presses E. */
  editable?: Array<{ key: string; label: string; value: string }>
  /** Items with no single proposal ("What is this money?"): one button per answer, each resolved as an edit. */
  answers?: Array<{ label: string; values: Record<string, string> }>
  /** "Which company?" items the server can answer together: same connection, same suggested answer. */
  batch?: { key: string; label: string; values: Record<string, string> }
}

export type ReviewDecision = { action: 'confirm' } | { action: 'reject' } | { action: 'edit'; values: Record<string, string> }

// ---------- Preferences ----------

export type RolePreset = 'owner' | 'admin' | 'finance' | 'accountant' | 'investor' | 'employee'

export interface PersonRow {
  id: Id
  name: string
  email: string
  role: RolePreset
  entityIds: EntityId[] | 'all'
  /** Full grid, one tap down from the preset. */
  grid: Record<DataType, 'none' | 'view' | 'add'>
  pending: boolean
}

export interface Preferences {
  signIn: {
    passkeys: Array<{ id: Id; name: string; addedAt: IsoTimestamp }>
    apple: boolean
    google: boolean
    email: string
    /** No "confirm it's you" step on this server (the challenge app): connect without a passkey or email link. */
    noRecheck?: boolean
  }
  companies: Array<{ id: EntityId; name: string; currency: string; fiscalYearStartMonth: number }>
  aiReviewMode: boolean
  notifications: { mondayEmail: boolean; blockedAsk: boolean }
  /** The workspace's IANA time zone: which day a balance belongs to, when the Monday note goes out. Owners and admins change it. */
  timeZone?: string
  people: PersonRow[]
  /** Leaving is allowed: false for the workspace's only owner (they make someone else owner first, or delete it). */
  canLeave?: boolean
  /** Only shown on self-host. */
  recovery: { applicable: boolean; savedAt: IsoTimestamp | null }
  theme: 'system' | 'light' | 'dark'
}

// ---------- Onboarding and adding ----------

/** 'reviewer': an app directory reviewer's access code (only while reviewer links are on). */
export type SignInMethod = 'passkey' | 'apple' | 'google' | 'github' | 'email' | 'reviewer'

/** One input in a connector's paste form (S2/S3). Absent `fields` = a single `apiKey` input. */
export interface ConnectField {
  name: string
  label: string
  placeholder?: string
  /** Password-style input. */
  secret?: boolean
  multiline?: boolean
  optional?: boolean
  /** A select; the first option is the default. */
  options?: string[]
}

/** `state` is single-use (30 min) and goes back in the finish body. */
export type ConnectStart = { state: string } & (
  | { kind: 'plaid_link'; linkToken: string }
  | { kind: 'oauth'; url: string }
  | { kind: 'api_key'; label: string; helpUrl: string; placeholder: string; fields?: ConnectField[]; /** Numbered steps to make the key. */ steps?: string[]; /** The least it needs, all read-only. */ permissions?: string[] }
  | { kind: 'upload'; accept: string }
)

export interface NewAccount {
  id: Id
  name: string
  mask?: string
  /** The provider's latest balance; null when it sent none. */
  balance: Money | null
  suggestedEntityId: EntityId | 'personal' | null
}

export interface CashEntry {
  entityId: EntityId
  direction: 'in' | 'out'
  amount: Money
  date: IsoDate
  counterparty: string
  note?: string
  /** Whose money: the company's own cash, or the person paid personally. */
  paidBy: 'company' | 'me'
}

export interface InboundSettings {
  address: string
  /** Legacy: the extra list. */
  allowedSenders: string[]
  /** Everyone who can add documents to this company, by sign-in email: always allowed. */
  members?: Array<{ personId: Id; name: string; email: string }>
  /** Extra senders: exact addresses or @domains. */
  extra?: string[]
  /** The last few refused emails, newest first (sender not allowed, or a forgery check failed). */
  recentRefused?: Array<{ at: IsoTimestamp; from: string; reason: string }>
}

export interface UnreadDocument {
  documentId: Id
  name: string
  entityId: EntityId
  arrivedVia: 'email' | 'upload' | 'agent' | 'import'
  createdAt: IsoTimestamp
  mimeType?: string
  sizeBytes?: number
}

export interface WaitingStatement {
  documentId: Id
  name: string
  entityId: EntityId
  arrivedVia?: string
  createdAt: IsoTimestamp
  accounts: Array<{ id: Id; name: string; mask?: string; institution?: string }>
}

export interface UploadResult {
  documentId: Id
  name: string
  /** CSV/OFX parse right away; PDFs and photos wait as unread documents for your AI. A CSV for a company that already
   * has accounts waits for "which account is this statement for?" (nothing imported until answered). */
  state: 'imported' | 'unread' | 'needs_account' | 'needs_mapping'
  message: string
  /** With needs_account: the company's accounts to choose from. */
  accounts?: Array<{ id: Id; name: string; mask?: string; institution?: string }>
  /** With needs_mapping: one question about an unfamiliar CSV (known bank exports never ask). */
  question?: MappingQuestion
}

/** "Which column is the date?" and friends, asked one at a time, with a small preview of the file. */
export interface MappingQuestion {
  field: 'date' | 'amount' | 'dateFormat' | 'sign'
  text: string
  options: Array<{ value: string; label: string }>
  headers: string[]
  sample: string[][]
}

/** What answering a question returns: the next question, "which account?", or done. */
export type MappingReply = Pick<UploadResult, 'state' | 'message' | 'question' | 'accounts'>

// ---------- Equity ----------

export type { EquityDetail } from '@agfn/equity/math'

export interface EquityWritePayloadInput {
  kind: 'issuance' | 'safe' | 'convertible_note' | 'option_grant' | 'exercise' | 'transfer' | 'cancellation'
  date: IsoDate
  stakeholder: string
  shares?: number | null
  shareClass?: string | null
  amount?: Money | null
  pricePerShare?: Money | null
  valuationCap?: Money | null
  discountPct?: number | null
  interestPct?: number | null
  vesting?: { start: IsoDate; months: number; cliffMonths: number } | null
  toStakeholder?: string | null
  /** option_grant, exercise, cancellation: which kind of grant ('rsu', 'warrant'; left out = stock options). */
  grantType?: 'iso' | 'nso' | 'rsu' | 'warrant' | null
  /** Warrants: when it lapses. */
  expirationDate?: IsoDate | null
  /** Warrant exercise paid in shares instead of cash. */
  netExercise?: boolean | null
  fairValuePerShare?: Money | null
  /** RSU release: units kept back for tax. */
  withheldShares?: number | null
}

export interface EquityWriteResult {
  /** 'pending_review' when AI review mode holds UI writes too; 'duplicate' when the same request was already recorded. */
  status?: 'applied' | 'pending_review' | 'duplicate'
  /** Absent while waiting for review. */
  recordId?: Id
  summary: string
  possibleDuplicates: Id[]
}

export interface EquityImportResult {
  writeId: Id | null
  added: number
  notes: string[]
  warnings: string[]
}

// ---------- The client ----------

/** Share cards (apps/server/src/routes/share.ts). */
export type ShareKind = 'runway' | 'cash_trend' | 'roast' | 'hype' | 'badge'
/** A badge's figures (each off unless turned on). */
export type BadgeField = 'mrr' | 'growth' | 'runway'
/** What a card or badge shows beyond ratios; each off unless turned on. */
export interface ShareOpts {
  amounts: boolean
  name: boolean
  vendors?: boolean
  fields?: BadgeField[]
}
/** The preview: the card's words. */
export interface SharePreview {
  words: { big: string; line: string; alt: string }
}
export interface ShareCard {
  id: string
  kind: ShareKind
  entityId: string
  company: string
  status: 'draft' | 'live'
  /** "app", or the AI that drafted it. */
  source: string
  url: string | null
  createdAt: string
  publishedAt: string | null
}

export interface AgfnApi {
  // session
  me(): Promise<Me | null>
  /** ok + next:'check_email' means a magic link was sent; 'redirect' means the browser is leaving for Apple/Google. */
  signIn(method: SignInMethod, email?: string): Promise<{ ok: true; next?: 'check_email' | 'redirect' } | { ok: false; message: string }>
  signOut(): Promise<void>

  // OAuth consent for "Connect your AI" (#/connect-ai/consent?consent_code=…&client_id=…&scope=…)
  /** Defaults for the consent sentence (computed in the client from the workspace and the OAuth query). */
  consentInfo(params: { clientId: string; clientName?: string; scope: string }): Promise<ConsentInfo>
  /** Creates the grant, then continues the OAuth flow; returns where to send the browser (null in the demo). */
  consent(input: { clientId: string; clientName: string; shape: GrantShape; oauthQuery: string }): Promise<{ redirectTo: string | null }>
  /** "Don't allow": no grant; the AI app hears access_denied. */
  decline(input: { oauthQuery: string }): Promise<{ redirectTo: string | null }>

  // workspace
  workspace(): Promise<Workspace>
  company(id: EntityId): Promise<CompanyDetail>
  searchTransactions(entityId: EntityId, query: string): Promise<TxnRow[]>
  createCompany(name: string, currency?: string): Promise<EntitySummary>
  /** Deletes an empty company; the server refuses (409, with its reason) one that has anything in it. */
  deleteCompany(id: EntityId): Promise<{ ok: true; name: string }>
  /** Onboarding: the first company creates the workspace (and your private Personal space). */
  /** No company name: a Personal-only workspace (individuals, investors). Companies can be added later. */
  createWorkspace(companyName: string | null, currency?: string): Promise<{ workspaceId: Id; companyId: EntityId | null; personalId: EntityId }>
  /** Look around first: a workspace of made-up companies (meridn-63's demo). Not for people with a real workspace. */
  startDemo(): Promise<{ workspaceId: Id; created: boolean; entities: Array<{ id: EntityId; name: string }> }>
  /** Sign-in methods this server offers, for the signed-out page. */
  signInMethods(): Promise<SignInMethod[]>
  /** A reviewer's access code (the reviewer link's token, or the whole link). Sets the session like any sign-in. */
  reviewerSignIn(code: string, email?: string): Promise<{ ok: true }>
  /** Signed in on an AI's OAuth login page: carry on the authorization (to the consent page). The next URL, or null. */
  continueOAuthLogin(oauthQuery: string): Promise<string | null>
  /** The invite this person arrived with (`/?invite=<id>` from the email). 404 unless it's theirs and still valid. */
  /** claim: the invite went to another address (invitedEmail) and nobody has used it: this account may take it. */
  inviteInfo(id: string): Promise<{ workspaceId: Id; workspaceName: string; inviterName: string; claim?: boolean; invitedEmail?: string }>
  /** Join with the signed-in account (for a claim, the invited place moves to it). */
  acceptInvite(id: string): Promise<{ ok: true; workspaceId: Id }>
  /** Switch which workspace every following call is about (sent as x-agfn-workspace). */
  setWorkspace(id: Id): void
  /** Delete the signed-in person's account. 409 'sole_owner' while they're the only owner of a shared workspace. */
  deleteMe(confirm: string): Promise<unknown>
  /** People without a passkey confirm it's them with an emailed link that brings them back to `returnTo`. */
  recheckByEmail(returnTo: string): Promise<{ ok: true; sentTo: string; expiresInMinutes?: number }>
  /** The 6-digit code from a sign-in email, typed in the browser that asked (the link may open elsewhere). */
  signInCode(code: string): Promise<{ ok: true }>
  /** The 6-digit code from a re-check email; counts like opening the link. */
  recheckCode(code: string): Promise<{ ok: true }>
  /** Owner only. Everything goes: companies, connections, documents, AI access. A passkey re-check comes first. */
  /** Owner only: the other members whose Personal connections go with the workspace (counts; Personal stays private). */
  deleteWorkspacePreview(): Promise<{ affected: Array<{ personId: Id; name: string; email: string; personalConnections: number }> }>
  deleteWorkspace(confirm: string): Promise<unknown>
  /** Leave the demo: onboarding starts fresh. */
  leaveDemo(): Promise<unknown>

  // connections
  connectors(): Promise<Connector[]>
  /** returnTo: the app page an OAuth round trip comes back to (e.g. /welcome/2); the overview when left out. */
  /** investmentsFirst: Plaid Link for a brokerage-only login (products: investments), the one retry after NO_ACCOUNTS. */
  startConnect(connectorKey: string, entityId: EntityId | null, returnTo?: string, opts?: { investmentsFirst?: boolean }): Promise<ConnectStart>
  finishConnect(connectorKey: string, input: Record<string, unknown> & { state: string }): Promise<{ connectionId: Id; accounts: NewAccount[] }>
  assignAccounts(assignments: Array<{ accountId: Id; entityId: EntityId | 'personal' | 'skip' }>): Promise<void>
  /** records: how many records it has brought in (invoices, bills…), for connections without bank accounts (Xero, QuickBooks). */
  connection(id: Id): Promise<ConnectionSummary & { accounts: AccountRow[]; unassigned?: Array<{ id: Id; name: string; mask?: string }>; provides: DataType[]; canRefreshBalance?: boolean; records?: number }>
  /** Xero organisations this connection's sign-in can reach that the workspace doesn't have yet (shared before, so Xero won't offer them again). Empty for other connectors and non-admins. */
  sharedOffers(id: Id): Promise<Array<{ id: string; name: string }>>
  /** Add one of those organisations as its own connection on the same sign-in; it starts syncing. 409 when it's no longer available. */
  addShared(id: Id, orgId: string): Promise<{ connectionId: Id; name: string }>
  /** Move a whole connection (all its accounts) to one company. Owners and admins; re-posts instantly. */
  setConnectionCompany(id: Id, entityId: EntityId): Promise<{ ok: true; moved: number }>
  /** Repair a connection in place (Plaid update mode: no second Item). 409 'gone' when the bank removed it. */
  reconnect(id: Id, accountSelection?: boolean): Promise<ReconnectStart>
  finishReconnect(id: Id, input: { state: string; linkSessionId?: string }): Promise<unknown>
  /** Link funnel events (no tokens). Fire and forget. */
  linkEvent(e: { event: string; linkSessionId?: string; institutionId?: string; errorType?: string; errorCode?: string; requestId?: string }): Promise<unknown>
  /** A live balance check, billed per call by Plaid: only ever on a click. 409 'cooldown' | 'unsupported' | 'needs_reauth'. */
  refreshBalance(id: Id): Promise<BalanceRefresh>
  syncNow(id: Id): Promise<void>
  /** `warning`: the provider's own sentence about what to finish on their side (the connection is removed here anyway). */
  disconnect(id: Id, deleteData: boolean): Promise<{ ok: true; dataDeleted?: boolean; warning?: string } | void>

  // buckets
  bucket(id: Id): Promise<BucketDetail>
  updateBucket(id: Id, patch: Partial<Pick<BucketDetail, 'name' | 'fields' | 'schedule'>>): Promise<BucketDetail>
  /** A new bucket by hand (a stake in a company, say); the AI makes most of them with create_bucket. */
  createBucket(entityId: EntityId, b: { name: string; fields: BucketField[] }): Promise<BucketDetail>
  undo(recordId: Id): Promise<WriteResult>

  // AI
  ai(grantId: GrantId): Promise<AiDetail>
  updateGrant(grantId: GrantId, shape: GrantShape): Promise<AiSummary>
  /** Keys only (an OAuth app keeps the name it signed in with). */
  renameKey(grantId: GrantId, name: string): Promise<AiSummary>
  pauseAi(grantId: GrantId, paused: boolean): Promise<void>
  revokeAi(grantId: GrantId): Promise<void>
  pauseAll(paused: boolean): Promise<void>
  /** For bots that can't sign in: a key shown once. */
  createKey(name: string, shape: GrantShape): Promise<{ grantId: GrantId; key: string }>
  /** Latest activity across all AIs (onboarding's "waiting for the first question"). */
  latestActivity(): Promise<AiActivity | null>

  // review
  review(): Promise<ReviewItem[]>
  /** What the answer did, when the server says: its summary, and the record an Undo reverts. */
  resolve(id: Id, decision: ReviewDecision): Promise<{ recordId?: Id; summary?: string } | void>

  // passkeys (Better Auth passkey plugin)
  /** Registers a new passkey on this device; false when the person cancels. */
  addPasskey(name: string): Promise<boolean>
  /** Prepare a passkey ceremony ahead of the click; call the result inside the click handler (Safari). */
  preparePasskey(): Promise<(name: string) => Promise<boolean>>
  removePasskey(id: Id): Promise<void>

  // preferences
  preferences(): Promise<Preferences>
  updatePreferences(patch: Partial<Omit<Preferences, 'people' | 'signIn' | 'recovery'>>): Promise<Preferences>
  invite(email: string, role: RolePreset, entityIds: EntityId[] | 'all'): Promise<PersonRow>
  updatePerson(id: Id, patch: Partial<Pick<PersonRow, 'role' | 'entityIds' | 'grid'>>): Promise<PersonRow>
  /** Remove a member, or cancel a pending invite. Someone else: owners/admins, with a re-check; an owner only by an owner. */
  removePerson(id: Id): Promise<{ ok: true }>
  /** A new invite email to someone still pending. */
  resendInvite(id: Id): Promise<{ ok: true; sentTo: string }>
  /** Leave the workspace in view (not its only owner). */
  leaveWorkspace(): Promise<{ ok: true }>
  /** json (default): everything; beancount / hledger: the books as a plain-text journal. */
  exportAll(format?: 'json' | 'beancount' | 'hledger'): Promise<{ url: string }>

  // investments (positions, marks, write-offs, exits; lib/investments.ts)
  investments(entityId: EntityId): Promise<{ positions: import('../lib/investments.ts').InvestmentView[]; totals: import('../lib/investments.ts').InvestmentTotals[] }>
  recordInvestment(entityId: EntityId, input: import('../lib/investments.ts').InvestmentInput): Promise<{ positionId: string; status?: string; recordId?: string }>

  // equity (S6)
  equity(entityId: EntityId): Promise<EquityDetail>
  /** Same payload as the record_equity_event tool, money in minor units. */
  recordEquity(entityId: EntityId, payload: EquityWritePayloadInput): Promise<EquityWriteResult>
  /** OCF JSON (file set or array) or a Carta / Pulley / spreadsheet CSV. Re-importing skips what's already there. */
  importEquity(entityId: EntityId, file: File): Promise<EquityImportResult>
  /** Where the browser downloads the OCF export. */
  ocfExportUrl(entityId: EntityId): string

  // add anything
  addCash(entry: CashEntry): Promise<WriteResult>
  upload(entityId: EntityId, file: File): Promise<UploadResult>
  /** Month-by-month recurring revenue movements, oldest first. */
  mrrMovements(entityId: EntityId, months?: number): Promise<import('@agfn/contracts').MrrMovementView[]>
  /** Close a company's books through a day before today, or reopen them. Undo works like any change. */
  closePeriod(entityId: EntityId, through: IsoDate, note?: string): Promise<{ recordId?: Id; summary: string }>
  reopenPeriod(entityId: EntityId): Promise<{ recordId?: Id; summary: string }>
  /** Statements (uploaded or emailed in) still waiting for "which account?". */
  waitingStatements(): Promise<WaitingStatement[]>
  /** Who may email a company's address (exact addresses or @domain). Everyone else is refused. */
  inboundSenders(entityId: EntityId): Promise<InboundSettings>
  /** Owner/admin: the extra senders beyond members (members are automatic). */
  setInboundSenders(entityId: EntityId, extra: string[]): Promise<InboundSettings>
  /** Documents waiting for an AI to read them, newest first (companies this person can see documents in). */
  unreadDocuments(): Promise<UnreadDocument[]>
  /** Owner or admin: a file nothing was imported from (unread, or a statement still asking). 409 once imported, 404 gone. */
  deleteDocument(id: Id): Promise<{ ok: true; name: string }>
  /** The file itself, for a preview in a new tab. */
  documentFileUrl(id: Id): string
  /** Answers needs_account: an existing account, or 'new' for a separate statements account. */
  chooseStatementAccount(documentId: Id, accountId: Id | 'new'): Promise<{ state: 'imported' | 'unread'; message: string }>
  /** Answers needs_mapping with one of the question's option values. */
  answerMapping(documentId: Id, field: MappingQuestion['field'], value: string): Promise<MappingReply>
  /** Owners/admins: share cards, drafts and live links. */
  shareCards(): Promise<ShareCard[]>
  /** A draft (nothing public yet); the 21st in a day is refused with a plain message. */
  shareDraft(entityId: EntityId, kind: ShareKind): Promise<{ id: string }>
  /** What the draft would show with these choices, or the plain reason it can't be made (e.g. books not reconciled). */
  sharePreview(id: string, opts: ShareOpts): Promise<SharePreview>
  /** The image the draft would publish with these choices (query: amounts=0|1&name=0|1). */
  sharePreviewUrl(id: string, query: string): string
  /** A badge's embed as it would publish (query: name=0|1&fields=mrr,runway). */
  badgePreviewUrl(id: string, query: string): string
  sharePublish(id: string, opts: ShareOpts): Promise<{ url: string }>
  /** Live: the link answers 410 from now on. Draft: discarded. */
  shareRevoke(id: string): Promise<void>
}
