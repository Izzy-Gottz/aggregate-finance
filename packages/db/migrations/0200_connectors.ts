import type { Kysely } from 'kysely'

// S2/S3 connector tables (meridn-63). Typed in @agfn/connector-sdk/db (ConnectorTables).

export async function up(db: Kysely<any>): Promise<void> {
  // Saved column mappings for CSV statement imports, so the second file from the same bank imports in one click.
  await db.schema
    .createTable('connector_import_mappings')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('connection_id', 'text', (c) => c.references('connections.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('format', 'text', (c) => c.notNull())
    // sha256 of the normalized header row: picks the mapping automatically for the next file with the same columns.
    .addColumn('header_signature', 'text', (c) => c.notNull())
    .addColumn('mapping_json', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createIndex('connector_import_mappings_ws_sig')
    .on('connector_import_mappings')
    .columns(['workspace_id', 'header_signature'])
    .unique()
    .execute()

  // One row per webhook delivery we accepted. Providers retry deliveries; the unique key makes handling idempotent.
  // workspace_id is filled once the delivery is matched to a connection (it can arrive before that is known).
  await db.schema
    .createTable('connector_webhook_receipts')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('dedupe_key', 'text', (c) => c.notNull())
    .addColumn('workspace_id', 'text', (c) => c.references('workspaces.id'))
    .addColumn('connection_id', 'text', (c) => c.references('connections.id'))
    .addColumn('action', 'text', (c) => c.notNull())
    .addColumn('match_field', 'text')
    .addColumn('match_value', 'text')
    .addColumn('received_at', 'text', (c) => c.notNull())
    .addColumn('processed_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createIndex('connector_webhook_receipts_dedupe')
    .on('connector_webhook_receipts')
    .columns(['provider', 'dedupe_key'])
    .unique()
    .execute()
  await db.schema
    .createIndex('connector_webhook_receipts_ws')
    .on('connector_webhook_receipts')
    .column('workspace_id')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('connector_webhook_receipts').execute()
  await db.schema.dropTable('connector_import_mappings').execute()
}
