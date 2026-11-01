import type { Kysely } from 'kysely'

// S7: pause one AI without revoking it ("Connect your AI" drawer → Pause).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('grants').addColumn('paused_at', 'text').execute()
  await db.schema.alterTable('grants').addColumn('paused_by', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('grants').dropColumn('paused_by').execute()
  await db.schema.alterTable('grants').dropColumn('paused_at').execute()
}
