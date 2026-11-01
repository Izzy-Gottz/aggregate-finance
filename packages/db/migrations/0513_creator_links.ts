import type { Kysely } from 'kysely'

// Creator links (Yisrael, 2026-10-12): people who sign up through a creator's link get 3 months free once pricing
// starts, for the first 100 sign-ups per link, links valid through 2026-12-31. Only the attribution is stored: which
// person came through which code, once. Person-level (no workspace_id), so outside RLS like `people`.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('creator_links')
    .addColumn('code', 'text', (c) => c.primaryKey())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('cap', 'integer', (c) => c.notNull().defaultTo(100))
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('creator_attributions')
    // One row per person ever; gone with the person (wipe, orphan cleanup) and removed by account deletion.
    .addColumn('person_id', 'text', (c) => c.primaryKey().references('people.id').onDelete('cascade'))
    .addColumn('code', 'text', (c) => c.notNull().references('creator_links.code'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('creator_attributions_code').on('creator_attributions').column('code').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('creator_attributions').execute()
  await db.schema.dropTable('creator_links').execute()
}
