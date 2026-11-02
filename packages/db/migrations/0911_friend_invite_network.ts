import type { Kysely } from 'kysely'

// A keyed hash of the network an invite came from, for the per-network limit. Kept for a day, then cleared by the daily
// retention job: a limit needs nothing older.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('friend_invites').addColumn('ip_hash', 'text').execute()
  await db.schema.createIndex('friend_invites_network').on('friend_invites').columns(['ip_hash', 'created_at']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropIndex('friend_invites_network').execute()
  await db.schema.alterTable('friend_invites').dropColumn('ip_hash').execute()
}
