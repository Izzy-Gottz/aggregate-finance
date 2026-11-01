import type { Kysely } from 'kysely'

// S1: provenance on ledger records (who/what wrote an AI or UI entry) and the undo log for AI/UI writes.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ledger_records').addColumn('provenance_json', 'text').execute()

  await db.schema
    .createTable('ledger_writes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('op', 'text', (c) => c.notNull())
    .addColumn('record_ids_json', 'text', (c) => c.notNull())
    .addColumn('before_json', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('reverted_at', 'text')
    .execute()
  await db.schema.createIndex('ledger_writes_ws').on('ledger_writes').columns(['workspace_id', 'created_at']).execute()

  await db.schema
    .createTable('ledger_write_targets')
    .addColumn('write_id', 'text', (c) => c.notNull().references('ledger_writes.id'))
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('target_id', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('ledger_write_targets_pk', ['write_id', 'target_id'])
    .execute()
  await db.schema.createIndex('ledger_write_targets_target').on('ledger_write_targets').columns(['workspace_id', 'target_id']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_write_targets').ifExists().execute()
  await db.schema.dropTable('ledger_writes').ifExists().execute()
  await db.schema.alterTable('ledger_records').dropColumn('provenance_json').execute()
}
