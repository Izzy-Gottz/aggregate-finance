// The parts of Square's API responses we read (Locations, Merchants, Payouts, Invoices, OAuth). Square money is
// already in minor units: {amount: integer, currency: "USD"}.

export interface SquareMoney {
  amount?: number | null
  currency?: string | null
}

export interface SquareError {
  category?: string
  code?: string
  detail?: string
  field?: string
}

export interface SquareLocation {
  id: string
  name?: string
  merchant_id?: string
  currency?: string
  country?: string
  status?: string
  /** IANA zone of the location (e.g. America/Los_Angeles): its business day. */
  timezone?: string
}

export interface SquareMerchant {
  id: string
  business_name?: string
  country?: string
  currency?: string
  status?: string
}

export interface SquarePayout {
  id: string
  /** SENT, FAILED or PAID. */
  status?: string
  location_id?: string
  created_at?: string
  updated_at?: string
  /** Amount sent to the destination (negative when Square debits the bank). */
  amount_money?: SquareMoney
  destination?: { type?: string; id?: string }
  version?: number
  type?: string
  payout_fee?: Array<{ amount_money?: SquareMoney; effective_at?: string; type?: string }>
  arrival_date?: string
  end_to_end_id?: string
}

export interface SquarePayoutEntry {
  id: string
  payout_id: string
  effective_at?: string
  type?: string
  gross_amount_money?: SquareMoney
  fee_amount_money?: SquareMoney
  net_amount_money?: SquareMoney
  /** type_charge_details, type_refund_details, type_dispute_details... each may carry payment_id/refund_id/dispute_id. */
  [details: `type_${string}_details`]: Record<string, unknown> | undefined
}

export interface SquareInvoice {
  id: string
  version?: number
  location_id?: string
  order_id?: string
  invoice_number?: string
  title?: string
  status?: string
  created_at?: string
  updated_at?: string
  sale_or_service_date?: string
  primary_recipient?: {
    customer_id?: string
    given_name?: string
    family_name?: string
    company_name?: string
    email_address?: string
  }
  payment_requests?: Array<{
    uid?: string
    request_type?: string
    due_date?: string
    computed_amount_money?: SquareMoney
    total_completed_amount_money?: SquareMoney
  }>
}

export interface SquareTokenResponse {
  access_token?: string
  token_type?: string
  expires_at?: string
  merchant_id?: string
  refresh_token?: string
  short_lived?: boolean
  refresh_token_expires_at?: string
  errors?: SquareError[]
}

export interface SquareWebhookBody {
  merchant_id?: string
  type?: string
  event_id?: string
  created_at?: string
  data?: { type?: string; id?: string; object?: unknown }
}

export interface SquareProcessingFee {
  effective_at?: string
  type?: string
  amount_money?: SquareMoney
}

export interface SquarePayment {
  id: string
  status?: string
  source_type?: string
  created_at?: string
  location_id?: string
  total_money?: SquareMoney
  amount_money?: SquareMoney
  processing_fee?: SquareProcessingFee[] | null
  note?: string | null
  buyer_email_address?: string | null
  card_details?: { card?: { cardholder_name?: string | null } | null } | null
  /** For source_type EXTERNAL: how it was paid outside Square (CHECK, BANK_TRANSFER, OTHER…). */
  external_details?: { type?: string | null; source?: string | null } | null
}

export interface SquareRefund {
  id: string
  status?: string
  payment_id?: string
  created_at?: string
  location_id?: string
  amount_money?: SquareMoney
  processing_fee?: SquareProcessingFee[] | null
  /** Where the money went back: CARD, CASH, EXTERNAL… (cash and other tenders come out of the drawer). */
  destination_type?: string | null
}
