import type { Kysely } from 'kysely'

// Operator commands that reach every workspace at once (`agfn usage`, a dry `agfn ledger-rebuild`). Access to one
// workspace goes in its activity log instead. No workspace_id, so RLS doesn't apply.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('operator_access')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('operator', 'text', (c) => c.notNull())
    .addColumn('command', 'text', (c) => c.notNull())
    .addColumn('reason', 'text', (c) => c.notNull())
    .execute()
}
