// Etsy Open API v3 shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that isn't what
// the spec says must stop a sync, not count as zero. From Etsy's published OpenAPI spec
// (https://www.etsy.com/openapi/generated/oas/3.0.0.json, "Etsy Open API v3" 3.0.0), read 2026-11-05.
//
// Left out on purpose, and never read into anything: a ledger entry's `description` (free text), its
// `payment_adjustments` (refund objects carrying a user id and a reason), every Payment field (buyer_user_id, the
// shipping and billing address ids), and every Shop field but shop_name and currency_code. Aggregate asks for
// `transactions_r shops_r` only: no email_r, no address_r, no profile_r, nothing that writes.

/** GET /v3/application/users/me (scope shops_r): `Self`. */
export interface EtsySelf {
  user_id: unknown
  shop_id?: unknown
}

/** GET /v3/application/shops/{shop_id}: `Shop`. Only these two fields are read. */
export interface EtsyShop {
  shop_name?: unknown
  currency_code?: unknown
}

/**
 * GET /v3/application/shops/{shop_id}/payment-account/ledger-entries (scope transactions_r): `PaymentAccountLedgerEntry`.
 * `amount` is "the amount of money credited to the ledger" and `balance` "the amount of money in the shop's ledger the
 * moment after this entry was applied", both integers in the currency's minor units.
 */
export interface EtsyLedgerEntry {
  entry_id: unknown
  ledger_id: unknown
  sequence_number: unknown
  amount: unknown
  currency: unknown
  balance: unknown
  create_date?: unknown
  created_timestamp?: unknown
  /** "The original reference type for the ledger entry." Not enumerated in the spec (README, Unverified). */
  ledger_type: unknown
  reference_type?: unknown
  reference_id?: unknown
  parent_entry_id?: unknown
  /** Read past, never kept. */
  description?: unknown
  /** Read past, never kept. */
  payment_adjustments?: unknown
}
