import { sql, type Kysely } from 'kysely'

// S1: which matcher version last looked at a workspace's whole history. When matching learns something new, the next
// settle re-matches everything once, so rows that came in before (still "What is this money?") get the new answers.
// Existing workspaces start at 1 (before this table); a new workspace is matched by the current version from the start.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_matcher_runs')
    .addColumn('workspace_id', 'text', (c) => c.primaryKey().references('workspaces.id'))
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('ran_at', 'text', (c) => c.notNull())
    .execute()
  await sql`insert into ledger_matcher_runs (workspace_id, version, ran_at) select id, 1, ${new Date().toISOString()} from workspaces`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_matcher_runs').ifExists().execute()
}
