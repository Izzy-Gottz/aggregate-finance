import type { Kysely } from 'kysely'

// One-time "it's you" links by email (apps/server/src/recheck.ts): the fallback for a person whose passkey isn't on
// this device. Stored as a hash, valid 10 minutes, usable once. Person-level (no workspace_id).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('recheck_links')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('used_at', 'text')
    .execute()
  await db.schema.createIndex('recheck_links_person_idx').on('recheck_links').column('person_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('recheck_links').ifExists().execute()
}
