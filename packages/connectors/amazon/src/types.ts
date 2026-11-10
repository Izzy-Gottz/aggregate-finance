// Amazon Selling Partner API shapes, Finances API v0 only, and only the fields Aggregate reads. Every value is unknown until
// checked: a field that isn't what the model says must stop a sync, not count as zero. From the published model
// (github.com/amzn/selling-partner-api-models, models/finances-api-model/financesV0.json), read 2026-11-05.
//
// Left out on purpose, and never read into anything: AmazonOrderId, SellerOrderId, SellerSKU, ASIN, FnSKU, product and
// coupon descriptions, store names, a group's AccountTail (the bank account's last digits) and ConvertedTotal. The Finance and
// Accounting role carries no buyer names, emails or addresses, and none of these is stored.

/** `{CurrencyCode, CurrencyAmount}`. CurrencyAmount is a signed decimal number: + into the seller's balance, − out of it. */
export interface AmazonCurrency {
  CurrencyCode: unknown
  CurrencyAmount: unknown
}

/** GET /finances/v0/financialEventGroups, under payload.FinancialEventGroupList. One group is one settlement. */
export interface AmazonFinancialEventGroup {
  FinancialEventGroupId: unknown
  /** `Open` or `Closed`. */
  ProcessingStatus: unknown
  /** Not enumerated in the model. Only `Succeeded` counts as paid here (README, Unverified). */
  FundTransferStatus?: unknown
  /** Closed: what was disbursed (or charged, when negative). Open: the balance so far. */
  OriginalTotal?: unknown
  /** Closed only: when the disbursement or charge was initiated. */
  FundTransferDate?: unknown
  TraceId?: unknown
  BeginningBalance?: unknown
  FinancialEventGroupStart?: unknown
  FinancialEventGroupEnd?: unknown
}

/** GET /finances/v0/financialEventGroups/{id}/financialEvents, under payload.FinancialEvents: one list per event kind. */
export type AmazonFinancialEvents = Record<string, unknown>
