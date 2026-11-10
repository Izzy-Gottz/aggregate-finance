// One month of what a Zeffy organization received online, added up exactly in cents, then turned into a ReportSnapshot.
//
// Which payments count: status "succeeded" and type "online", in the month of `created` on the organization's clock (the
// time zone the person picked at connect: Zeffy's API doesn't give one), at `amount`. Left out: "failed" and "pending",
// and "manual" and "imported" payments. Those two are recorded in Zeffy (cash, cheques, a past platform's history) but
// their money didn't move through Zeffy, so it may already be in the bank or in another source.
//
// Each refund with status "succeeded" counts in the month it was created, at its own amount, when its payment counts as
// sold (placed in the report months or the year before them). A dispute isn't taken off.
//
// Fees: none. Zeffy charges organizations no fee; a donor's optional contribution to Zeffy isn't the organization's.
//
// basis is 'accrual' because a payment is dated when it's made, not when Zeffy paid it out. None of this is revenue:
// payouts reach the bank, which may be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, isRecord } from '@agfn/connector-sdk'

export interface MonthTotals {
  received: number
  refunds: number
}

export const emptyTotals = (): MonthTotals => ({ received: 0, refunds: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals => isRecord(v) && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger(v[k]))

export const stop = (what: string) => new ConnectorError('permanent', `Zeffy sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'zeffy', forUser: true })

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Zeffy totals are too large to add exactly.', { provider: 'zeffy', forUser: true })
  return n
}

/** Cents, as Zeffy sends them: a whole number, never negative. */
export function cents(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw stop(what)
  return v
}

/** Zeffy's two currencies, lowercase in the API. Anything else stops the sync. */
export const CURRENCIES: Readonly<Record<string, string>> = { cad: 'CAD', usd: 'USD' }

export function currencyOf(v: unknown): string {
  const c = typeof v === 'string' ? CURRENCIES[v] : undefined
  if (!c) throw stop('a currency')
  return c
}

/** A unix time in seconds. */
export function when(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) throw stop('a date')
  return v * 1000
}

/** "2026-09-14" on the organization's clock. */
export function dayIn(zone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

/** "2026-09" on the organization's clock. */
export const monthIn = (zone: string, ms: number): string => dayIn(zone, ms).slice(0, 7)

const PAYMENT_STATUSES = new Set(['succeeded', 'failed', 'pending'])
const PAYMENT_TYPES = new Set(['online', 'manual', 'imported'])
/** Refund statuses that mean no money went back. Zeffy's docs show only "succeeded"; these are Stripe's others. */
const REFUND_NOT_DONE = new Set(['pending', 'failed', 'canceled', 'requires_action'])

export interface Line {
  id: string
  month: string
  currency: string
  /** Succeeded and online: sold through Zeffy. */
  counted: boolean
  amount: number
  /** Succeeded refunds: month and cents. */
  refunds: Array<{ month: string; amount: number }>
}

/** What one payment is, read past everything but these fields. Buyer, payment method, questions and items never are. */
export function paymentLine(p: Record<string, unknown>, zone: string): Line {
  if (typeof p.id !== 'string' || !p.id) throw stop('a payment')
  if (typeof p.status !== 'string' || !PAYMENT_STATUSES.has(p.status)) throw stop('a payment status')
  if (typeof p.type !== 'string' || !PAYMENT_TYPES.has(p.type)) throw stop('a payment type')
  const currency = currencyOf(p.currency)
  const month = monthIn(zone, when(p.created))
  // Read even when it won't count: a value that isn't what the docs say is never passed over.
  const amount = cents(p.amount, 'an amount')
  const list = p.refunds ?? []
  if (!Array.isArray(list)) throw stop('a refund list')
  const refunds: Line['refunds'] = []
  for (const r of list) {
    if (!isRecord(r) || typeof r.status !== 'string') throw stop('a refund')
    if (currencyOf(r.currency) !== currency) throw stop('a refund in another currency')
    const value = cents(r.amount, 'a refund amount')
    const at = when(r.created)
    if (r.status === 'succeeded') refunds.push({ month: monthIn(zone, at), amount: value })
    else if (!REFUND_NOT_DONE.has(r.status)) throw stop('a refund status')
  }
  return { id: p.id, month, currency, counted: p.status === 'succeeded' && p.type === 'online', amount, refunds }
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: online payments less refunds. */
export const REPORT_ROW_NET = 'Net received online through Zeffy'

/** No `totals` and no "Net income" row on purpose: this is what Zeffy reports, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Online payments through Zeffy', amount: m(t.received, currency), section: 'Payments', depth: 0 },
    { account: 'Refunds', amount: m(-t.refunds, currency), section: 'Payments', depth: 0 },
    { account: REPORT_ROW_NET, amount: m(exact(t.received - t.refunds), currency), section: 'Payments', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
