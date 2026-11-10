import type { Kysely } from 'kysely'

// "Don't see your app? Request it +" (apps/server/src/connection-requests.ts): which apps a workspace asked us to add.
// One row per workspace and app (asking twice changes nothing). No person, IP or text: only the workspace, the app key
// from a fixed list, and when. It goes with the workspace (cascade), and it carries a workspace_id, so row-level
// security covers it with the workspace policy automatically.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('connection_requests')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id').onDelete('cascade'))
    .addColumn('app_key', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('connection_requests_pk', ['workspace_id', 'app_key'])
    .execute()
  // The operator count groups by app across workspaces.
  await db.schema.createIndex('connection_requests_app_idx').on('connection_requests').column('app_key').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('connection_requests').ifExists().execute()
}
