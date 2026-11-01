import type { Kysely } from 'kysely'

// S6 cap table (owned by @agfn/equity; typed as EquityTables there). One append-only table of OCF-shaped objects per
// company; the cap table is a replay of the live (not voided) rows. Writes from one request share a write_id so undo
// voids them together.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('equity_objects')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('entity_id', 'text', (c) => c.notNull().references('entities.id'))
    .addColumn('object_id', 'text', (c) => c.notNull())
    .addColumn('object_type', 'text', (c) => c.notNull())
    .addColumn('date', 'text', (c) => c.notNull())
    .addColumn('seq', 'integer', (c) => c.notNull())
    .addColumn('body_json', 'text', (c) => c.notNull())
    .addColumn('write_id', 'text', (c) => c.notNull())
    .addColumn('origin', 'text', (c) => c.notNull())
    .addColumn('created_by', 'text')
    .addColumn('added_by_label', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('voided_at', 'text')
    .addColumn('voided_by', 'text')
    .execute()
  await db.schema.createIndex('equity_objects_entity').on('equity_objects').columns(['workspace_id', 'entity_id', 'seq']).execute()
  await db.schema.createIndex('equity_objects_object').on('equity_objects').columns(['workspace_id', 'entity_id', 'object_id']).execute()
  await db.schema.createIndex('equity_objects_write').on('equity_objects').columns(['workspace_id', 'write_id']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('equity_objects').execute()
}
