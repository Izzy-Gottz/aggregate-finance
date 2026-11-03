// One month of what a Wix store took, added up exactly in minor units, then turned into a ReportSnapshot.
//
// What counts: each order's balanceSummary, `paid` less `refunded`, in the month of the sale. A refund comes off the sale's own
// month, whenever it happened, so a past month can change. No order status is filtered on: money kept on a cancelled order is
// still in paid less refunded, and an order nobody paid adds nothing.
//
// The month is UTC. The site's time zone needs a second permission, and Read Orders stays the only one, so a sale near a month's
// end can land a month away from the store's own view.
//
// paid is approved payments, so tax and shipping are in here. Chargebacks aren't taken off (README). basis is 'accrual' because
// a sale is dated when it's made, not when the money settles. None of this is revenue: the money arrives through a payment
// processor, which may be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isRecord, toMinor } from '@agfn/connector-sdk'
import type { WixOrder } from './types.ts'

export interface MonthTotals {
  sales: number
  refunds: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, refunds: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals => isRecord(v) && Number.isSafeInteger(v.sales) && Number.isSafeInteger(v.refunds)

const stop = (what: string) => new ConnectorError('permanent', `Wix sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'wix', forUser: true })

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Wix totals are too large to add exactly.', { provider: 'wix', forUser: true })
  return n
}

/** A Price: { amount: "25.00" }, a decimal string with no currency of its own. Trailing zeros are fine ("500.00" yen); a real digit past the currency's decimals isn't, because toMinor would round it away. */
export function price(v: unknown, currency: string): number {
  if (!isRecord(v) || typeof v.amount !== 'string' || !/^\d+(\.\d+)?$/.test(v.amount)) throw stop('an amount')
  const [whole, fraction = ''] = v.amount.split('.') as [string, string?]
  const kept = fraction.replace(/0+$/, '')
  try {
    if (kept.length > currencyExponent(currency)) throw new Error('too precise')
    return toMinor(kept ? `${whole}.${kept}` : whole, currency)
  } catch {
    throw stop('an amount')
  }
}

const NOTHING_PAID = new Set(['UNSPECIFIED', 'NOT_PAID', 'PENDING', 'CANCELED', 'DECLINED'])
const SOME_PAID = new Set(['PAID', 'PARTIALLY_REFUNDED', 'FULLY_REFUNDED', 'PARTIALLY_PAID', 'PENDING_MERCHANT'])

export interface OrderLine {
  month: string
  currency: string
  sales: number
  refunds: number
}

/** What one order adds. Missing money is only zero on an order Wix says nobody paid. */
export function orderLine(o: WixOrder): OrderLine {
  if (typeof o.id !== 'string' || !o.id) throw stop('an order')
  if (typeof o.currency !== 'string' || !/^[A-Z]{3}$/.test(o.currency)) throw stop('a currency')
  const when = o.purchasedDate ?? o.createdDate
  const at = typeof when === 'string' ? Date.parse(when) : NaN
  if (!Number.isFinite(at)) throw stop('an order date')
  const status = o.paymentStatus ?? 'UNSPECIFIED'
  if (typeof status !== 'string' || (!NOTHING_PAID.has(status) && !SOME_PAID.has(status))) throw stop('a payment status')
  const balance = o.balanceSummary ?? {}
  if (!isRecord(balance)) throw stop('a balance')
  if ((balance.paid === undefined || balance.paid === null) && SOME_PAID.has(status)) throw stop('a paid order with no amount')
  const sales = balance.paid === undefined || balance.paid === null ? 0 : price(balance.paid, o.currency)
  const refunds = balance.refunded === undefined || balance.refunded === null ? 0 : price(balance.refunded, o.currency)
  if ((status === 'PARTIALLY_REFUNDED' || status === 'FULLY_REFUNDED') && refunds === 0) throw stop('a refunded order with no refund')
  if (refunds > sales) throw stop('a refund above what was paid')
  return { month: new Date(at).toISOString().slice(0, 7), currency: o.currency, sales, refunds }
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: sales less their refunds. */
export const REPORT_ROW_NET_SALES = 'Net sales reported by the store'

/** No `totals` and no "Net income" row on purpose: this is the store's sales report, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Sales reported by the store', amount: m(t.sales, currency), section: 'Sales', depth: 0 },
    { account: 'Refunds of sales', amount: m(-t.refunds, currency), section: 'Sales', depth: 0 },
    { account: REPORT_ROW_NET_SALES, amount: m(t.sales - t.refunds, currency), section: 'Sales', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
