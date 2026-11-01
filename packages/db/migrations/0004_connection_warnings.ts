import type { Kysely } from 'kysely'

// Non-fatal notes from the last sync ("fees not exposed by this provider"), shown on the connection row.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').addColumn('warnings_json', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').dropColumn('warnings_json').execute()
}
