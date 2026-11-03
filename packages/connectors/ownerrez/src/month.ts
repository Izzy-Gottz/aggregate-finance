// One month of what OwnerRez recorded as collected, added up exactly in minor units, then turned into a ReportSnapshot.
//
// What counts: each payment in the month it was collected on the account's clock, and each refund in the month it was paid
// out. A chargeback is a payment of type `chargeback`; the docs don't give its sign, so its size comes off, on its own line.
// Fees are shown on their own line and kept out of the net: they're what the processor kept, not money that didn't come in.
//
// Left out: a payment with no collected date (not collected yet). Security deposits aren't a payment type in the docs, so
// they aren't expected here; see the README.
//
// basis is 'cash' because a payment counts when it's collected. None of this is revenue: Airbnb, Vrbo and card payouts reach
// the bank, which may be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isRecord, toMinor } from '@agfn/connector-sdk'
import type { OwnerRezPayment, OwnerRezRefund } from './types.ts'

export interface MonthTotals {
  payments: number
  refunds: number
  chargebacks: number
  fees: number
}

export const emptyTotals = (): MonthTotals => ({ payments: 0, refunds: 0, chargebacks: 0, fees: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals => isRecord(v) && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger(v[k]))

const stop = (what: string) => new ConnectorError('permanent', `OwnerRez sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: 'ownerrez', forUser: true })

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These OwnerRez totals are too large to add exactly.', { provider: 'ownerrez', forUser: true })
  return n
}

/** A decimal amount. toMinor rounds past the currency's decimals, which here would hide a value that isn't what the docs say. */
export function amount(v: unknown, currency: string): number {
  const value = typeof v === 'number' ? String(v) : v
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) throw stop('an amount')
  try {
    if ((value.split('.')[1]?.length ?? 0) > currencyExponent(currency)) throw new Error('too precise')
    return toMinor(value, currency)
  } catch {
    throw stop('an amount')
  }
}

/** "2026-09-14" on the account's clock. A zone that isn't known falls back to UTC. */
export function dayIn(zone: unknown, ms: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: typeof zone === 'string' ? zone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}

/** "2026-09" on the account's clock. */
export const monthIn = (zone: unknown, ms: number): string => dayIn(zone, ms).slice(0, 7)

/** A date OwnerRez stamps. Missing means not happened yet; anything else that isn't a date stops the sync. */
function when(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const at = typeof v === 'string' ? Date.parse(v) : NaN
  if (!Number.isFinite(at)) throw stop('a date')
  return at
}

export interface Line {
  month: string
  totals: MonthTotals
}

/** What one payment adds, or nothing when it hasn't been collected. */
export function paymentLine(p: OwnerRezPayment, zone: unknown, currency: string): Line | null {
  if (typeof p.id !== 'number' && typeof p.id !== 'string') throw stop('a payment')
  const at = when(p.collected_utc)
  if (at === null) return null
  const value = amount(p.amount, currency)
  const fees = p.total_fees === null || p.total_fees === undefined ? 0 : Math.abs(amount(p.total_fees, currency))
  const t = emptyTotals()
  if (p.type === 'chargeback') t.chargebacks = Math.abs(value)
  else if (value < 0) throw stop('a payment below zero')
  else t.payments = value
  t.fees = fees
  return { month: monthIn(zone, at), totals: t }
}

/** What one refund takes off, in the month it was paid, or nothing when it hasn't been paid. The docs don't give its sign, so its size is used. */
export function refundLine(r: OwnerRezRefund, zone: unknown, currency: string): Line | null {
  if (typeof r.id !== 'number' && typeof r.id !== 'string') throw stop('a refund')
  const at = when(r.paid_utc)
  if (at === null) return null
  const t = emptyTotals()
  t.refunds = Math.abs(amount(r.amount, currency))
  return { month: monthIn(zone, at), totals: t }
}

export function add(a: MonthTotals, b: MonthTotals): MonthTotals {
  return { payments: exact(a.payments + b.payments), refunds: exact(a.refunds + b.refunds), chargebacks: exact(a.chargebacks + b.chargebacks), fees: exact(a.fees + b.fees) }
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** The row the connection's drawer shows: payments less refunds and chargebacks. */
export const REPORT_ROW_NET_COLLECTED = 'Net collected in OwnerRez'

/** No `totals` and no "Net income" row on purpose: this is what OwnerRez recorded, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: 'Payments collected in OwnerRez', amount: m(t.payments, currency), section: 'Payments', depth: 0 },
    { account: 'Refunds paid', amount: m(-t.refunds, currency), section: 'Payments', depth: 0 },
    { account: 'Chargebacks', amount: m(-t.chargebacks, currency), section: 'Payments', depth: 0 },
    { account: REPORT_ROW_NET_COLLECTED, amount: m(exact(t.payments - t.refunds - t.chargebacks), currency), section: 'Payments', depth: 0 },
    { account: 'Processing fees on those payments', amount: m(-t.fees, currency), section: 'Fees', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
