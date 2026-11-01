import type { Kysely } from 'kysely'

// Card and loan terms and investment positions (agfn-af). Side data next to accounts, never ledger postings: the
// balance still comes from balance snapshots. Filled from the provider's events as they sync (Plaid Liabilities and
// Investments). Typed in apps/server/src/account-terms.ts.

export async function up(db: Kysely<any>): Promise<void> {
  // One row per account: the terms as last reported.
  await db.schema
    .createTable('account_liabilities')
    .addColumn('account_id', 'text', (c) => c.primaryKey().references('accounts.id'))
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('kind', 'text', (c) => c.notNull()) // credit | mortgage | student | other
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('apr', 'text')
    .addColumn('minimum_payment_minor', 'bigint')
    .addColumn('next_due_date', 'text')
    .addColumn('last_statement_balance_minor', 'bigint')
    .addColumn('last_statement_date', 'text')
    .addColumn('last_payment_minor', 'bigint')
    .addColumn('last_payment_date', 'text')
    .addColumn('origination_principal_minor', 'bigint')
    .addColumn('maturity_date', 'text')
    .addColumn('as_of', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('account_liabilities_ws').on('account_liabilities').columns(['workspace_id']).execute()

  // One row per account, security and day: the latest day is the current position, earlier days are history.
  await db.schema
    .createTable('account_holdings')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('workspace_id', 'text', (c) => c.notNull().references('workspaces.id'))
    .addColumn('account_id', 'text', (c) => c.notNull().references('accounts.id'))
    .addColumn('as_of_date', 'text', (c) => c.notNull())
    .addColumn('security_id', 'text', (c) => c.notNull())
    .addColumn('ticker', 'text')
    .addColumn('name', 'text')
    .addColumn('quantity', 'text', (c) => c.notNull())
    .addColumn('currency', 'text', (c) => c.notNull())
    .addColumn('value_minor', 'bigint', (c) => c.notNull())
    .addColumn('cost_basis_minor', 'bigint')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute()
  await db.schema.createIndex('account_holdings_day').on('account_holdings').columns(['account_id', 'as_of_date', 'security_id']).unique().execute()
  await db.schema.createIndex('account_holdings_ws').on('account_holdings').columns(['workspace_id', 'account_id', 'as_of_date']).execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('account_holdings').execute()
  await db.schema.dropTable('account_liabilities').execute()
}
