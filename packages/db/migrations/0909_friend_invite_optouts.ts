import type { Kysely } from 'kysely'

// "Don't send me invites": the keyed hash of an address (as in 0908), never the address, kept until they undo it. It
// belongs to nobody's account, so no person or workspace column, and nothing outside this table can name who it is.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('friend_invite_optouts')
    .addColumn('email_hash', 'text', (c) => c.primaryKey())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('friend_invite_optouts').execute()
}
