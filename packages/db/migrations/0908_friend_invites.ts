import type { Kysely } from 'kysely'

// Inviting a friend to their own Aggregate account (nothing of the inviter's is shared). Not creator_attributions: a row
// there is the "3 months free" perk, which these don't carry. Addresses are kept only as a keyed hash, enough to refuse a
// repeat. Person-level (no workspace_id), so outside RLS like `people`; gone with the person.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('friend_codes')
    .addColumn('person_id', 'text', (c) => c.primaryKey().references('people.id').onDelete('cascade'))
    .addColumn('code', 'text', (c) => c.notNull().unique())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createTable('friend_invites')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('inviter_id', 'text', (c) => c.notNull().references('people.id').onDelete('cascade'))
    .addColumn('email_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('friend_invites_inviter').on('friend_invites').columns(['inviter_id', 'created_at']).execute()
  await db.schema.createIndex('friend_invites_email').on('friend_invites').columns(['email_hash', 'created_at']).execute()
  await db.schema
    .createTable('friend_signups')
    .addColumn('person_id', 'text', (c) => c.primaryKey().references('people.id').onDelete('cascade'))
    .addColumn('inviter_id', 'text', (c) => c.notNull().references('people.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('friend_signups').execute()
  await db.schema.dropTable('friend_invites').execute()
  await db.schema.dropTable('friend_codes').execute()
}
