import type { Kysely } from 'kysely'

// A bucket can hold money back in accounts (core/set-aside.ts): allocations, the count-in-cash switch, a goal, a note.
// Null on every bucket until someone sets one, so existing buckets behave as before.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ledger_buckets').addColumn('set_aside_json', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ledger_buckets').dropColumn('set_aside_json').execute()
}
