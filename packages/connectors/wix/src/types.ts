// Wix eCommerce order shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that isn't what
// the docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: buyerInfo (the customer's email and ids), billing and shipping details,
// recipient info, line items and payment gateway details. An order is reduced to these fields as it comes off the page.

export interface WixOrder {
  id: unknown
  /** ISO 4217. */
  currency?: unknown
  createdDate?: unknown
  /** Set on imported orders. Immutable, like createdDate. */
  purchasedDate?: unknown
  paymentStatus?: unknown
  /** `paid` and `refunded`, each a Price: { amount: "25.00", formattedAmount }. */
  balanceSummary?: unknown
}

export interface OrdersPage {
  orders: WixOrder[]
  nextCursor: string | null
}
