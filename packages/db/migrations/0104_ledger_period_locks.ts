import type { Kysely } from 'kysely'

// S1: closed periods. A company's books are locked through a date; later changes to anything dated on or before it
// post as adjustments on the first open day, so reports for the closed period never move.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_period_locks')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('entity_id', 'text', (c) => c.notNull())
    .addColumn('through_date', 'text', (c) => c.notNull())
    .addColumn('note', 'text')
    .addColumn('created_by', 'text')
    .addColumn('provenance_json', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('removed_at', 'text')
    .execute()
  await db.schema.createIndex('ledger_period_locks_entity').on('ledger_period_locks').columns(['workspace_id', 'entity_id']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_period_locks').ifExists().execute()
}
