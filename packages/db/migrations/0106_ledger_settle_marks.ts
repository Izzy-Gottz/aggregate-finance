import type { Kysely } from 'kysely'

// S1: sync pages post without matching or opening balances; a connection's mark says since when its records wait for
// that settle step. Written in the same transaction as the posts, so a sync that stops halfway is settled next time.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_settle_marks')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('connection_id', 'text', (c) => c.notNull())
    .addColumn('since', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('ledger_settle_marks_pk', ['workspace_id', 'connection_id'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_settle_marks').ifExists().execute()
}
