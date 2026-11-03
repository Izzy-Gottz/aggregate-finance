// AdSense Management API v2 shapes, only the fields Aggregate reads. Every value is unknown until checked: a field that
// isn't what the docs say must stop a sync, not count as zero.
//
// Left out on purpose, and never read into anything: an account's pendingTasks and createTime, and any site, ad unit, page
// or country dimension. Reports ask for MONTH and ESTIMATED_EARNINGS and nothing else.

export interface AdSenseAccount {
  /** accounts/pub-123 */
  name: string
  displayName: string
  /** An IANA zone. AdSense reports in it. */
  timeZone: string
}

export interface AdSensePayment {
  /** accounts/pub-123/payments/2026-09-21, or .../youtube-2026-09-21, or .../unpaid, or .../youtube-unpaid. */
  name: unknown
  /** "$1,234.57": a formatted string, not a number. */
  amount: unknown
  /** { year, month, day } in the billing time zone. Empty on unpaid earnings. */
  date?: unknown
}

export interface AdSenseReport {
  /** The currency of the earnings column. */
  currency: string
  /** Months in order of arrival, the amount as AdSense sent it. */
  rows: Array<{ month: string; amount: string }>
  /** The report's own total, when it sends one. */
  total: string | null
}
