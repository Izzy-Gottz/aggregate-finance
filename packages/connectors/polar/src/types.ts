// The parts of Polar's API objects (OpenAPI 2026-10) the connector reads. Amounts are integer minor units.

export interface PolarList<T> {
  items: T[]
  pagination: { total_count: number; max_page: number }
}

export interface PolarOrganization {
  id: string
  name: string
  slug?: string
}

export interface PolarCustomerRef {
  id?: string
  email?: string | null
  name?: string | null
}

export interface PolarOrder {
  id: string
  created_at: string
  modified_at?: string | null
  status: 'draft' | 'pending' | 'paid' | 'refunded' | 'partially_refunded' | 'void'
  paid: boolean
  /** After discounts, before tax: what the seller sells for. Tax is Polar's (merchant of record). */
  net_amount: number
  tax_amount: number
  total_amount: number
  currency: string
  /** Polar's fee on this order (its plan rate, international surcharge), in platform_fee_currency. */
  platform_fee_amount?: number | null
  platform_fee_currency?: string | null
  billing_reason?: string
  customer_id: string
  customer?: PolarCustomerRef | null
  subscription_id?: string | null
  description?: string | null
}

export interface PolarRefund {
  id: string
  created_at: string
  status: 'pending' | 'succeeded' | 'failed' | 'canceled'
  reason?: string
  /** Before tax (the tax part is tax_amount, returned by Polar). */
  amount: number
  tax_amount: number
  currency: string
  order_id: string
  subscription_id?: string | null
  customer_id: string
}

export interface PolarDispute {
  id: string
  created_at: string
  modified_at?: string | null
  status: 'prevented' | 'early_warning' | 'needs_response' | 'under_review' | 'lost' | 'won'
  amount: number
  tax_amount: number
  currency: string
  order_id: string
}

export type PolarInterval = 'day' | 'week' | 'month' | 'year'

export interface PolarDiscount {
  id: string
  type: 'fixed' | 'percentage'
  duration: 'once' | 'forever' | 'repeating'
  duration_in_months?: number | null
  basis_points?: number | null
  amount?: number | null
  currency?: string | null
  /** Fixed discounts priced in several currencies. */
  amounts?: Record<string, number> | null
}

export interface PolarSubscription {
  id: string
  created_at: string
  /** Per billing period, before discounts and tax; metered usage is billed separately and not included. */
  amount: number
  currency: string
  recurring_interval: PolarInterval
  recurring_interval_count?: number | null
  status: 'incomplete' | 'incomplete_expired' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' | 'paused'
  current_period_end?: string | null
  cancel_at_period_end: boolean
  canceled_at?: string | null
  started_at?: string | null
  ended_at?: string | null
  customer_id: string
  product_id: string
  discount_id?: string | null
  discount?: PolarDiscount | null
  seats?: number | null
  units?: number | null
  prices?: Array<{ id: string }>
}
