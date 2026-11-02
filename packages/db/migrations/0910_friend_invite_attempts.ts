import type { Kysely } from 'kysely'

// friend_invites now holds every attempt, so the limits count before anything is looked up. `sent` tells the ones that
// became an email (1) from the rest (0): only those count toward the total cap, and against other inviters.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('friend_invites').addColumn('sent', 'integer', (c) => c.notNull().defaultTo(0)).execute()
  await db.updateTable('friend_invites').set({ sent: 1 }).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('friend_invites').dropColumn('sent').execute()
}
