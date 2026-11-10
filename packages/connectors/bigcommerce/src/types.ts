// BigCommerce shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that isn't what the
// docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: an order's billing_address (names, emails, phone, street), its
// customer_id, ip_address, customer_message and staff_notes; a refund's reason, user_id and payments; and the store
// owner's name, admin_email and order_email on /v2/store.

/** GET /v2/orders and /v2/orders/{id}. Dates are RFC-2822 in UTC; amounts are decimal strings. */
export interface BigCommerceOrder {
  id: unknown
  status_id: unknown
  date_created: unknown
  /** What the shopper was charged: products, shipping, handling, wrapping and tax, after discounts. */
  total_inc_tax: unknown
  /**
   * The transactional currency, the one the shopper paid in. The Orders V2 docs: "default currency refers to the
   * transactional currency which is the currency the shopper pays in"; store_default_currency_code is the store's own.
   */
  default_currency_code: unknown
  /** Everything refunded on the order so far, in its currency. Checked against the refund records on 4 and 14 orders. */
  refunded_amount?: unknown
  is_deleted?: unknown
}

/** GET /v3/orders/payment_actions/refunds, under `data`. */
export interface BigCommerceRefund {
  id: unknown
  order_id: unknown
  /** RFC 3339. */
  created: unknown
  /** Non-negative, rounded to 2 places: what went back to the shopper, tax included. */
  total_amount: unknown
}
