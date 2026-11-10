import type { Kysely } from 'kysely'

// BigCommerce single-click installs: BigCommerce opens our auth callback inside its control panel, we trade the code for
// the store's token, and that token waits here (sealed) until the installer signs in to Aggregate and the store is linked
// to their workspace. No workspace yet, so no workspace_id. The link is stored as a hash, one-time and short-lived, and
// only works for the installer's email.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('bigcommerce_pending_installs')
    .addColumn('store_hash', 'text', (c) => c.primaryKey())
    .addColumn('secret_enc', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('link_hash', 'text', (c) => c.unique())
    .addColumn('link_expires_at', 'text')
    .addColumn('link_email', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('bigcommerce_pending_installs').ifExists().execute()
}
