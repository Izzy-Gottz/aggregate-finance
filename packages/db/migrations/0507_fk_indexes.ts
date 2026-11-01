import type { Kysely } from 'kysely'

// Indexes on foreign-key columns that deletes check row by row. Without them, deleting a workspace (DELETE
// /api/workspace, account deletion, the member-less-workspace pass) made Postgres scan every workspace's rows once per
// deleted row: journal_entries.reverses_id for each entry, journal_lines.ledger_account_id for each ledger account.
// On hosted that ran past the 30 s statement timeout, so nothing was deleted. Found by the orphan pass (2026-10-11).

const INDEXES: Array<[name: string, table: string, column: string]> = [
  ['journal_entries_reverses_id_idx', 'journal_entries', 'reverses_id'],
  ['journal_entries_entity_id_idx', 'journal_entries', 'entity_id'],
  ['journal_lines_ledger_account_id_idx', 'journal_lines', 'ledger_account_id'],
  ['ledger_links_from_id_idx', 'ledger_links', 'from_id'],
  ['ledger_links_to_id_idx', 'ledger_links', 'to_id'],
  ['ledger_rule_applications_record_id_idx', 'ledger_rule_applications', 'record_id'],
  ['ledger_rule_applications_rule_id_idx', 'ledger_rule_applications', 'rule_id'],
  ['ledger_accounts_entity_id_idx', 'ledger_accounts', 'entity_id'],
  ['accounts_entity_id_idx', 'accounts', 'entity_id'],
  ['ledger_buckets_entity_id_idx', 'ledger_buckets', 'entity_id'],
  ['entities_parent_entity_id_idx', 'entities', 'parent_entity_id'],
  ['accounts_duplicate_of_idx', 'accounts', 'duplicate_of'],
  ['payroll_runs_connection_id_idx', 'payroll_runs', 'connection_id'],
  ['agent_keys_grant_id_idx', 'agent_keys', 'grant_id'],
]

export async function up(db: Kysely<any>): Promise<void> {
  for (const [name, table, column] of INDEXES) await db.schema.createIndex(name).ifNotExists().on(table).column(column).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const [name] of INDEXES) await db.schema.dropIndex(name).ifExists().execute()
}
