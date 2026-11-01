import { sql, type Kysely } from 'kysely'

// Postgres only (a no-op on SQLite): re-analyze the big ledger tables after ~2% of their rows change instead of the
// default 10%. A new workspace's fill is a tiny share of a large multi-tenant table, so with the default the planner
// kept stale estimates for hours (the 11–23 s overview spike, docs/launch/load-runbook.md). Autovacuum does this in the
// background, never on a request.

export const AUTOANALYZE_TABLES = ['journal_lines', 'journal_entries', 'ledger_records'] as const

const onPostgres = (db: Kysely<any>) => sql`select current_setting('server_version')`.execute(db).then(() => true, () => false)

export async function up(db: Kysely<any>): Promise<void> {
  if (!(await onPostgres(db))) return
  for (const t of AUTOANALYZE_TABLES) await sql`alter table ${sql.table(t)} set (autovacuum_analyze_scale_factor = 0.02, autovacuum_analyze_threshold = 500)`.execute(db)
}

export async function down(db: Kysely<any>): Promise<void> {
  if (!(await onPostgres(db))) return
  for (const t of AUTOANALYZE_TABLES) await sql`alter table ${sql.table(t)} reset (autovacuum_analyze_scale_factor, autovacuum_analyze_threshold)`.execute(db)
}
