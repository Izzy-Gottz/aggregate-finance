import type { Kysely } from 'kysely'

// The provider's own data-as-of times from the last successful sync (Plaid Item status, balance timestamps), shown by MCP
// reads as data_as_of. Nullable, additive.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').addColumn('freshness_json', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('connections').dropColumn('freshness_json').execute()
}
