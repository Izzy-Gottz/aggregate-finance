import type { Kysely } from 'kysely'

// S6: the cap table's connection (connector_key 'equity', no credentials) was queued by the hourly sync and failed as
// "connector equity is not installed". The sync engine now treats such records-only connections as up to date
// (packages/sync holdsRecordsOnly); this clears the error those runs left behind.

export async function up(db: Kysely<any>): Promise<void> {
  await db
    .updateTable('connections')
    .set({ status: 'active', last_error: null })
    .where('status', '=', 'error')
    .where('secret_enc', 'is', null)
    .where('last_error', 'like', 'connector % is not installed')
    .execute()
}

export async function down(): Promise<void> {}
