import type { Kysely } from 'kysely'

// Shopify managed install: Shopify installs the app, the embedded page exchanges its session token for the store's
// offline token, and that token waits here (sealed) until someone signs in to Aggregate and picks the workspace. No
// workspace yet, so no workspace_id. The link that attaches it is stored as a hash, one-time, short-lived.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('shopify_pending_installs')
    .addColumn('shop', 'text', (c) => c.primaryKey())
    .addColumn('secret_enc', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('link_hash', 'text', (c) => c.unique())
    .addColumn('link_expires_at', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('shopify_pending_installs').ifExists().execute()
}
