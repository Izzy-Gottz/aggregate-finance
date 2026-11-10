import type { Kysely } from 'kysely'

// Connect-from-chat links (apps/server/src/connect-source.ts), behind AGFN_CONNECT_FROM_CHAT.
// An AI with an owner/admin's connection mints one of these from chat; the owner opens it in Aggregate, signs in and
// approves, and only then does the real connect flow begin. Stored as a hash, bound to one workspace + provider +
// person, valid 15 minutes, usable once. The token itself is never stored or logged — only its sha256. It carries a
// workspace_id, so RLS covers it with the workspace policy automatically; the confirm page reaches it by token (before
// a workspace is known) under a named bypass, like recheck_links.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('connect_links')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('workspace_id', 'text', (c) => c.notNull())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('provider', 'text', (c) => c.notNull())
    .addColumn('entity_id', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('used_at', 'text')
    .execute()
  // Mint rate-limit counts recent rows per grant and per workspace; the confirm page claims by token_hash (unique).
  await db.schema.createIndex('connect_links_grant_idx').on('connect_links').columns(['grant_id', 'created_at']).execute()
  await db.schema.createIndex('connect_links_workspace_idx').on('connect_links').columns(['workspace_id', 'created_at']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('connect_links').ifExists().execute()
}
