import type { Kysely } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
  // The grant a person chose on the control-sentence step, waiting to be bound to the OAuth consent.
  await db.schema
    .createTable('oauth_pending_grants')
    .addColumn('session_id', 'text', (c) => c.primaryKey())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()

  // Passkey re-checks, for "confirm it's you within the last 10 minutes" before sensitive actions.
  await db.schema
    .createTable('reauth_events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('method', 'text', (c) => c.notNull())
    .addColumn('at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('reauth_person_at').on('reauth_events').columns(['person_id', 'at']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('reauth_events').ifExists().execute()
  await db.schema.dropTable('oauth_pending_grants').ifExists().execute()
}
