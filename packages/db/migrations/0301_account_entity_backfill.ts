import type { Kysely } from 'kysely'

// Backfill (agfn-af, QA story 1): before this fix, accounts of single-company connections (Stripe, QuickBooks,
// payroll) were created with entity_id null, so the ledger held their events as "unassigned". Give each such account
// its connection's company, and queue it so the server tells the ledger at boot (ledger.accountChanged, the same
// path as /api/accounts/assign), which re-posts the held events. Accounts someone already assigned are untouched.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('account_reassignments')
    .ifNotExists()
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('account_id', 'text', (c) => c.notNull().references('accounts.id'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  const rows = (await db
    .selectFrom('accounts')
    .innerJoin('connections', 'connections.id', 'accounts.connection_id')
    .select(['accounts.id as account_id', 'accounts.workspace_id as workspace_id', 'connections.entity_id as entity_id'])
    .where('accounts.entity_id', 'is', null)
    .where('connections.entity_id', 'is not', null)
    .execute()) as Array<{ account_id: string; workspace_id: string; entity_id: string }>
  const at = new Date().toISOString()
  for (const r of rows) {
    await db.updateTable('accounts').set({ entity_id: r.entity_id }).where('id', '=', r.account_id).where('entity_id', 'is', null).execute()
    await db.insertInto('account_reassignments').values({ id: `backfill_${r.account_id}`, workspace_id: r.workspace_id, account_id: r.account_id, created_at: at }).execute()
  }
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('account_reassignments').execute()
}
