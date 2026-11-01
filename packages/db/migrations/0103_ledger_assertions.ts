import type { Kysely } from 'kysely'

// S1: balance assertions — "this account held X on date D" (from a statement, a person or an AI). Checked, never posted.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_assertions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('account_id', 'text', (c) => c.notNull())
    .addColumn('date', 'text', (c) => c.notNull())
    .addColumn('balance_minor', 'bigint', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('source', 'text')
    .addColumn('created_by', 'text')
    .addColumn('provenance_json', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('removed_at', 'text')
    .execute()
  await db.schema.createIndex('ledger_assertions_account').on('ledger_assertions').columns(['workspace_id', 'account_id', 'date']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_assertions').ifExists().execute()
}
