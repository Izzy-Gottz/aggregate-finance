import type { Kysely } from 'kysely'

// S2/S3 (meridn-63): things a connection needs from a person while it still works, e.g. "reconnect within 7 days"
// (Plaid PENDING_DISCONNECT) or "new accounts to choose" (NEW_ACCOUNTS_AVAILABLE). Typed in @agfn/connector-sdk/db.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('connection_attention')
    .addColumn('connection_id', 'text', (c) => c.notNull().references('connections.id'))
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('connection_attention_pk', ['connection_id', 'kind'])
    .execute()
  await db.schema.createIndex('connection_attention_ws').on('connection_attention').column('workspace_id').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('connection_attention').execute()
}
