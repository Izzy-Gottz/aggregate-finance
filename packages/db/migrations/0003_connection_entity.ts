import type { Kysely } from 'kysely'

// The company a whole connection belongs to (QuickBooks file, Gusto company, cap table). Accounts keep their own entity_id.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').addColumn('entity_id', 'text', (c) => c.references('entities.id')).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').dropColumn('entity_id').execute()
}
