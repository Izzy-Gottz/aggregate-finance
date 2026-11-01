import type { Kysely } from 'kysely'

// S7/S9: shared rate-limit counters so several server instances enforce one limit (hosted).

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('rate_limit_counters')
    .addColumn('key', 'text', (c) => c.notNull())
    .addColumn('window_start', 'bigint', (c) => c.notNull())
    .addColumn('count', 'integer', (c) => c.notNull())
    .addPrimaryKeyConstraint('rate_limit_counters_pk', ['key', 'window_start'])
    .execute()
  await db.schema.createIndex('rate_limit_counters_window').on('rate_limit_counters').column('window_start').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('rate_limit_counters').ifExists().execute()
}
