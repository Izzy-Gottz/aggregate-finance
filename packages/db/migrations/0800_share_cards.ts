import type { Kysely } from 'kysely'

// S8: shareable answer cards (apps/server/src/share.ts). A draft has no snapshot; publishing freezes what the card
// shows; revoking clears it. Workspace-scoped (RLS covers it like every table with workspace_id).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('share_cards')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('entity_id', 'text', (c) => c.notNull().references('entities.id'))
    .addColumn('created_by', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('snapshot', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('published_at', 'text')
    .addColumn('revoked_at', 'text')
    .execute()
  await db.schema.createIndex('share_cards_workspace_idx').on('share_cards').columns(['workspace_id', 'created_at']).execute()
  await db.schema.createIndex('share_cards_entity_idx').on('share_cards').column('entity_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('share_cards').ifExists().execute()
}
