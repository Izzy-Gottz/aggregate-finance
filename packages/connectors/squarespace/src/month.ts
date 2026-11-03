// One month of what a Squarespace site took, added up exactly in minor units, then turned into a ReportSnapshot.
//
// What counts: each payment on a Document, in the month it was paid on the site's clock, less that payment's refunds. A refund
// comes off the sale's own month, whenever it happened, so a past month can change. Payments come from `payments[]`, not the
// Document's totals: a payment plan has several payments across months, and the docs don't say whether totals drop on a refund.
//
// Left out: a voided Document (an order that was cancelled) and a payment made with a gift card, because the card's own sale
// already counted. Payments are what the customer paid, so tax, shipping and donations are in here.
//
// basis is 'accrual' because a sale is dated when it's made, not when the money settles. None of this is revenue: the money
// arrives through Stripe, PayPal or Square, which may be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isRecord, toMinor } from '@agfn/connector-sdk'
import type { SquarespaceDocument, SquarespacePayment } from './types.ts'

export interface MonthTotals {
  sales: number
  refunds: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, refunds: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals => isRecord(v) && Number.isSafeInteger(v.sales) && Number.isSafeInteger(v.refunds)

const stop = (what: string) => new ConnectorError('permanent', `Squarespace sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'squarespace', forUser: true })

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Squarespace totals are too large to add exactly.', { provider: 'squarespace', forUser: true })
  return n
}

/** A MonetaryAmount: { currency, value }, value a decimal number. toMinor rounds past the currency's decimals, which here would hide a value that isn't what the docs say. */
export function money(v: unknown): { minor: number; currency: string } {
  if (!isRecord(v) || typeof v.currency !== 'string' || !/^[A-Z]{3}$/.test(v.currency)) throw stop('an amount')
  const value = typeof v.value === 'number' ? String(v.value) : v.value
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) throw stop('an amount')
  try {
    if ((value.split('.')[1]?.length ?? 0) > currencyExponent(v.currency)) throw new Error('too precise')
    return { minor: toMinor(value, v.currency), currency: v.currency }
  } catch {
    throw stop('an amount')
  }
}

/** "2026-09" on the site's clock. A zone that isn't known falls back to UTC. */
export function monthIn(zone: unknown, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: typeof zone === 'string' ? zone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms).slice(0, 7)
  } catch {
    return new Date(ms).toISOString().slice(0, 7)
  }
}

export interface PaymentLine {
  month: string
  currency: string
  sales: number
  refunds: number
}

/** A payment's lines, or nothing when it doesn't count. The docs don't give a refund's sign, so its size is what's used. */
function paymentLine(p: SquarespacePayment, zone: unknown): PaymentLine | null {
  if (p.giftCardId !== null && p.giftCardId !== undefined && p.giftCardId !== '') return null
  if (p.paidOn === null || p.paidOn === undefined) return null
  const at = typeof p.paidOn === 'string' ? Date.parse(p.paidOn) : NaN
  if (!Number.isFinite(at)) throw stop('a payment date')
  const amount = money(p.amount)
  if (amount.minor < 0) throw stop('a payment below zero')
  const list = p.refunds ?? []
  if (!Array.isArray(list)) throw stop('a refund list')
  let refunds = 0
  for (const r of list) {
    if (!isRecord(r)) throw stop('a refund')
    const refund = money(r.amount)
    if (refund.currency !== amount.currency) throw stop('a refund in another currency')
    refunds = exact(refunds + Math.abs(refund.minor))
  }
  // The two views of the same refunds must agree, or one of them isn't what the docs imply.
  if (p.refundedAmount !== null && p.refundedAmount !== undefined) {
    const stated = money(p.refundedAmount)
    if (stated.minor !== 0 && stated.currency !== amount.currency) throw stop('a refund in another currency')
    if (Math.abs(stated.minor) !== refunds) throw stop('refunds that don’t match their total')
  }
  return { month: monthIn(zone, at), currency: amount.currency, sales: amount.minor, refunds }
}

/** Every line a Document adds. A voided one adds none. */
export function documentLines(doc: SquarespaceDocument, zone: unknown): PaymentLine[] {
  if (typeof doc.id !== 'string' || !doc.id) throw stop('a transaction')
  if (doc.voided !== undefined && doc.voided !== null && typeof doc.voided !== 'boolean') throw stop('a transaction')
  if (doc.voided === true) return []
  const payments = doc.payments ?? []
  if (!Array.isArray(payments) || !payments.every(isRecord)) throw stop('a transaction')
  return payments.flatMap((p) => paymentLine(p as unknown as SquarespacePayment, zone) ?? [])
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
