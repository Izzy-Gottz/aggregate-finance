import type { Generated } from 'kysely'

// Core tables owned by S0 (migration 0001). Other slices declare their own table interfaces and use
// Kysely<CoreTables & TheirTables>. Conventions: COORDINATION.md "Database conventions".

export interface WorkspacesTable {
  id: string
  name: string
  base_currency: string
  /** IANA zone; null = America/New_York. */
  time_zone: string | null
  created_at: string
}

/** A human. Login identities (passkeys, Apple, Google, email) live in the auth tables and point here via auth_user_id. */
export interface PeopleTable {
  id: string
  auth_user_id: string | null
  name: string
  email: string
  created_at: string
}

export type RolePreset = 'owner' | 'admin' | 'finance' | 'accountant' | 'investor' | 'employee' | 'custom'

export interface MembershipsTable {
  id: string
  workspace_id: string
  person_id: string
  role: RolePreset
  /** JSON permission grid (custom or overrides): { entities: string[] | 'all', view: DataType[], add: DataType[], manage: boolean }. */
  grid_json: string | null
  expires_at: string | null
  invited_by: string | null
  created_at: string
  revoked_at: string | null
}

export interface EntitiesTable {
  id: string
  workspace_id: string
  kind: 'company' | 'personal'
  name: string
  base_currency: string
  /** For a personal entity: the only person who can see it unless shared. */
  owner_person_id: string | null
  parent_entity_id: string | null
  fiscal_year_start_month: number
  created_at: string
  archived_at: string | null
}

export interface ConnectionsTable {
  id: string
  workspace_id: string
  connector_key: string
  /** Company the whole connection feeds (accounting file, payroll company); null for multi-company bank logins. */
  entity_id: string | null
  display_name: string
  status: 'active' | 'needs_reauth' | 'error' | 'paused' | 'disconnected'
  /** Envelope-encrypted secret (see @agfn/security). Never logged, never returned by any API. */
  secret_enc: string | null
  config_json: string
  cursor: string | null
  last_sync_at: string | null
  last_success_at: string | null
  last_error: string | null
  /** JSON string[] of non-fatal notes from the last sync. */
  warnings_json?: string | null
  /** JSON ProviderFreshness from the last successful sync (@agfn/contracts): the provider's own data-as-of times. */
  freshness_json?: string | null
  /** When it was disconnected (raw payloads are purged 30 days later). Null while connected. */
  disconnected_at?: string | null
  created_by: string | null
  created_at: string
}

export interface RawRecordsTable {
  id: string
  workspace_id: string
  connection_id: string
  kind: string
  external_id: string
  payload_json: string
  sha256: string
  received_at: string
}

export interface AccountsTable {
  id: string
  workspace_id: string
  /** Null until the person answers "which company is this, or Personal?". */
  entity_id: string | null
  connection_id: string | null
  external_id: string | null
  name: string
  account_type: string
  currency: string
  mask: string | null
  institution: string | null
  business_hint: 'business' | 'personal' | 'unknown' | null
  include_in_cash: number
  duplicate_of: string | null
  created_at: string
  closed_at: string | null
}

export interface DocumentsTable {
  id: string
  workspace_id: string
  entity_id: string | null
  storage_key: string
  sha256: string
  mime_type: string
  size_bytes: number
  original_name: string | null
  arrived_via: 'upload' | 'agent' | 'email' | 'import'
  status: 'unread' | 'processed' | 'ignored'
  /** Structured fields an AI extracted (untrusted until confirmed). */
  extracted_json: string | null
  record_type: string | null
  record_id: string | null
  created_by: string | null
  created_at: string
}

/** One row per release a worker has run (jobs.ts release guard). */
export interface WorkerReleasesTable {
  release: string
  first_seen: string
  last_seen: string
}

export interface JobsTable {
  id: string
  workspace_id: string | null
  kind: string
  payload_json: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead'
  run_at: string
  attempts: number
  max_attempts: number
  lease_until: string | null
  locked_by: string | null
  last_error: string | null
  /** Optional dedupe key: at most one queued/running job per (kind, unique_key). */
  unique_key: string | null
  created_at: string
  updated_at: string
}

export interface SettingsTable {
  workspace_id: string
  key: string
  value_json: string
  updated_at: string
}

export interface OAuthPendingGrantsTable {
  session_id: string
  /** The OAuth client the person chose this grant for (migration 0505). */
  client_id: string
  grant_id: string
  person_id: string
  expires_at: string
  created_at: string
}

export interface ReauthEventsTable {
  id: string
  person_id: string
  /** email_link: the one-time re-check link (recheck_links), which also satisfies a passkey check. */
  method: 'passkey' | 'magic_link' | 'social' | 'email_link'
  at: string
}

/** One-time re-check links by email (migration 0508): the fallback when a passkey isn't on this device. */
export interface RecheckLinksTable {
  id: string
  person_id: string
  token_hash: string
  created_at: string
  expires_at: string
  used_at: string | null
  /** The 6-digit code in the same email (migration 0509); null for links sent before codes existed. */
  code_hash: string | null
  attempts: number
}

/**
 * Connect-from-chat links (migration 0914, apps/server/src/connect-source.ts), behind AGFN_CONNECT_FROM_CHAT. An AI
 * mints one; a workspace owner/admin opens it in Aggregate and approves before any real connect begins. Bound to one
 * workspace + provider + person, hashed, 15 minutes, single-use. The raw token lives only in the URL, never stored.
 */
export interface ConnectLinksTable {
  id: string
  token_hash: string
  workspace_id: string
  person_id: string
  /** The AI connection (grant) that minted it: for the per-grant mint rate-limit and shadow logging. */
  grant_id: string
  /** Connector key, e.g. "stripe", "plaid". */
  provider: string
  /** The company this source is for, if the AI named one; null = decide at connect time. */
  entity_id: string | null
  created_at: string
  expires_at: string
  used_at: string | null
}

/** Sign-in codes (migration 0509): the code next to a sign-in link, for the browser that asked for it. */
export interface SigninCodesTable {
  id: string
  email: string
  code_hash: string
  nonce_hash: string
  link_token: string
  attempts: number
  created_at: string
  expires_at: string
  used_at: string | null
}

/** The challenge deployment (migration 0511): outbound HTTP calls, planted flag hashes, archived AI activity. */
export interface OutboundCallsTable {
  id: string
  at: string
  method: string
  host: string
  path: string
  status: number | null
  ms: number | null
  ws: string | null
}
export interface ChallengeFlagsTable {
  name: string
  sha256: string
  planted_at: string
  ws: string | null
}
export interface ChallengeActivityTable {
  id: string
  ws: string
  at: string
  row_json: string
}

/** The public no-sign-up demo (migration 0510): which demo workspace /demo/mcp serves, and the one being retired. */
export interface PublicDemoTable {
  id: string
  current_ws: string
  person_id: string
  grant_id: string
  built_at: string
  retiring_ws: string | null
  retiring_person: string | null
  retire_after: string | null
}

/** Reviewer access links (migration 0506): demo-only sign-in for directory reviewers. */
export interface ReviewerLinksTable {
  id: string
  person_id: string
  /** sha256 of the token, hex. The token itself is shown once. */
  token_hash: string
  label: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
  uses: number
}

/** Shareable answer cards (migration 0800, apps/server/src/share.ts): a draft until published; revoked clears it. */
export interface ShareCardsTable {
  id: string
  workspace_id: string
  entity_id: string
  created_by: string
  source: string
  kind: 'runway' | 'cash_trend' | 'roast' | 'hype' | 'badge'
  status: 'draft' | 'live' | 'revoked'
  snapshot: string | null
  created_at: string
  published_at: string | null
  revoked_at: string | null
}

export interface CoreTables {
  workspaces: WorkspacesTable
  people: PeopleTable
  memberships: MembershipsTable
  entities: EntitiesTable
  connections: ConnectionsTable
  raw_records: RawRecordsTable
  accounts: AccountsTable
  documents: DocumentsTable
  jobs: JobsTable
  worker_releases: WorkerReleasesTable
  settings: SettingsTable
  reviewer_links: ReviewerLinksTable
  outbound_calls: OutboundCallsTable
  challenge_flags: ChallengeFlagsTable
  challenge_activity: ChallengeActivityTable
  public_demo: PublicDemoTable
  recheck_links: RecheckLinksTable
  connect_links: ConnectLinksTable
  signin_codes: SigninCodesTable
  oauth_pending_grants: OAuthPendingGrantsTable
  reauth_events: ReauthEventsTable
  share_cards: ShareCardsTable
}

export type { Generated }
