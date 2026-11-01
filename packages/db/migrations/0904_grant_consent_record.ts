import type { Kysely } from 'kysely'

// Evidence of what a person agreed to when they connected an AI (Intuit, case #00231347, 2026-10-27: written consent per
// customer, with evidence kept). Each grant keeps the disclosure version shown, a sha256 of the exact line (with the AI's
// name filled in), and the connected sources (connector keys) its companies had at approval. Older grants stay null.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('grants').addColumn('consent_version', 'text').execute()
  await db.schema.alterTable('grants').addColumn('consent_sha256', 'text').execute()
  await db.schema.alterTable('grants').addColumn('consent_sources_json', 'text').execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('grants').dropColumn('consent_sources_json').execute()
  await db.schema.alterTable('grants').dropColumn('consent_sha256').execute()
  await db.schema.alterTable('grants').dropColumn('consent_version').execute()
}
