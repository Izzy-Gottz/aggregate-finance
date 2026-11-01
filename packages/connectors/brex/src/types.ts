// The parts of Brex's API responses we read (https://developer.brex.com, transactions_api.yaml). Everything else
// stays in the raw payload. Brex Money is {amount: integer minor units, currency}.
//
// Signs: Brex card transactions are from the card's point of view: a PURCHASE is positive (it raises what is owed)
// and a COLLECTION ("Payment - Thank you!") is negative. Aggregate's rule is + = money in to the account, so card
// amounts are negated. Cash transactions are taken as signed from the cash account's view (+ in, − out).

export interface BrexMoney {
  amount: number
  currency?: string | null
}

export interface BrexPage<T> {
  next_cursor?: string | null
  items: T[]
}

export interface BrexCashAccount {
  id: string
  name: string
  status?: 'ACTIVE' | string | null
  current_balance: BrexMoney
  available_balance: BrexMoney
  account_number?: string
  routing_number?: string
  primary: boolean
}

export interface BrexCardAccount {
  id: string
  status?: string | null
  /** Amount owed on the card (positive). */
  current_balance?: BrexMoney | null
  available_balance?: BrexMoney | null
  account_limit?: BrexMoney | null
  current_statement_period?: { start_date: string; end_date: string }
}

export type BrexCashTxnType =
  | 'PAYMENT'
  | 'DIVIDEND'
  | 'FEE'
  | 'ADJUSTMENT'
  | 'INTEREST'
  | 'CARD_COLLECTION'
  | 'REWARDS_REDEMPTION'
  | 'INTRA_CUSTOMER_ACCOUNT_BOOK_TRANSFER'
  | 'BOOK_TRANSFER'
  | string

export interface BrexCashTransaction {
  id: string
  description: string
  amount?: BrexMoney | null
  initiated_at_date: string
  posted_at_date: string
  type?: BrexCashTxnType | null
  /** Payments API transfer id (GET /v1/transfers/{id}). */
  transfer_id?: string | null
}

export type BrexCardTxnType = 'PURCHASE' | 'REFUND' | 'CHARGEBACK' | 'REWARDS_CREDIT' | 'COLLECTION' | 'BNPL_FEE' | string

export interface BrexCardTransaction {
  id: string
  card_id?: string | null
  description: string
  amount: BrexMoney
  initiated_at_date: string
  posted_at_date: string
  type?: BrexCardTxnType | null
  merchant?: { raw_descriptor: string; mcc: string; country: string } | null
  card_metadata?: Record<string, string> | null
  expense_id?: string | null
  card_transaction_operation_reference_id?: string | null
}

export interface BrexWebhookBody {
  event_type?: string
  company_id?: string
  transfer_id?: string
  expense_id?: string
  [k: string]: unknown
}
