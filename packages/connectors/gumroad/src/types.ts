// The parts of Gumroad's API v2 responses we read (gumroad.com/api; source: github.com/antiwork/gumroad,
// app/controllers/api/v2/{sales,payouts,users}_controller.rb and Purchase#as_json). Sale amounts are integer USD
// cents whatever currency the buyer paid in; `currency` is the currency the sale was shown in.

export interface GumroadUser {
  user_id?: string
  id?: string
  name?: string | null
  email?: string | null
}

export interface GumroadSale {
  id: string
  created_at: string
  product_name?: string
  product_id?: string
  /** USD cents the seller sold for, including Gumroad's fee and any seller-collected tax. */
  price: number
  /** Tax the seller is responsible for. Gumroad's API docs show it on GET /v2/sales. */
  tax_cents?: number
  /** Shown on GET /v2/sales/:id in the docs, not on the list's sample: not seen on a real list row yet. */
  tax_included_in_price?: boolean
  /** Gumroad's fee in USD cents (includes the Discover fee). */
  gumroad_fee: number
  currency?: string
  /** What's left to refund, formatted in `currency` without a symbol (e.g. "7.5", "1,234.56"). */
  amount_refundable_in_currency?: string
  refunded?: boolean | null
  partially_refunded?: boolean | null
  /** A chargeback that wasn't reversed. */
  chargedback?: boolean | null
  disputed?: boolean | null
  dispute_won?: boolean | null
  purchaser_id?: string | null
  /** The affiliate's cut, formatted in USD (e.g. "$2.50", "$1,200"). */
  affiliate?: { amount?: string } | null
  subscription_id?: string | null
  test?: boolean
}

export interface GumroadSalesPage {
  success: boolean
  sales: GumroadSale[]
  next_page_key?: string | null
}

export interface GumroadPayout {
  /** null for the upcoming payout (balance not yet paid). */
  id: string | null
  /** Decimal string in `currency` (e.g. "150.00"). */
  amount: string
  currency: string
  status: string
  created_at: string
  processed_at: string | null
  payment_processor?: string
}

export interface GumroadPayoutsPage {
  success: boolean
  payouts: GumroadPayout[]
  next_page_key?: string | null
}
