// The parts of PayPal's REST responses we read (Transaction Search v1, Invoicing v2, OAuth2, Webhooks v1).
// Everything else stays in the raw payload.

export interface PayPalMoney {
  currency_code: string
  /** Decimal string, signed (e.g. "-0.59"). */
  value: string
}

export interface PayPalTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  app_id?: string
  scope?: string
}

export interface PayPalBalanceDetail {
  currency: string
  primary?: boolean
  total_balance: PayPalMoney
  available_balance?: PayPalMoney
  withheld_balance?: PayPalMoney
}

export interface PayPalBalancesResponse {
  balances?: PayPalBalanceDetail[]
  account_id?: string
  as_of_time?: string
  last_refresh_time?: string
}

export interface PayPalTransactionInfo {
  paypal_account_id?: string
  transaction_id: string
  paypal_reference_id?: string
  paypal_reference_id_type?: string
  transaction_event_code?: string
  transaction_initiation_date?: string
  transaction_updated_date?: string
  transaction_amount?: PayPalMoney
  fee_amount?: PayPalMoney
  /** D denied, P pending, S success, V reversed. */
  transaction_status?: string
  transaction_subject?: string
  transaction_note?: string
  bank_reference_id?: string
  invoice_id?: string
  custom_field?: string
}

export interface PayPalPayerInfo {
  account_id?: string
  email_address?: string
  payer_name?: { given_name?: string; surname?: string; alternate_full_name?: string; full_name?: string }
}

export interface PayPalTransactionDetail {
  transaction_info: PayPalTransactionInfo
  payer_info?: PayPalPayerInfo
}

export interface PayPalSearchResponse {
  transaction_details?: PayPalTransactionDetail[]
  account_number?: string
  start_date?: string
  end_date?: string
  last_refreshed_datetime?: string
  page?: number
  total_items?: number
  total_pages?: number
}

export interface PayPalInvoice {
  id: string
  status: string
  detail?: {
    invoice_number?: string
    invoice_date?: string
    currency_code?: string
    payment_term?: { term_type?: string; due_date?: string }
  }
  primary_recipients?: Array<{
    billing_info?: {
      business_name?: string
      name?: { given_name?: string; surname?: string; full_name?: string }
      email_address?: string
    }
  }>
  amount?: { currency_code: string; value: string }
  due_amount?: PayPalMoney
  payments?: { paid_amount?: PayPalMoney }
  refunds?: { refund_amount?: PayPalMoney }
}

export interface PayPalInvoicesResponse {
  items?: PayPalInvoice[]
  total_items?: number
  total_pages?: number
}

export interface PayPalWebhookEvent {
  id?: string
  event_type?: string
  resource_type?: string
  create_time?: string
  resource?: Record<string, unknown>
}
