// The parts of Plaid's API responses we read. Everything else stays in the raw payload.

export interface PlaidBalances {
  current: number | null
  available: number | null
  limit: number | null
  iso_currency_code: string | null
  unofficial_currency_code?: string | null
  /** When the institution last updated the balance. Plaid gives it for some institutions only (Capital One, Apple Card). */
  last_updated_datetime?: string | null
}

export interface PlaidAccount {
  account_id: string
  name: string
  official_name?: string | null
  mask?: string | null
  type: 'depository' | 'credit' | 'loan' | 'investment' | 'brokerage' | 'other' | string
  subtype?: string | null
  holder_category?: 'business' | 'personal' | 'unrecognized' | null
  balances: PlaidBalances
}

export interface PlaidItem {
  item_id: string
  institution_id?: string | null
  institution_name?: string | null
  webhook?: string | null
  error?: { error_type: string; error_code: string; error_message?: string; display_message?: string | null } | null
  products?: string[]
  consented_products?: string[]
  billed_products?: string[]
  consent_expiration_time?: string | null
}

/** /item/get's top-level `status`: when Plaid last refreshed each product from the institution. */
export interface PlaidItemStatus {
  transactions?: { last_successful_update?: string | null; last_failed_update?: string | null } | null
  investments?: { last_successful_update?: string | null; last_failed_update?: string | null } | null
}

export interface PlaidTransaction {
  transaction_id: string
  account_id: string
  /** Positive = money out of the account (Plaid's convention; we flip it). */
  amount: number
  iso_currency_code: string | null
  unofficial_currency_code?: string | null
  date: string
  authorized_date?: string | null
  name: string
  original_description?: string | null
  merchant_name?: string | null
  pending: boolean
  pending_transaction_id?: string | null
  payment_channel?: string | null
  check_number?: string | null
  personal_finance_category?: { primary?: string | null; detailed?: string | null; confidence_level?: string | null } | null
  counterparties?: Array<{ name?: string | null; type?: string | null }> | null
  payment_meta?: {
    reference_number?: string | null
    ppd_id?: string | null
    payee?: string | null
    payer?: string | null
    by_order_of?: string | null
  } | null
}

export interface PlaidTransactionsSyncResponse {
  added: PlaidTransaction[]
  modified: PlaidTransaction[]
  removed: Array<{ transaction_id: string; account_id?: string }>
  next_cursor: string
  has_more: boolean
  accounts?: PlaidAccount[]
  transactions_update_status?: string
}

export interface PlaidAccountsGetResponse {
  accounts: PlaidAccount[]
  item: PlaidItem
}

export interface PlaidCreditLiability {
  account_id: string | null
  aprs?: Array<{ apr_percentage: number; apr_type: string }>
  last_payment_amount?: number | null
  last_payment_date?: string | null
  last_statement_balance?: number | null
  last_statement_issue_date?: string | null
  minimum_payment_amount?: number | null
  next_payment_due_date?: string | null
}

export interface PlaidMortgageLiability {
  account_id: string
  interest_rate?: { percentage?: number | null } | null
  last_payment_amount?: number | null
  last_payment_date?: string | null
  maturity_date?: string | null
  next_monthly_payment?: number | null
  next_payment_due_date?: string | null
  origination_principal_amount?: number | null
}

export interface PlaidStudentLiability {
  account_id: string | null
  interest_rate_percentage?: number | null
  last_payment_amount?: number | null
  last_payment_date?: string | null
  last_statement_balance?: number | null
  last_statement_issue_date?: string | null
  minimum_payment_amount?: number | null
  next_payment_due_date?: string | null
  origination_principal_amount?: number | null
  expected_payoff_date?: string | null
}

/** Auto, home-equity and other installment loans (Plaid's newer `loan` liability type). */
export interface PlaidLoanLiability {
  account_id: string | null
  interest_rate?: { percentage?: number | null } | null
  last_payment_amount?: number | null
  last_payment_date?: string | null
  maturity_date?: string | null
  next_payment_amount?: number | null
  next_payment_due_date?: string | null
  origination_principal_amount?: number | null
}

export interface PlaidLiabilitiesResponse {
  accounts: PlaidAccount[]
  liabilities: {
    credit?: PlaidCreditLiability[] | null
    mortgage?: PlaidMortgageLiability[] | null
    student?: PlaidStudentLiability[] | null
    loan?: PlaidLoanLiability[] | null
  }
}

export interface PlaidHolding {
  account_id: string
  security_id: string
  quantity: number
  institution_price?: number | null
  institution_value: number
  cost_basis?: number | null
  iso_currency_code?: string | null
  unofficial_currency_code?: string | null
}

export interface PlaidSecurity {
  security_id: string
  ticker_symbol?: string | null
  name?: string | null
  type?: string | null
}

export interface PlaidHoldingsResponse {
  accounts: PlaidAccount[]
  holdings: PlaidHolding[]
  securities: PlaidSecurity[]
}

export interface PlaidInvestmentTransaction {
  investment_transaction_id: string
  account_id: string
  security_id?: string | null
  date: string
  name: string
  /** Positive = cash debited from the account (e.g. a buy); negative = cash credited (sale, dividend). */
  amount: number
  quantity?: number
  fees?: number | null
  type: 'buy' | 'sell' | 'cancel' | 'cash' | 'fee' | 'transfer' | string
  subtype?: string | null
  iso_currency_code?: string | null
  unofficial_currency_code?: string | null
}

export interface PlaidInvestmentTxnsResponse {
  accounts: PlaidAccount[]
  investment_transactions: PlaidInvestmentTransaction[]
  securities: PlaidSecurity[]
  total_investment_transactions: number
}

export interface PlaidWebhookBody {
  webhook_type: string
  webhook_code: string
  item_id?: string
  error?: { error_code?: string; error_type?: string } | null
  environment?: string
}
