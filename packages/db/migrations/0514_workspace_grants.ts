import type { Kysely } from 'kysely'

// Free time granted to a workspace (34, 2026-10-13: the YC Deal is a year of hosted free; creator links and by-hand
// grants are the same kind of thing). Durable: billing reads it when paid plans start. `months` counts from when the
// workspace's billing starts; `until` is a fixed last day instead. One of the two is set. Revoked rows stay (history).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('workspace_grants')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('months', 'integer')
    .addColumn('until', 'text')
    .addColumn('reason', 'text', (c) => c.notNull())
    .addColumn('granted_by', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'text')
    .execute()
  await db.schema.createIndex('workspace_grants_ws').on('workspace_grants').column('workspace_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('workspace_grants').execute()
}
