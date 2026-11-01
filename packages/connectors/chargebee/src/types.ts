// Chargebee API v2 shapes (Product Catalog 2.0), only the fields Aggregate reads. Amounts are in the currency's minor
// units ("in cents"); timestamps are UTC seconds.

export type CbPeriodUnit = 'day' | 'week' | 'month' | 'year'

export interface CbSubscriptionItem {
  item_price_id: string
  item_type: 'plan' | 'addon' | 'charge'
  quantity?: number
  unit_price?: number
  amount?: number
  amount_in_decimal?: string
  free_quantity?: number
  billing_period?: number
  billing_period_unit?: CbPeriodUnit
}

export interface CbDiscount {
  id: string
  type: 'fixed_amount' | 'percentage' | 'offer_quantity'
  percentage?: number
  amount?: number
  quantity?: number
  currency_code?: string
  duration_type: 'one_time' | 'forever' | 'limited_period'
  included_in_mrr?: boolean
  apply_on: 'invoice_amount' | 'specific_item_price'
  item_price_id?: string
}

export interface CbSubscription {
  id: string
  customer_id: string
  currency_code: string
  status: 'future' | 'in_trial' | 'active' | 'non_renewing' | 'paused' | 'cancelled' | 'transferred'
  billing_period?: number
  billing_period_unit?: CbPeriodUnit
  deleted?: boolean
  created_at: number
  updated_at: number
  started_at?: number
  activated_at?: number
  current_term_end?: number
  cancelled_at?: number
  due_invoices_count?: number
  /** Chargebee's own figure; its docs say it "may not return accurate values since updated asynchronously". */
  mrr?: number
  subscription_items?: CbSubscriptionItem[]
  discounts?: CbDiscount[]
  coupons?: Array<{ coupon_id: string; apply_till?: number }>
}

export interface CbList<T> {
  list: T[]
  next_offset?: string
}
