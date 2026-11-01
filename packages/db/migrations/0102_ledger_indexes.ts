import type { Kysely } from 'kysely'

// S1: indexes and a write counter for big workspaces (benchmark: 5 companies, 3 years, ~100k rows).
// Lines by account now carry entry_id, so "this account's lines in these entries" is a single index probe;
// the old (workspace_id, ledger_account_id) index is a prefix of it.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.createIndex('journal_lines_account_entry').on('journal_lines').columns(['workspace_id', 'ledger_account_id', 'entry_id']).execute()
  await db.schema.dropIndex('journal_lines_account').ifExists().execute()
  await db.schema.createIndex('ledger_records_status').on('ledger_records').columns(['workspace_id', 'status', 'date']).execute()
  await db.schema.createIndex('ledger_records_origin').on('ledger_records').columns(['workspace_id', 'origin']).execute()

  // Bumped by every ledger write; derived results (checks, review) are cached against it across requests.
  await db.schema
    .createTable('ledger_versions')
    .addColumn('workspace_id', 'text', (c) => c.primaryKey().references('workspaces.id'))
    .addColumn('version', 'bigint', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_versions').ifExists().execute()
  await db.schema.dropIndex('ledger_records_origin').ifExists().execute()
  await db.schema.dropIndex('ledger_records_status').ifExists().execute()
  await db.schema.createIndex('journal_lines_account').on('journal_lines').columns(['workspace_id', 'ledger_account_id']).execute()
  await db.schema.dropIndex('journal_lines_account_entry').ifExists().execute()
}
