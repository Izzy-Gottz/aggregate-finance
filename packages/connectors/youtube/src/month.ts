// One month of what YouTube Analytics shows, turned into a ReportSnapshot's rows.
//
// estimatedRevenue is YouTube's own net estimate, subject to month-end adjustment, by the month on YouTube's clock (Pacific
// time). It's shown as given, rounded to the cent: YouTube's policies forbid derived metrics, so nothing is summed or netted.
//
// basis is 'accrual' because earnings count when they're made. None of this is revenue: the money arrives through AdSense
// and the bank.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { toMinor } from '@agfn/connector-sdk'

export const REPORT_CURRENCY = 'USD'
/** The row the connection's drawer shows. */
export const REPORT_ROW_EARNED = 'Estimated YouTube earnings'

/** The API sends a float with more places than cents. */
export function revenueMinor(amount: number): number {
  return toMinor(amount.toFixed(6), REPORT_CURRENCY)
}

/** No `totals` and no "Net income" row on purpose: this is what YouTube reports, not a profit figure. */
export function monthRows(minor: number): ReportSnapshot['rows'] {
  const amount: Money = { minor: minor === 0 ? 0 : minor, currency: REPORT_CURRENCY }
  return [{ account: REPORT_ROW_EARNED, amount, section: 'Earnings', depth: 0 }]
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

export function lastDay(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}
