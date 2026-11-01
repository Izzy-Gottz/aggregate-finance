import { sql, type Kysely } from 'kysely'

// The job queue's "one twin at a time" rule, held by the database (c7's multi-machine audit, 2026-10-15): at most one
// queued and one running job per (kind, unique_key). Before this it was checked with a read before the write, so two
// machines could both see no twin and both queue one (or both run one: the digest email or the backup twice).
// Existing duplicates go first: of queued twins the oldest stays; of running twins the one with the latest lease stays
// and the others are marked done (their work is the same as the one still running). The index conditions are literal
// SQL: SQLite only uses a partial index for ON CONFLICT when the statement's condition matches it word for word.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    DELETE FROM jobs WHERE status = 'queued' AND unique_key IS NOT NULL AND id IN (
      SELECT j.id FROM jobs j JOIN jobs k
        ON k.kind = j.kind AND k.unique_key = j.unique_key AND k.status = 'queued' AND k.id <> j.id
       AND (k.created_at < j.created_at OR (k.created_at = j.created_at AND k.id < j.id))
      WHERE j.status = 'queued'
    )`.execute(db)
  await sql`
    UPDATE jobs SET status = 'done', lease_until = NULL, last_error = 'a twin of this job was running'
    WHERE status = 'running' AND unique_key IS NOT NULL AND id IN (
      SELECT j.id FROM jobs j JOIN jobs k
        ON k.kind = j.kind AND k.unique_key = j.unique_key AND k.status = 'running' AND k.id <> j.id
       AND (COALESCE(k.lease_until, '') > COALESCE(j.lease_until, '') OR (COALESCE(k.lease_until, '') = COALESCE(j.lease_until, '') AND k.id < j.id))
      WHERE j.status = 'running'
    )`.execute(db)
  await db.schema.createIndex('jobs_one_queued').unique().on('jobs').columns(['kind', 'unique_key']).where(sql<boolean>`status = 'queued'`).execute()
  await db.schema.createIndex('jobs_one_running').unique().on('jobs').columns(['kind', 'unique_key']).where(sql<boolean>`status = 'running'`).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('jobs_one_running').ifExists().execute()
  await db.schema.dropIndex('jobs_one_queued').ifExists().execute()
}
