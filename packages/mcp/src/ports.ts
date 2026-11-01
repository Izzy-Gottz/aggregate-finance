// Ports S7 depends on. S1 (ledger) implements FinanceReader + RecordWriter, S0 implements the auth ports.
// All money is integer minor units (contracts Money). Third-party strings arrive raw; S7 cleans and labels them
// before they reach an AI. Every view carries entityId so S7 can drop anything outside the caller's scope
// (defense in depth: the reader is asked for the right entities, and the answer is filtered again).

import type { Can, EntityId, EntityKind, Id, PersonId, WorkspaceId } from '@agfn/contracts'

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
