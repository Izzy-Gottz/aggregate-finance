// OwnerRez API v2 shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that isn't what the
// docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: a payment's or refund's description and booking_id, every deposit
// detail, and the user's name and email on /v2/users/me.

export interface OwnerRezPayment {
  id: unknown
  amount: unknown
  collected_utc?: unknown
  total_fees?: unknown
  /** credit_card, check, cash, credit_card_processed_elsewhere, pay_pal, bank_transfer, chargeback, other. */
  type?: unknown
}

export interface OwnerRezRefund {
  id: unknown
  amount: unknown
  paid_utc?: unknown
  type?: unknown
}

export interface OwnerRezPage<T> {
  items: T[]
  /** The query of next_page_url; null on the last page. */
  next: Record<string, string> | null
}
