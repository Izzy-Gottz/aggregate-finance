import type { Kysely } from 'kysely'

// S1: deletions a connector can only show by leaving things out. A record's last_seen_at is when a sync last carried
// it; when a full listing completes (listing.complete), records of those kinds it didn't carry are voided. The latest
// outcome per connection and kind is kept for data health (voided, or skipped by the safety limits and why).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('ledger_records').addColumn('last_seen_at', 'text').execute()
  await db.schema
    .createTable('ledger_listings')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('connection_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('started_at', 'text', (c) => c.notNull())
    .addColumn('applied_at', 'text', (c) => c.notNull())
    .addColumn('seen', 'integer', (c) => c.notNull())
    .addColumn('voided', 'integer', (c) => c.notNull())
    .addColumn('skipped_reason', 'text')
    .addPrimaryKeyConstraint('ledger_listings_pk', ['workspace_id', 'connection_id', 'kind'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_listings').ifExists().execute()
  await db.schema.alterTable('ledger_records').dropColumn('last_seen_at').execute()
}
