// One month of what a WooCommerce store reports, added up exactly in minor units, then turned into a ReportSnapshot.
//
// Which orders count: completed, processing and refunded.
//   completed, processing   paid or fulfilled. Cash on delivery sits in processing unpaid until it completes; the store
//                           reports it as a sale either way.
//   refunded                WooCommerce moves a fully refunded order to this status. It was still sold: leaving it out
//                           would take the sale away from its month AND leave its refund to count, removing it twice.
//   left out                pending, on-hold, failed, cancelled, trash and any status a plugin adds (the sync warns of
//                           those with a count).
//
// Each order counts in the month of date_created, read from the date as the store wrote it, so months are the store's
// own. An order's parts: shipping_total, total_tax (cart and shipping tax), and sales as what's left of total, so the
// rows always add back to what the store says the order came to. Discounts are already out of total; fees stay in sales.
//
// Each refund counts in the month it was made, against the sales-reported total of that month, as WooCommerce Analytics
// does. A refund counts only if its order is one of the statuses above. Its parts come from its lines (negative numbers
// on the refund), and sales is again what's left of `amount`, so a refund typed as a bare amount lands wholly in "Refunds
// of sales": we can't know its tax or shipping share, and the sync says so.
//
// basis is 'accrual' because an order is dated when it's placed, not when money moved; a bank transfer or cash on
// delivery is paid later. It isn't a cash figure.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, toMinor } from '@agfn/connector-sdk'
import type { WooOrder, WooRefund, WooRefundLine } from './types.ts'

export const COUNTED_STATUSES = ['completed', 'processing', 'refunded']
/** WooCommerce's own statuses; anything else came from a plugin. */
export const KNOWN_STATUSES = new Set([...COUNTED_STATUSES, 'pending', 'on-hold', 'cancelled', 'failed', 'trash', 'checkout-draft', 'auto-draft'])

export interface MonthTotals {
  sales: number
  shipping: number
  tax: number
  refundedSales: number
  refundedShipping: number
  refundedTax: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, shipping: 0, tax: 0, refundedSales: 0, refundedShipping: 0, refundedTax: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals =>
  !!v && typeof v === 'object' && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger((v as Record<string, unknown>)[k]))

/** toMinor, but its error quotes the value it choked on, and a store's text is never repeated. */
function signed(value: string, currency: string): number {
  try {
    return toMinor(value, currency)
  } catch {
    throw new ConnectorError('permanent', 'WooCommerce sent an amount Aggregate can’t read.', { provider: 'woocommerce', forUser: true })
  }
}

/** Refund lines are negative and a refund's amount positive; only the size matters here. */
const size = (value: string | undefined, currency: string) => Math.abs(signed(value ?? '0', currency))

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These WooCommerce totals are too large to add exactly.', { provider: 'woocommerce', forUser: true })
  return n
}

export function addOrder(t: MonthTotals, o: WooOrder, currency: string): void {
  const total = signed(o.total, currency)
  const tax = signed(o.total_tax, currency)
  const shipping = signed(o.shipping_total, currency)
  t.sales = exact(t.sales + total - tax - shipping)
  t.shipping = exact(t.shipping + shipping)
  t.tax = exact(t.tax + tax)
}

const sum = (lines: WooRefundLine[] | undefined, field: 'total' | 'total_tax', currency: string) => (lines ?? []).reduce((a, l) => a + size(l[field], currency), 0)

/** Returns true when the refund had no lines at all, only an amount. */
export function addRefund(t: MonthTotals, r: WooRefund, currency: string): boolean {
  const amount = size(r.amount, currency)
  const shipping = sum(r.shipping_lines, 'total', currency)
  const tax = sum(r.line_items, 'total_tax', currency) + sum(r.shipping_lines, 'total_tax', currency) + sum(r.fee_lines, 'total_tax', currency)
  t.refundedShipping = exact(t.refundedShipping + shipping)
  t.refundedTax = exact(t.refundedTax + tax)
  t.refundedSales = exact(t.refundedSales + amount - shipping - tax)
  return !r.line_items?.length && !r.shipping_lines?.length && !r.fee_lines?.length && amount > 0
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: sales less refunds of sales, with tax and shipping in rows of their own. */
export const REPORT_ROW_NET_SALES = 'Net sales reported by the store'

/** No `totals` and no "Net income" row on purpose: this is the store's sales report, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Sales reported by the store', amount: m(t.sales, currency), section: 'Sales', depth: 0 },
    { account: 'Refunds of sales', amount: m(-t.refundedSales, currency), section: 'Sales', depth: 0 },
    { account: REPORT_ROW_NET_SALES, amount: m(t.sales - t.refundedSales, currency), section: 'Sales', depth: 0 },
    { account: 'Shipping charged', amount: m(t.shipping, currency), section: 'Shipping', depth: 0 },
    { account: 'Shipping refunded', amount: m(-t.refundedShipping, currency), section: 'Shipping', depth: 0 },
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
