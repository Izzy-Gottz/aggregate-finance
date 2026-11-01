// The parts of Stripe's API objects we read (API version pinned in client.ts). Everything else stays in the raw payload.
// Amounts are integers in the currency's smallest unit; currencies are lower-case ISO codes.

export interface StripeList<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  url?: string
}

export interface StripeAccount {
  id: string
  object: 'account'
  business_profile?: { name?: string | null } | null
  settings?: { dashboard?: { display_name?: string | null } | null } | null
  default_currency?: string | null
  country?: string | null
}

export interface StripeBalanceAmount {
  amount: number
  currency: string
  source_types?: Record<string, number>
}

export interface StripeBalance {
  object: 'balance'
  available: StripeBalanceAmount[]
  pending: StripeBalanceAmount[]
  connect_reserved?: StripeBalanceAmount[] | null
  livemode: boolean
}

/** A balance transaction's `source` with expand[]=data.source: the charge/refund/dispute/payout/... object. */
export interface StripeExpandedSource {
  id: string
  object: string
  customer?: string | { id: string } | null
  charge?: string | { id: string } | null
  payment_intent?: string | { id: string } | null
  billing_details?: { name?: string | null; email?: string | null } | null
  receipt_email?: string | null
  description?: string | null
}

export interface StripeCustomer {
  id: string
  deleted?: boolean
  name?: string | null
  email?: string | null
}

export interface StripeBalanceTransaction {
  id: string
  object: 'balance_transaction'
  /** Gross, signed into the balance (charges +, refunds/payouts −). */
  amount: number
  /** Positive cost; negative when a fee is returned. */
  fee: number
  net: number
  currency: string
  created: number
  available_on?: number
  description?: string | null
  reporting_category?: string | null
  status?: 'available' | 'pending' | string
  type: string
  source: string | StripeExpandedSource | null
}

export interface StripePayout {
  id: string
  object: 'payout'
  amount: number
  currency: string
  arrival_date: number
  created: number
  automatic: boolean
  status: 'paid' | 'pending' | 'in_transit' | 'canceled' | 'failed' | string
  balance_transaction?: string | null
  statement_descriptor?: string | null
  trace_id?: { status?: string; value?: string | null } | null
}

export interface StripeInvoiceLine {
  id: string
  amount: number
  currency: string
  description?: string | null
  quantity?: number | null
  /** The billing period this line covers (a subscription line: the period it charges for). */
  period?: { start: number; end: number } | null
  discount_amounts?: Array<{ amount: number }> | null
  /** Basil and later: where the line came from (a subscription item, with whether it's a proration). */
  parent?: {
    type?: string | null
    subscription_item_details?: { subscription?: string | null; subscription_item?: string | null; proration?: boolean | null } | null
  } | null
}

export interface StripeInvoice {
  id: string
  object: 'invoice'
  number?: string | null
  customer?: string | { id: string } | null
  customer_name?: string | null
  currency: string
  status: 'draft' | 'open' | 'paid' | 'void' | 'uncollectible' | null
  created: number
  due_date?: number | null
  status_transitions?: { finalized_at?: number | null; paid_at?: number | null } | null
  total: number
  subtotal: number
  amount_due: number
  amount_paid: number
  amount_remaining?: number
  /** Basil (2025-03-31) and later: per-tax amounts. */
  total_taxes?: Array<{ amount: number }> | null
  /** Before Basil. */
  tax?: number | null
  lines: StripeList<StripeInvoiceLine>
  /** Expanded (expand[]=data.payments): the payments that paid it (Basil and later). */
  payments?: StripeList<{ status?: string | null; payment?: { type?: string; payment_intent?: string | { id: string } | null } | null }> | null
}

export interface StripeCoupon {
  id: string
  object: 'coupon'
  percent_off?: number | null
  amount_off?: number | null
  currency?: string | null
  currency_options?: Record<string, { amount_off: number }> | null
  duration: 'once' | 'repeating' | 'forever'
  valid?: boolean
}

/** Since 2025-09-30.clover the coupon hangs off `source`; older versions put it on `coupon`. */
export interface StripeDiscount {
  id: string
  object: 'discount'
  source?: { type?: string; coupon?: string | StripeCoupon | null } | null
  coupon?: string | StripeCoupon | null
  start?: number
  end?: number | null
}

export interface StripePrice {
  id: string
  object: 'price'
  currency: string
  product?: string | { id: string } | null
  unit_amount?: number | null
  unit_amount_decimal?: string | null
  billing_scheme?: 'per_unit' | 'tiered'
  /** Tiered prices: only with expand (price.tiers); up_to null is the last, unbounded tier. */
  tiers?: StripePriceTier[] | null
  tiers_mode?: 'graduated' | 'volume' | null
  /** Per-unit prices only: the quantity is divided (and rounded) before it is multiplied by unit_amount. */
  transform_quantity?: { divide_by: number; round: 'up' | 'down' } | null
  recurring?: {
    interval: 'day' | 'week' | 'month' | 'year'
    interval_count: number
    usage_type?: 'licensed' | 'metered'
    meter?: string | null
  } | null
}

export interface StripePriceTier {
  up_to: number | null
  unit_amount?: number | null
  unit_amount_decimal?: string | null
  flat_amount?: number | null
  flat_amount_decimal?: string | null
}

export interface StripeSubscriptionItem {
  id: string
  object: 'subscription_item'
  price: StripePrice
  quantity?: number | null
  /** Basil and later. */
  current_period_end?: number
  discounts?: Array<string | StripeDiscount> | null
}

export type StripeSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'paused'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'

export interface StripeSubscription {
  id: string
  object: 'subscription'
  customer: string | { id: string }
  currency: string
  status: StripeSubscriptionStatus
  start_date: number
  created: number
  /** Before Basil; later versions carry it per item. */
  current_period_end?: number
  cancel_at_period_end?: boolean
  canceled_at?: number | null
  ended_at?: number | null
  discounts?: Array<string | StripeDiscount> | null
  /** Legacy single discount (removed in recent versions). */
  discount?: StripeDiscount | null
  items: StripeList<StripeSubscriptionItem>
}

export interface StripeEvent {
  id: string
  object: 'event'
  type: string
  account?: string
  livemode?: boolean
  created?: number
  data?: { object?: unknown }
}

export interface StripeErrorBody {
  error?: { type?: string; code?: string; message?: string; decline_code?: string; param?: string }
}
