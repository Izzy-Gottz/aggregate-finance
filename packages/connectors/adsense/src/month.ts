// One month of what AdSense shows, turned into a ReportSnapshot's rows.
//
// Two clocks, on purpose, and the two rows are never netted against each other:
//   Estimated earnings: the report's MONTH, in the account's time zone. Google calls these estimates: recent days can still
//   change, and the month's final figure is what gets paid.
//   Paid: payments with a date, by the month of that date (Google's billing zone). October's payment is usually September's
//   earnings. The unpaid balance is never in here.
//
// basis is 'accrual' because earnings count when they're made. None of this is revenue: the money arrives in the bank.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, toMinor } from '@agfn/connector-sdk'

export interface MonthTotals {
  earned: number
  paid: number
}

export const emptyTotals = (): MonthTotals => ({ earned: 0, paid: 0 })

const stop = (what: string) => new ConnectorError('permanent', `AdSense sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'adsense', forUser: true })

/** toMinor rounds past the currency's decimals, which here would hide a value that isn't what the docs say. */
function exactMinor(digits: string, currency: string): number {
  const decimals = digits.split('.')[1]?.length ?? 0
  try {
    if (decimals > currencyExponent(currency)) throw new Error('too precise')
    return toMinor(digits, currency)
  } catch {
    throw stop('an amount')
  }
}

/** A report cell: a plain decimal, which can be below zero when a month is adjusted. */
export function cellMinor(value: unknown, currency: string): number {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) throw stop('an amount')
  return exactMinor(value, currency)
}

/** "$" and "¥" alone could be several currencies. They're taken only when the report's currency is one they can mean. */
const DOLLARS = new Set(['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD'])
const FORMATTED = /^(?:([A-Z]{3})\s?|([$€£¥]))?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?:\s?([A-Z]{3}))?$/

/**
 * A payment's amount. It's a display string, so only the shapes below pass: "1.234,57 €" must stop a sync, because read
 * loosely it's a different number. A currency that can't be told for sure stops it too: payments can be in another
 * currency from the report's.
 */
export function paymentMoney(value: unknown, reportCurrency: string): { minor: number; currency: string } {
  const m = typeof value === 'string' ? FORMATTED.exec(value.trim()) : null
  if (!m) throw stop('a payment amount')
  const [, before, symbol, whole, decimals, after] = m
  if (before && after && before !== after) throw stop('a payment amount')
  if ((before || after) && symbol) throw stop('a payment amount')
  let currency = before ?? after
  if (symbol === '€') currency = 'EUR'
  else if (symbol === '£') currency = 'GBP'
  else if (symbol === '$' && DOLLARS.has(reportCurrency)) currency = reportCurrency
  else if (symbol === '¥' && reportCurrency === 'JPY') currency = 'JPY'
  if (!currency) throw stop('a payment with no clear currency')
  return { minor: exactMinor((whole as string).replaceAll(',', '') + (decimals ?? ''), currency), currency }
}

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These AdSense totals are too large to add exactly.', { provider: 'adsense', forUser: true })
  return n
}

/** The row the connection's drawer shows. */
export const REPORT_ROW_EARNED = 'Estimated AdSense earnings'
export const REPORT_ROW_PAID = 'Paid by AdSense'

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** Each row stands alone. No `totals` and no "Net income" row on purpose: this is what AdSense reports, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: REPORT_ROW_EARNED, amount: m(t.earned, currency), section: 'Earnings', depth: 0 },
    { account: REPORT_ROW_PAID, amount: m(t.paid, currency), section: 'Payments', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
