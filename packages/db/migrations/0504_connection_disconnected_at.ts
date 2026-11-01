import type { Kysely } from 'kysely'

// Data-retention policy §8: raw payloads of a disconnected connection are purged 30 days after disconnect, so the
// disconnect time is recorded. Existing disconnected rows get stamped by the first purge run (the clock starts then).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').addColumn('disconnected_at', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').dropColumn('disconnected_at').execute()
}
