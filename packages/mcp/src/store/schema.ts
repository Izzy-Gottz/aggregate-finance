// Tables owned by S7 (migrations 0500-0599). Conventions: COORDINATION.md "Database conventions".
// Use as Kysely<CoreTables & McpTables>.

export interface GrantsTable {
  id: string
  workspace_id: string
  person_id: string
  /** oauth = issued through the consent screen; key = backs an agent key. */
  kind: 'oauth' | 'key'
  client_id: string
  client_name: string
  /** JSON: "all" or ["ent_…"]. */
  entity_ids_json: string
  /** JSON: DataType[]. */
  data_types_json: string
  can_write: number
  review_mode: 'instant' | 'review_all'
  daily_write_cap: number | null
  expires_at: string | null
  created_at: string
  updated_at: string
  revoked_at: string | null
  revoked_by: string | null
  last_used_at: string | null
  /** Paused by the owner: calls are refused (whoami still answers) until resumed. */
  paused_at: string | null
  /** Consent evidence (migration 0904): the AI disclosure version shown, sha256 of that exact line, and the connected
   *  sources (connector keys) the grant's companies had at approval. Null on grants made before it. */
  consent_version?: string | null
  consent_sha256?: string | null
  consent_sources_json?: string | null
  paused_by: string | null
}

export interface AgentKeysTable {
  id: string
  workspace_id: string
  grant_id: string
  name: string
  /** Display prefix, e.g. "agfn_live_k7Qp". Never enough to use the key. */
  display_prefix: string
  last4: string
  /** sha256 hex of the full key. Unique. */
  key_hash: string
  /** JSON string[] of allowed client IPs, or null for any. */
  ip_allowlist_json: string | null
  expires_at: string | null
  created_by: string
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}

/** applying = claimed by a submit in flight (guards the idempotency key while the writer runs). */
export type WriteStatus = 'applying' | 'applied' | 'pending_review' | 'rejected' | 'reverted'

export interface WriteRequestsTable {
  id: string
  workspace_id: string
  actor_kind: 'person' | 'agent' | 'system'
  person_id: string | null
  grant_id: string | null
  origin: string
  op: string
  entity_id: string | null
  /** Idempotency is scoped per grant (agents) or per person (UI): "g:<id>" / "p:<id>" / "s:<reason>". */
  idem_scope: string
  idempotency_key: string
  payload_hash: string
  payload_json: string
  reason: string | null
  file_sha256: string | null
  source_document_id: string | null
  status: WriteStatus
  /** Why it waits for review: "review_mode", "suspicious_text", "suspicious_document", "needs_approval" (close/reopen books). */
  hold_reason: string | null
  record_id: string | null
  record_type: string | null
  result_json: string | null
  error: string | null
  undo_until: string | null
  created_at: string
  decided_at: string | null
  decided_by: string | null
  reverted_at: string | null
  reverted_by: string | null
}

export interface ActivityLogTable {
  id: string
  workspace_id: string
  /** 1, 2, 3… per workspace. Unique with workspace_id; the hash chain follows it. */
  seq: number
  at: string
  actor_kind: 'person' | 'agent' | 'system' | 'operator'
  person_id: string | null
  grant_id: string | null
  actor_label: string
  action: string
  target_type: string | null
  target_id: string | null
  entity_ids_json: string | null
  /** Arguments with amounts redacted. */
  args_json: string | null
  status: 'ok' | 'denied' | 'error' | 'held' | 'alert'
  rows_returned: number | null
  detail: string | null
  ip: string | null
  user_agent: string | null
  prev_hash: string
  hash: string
}

export interface AiSettingsTable {
  workspace_id: string
  paused_at: string | null
  paused_by: string | null
  /** Preferences → "AI changes wait for my review". Off (instant) by default. */
  review_mode_default: 'instant' | 'review_all'
  updated_at: string
}

export interface RateLimitCountersTable {
  key: string
  /** Window start, epoch ms. */
  window_start: number
  count: number
}

export interface McpTables {
  grants: GrantsTable
  agent_keys: AgentKeysTable
  write_requests: WriteRequestsTable
  activity_log: ActivityLogTable
  ai_settings: AiSettingsTable
  rate_limit_counters: RateLimitCountersTable
}
