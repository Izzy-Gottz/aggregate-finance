// Squarespace Commerce API shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that isn't
// what the docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: customerEmail, line items, shipping, discounts, card type and every
// gateway id on a Document.

export interface SquarespaceSite {
  id: string
  title: string
  /** ISO 4217, set under Commerce → Payments. */
  currency: string
  /** An IANA zone, set under Settings → Language & Region. */
  timeZone: string
}

export interface SquarespaceRefund {
  amount: unknown
}

export interface SquarespacePayment {
  amount: unknown
  refundedAmount?: unknown
  paidOn?: unknown
  /** Set when a gift card paid. The card's own sale already counted. */
  giftCardId?: unknown
  refunds?: unknown
}

export interface SquarespaceDocument {
  id: unknown
  /** "Flag; indicates order cancellation." */
  voided?: unknown
  payments?: unknown
}

export interface TransactionsPage {
  documents: SquarespaceDocument[]
  nextPageCursor: string | null
}
