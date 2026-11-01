// The parts of Lemon Squeezy's JSON:API responses we read (docs.lemonsqueezy.com/api). Amounts are integer cents.

export interface LsResource<A> {
  type: string
  id: string
  attributes: A
}

export interface LsList<A> {
  data: Array<LsResource<A>>
  meta?: { page?: { currentPage: number; from: number | null; lastPage: number; perPage: number; to: number | null; total: number } }
  /** `next` is absent on the last page. */
  links?: { first?: string; last?: string; next?: string; prev?: string }
}

export interface LsStore {
  name: string
  slug?: string
  domain?: string
  url?: string
  currency: string
  created_at?: string
  updated_at?: string
}

export interface LsOrder {
  store_id: number
  customer_id: number
  identifier?: string
  order_number: number
  currency: string
  currency_rate?: string
  subtotal: number
  discount_total: number
  tax: number
  total: number
  setup_fee?: number
  subtotal_usd: number
  discount_total_usd: number
  tax_usd: number
  total_usd: number
  setup_fee_usd?: number
  tax_inclusive?: boolean
  status: 'pending' | 'failed' | 'paid' | 'refunded' | 'partial_refund' | 'fraudulent'
  refunded: boolean
  refunded_at: string | null
  refunded_amount: number
  refunded_amount_usd: number
  test_mode: boolean
  created_at: string
  updated_at: string
}

export interface LsSubscription {
  store_id: number
  customer_id: number
  order_id: number
  order_item_id?: number
  product_id: number
  variant_id: number
  status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired'
  cancelled: boolean
  pause?: unknown
  trial_ends_at: string | null
  billing_anchor?: number
  first_subscription_item: { id: number; subscription_id: number; price_id: number; quantity: number; is_usage_based?: boolean } | null
  renews_at: string | null
  ends_at: string | null
  created_at: string
  updated_at: string
  test_mode: boolean
}

export type LsInterval = 'day' | 'week' | 'month' | 'year'

export interface LsPrice {
  variant_id: number
  category: 'one_time' | 'subscription' | 'lead_magnet' | 'pwyw'
  scheme: 'standard' | 'package' | 'graduated' | 'volume'
  usage_aggregation: 'sum' | 'last_during_period' | 'last_ever' | 'max' | null
  unit_price: number | null
  unit_price_decimal: string | null
  package_size: number | null
  renewal_interval_unit: LsInterval | null
  renewal_interval_quantity: number | null
}

export interface LsWebhookBody {
  meta?: { event_name?: string; custom_data?: unknown; test_mode?: boolean; webhook_id?: string }
  data?: { type?: string; id?: string; attributes?: { store_id?: number | string; updated_at?: string } }
}
