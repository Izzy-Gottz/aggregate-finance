// Ports S7 depends on. S1 (ledger) implements FinanceReader + RecordWriter, S0 implements the auth ports.
// All money is integer minor units (contracts Money). Third-party strings arrive raw; S7 cleans and labels them
// before they reach an AI. Every view carries entityId so S7 can drop anything outside the caller's scope
// (defense in depth: the reader is asked for the right entities, and the answer is filtered again).

import type { Can, DataType, EntityId, EntityKind, Id, IsoTimestamp, PersonId, WorkspaceId } from '@agfn/contracts'

// FinanceReader, RecordWriter and their view types live in @agfn/contracts (S1 implements them without depending
// on this package). Re-exported here for convenience.
export type {
  EntityInfo,
  ReadScope,
  Page,
  SourceStatus,
  AddedBy,
  OverviewEntity,
  AttentionItem,
  Overview,
  AccountView,
  AccountFilter,
  TxnView,
  TxnQuery,
  TxnSearchResult,
  InvoiceView,
  InvoiceQuery,
  AgingBuckets,
  InvoiceSearchResult,
  RecordType,
  AuditTrailItem,
  RecordView,
  CounterpartyView,
  UpcomingItem,
  OwnerBalanceView,
  BucketView,
  CapTableView,
  PayrollView,
  ReviewItemView,
  DocumentView,
  ReportView,
  FinanceReader,
  Provenance,
  WriteOp,
  WriteCommand,
  AppliedWrite,
  RecordWriter,
} from '@agfn/contracts'
export { WriteRejected } from '@agfn/contracts'

// ---------- Auth ports (S0) ----------

export interface VerifiedAccessToken {
  grantId: Id
  personId: PersonId
  workspaceId: WorkspaceId
  clientId: string
  clientName: string
  scopes: string[]
  /** Epoch seconds. */
  expiresAt: number
}

export interface McpTokenVerifier {
  /** Null when the token is invalid, expired, revoked, or not issued for `resource` (RFC 8707 audience). */
  verifyAccessToken(token: string, resource: string): Promise<VerifiedAccessToken | null>
  /** Authorization server issuer, advertised in Protected Resource Metadata. */
  readonly issuer: string
}

export interface PeopleDirectory {
  can: Can
  /**
   * A `can` for one tool call: the same rule, read live when the call starts, with its rows read once for all the call's
   * checks (S0 permissions.forCall). Optional; without it every check reads its own rows.
   */
  forCall?(): Can
  /** Entities this person can see at all in the workspace (S0 `entitiesFor`). */
  entitiesFor(workspaceId: WorkspaceId, personId: PersonId): Promise<Array<{ id: EntityId; name: string; kind: EntityKind }>>
  displayName(personId: PersonId): Promise<string>
  /** Owners/admins: may pause all AI, change the workspace review default, and manage anyone's AI connections. */
  canManageWorkspace(workspaceId: WorkspaceId, personId: PersonId): Promise<boolean>
  /** Passkey re-check (MASTER §9: 10 minutes) before adding AI access or widening a grant. */
  /**
   * A recent passkey check (or, without a passkey, a fresh sign-in). `purpose` names the one action a reviewer demo
   * account may pass it for: creating an AI connection. Every other caller leaves it out, and reviewers then fail.
   * 'first_grant' is an account's first AI connection: any sign-up or sign-in within the window counts, passkey or not.
   */
  requireRecentPasskey(personId: PersonId, withinMs: number, purpose?: 'create_grant' | 'first_grant'): Promise<boolean>
}

/** Optional hooks the host wires (S0 kills refresh tokens; S9 sends alerts). */
export interface ControlHooks {
  onGrantRevoked?(grantId: Id): Promise<void>
  /** Extra say on every bearer request (agent key or OAuth), after the grant checks: false refuses it as revoked. */
  personAllowed?(workspaceId: WorkspaceId, personId: Id): Promise<boolean>
  onAlert?(alert: { workspaceId: WorkspaceId; kind: string; text: string; grantId?: Id; recordId?: Id }): Promise<void>
}

export interface Clock {
  now(): Date
}

export const systemClock: Clock = { now: () => new Date() }

/**
 * Live balance checks at the bank (billed per call, capped by the sync engine). Optional: without it the
 * refresh_balance tool is not offered.
 */
export interface LiveBalancePort {
  /** The connections a live check of these accounts would call, each with the accounts it covers. Only connections
   *  whose connector supports live balances are returned. */
  targets(workspaceId: string, accountIds: string[]): Promise<Array<{ connectionId: string; name: string; accountIds: string[] }>>
  refresh(connectionId: string): Promise<{ status: 'ok'; at: string } | { status: 'cached'; reason: 'cooldown' | 'daily_cap'; refreshedAt: string | null; retryAt: string } | { status: 'unsupported' }>
  /** What one check costs, in words (AGFN_LIVE_BALANCE_NOTE). */
  costNote: string
  /** The engine's caps, said in every answer. */
  limits: { cooldownMinutes: number; dailyCap: number }
}

/** Shareable answer cards (apps/server share.ts): drafts only; publishing is a person's act in the app. Errors carry
 *  .status 404 / 409 / 422 / 429. roast and hype return the card's own template lines (never AI text); a refusal is a
 *  422 with the reason. */
export interface SharePort {
  draft(i: { workspaceId: string; personId: string; entityId: string; kind: 'runway' | 'cash_trend' | 'roast' | 'hype'; source: string; vendors?: boolean }): Promise<{ id: string; reviewUrl: string; lines?: string[] }>
}

/** Which provider timestamp a tool's answer leans on, so the host can pick the right field from freshness_json. */
export type FreshnessAspect = 'transactions' | 'investments' | 'balances' | 'overview'

/** One source behind an answer, for the shared `sources` block and the "Data as of" line on every read. */
export interface SourceEntry {
  /** The connection's display name, e.g. "Chase". */
  source: string
  institution: string | null
  /** cached = we hold a copy refreshed on a schedule (Plaid, SimpleFIN); live = queried now (Stripe, QuickBooks…); file = a statement/export upload; manual = entries a person keyed in. */
  kind: 'live' | 'cached' | 'file' | 'manual'
  /** The provider's own "data current as of" time where we have it (freshness_json; a file's closing date), else null. */
  data_as_of: string | null
  /** When WE last refreshed this source successfully (connections.last_success_at). */
  last_checked: string | null
  /** The connector's typical cadence in words (manifest freshness), e.g. "updates within minutes via webhooks". */
  typical_refresh: string | null
  /** Older than this source's own expected cadence (not a flat 24h). */
  stale: boolean
  /** Set only when the provider's last refresh FAILED later than its last success (or with no success): the fail time. */
  refresh_failed_at?: string | null
  /** The last successful data time to fall back to as "data from …" when a refresh failed. */
  refresh_last_good?: string | null
  /** The provider's error code (e.g. ITEM_LOGIN_REQUIRED), constrained to ^[A-Z0-9_]{1,64}$, when a refresh failed. */
  error_code?: string | null
}

/**
 * The sources behind one read answer (apps/server/src/freshness.ts). Built from the workspace's connections + the
 * connector manifest + 2a's connections.freshness_json. Without it wired, reads simply carry no `sources` block.
 */
export interface SourcesPort {
  /** Sources feeding these entities, for this aspect. entityIds is the answer's scope; empty means it spans everything. */
  forEntities(i: { workspaceId: WorkspaceId; entityIds: EntityId[]; aspect: FreshnessAspect }): Promise<SourceEntry[]>
}

/** How one connector is reached, so connect_source can tell the AI what the owner will see. */
export type ConnectAuthKind = 'oauth' | 'link_widget' | 'api_key' | 'file' | 'none'

/** One source a connect-from-chat link could reach on this deployment. */
export interface ConnectOption {
  key: string
  name: string
  group: string
  auth: ConnectAuthKind
  provides: DataType[]
}

/** A plain-message refusal from the host (rate limit reached, reviewer demo, provider gone): shown to the AI as-is. */
export class ConnectMintError extends Error {
  override name = 'ConnectMintError'
}

/**
 * Connecting a financial source from the AI chat (apps/server/src/connect-source.ts), behind AGFN_CONNECT_FROM_CHAT.
 * Without it wired the connect_source tool isn't offered. The AI only ever mints a link: no secret, key or token ever
 * reaches the AI, and nothing is connected until a workspace owner/admin opens the link and approves in Aggregate.
 */
export interface ConnectPort {
  /** The connectors a link could reach for this workspace, already filtered to what's offered here (flags, hidden/
   *  unlisted, hosted vs self-hosted, reviewer demo). Empty when none are available to this caller. */
  options(i: { workspaceId: WorkspaceId; personId: PersonId }): Promise<ConnectOption[]>
  /**
   * Mint a single-use, short-lived link bound to this workspace + provider + the minting person. The token lives only
   * in the returned URL (never stored or logged). Throws ConnectMintError with a plain message on a rate limit, a
   * caller who may not mint (reviewer demo, not an owner/admin), or a provider that isn't available.
   */
  mint(i: { workspaceId: WorkspaceId; personId: PersonId; grantId: Id; provider: string; entityId?: EntityId | null }): Promise<{ id: string; url: string; expiresAt: IsoTimestamp }>
}
