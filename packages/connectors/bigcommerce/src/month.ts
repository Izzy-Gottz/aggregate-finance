// One month of what a BigCommerce store reports, added up exactly in minor units, then turned into a ReportSnapshot.
//
// Which orders count, by status_id (BigCommerce's fixed list, GET /v2/order_statuses):
//   counted      2 Shipped, 3 Partially Shipped, 8 Awaiting Pickup, 9 Awaiting Shipment, 10 Completed, 11 Awaiting
//                Fulfillment (the docs: "payment has been confirmed"), 13 Disputed (paid; a dispute isn't taken off), and
//                4 Refunded and 14 Partially Refunded. A refunded order was still sold: leaving it out would take the sale
//                away from its month AND leave its refund to count, removing it twice.
//   left out     0 Incomplete, 1 Pending, 5 Cancelled, 6 Declined, 7 Awaiting Payment, 12 Manual Verification Required,
//                any order marked is_deleted, and any status id not in that list (the sync warns of those with a count).
//
// Each order counts in the month of date_created on the store's clock (/v2/store timezone), at total_inc_tax: what the
// shopper was charged, tax, shipping and handling included, discounts already out. Each refund counts in the month it was
// created, at total_amount, and only when its order is one that counts. Refunds and sales stay apart; their net is its own
// row. A Refunded or Partially Refunded order placed in the run whose refunded_amount isn't the sum of its refund records
// is counted and warned of: only the refund records come off, since they alone say which month a refund fell in.
//
// Fees: none. BigCommerce has no payout or fee scope; what a payment provider kept is only in that provider's account.
//
// basis is 'accrual' because an order is dated when it's placed, not when money moved. None of this is revenue: payouts
// reach the bank, which may be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isRecord, toMinor } from '@agfn/connector-sdk'

export const COUNTED_STATUS_IDS = new Set([2, 3, 4, 8, 9, 10, 11, 13, 14])
/** BigCommerce's own status ids, 0 to 14. Anything else isn't in the docs. */
export const KNOWN_STATUS_IDS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])

export interface MonthTotals {
  sales: number
  refunds: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, refunds: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals => isRecord(v) && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger(v[k]))

export const stop = (what: string) => new ConnectorError('permanent', `BigCommerce sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'bigcommerce', forUser: true })

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These BigCommerce totals are too large to add exactly.', { provider: 'bigcommerce', forUser: true })
  return n
}

/**
 * A non-negative decimal amount. BigCommerce writes order amounts to four places ("108.2500"); places past the currency's
 * own must be zeros, because toMinor would round anything else and hide a value that isn't what the docs say.
 */
export function amount(v: unknown, currency: string): number {
  const value = typeof v === 'number' ? String(v) : v
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw stop('an amount')
  const extra = (value.split('.')[1] ?? '').slice(currencyExponent(currency))
  if (/[^0]/.test(extra)) throw stop('an amount')
  try {
    return toMinor(value, currency)
  } catch {
    throw stop('an amount')
  }
}

/** "2026-09-14" on the store's clock. */
export function dayIn(zone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

/** "2026-09" on the store's clock. */
export const monthIn = (zone: string, ms: number): string => dayIn(zone, ms).slice(0, 7)

/** A date BigCommerce stamps: RFC-2822 on orders, RFC 3339 on refunds. Missing or not a date stops the sync. */
export function when(v: unknown): number {
  const at = typeof v === 'string' && v ? Date.parse(v) : NaN
  if (!Number.isFinite(at)) throw stop('a date')
  return at
}

export const positiveId = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw stop(what)
  return v
}

export const BIGCOMMERCE_UNKNOWN_CURRENCY = 'BigCommerce sent an order in a currency the store doesn’t list, so Aggregate can’t tell how to add it up, and this sync stopped. No totals were changed.'

export interface OrderLine {
  id: number
  month: string
  currency: string
  counted: boolean
  /** A status id that isn't in BigCommerce's list. */
  unknownStatus: boolean
  sales: number
  /** refunded_amount, on Refunded (4) and Partially Refunded (14) orders only. */
  refunded?: number
}

/** Refunded and Partially Refunded: their refunded_amount is checked against the refund records. */
export const REFUNDED_STATUS_IDS = new Set([4, 14])

/** What one order is, read past everything but these fields. `currencies` is every currency the store has set up. */
export function orderLine(o: Record<string, unknown>, zone: string, currencies: ReadonlySet<string>): OrderLine {
  const id = positiveId(o.id, 'an order')
  const status = o.status_id
  if (typeof status !== 'number' || !Number.isInteger(status)) throw stop('an order status')
  const currency = o.default_currency_code
  if (typeof currency !== 'string' || !currencies.has(currency)) throw new ConnectorError('permanent', BIGCOMMERCE_UNKNOWN_CURRENCY, { provider: 'bigcommerce', forUser: true })
  const month = monthIn(zone, when(o.date_created))
  const counted = COUNTED_STATUS_IDS.has(status) && o.is_deleted !== true
  // Read even when it won't count: a value that isn't what the docs say is never passed over.
  const sales = amount(o.total_inc_tax, currency)
  const refunded = REFUNDED_STATUS_IDS.has(status) ? amount(o.refunded_amount, currency) : undefined
  return { id, month, currency, counted, unknownStatus: !KNOWN_STATUS_IDS.has(status), sales, ...(refunded === undefined ? {} : { refunded }) }
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: orders less refunds. */
export const REPORT_ROW_NET_SALES = 'Net sales reported by BigCommerce'

/** No `totals` and no "Net income" row on purpose: this is the store's sales report, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Orders placed in BigCommerce', amount: m(t.sales, currency), section: 'Sales', depth: 0 },
    { account: 'Refunds', amount: m(-t.refunds, currency), section: 'Sales', depth: 0 },
    { account: REPORT_ROW_NET_SALES, amount: m(exact(t.sales - t.refunds), currency), section: 'Sales', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
