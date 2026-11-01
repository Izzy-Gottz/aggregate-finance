import type { Kysely } from 'kysely'

// A 6-digit code in the same email as each sign-in and re-check link, for when the email opens in another browser or
// on a phone (apps/server/src/email-codes.ts). Codes are stored as hashes, expire with the link (10 minutes), allow 5
// tries, and work once. A sign-in code works only in the browser that asked for it (nonce cookie).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('signin_codes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull())
    .addColumn('code_hash', 'text', (c) => c.notNull())
    .addColumn('nonce_hash', 'text', (c) => c.notNull())
    // The magic link's token: entering the code verifies that same link, so the link and the code share one use.
    .addColumn('link_token', 'text', (c) => c.notNull())
    .addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('used_at', 'text')
    .execute()
  await db.schema.createIndex('signin_codes_nonce_idx').on('signin_codes').column('nonce_hash').execute()
  await db.schema.alterTable('recheck_links').addColumn('code_hash', 'text').execute()
  await db.schema.alterTable('recheck_links').addColumn('attempts', 'integer', (c) => c.notNull().defaultTo(0)).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('signin_codes').ifExists().execute()
}
