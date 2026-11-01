import type { Kysely } from 'kysely'

// Security fix: a pending AI grant belongs to one (session, OAuth client) pair, not to the whole session, so a second
// AI client started in the same browser can't be bound to the first client's grant. Rows live 15 minutes, so the table
// is recreated rather than migrated.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('oauth_pending_grants').ifExists().execute()
  await db.schema
    .createTable('oauth_pending_grants')
    .addColumn('session_id', 'text', (c) => c.notNull())
    .addColumn('client_id', 'text', (c) => c.notNull())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('oauth_pending_grants_pk', ['session_id', 'client_id'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('oauth_pending_grants').ifExists().execute()
  await db.schema
    .createTable('oauth_pending_grants')
    .addColumn('session_id', 'text', (c) => c.primaryKey())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
}
