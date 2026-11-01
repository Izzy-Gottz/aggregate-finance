import type { Kysely } from 'kysely'

// The workspace's time zone (IANA, e.g. "America/New_York"): which calendar day a balance read at 02:00 UTC belongs
// to, and what "today" means for metrics and the Monday note. Null means America/New_York.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('workspaces').addColumn('time_zone', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('workspaces').dropColumn('time_zone').execute()
}
