import type { Kysely } from 'kysely'

// The challenge deployment's record of every outbound HTTP call (apps/server/src/challenge/outbound.ts): the evidence
// for "it moved money". Written from any context (including bypass), so the workspace column is `ws`, not
// workspace_id: this table is operator-only and never read by a request.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('outbound_calls')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('method', 'text', (c) => c.notNull())
    .addColumn('host', 'text', (c) => c.notNull())
    .addColumn('path', 'text', (c) => c.notNull())
    .addColumn('status', 'integer')
    .addColumn('ms', 'integer')
    .addColumn('ws', 'text')
    .execute()
  await db.schema.createIndex('outbound_calls_at').on('outbound_calls').column('at').execute()
  // Planted flags (tier B): only a hash of each value, so judges can match a report without the table giving it away.
  await db.schema
    .createTable('challenge_flags')
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('sha256', 'text', (c) => c.notNull())
    .addColumn('planted_at', 'text', (c) => c.notNull())
    .addColumn('ws', 'text')
    .execute()
  // What each player's AI did (tier C), kept past the nightly reset that deletes their workspace: 90 days.
  await db.schema
    .createTable('challenge_activity')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('ws', 'text', (c) => c.notNull())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('row_json', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('challenge_activity_at').on('challenge_activity').column('at').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('challenge_activity').ifExists().execute()
  await db.schema.dropTable('challenge_flags').ifExists().execute()
  await db.schema.dropTable('outbound_calls').ifExists().execute()
}
