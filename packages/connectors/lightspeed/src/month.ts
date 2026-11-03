// One month of what a Lightspeed store reports, added up exactly in minor units, then turned into a ReportSnapshot.
//
// What counts: closed sales only. Parked, pending (open on-account, layby and the like) and voided sales are left out. Each
// sale counts in the store's own month, by its default time zone (an outlet in another zone still files by that one).
// sales is totals.price, which Lightspeed gives without tax, and tax is totals.tax, in a row of its own. A return is a
// separate sale with negative totals, so it counts in the month it happened, against that month's sales.
//
// basis is 'accrual' because a sale is dated when it's rung up, not when the money settles. It isn't a cash figure.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, toMinor } from '@agfn/connector-sdk'

export interface MonthTotals {
  sales: number
  tax: number
  refundedSales: number
  refundedTax: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, tax: 0, refundedSales: 0, refundedTax: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals =>
  !!v && typeof v === 'object' && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger((v as Record<string, unknown>)[k]))

const unreadableSale = () => new ConnectorError('permanent', 'Lightspeed sent a sale Aggregate can’t read.', { provider: 'lightspeed', forUser: true })

/** toMinor, but its error quotes the value it choked on, and a value from the store is never repeated. A missing total stops the sync: a sale is never counted as zero. */
function amount(value: unknown, currency: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw unreadableSale()
  try {
    return toMinor(value, currency)
  } catch {
    throw unreadableSale()
  }
}

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Lightspeed totals are too large to add exactly.', { provider: 'lightspeed', forUser: true })
  return n
}

export function addSale(t: MonthTotals, totals: unknown, currency: string): void {
  if (!totals || typeof totals !== 'object') throw unreadableSale()
  const { price, tax } = totals as { price?: unknown; tax?: unknown }
  const p = amount(price, currency)
  const x = amount(tax, currency)
  if (p < 0) {
    t.refundedSales = exact(t.refundedSales - p)
    t.refundedTax = exact(t.refundedTax - x)
  } else {
    t.sales = exact(t.sales + p)
    t.tax = exact(t.tax + x)
  }
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: sales less refunds of sales, with tax in rows of its own. */
export const REPORT_ROW_NET_SALES = 'Net sales reported by the store'

/** No `totals` and no "Net income" row on purpose: this is the store's sales report, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Sales reported by the store', amount: m(t.sales, currency), section: 'Sales', depth: 0 },
    { account: 'Refunds of sales', amount: m(-t.refundedSales, currency), section: 'Sales', depth: 0 },
    { account: REPORT_ROW_NET_SALES, amount: m(t.sales - t.refundedSales, currency), section: 'Sales', depth: 0 },
    { account: 'Sales tax collected', amount: m(t.tax, currency), section: 'Sales tax', depth: 0 },
    { account: 'Sales tax refunded', amount: m(-t.refundedTax, currency), section: 'Sales tax', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms).map((p) => [p.type, Number(p.value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000
}

/** The instant a month starts in a time zone. A name Intl doesn't know means UTC. */
export function monthStartMs(month: string, timeZone: string): number {
  const wall = Date.parse(`${month}-01T00:00:00Z`)
  try {
    // Twice, because the offset before a clock change differs from the one after.
    const first = wall - zoneOffsetMs(wall, timeZone)
    return wall - zoneOffsetMs(first, timeZone)
  } catch {
    return wall
  }
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function dateIn(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}
