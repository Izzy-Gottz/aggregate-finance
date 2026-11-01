// The parts of Paddle Billing API responses we read (developer.paddle.com/api-reference). Amounts are strings in the
// currency's lowest denomination ("1099" = 10.99 USD). Everything else stays in the raw payload.

export interface PaddlePagination {
  per_page: number
  /** Absolute URL of the next page (carries the `after` id). Always present. */
  next: string
  has_more: boolean
  estimated_total?: number
}

export interface PaddleList<T> {
  data: T[]
  meta: { request_id?: string; pagination: PaddlePagination }
}

export interface PaddleTotals {
  subtotal?: string | null
  discount?: string | null
  tax?: string | null
  total?: string | null
  credit?: string | null
  balance?: string | null
  grand_total?: string | null
  fee?: string | null
  earnings?: string | null
  currency_code: string
}

export interface PaddleTransaction {
  id: string
  status: 'draft' | 'ready' | 'billed' | 'paid' | 'completed' | 'canceled' | 'past_due'
  customer_id: string | null
  subscription_id: string | null
  invoice_number?: string | null
  currency_code: string
  origin?: string
  billed_at: string | null
  created_at: string
  updated_at: string
  details: {
    totals: PaddleTotals
    /** In the seller's balance (payout) currency; null until the transaction is completed. */
    payout_totals: PaddleTotals | null
  }
}

export interface PaddleAdjustmentTotals {
  subtotal?: string | null
  tax?: string | null
  total?: string | null
  fee?: string | null
  retained_fee?: string | null
  chargeback_fee?: string | null
  earnings?: string | null
  currency_code: string
}

export interface PaddleAdjustment {
  id: string
  action: 'credit' | 'refund' | 'chargeback' | 'chargeback_reverse' | 'chargeback_warning' | 'chargeback_warning_reverse' | 'credit_reverse'
  type?: 'full' | 'partial'
  transaction_id: string
  subscription_id: string | null
  customer_id: string | null
  reason?: string
  currency_code: string
  status: 'pending_approval' | 'approved' | 'rejected' | 'reversed'
  totals: PaddleAdjustmentTotals
  payout_totals: PaddleAdjustmentTotals | null
  created_at: string
  updated_at: string
}

export type PaddleInterval = 'day' | 'week' | 'month' | 'year'

export interface PaddleBillingCycle {
  interval: PaddleInterval
  frequency: number
}

export interface PaddleSubscriptionItem {
  status: 'active' | 'inactive' | 'trialing'
  quantity: number
  recurring: boolean
  price: {
    id: string
    product_id: string
    unit_price: { amount: string; currency_code: string }
    billing_cycle: PaddleBillingCycle | null
  }
}

export interface PaddleSubscription {
  id: string
  status: 'active' | 'canceled' | 'past_due' | 'paused' | 'trialing'
  customer_id: string
  currency_code: string
  created_at: string
  updated_at: string
  started_at: string | null
  first_billed_at: string | null
  next_billed_at: string | null
  paused_at: string | null
  canceled_at: string | null
  current_billing_period: { starts_at: string; ends_at: string } | null
  billing_cycle: PaddleBillingCycle
  scheduled_change: { action: 'cancel' | 'pause' | 'resume'; effective_at: string } | null
  discount: { id: string; starts_at: string | null; ends_at: string | null } | null
  items: PaddleSubscriptionItem[]
}

export interface PaddleDiscount {
  id: string
  type: 'flat' | 'flat_per_seat' | 'percentage'
  /** Percent ("12.5") for percentage; lowest denomination for flat types. */
  amount: string
  currency_code: string | null
  recur: boolean
  status: 'active' | 'archived'
}

export interface PaddleEventBody {
  event_id?: string
  event_type?: string
  occurred_at?: string
  notification_id?: string
  data?: { id?: string }
}
