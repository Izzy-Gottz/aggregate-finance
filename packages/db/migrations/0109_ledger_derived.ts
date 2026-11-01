import type { Kysely } from 'kysely'

// S1: results derived from a workspace's whole ledger (an overview answer, the checks run, review items), kept for the
// ledger version they were computed at, so a machine that starts cold reads what another one computed (one statement)
// instead of rebuilding it (f8's run K: a cloned machine at peak ran 267 statements and ~8 s of CPU per first overview).
// Nothing here is a record: every row can be recomputed, so it's left out of backups, and a write at a newer version
// prunes the workspace's older rows. Row-level security covers it like every workspace_id table (found at boot).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('ledger_derived')
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('key_hash', 'text', (c) => c.notNull())
    // The key itself, so a starting machine can load what's current into memory before it takes traffic (prewarm).
    .addColumn('cache_key', 'text', (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('value_json', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('ledger_derived_pk', ['workspace_id', 'key_hash'])
    .execute()
  await db.schema.createIndex('ledger_derived_created').on('ledger_derived').column('created_at').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('ledger_derived').ifExists().execute()
}
