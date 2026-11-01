import type { Kysely } from 'kysely'

// Which release each worker runs (jobs.ts release guard): during a deploy's overlap, workers of an older release stop
// claiming jobs once a newer release heartbeats, so a job never runs on code that doesn't know what it means.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('worker_releases')
    .addColumn('release', 'text', (c) => c.primaryKey())
    .addColumn('first_seen', 'text', (c) => c.notNull())
    .addColumn('last_seen', 'text', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('worker_releases').ifExists().execute()
}
