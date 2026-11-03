// SumUp API shapes, only the fields Aggregate reads. Every value is unknown until checked: SumUp's schema marks almost
// nothing required on a history row, and a field that isn't what the docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: a history row's `user` (an email), `product_summary`,
// `client_transaction_id` and `card_type`, and a membership's `invite` (an email) and `metadata`.

export interface SumUpPayout {
  /** PAYOUT, or one of the deduction types. */
  type: unknown
  /** Major units. Net or gross of `fee`, and the sign of a deduction, aren't documented. */
  amount: unknown
  fee: unknown
  /** YYYY-MM-DD. */
  date: unknown
  currency: unknown
  /** SUCCESSFUL or FAILED. */
  status: unknown
}

export interface SumUpTransaction {
  /** PAYMENT, REFUND or CHARGE_BACK. */
  type: unknown
  status: unknown
  payment_type: unknown
  /** Major units. */
  amount: unknown
  currency: unknown
  /** When the transaction was created. */
  timestamp: unknown
  /** Major units. Optional in SumUp's schema. */
  refunded_amount?: unknown
}

export interface SumUpMerchant {
  merchantCode: string
  name: string
}
