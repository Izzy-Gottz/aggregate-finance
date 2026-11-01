import type { Kysely } from 'kysely'

// S7/S9 usage metering: event samples (sync durations, emails) and one rollup row per workspace per day.
// Instance-wide counts use workspace_id '_' (emails are not tied to a workspace).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('usage_samples')
    .addColumn('workspace_id', 'text', (c) => c.notNull())
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('metric', 'text', (c) => c.notNull())
    .addColumn('value', 'bigint', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('usage_samples_day').on('usage_samples').columns(['day', 'workspace_id', 'metric']).execute()
  await db.schema
    .createTable('usage_daily')
    .addColumn('workspace_id', 'text', (c) => c.notNull())
    .addColumn('day', 'text', (c) => c.notNull())
    .addColumn('json', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('usage_daily_pk', ['workspace_id', 'day'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('usage_daily').ifExists().execute()
  await db.schema.dropTable('usage_samples').ifExists().execute()
}
