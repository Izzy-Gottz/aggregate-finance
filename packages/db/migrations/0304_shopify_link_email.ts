import type { Kysely } from 'kysely'

// The Shopify staff member's email the "Connect to Aggregate" link was issued to (from the online token exchange):
// only an Aggregate person signed in with that email can use the link.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('shopify_pending_installs').addColumn('link_email', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('shopify_pending_installs').dropColumn('link_email').execute()
}
