import type { Kysely } from 'kysely'

// The public no-sign-up demo (apps/server/src/public-demo.ts): one row naming the demo workspace, its system person and
// its read-only AI connection, plus the one being retired after the nightly rebuild. Read before any workspace is
// known (it says which one), so its columns are deliberately not named workspace_id: row-level security covers tables
// with that column, and this one is reached only through a named bypass.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('public_demo')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('current_ws', 'text', (c) => c.notNull())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('grant_id', 'text', (c) => c.notNull())
    .addColumn('built_at', 'text', (c) => c.notNull())
    .addColumn('retiring_ws', 'text')
    .addColumn('retiring_person', 'text')
    .addColumn('retire_after', 'text')
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('public_demo').ifExists().execute()
}
