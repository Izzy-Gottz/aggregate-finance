// Typed access to the S2/S3 tables from migrations 0200-0201 (import mappings, webhook receipts, connection attention).
// Separate entry point (@agfn/connector-sdk/db) so connectors themselves never depend on the database.

import type { Kysely } from 'kysely'

export interface ConnectorImportMappingsTable {
  id: string
  workspace_id: string
  connection_id: string | null
  name: string
  format: string
  header_signature: string
  mapping_json: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ConnectorWebhookReceiptsTable {
  id: string
  provider: string
  dedupe_key: string
  workspace_id: string | null
  connection_id: string | null
  action: string
  match_field: string | null
  match_value: string | null
  received_at: string
  processed_at: string | null
  created_at: string
}

export type AttentionKind = 'reconnect_soon' | 'new_accounts'

export interface ConnectionAttentionTable {
  connection_id: string
  workspace_id: string
  kind: AttentionKind
  message: string
  created_at: string
}

export interface ConnectorTables {
  connector_import_mappings: ConnectorImportMappingsTable
  connector_webhook_receipts: ConnectorWebhookReceiptsTable
  connection_attention: ConnectionAttentionTable
}

/** Callers pass Kysely<CoreTables & ConnectorTables>; queries here only touch ConnectorTables. */
function narrow<DB extends ConnectorTables>(db: Kysely<DB>): Kysely<ConnectorTables> {
  return db as unknown as Kysely<ConnectorTables>
}

export interface ReceiptInput {
  id: string
  provider: string
  dedupeKey: string
  action: string
  match?: { field: string; value: string }
  at: string
}

/**
 * Record a webhook delivery. Returns 'duplicate' if this (provider, dedupeKey) was already recorded, so the caller
 * acknowledges the retry without enqueueing a second sync.
 */
export async function recordWebhookReceipt<DB extends ConnectorTables>(db: Kysely<DB>, r: ReceiptInput): Promise<'new' | 'duplicate'> {
  const res = await narrow(db)
    .insertInto('connector_webhook_receipts')
    .values({
      id: r.id,
      provider: r.provider,
      dedupe_key: r.dedupeKey,
      workspace_id: null,
      connection_id: null,
      action: r.action,
      match_field: r.match?.field ?? null,
      match_value: r.match?.value ?? null,
      received_at: r.at,
      processed_at: null,
      created_at: r.at,
    })
    .onConflict((oc) => oc.columns(['provider', 'dedupe_key']).doNothing())
    .executeTakeFirst()
  return Number(res.numInsertedOrUpdatedRows ?? 0n) > 0 ? 'new' : 'duplicate'
}

export interface SavedMapping<M> {
  id: string
  name: string
  format: string
  mapping: M
}

export async function findImportMapping<M, DB extends ConnectorTables = ConnectorTables>(
  db: Kysely<DB>,
  workspaceId: string,
  headerSignature: string,
): Promise<SavedMapping<M> | undefined> {
  const row = await narrow(db)
    .selectFrom('connector_import_mappings')
    .select(['id', 'name', 'format', 'mapping_json'])
    .where('workspace_id', '=', workspaceId)
    .where('header_signature', '=', headerSignature)
    .executeTakeFirst()
  return row ? { id: row.id, name: row.name, format: row.format, mapping: JSON.parse(row.mapping_json) as M } : undefined
}

/** Insert or replace the mapping for this header signature (idempotent per workspace + signature). */
export async function saveImportMapping<DB extends ConnectorTables>(
  db: Kysely<DB>,
  m: { id: string; workspaceId: string; connectionId?: string; name: string; format: string; headerSignature: string; mapping: unknown; createdBy?: string; at: string },
): Promise<void> {
  await narrow(db)
    .insertInto('connector_import_mappings')
    .values({
      id: m.id,
      workspace_id: m.workspaceId,
      connection_id: m.connectionId ?? null,
      name: m.name,
      format: m.format,
      header_signature: m.headerSignature,
      mapping_json: JSON.stringify(m.mapping),
      created_by: m.createdBy ?? null,
      created_at: m.at,
      updated_at: m.at,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'header_signature']).doUpdateSet({
        name: m.name,
        format: m.format,
        mapping_json: JSON.stringify(m.mapping),
        connection_id: m.connectionId ?? null,
        updated_at: m.at,
      }),
    )
    .execute()
}

/** Flag a connection as needing a person (idempotent per kind; the newest message wins). */
export async function setAttention<DB extends ConnectorTables>(db: Kysely<DB>, a: { connectionId: string; workspaceId: string; kind: AttentionKind; message: string; at: string }): Promise<void> {
  await narrow(db)
    .insertInto('connection_attention')
    .values({ connection_id: a.connectionId, workspace_id: a.workspaceId, kind: a.kind, message: a.message, created_at: a.at })
    .onConflict((oc) => oc.columns(['connection_id', 'kind']).doUpdateSet({ message: a.message, created_at: a.at }))
    .execute()
}

/** Clear one kind, or every kind when none is given (after a successful reconnect). */
export async function clearAttention<DB extends ConnectorTables>(db: Kysely<DB>, connectionId: string, kind?: AttentionKind): Promise<void> {
  let q = narrow(db).deleteFrom('connection_attention').where('connection_id', '=', connectionId)
  if (kind) q = q.where('kind', '=', kind)
  await q.execute()
}

export async function listAttention<DB extends ConnectorTables>(db: Kysely<DB>, workspaceId: string): Promise<ConnectionAttentionTable[]> {
  return narrow(db).selectFrom('connection_attention').selectAll().where('workspace_id', '=', workspaceId).execute()
}
