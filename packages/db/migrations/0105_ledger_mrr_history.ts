import type { Kysely } from 'kysely'

// S1: subscription MRR over time. A subscription record holds only its latest state; each change in its monthly
// value is kept here (dated), so MRR on any past day and the monthly movements (new, expansion, churn) can be told.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_mrr_points')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('record_id', 'text', (c) => c.notNull())
    .addColumn('date', 'text', (c) => c.notNull())
    .addColumn('mrr_minor', 'bigint', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('ledger_mrr_points_record').on('ledger_mrr_points').columns(['workspace_id', 'record_id', 'date']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_mrr_points').ifExists().execute()
}
