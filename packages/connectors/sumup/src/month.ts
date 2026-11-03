// One month of what SumUp shows, added up exactly in minor units, then turned into a ReportSnapshot's rows.
//
// Two clocks, on purpose, and the two sections are never netted against each other:
//   Sales: transaction history, by the UTC month of `timestamp`, when the sale happened.
//   Payouts: the payouts list, by `date`, when the money moved. A payout in October can hold September's sales.
//
// Gross sales: PAYMENT rows that went through (SUCCESSFUL, REFUNDED or CHARGE_BACK; the sale still happened, and what came
// back is on its own row), whatever the payment type but CASH. Cash sales get their own row, because a cash sale is only
// noted in SumUp and never reaches a payout.
//
// Paid out: PAYOUT records marked SUCCESSFUL. Fees: the `fee` on those same records; a fee on a deduction record isn't
// counted, because the docs don't say what one means. Deductions: one row per kind. DD_RETURN_DEDUCTION and
// BALANCE_DEDUCTION share the last.
//
// basis is 'accrual' because a sale counts when it's made. None of this is revenue: the money arrives in the bank.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, toMinor } from '@agfn/connector-sdk'

export interface MonthTotals {
  sales: number
  cashSales: number
  refunds: number
  chargebacks: number
  paidOut: number
  fees: number
  refundDeductions: number
  chargebackDeductions: number
  otherDeductions: number
}

export const emptyTotals = (): MonthTotals => ({ sales: 0, cashSales: 0, refunds: 0, chargebacks: 0, paidOut: 0, fees: 0, refundDeductions: 0, chargebackDeductions: 0, otherDeductions: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals =>
  !!v && typeof v === 'object' && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger((v as Record<string, unknown>)[k]))

/** toMinor, but nothing counts as zero, and its error quotes the value it choked on, which a value from SumUp never is. */
export function minor(value: unknown, currency: string): number {
  try {
    if ((typeof value !== 'number' || !Number.isFinite(value)) && (typeof value !== 'string' || !value.trim())) throw new Error('not an amount')
    return toMinor(value as number | string, currency)
  } catch {
    throw new ConnectorError('permanent', 'SumUp sent an amount Aggregate can’t read, so this sync stopped. No totals were changed.', { provider: 'sumup', forUser: true })
  }
}

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These SumUp totals are too large to add exactly.', { provider: 'sumup', forUser: true })
  return n
}

/** The row the connection's drawer shows. */
export const REPORT_ROW_PAID_OUT = 'Paid out by SumUp'
export const REPORT_ROW_FEES = 'Fees on those payouts'
export const REPORT_ROW_REFUND_DEDUCTIONS = 'Refunds taken from payouts'
export const REPORT_ROW_CHARGEBACK_DEDUCTIONS = 'Chargebacks taken from payouts'
export const REPORT_ROW_OTHER_DEDUCTIONS = 'Other amounts taken from payouts'
export const REPORT_ROW_SALES = 'Gross sales through SumUp'
export const REPORT_ROW_CASH = 'Cash sales noted in SumUp'
export const REPORT_ROW_REFUNDS = 'Refunds'
export const REPORT_ROW_CHARGEBACKS = 'Chargebacks'

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** Every amount is a positive size, and each row stands alone. No `totals` and no "Net income" row on purpose: this is what SumUp reports, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  const row = (account: string, minorUnits: number, section: string) => ({ account, amount: m(minorUnits, currency), section, depth: 0 })
  return [
    row(REPORT_ROW_SALES, t.sales, 'Sales'),
    row(REPORT_ROW_CASH, t.cashSales, 'Sales'),
    row(REPORT_ROW_REFUNDS, t.refunds, 'Sales'),
    row(REPORT_ROW_CHARGEBACKS, t.chargebacks, 'Sales'),
    row(REPORT_ROW_PAID_OUT, t.paidOut, 'Payouts'),
    row(REPORT_ROW_FEES, t.fees, 'Payouts'),
    row(REPORT_ROW_REFUND_DEDUCTIONS, t.refundDeductions, 'Payouts'),
    row(REPORT_ROW_CHARGEBACK_DEDUCTIONS, t.chargebackDeductions, 'Payouts'),
    row(REPORT_ROW_OTHER_DEDUCTIONS, t.otherDeductions, 'Payouts'),
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`)
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** Two ranges that don't overlap, from one of at least two days. */
export function splitDays(start: string, end: string): [[string, string], [string, string]] {
  const a = dayMs(start)
  const middle = a + Math.floor((dayMs(end) - a) / 172_800_000) * 86_400_000
  return [
    [start, dayOf(middle)],
    [dayOf(middle + 86_400_000), end],
  ]
}
