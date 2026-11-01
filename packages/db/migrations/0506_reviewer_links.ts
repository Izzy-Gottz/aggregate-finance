import type { Kysely } from 'kysely'

// Reviewer access links (docs/compliance/mcp-directory.md, Launch packet §3): a hashed, expiring, revocable token that
// signs a directory reviewer into a demo-only account. Person-level (no workspace_id): looked up before any workspace.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('reviewer_links')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('person_id', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('label', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('revoked_at', 'text')
    .addColumn('last_used_at', 'text')
    .addColumn('uses', 'integer', (c) => c.notNull().defaultTo(0))
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('reviewer_links').ifExists().execute()
}
