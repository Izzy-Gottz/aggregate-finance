// The parts of Ramp's Developer API responses we read (https://docs.ramp.com, openapi/developer-api.json v1).
// Everything else stays in the raw payload. Money is integer minor units in the current API:
//   ApiSignedAmount {value, currency}: purchases positive, refunds/credits negative (card's point of view).
//   CurrencyAmount  {amount, currency_code, minor_unit_conversion_rate}.
// The decimal `amount` fields are deprecated; used only as a fallback.

export interface RampSignedAmount {
  value: number
  currency: string
}

export interface RampCurrencyAmount {
  amount: number
  currency_code?: string | null
  minor_unit_conversion_rate?: number | null
}

export interface RampPage<T> {
  data: T[]
  page: { next: string | null }
}

export type RampTxnState = 'CLEARED' | 'COMPLETION' | 'DECLINED' | 'ERROR' | 'PENDING' | 'PENDING_INITIATION' | string

export interface RampTransaction {
  id: string
  entity_amount?: RampSignedAmount | null
  /** Deprecated decimal dollars. */
  amount?: number | null
  currency_code?: string | null
  state: RampTxnState
  user_transaction_time: string
  settlement_date?: string | null
  merchant_name?: string | null
  merchant_descriptor?: string | null
  merchant_category_code?: string | null
  sk_category_name?: string | null
  memo?: string | null
  card_id?: string | null
  card_holder?: { user_id?: string | null; department_name?: string | null } | null
}

export type RampReimbursementState =
  | 'APPROVED' | 'AWAITING_EXPORT' | 'AWAITING_PAYMENT' | 'AWAITING_PUSH_PAYMENT' | 'CANCELED' | 'DELETED' | 'DRAFT'
  | 'EXPORTED' | 'EXPORT_FAILED' | 'EXPORT_INITIATED' | 'EXPORT_MARKED_AS_FAILED' | 'EXPORT_SUCCESSFUL'
  | 'FAILED_REIMBURSEMENT' | 'INIT' | 'MANUALLY_REIMBURSED' | 'MISSING_ACH' | 'PENDING' | 'PROCESSING'
  | 'PUSH_PAYMENT_FAILED' | 'PUSH_PAYMENT_INITIATED' | 'REIMBURSED' | 'REIMBURSED_VIA_PUSH' | 'REJECTED' | string

export interface RampReimbursement {
  id: string
  entity_amount?: { value: number; currency: string; minor_unit_conversion_rate?: number | null } | null
  /** Legacy decimal amount + currency. */
  amount?: number | null
  currency?: string | null
  state: RampReimbursementState
  type?: 'MILEAGE' | 'OUT_OF_POCKET' | 'PAYBACK_FULL' | 'PAYBACK_PARTIAL' | 'PER_DIEM' | string | null
  direction?: 'BUSINESS_TO_USER' | 'USER_TO_BUSINESS' | string | null
  created_at: string
  transaction_date?: string | null
  user_id?: string | null
  merchant?: string | null
  memo?: string | null
}

export interface RampBill {
  id: string
  amount: RampCurrencyAmount
  invoice_number?: string | null
  issued_at?: string | null
  due_at?: string | null
  created_at: string
  paid_at?: string | null
  memo?: string | null
  status?: 'OPEN' | 'PAID' | string | null
  approval_status?: 'APPROVED' | 'INITIALIZED' | 'PENDING' | 'REJECTED' | 'TERMINATED' | string | null
  status_summary?: string | null
  vendor?: { id?: string; name?: string | null } | null
  line_items?: Array<{ memo?: string | null; amount?: RampCurrencyAmount | null }> | null
}

export interface RampBusiness {
  id: string
  business_name_legal?: string | null
  business_name_on_card?: string | null
}

export interface RampBusinessBalance {
  card_balance_excluding_pending_amount?: RampCurrencyAmount | null
  card_balance_including_pending_amount?: RampCurrencyAmount | null
  /** Legacy decimal twins. */
  card_balance_including_pending?: number | null
  card_limit_amount?: RampCurrencyAmount | null
  next_billing_date?: string | null
  prev_billing_date?: string | null
}
