import type { Kysely } from 'kysely'

// S4/S5 tables (agfn-af): invoices, bills, payments, credit notes, and payroll runs. Typed in @agfn/invoices/db.
// Each row keeps the normalized event it came from (event_json), so the AR/AP subledger can always be rebuilt.
// Money moves only through the ledger (packages/core); these tables are the documents and their state.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('books_documents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('entity_id', 'text', (c) => c.notNull().references('entities.id'))
    // null for records added by a person or an AI (no provider behind them).
    .addColumn('connection_id', 'text', (c) => c.references('connections.id'))
    // connection id, or "manual:<entityId>": with doc_type + external_id it identifies one provider object.
    .addColumn('source_key', 'text', (c) => c.notNull())
    .addColumn('doc_type', 'text', (c) => c.notNull()) // invoice | payment | credit_note
    .addColumn('external_id', 'text', (c) => c.notNull())
    .addColumn('direction', 'text', (c) => c.notNull()) // receivable | payable
    .addColumn('number', 'text')
    .addColumn('counterparty', 'text')
    .addColumn('doc_date', 'text', (c) => c.notNull())
    .addColumn('due_date', 'text')
    .addColumn('total_minor', 'bigint', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('event_json', 'text', (c) => c.notNull())
    .addColumn('added_by_json', 'text', (c) => c.notNull())
    .addColumn('write_request_id', 'text')
    .addColumn('note', 'text')
    .addColumn('document_id', 'text', (c) => c.references('documents.id'))
    .addColumn('voided_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema
    .createIndex('books_documents_source')
    .on('books_documents')
    .columns(['workspace_id', 'source_key', 'doc_type', 'external_id'])
    .unique()
    .execute()
  await db.schema.createIndex('books_documents_entity').on('books_documents').columns(['workspace_id', 'entity_id', 'doc_type']).execute()

  await db.schema
    .createTable('payroll_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('entity_id', 'text', (c) => c.notNull().references('entities.id'))
    .addColumn('connection_id', 'text', (c) => c.references('connections.id'))
    // connection id, "detect:<entityId>" (bank detection) or "register:<entityId>" (CSV upload).
    .addColumn('source_key', 'text', (c) => c.notNull())
    .addColumn('external_id', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull()) // provider | bank_detected | register_upload
    .addColumn('provider', 'text')
    .addColumn('pay_date', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('estimated', 'integer', (c) => c.notNull())
    .addColumn('gross_minor', 'bigint', (c) => c.notNull())
    .addColumn('employer_taxes_minor', 'bigint', (c) => c.notNull())
    .addColumn('net_minor', 'bigint', (c) => c.notNull())
    .addColumn('company_debit_minor', 'bigint')
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('employee_count', 'integer')
    .addColumn('event_json', 'text', (c) => c.notNull())
    .addColumn('voided_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('payroll_runs_source').on('payroll_runs').columns(['workspace_id', 'source_key', 'external_id']).unique().execute()
  await db.schema.createIndex('payroll_runs_entity_date').on('payroll_runs').columns(['workspace_id', 'entity_id', 'pay_date']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('payroll_runs').execute()
  await db.schema.dropTable('books_documents').execute()
}
