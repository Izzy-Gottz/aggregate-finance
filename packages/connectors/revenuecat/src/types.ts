// RevenueCat REST API v2 shapes, only the fields Aggregate reads. Timestamps are ms since the epoch. Revenue is a JSON
// number in major units; indicative prices are integer micros.

export type RcSubscriptionStatus = 'trialing' | 'active' | 'expired' | 'in_grace_period' | 'in_billing_retry' | 'paused' | 'unknown' | 'incomplete'

export interface RcList<T> {
  items: T[]
  /** Absent or null on the last page. */
  next_page?: string | null
}

export interface RcCustomer {
  id: string
}

export interface RcMonetaryAmount {
  currency: string
  gross: number
  commission?: number
  tax: number
  proceeds: number
}

export interface RcSubscription {
  id: string
  customer_id: string
  /** Null for promotional subscriptions. */
  product_id: string | null
  starts_at: number
  current_period_starts_at: number
  current_period_ends_at: number | null
  ends_at: number | null
  gives_access: boolean
  auto_renewal_status: string
  status: string
  /** Only ever read as "has this ever paid?". Never posted. */
  total_revenue_in_usd?: RcMonetaryAmount | null
  environment: string
  store: string
  ownership: string
}

export interface RcProduct {
  id: string
  store_identifier: string
  type: string
  subscription?: { duration?: string | null } | null
  display_name?: string | null
  /** Only with expand=items.indicative_price. Always USD / US, whatever the customer paid in. */
  indicative_price?: { currency: string; country?: string; amount_micros: number } | null
}

export interface RcTransaction {
  id: string
  purchased_at: number
  revenue_in_local_currency?: RcMonetaryAmount | null
  expiration_date?: number | null
}
