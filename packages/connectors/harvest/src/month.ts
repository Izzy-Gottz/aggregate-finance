// One month of what Harvest shows, added up exactly in minor units, then turned into a ReportSnapshot's rows.
//
// Invoiced: invoices that went out (open, paid, closed), by issue_date, for their whole amount with tax. A closed invoice
// was written off but was still invoiced. Drafts never went out. Harvest has no credit notes; a credit is a negative line,
// so a negative invoice lowers its month.
//
// Paid: each payment by its paid_date, whatever month the invoice is from. Harvest has no refund record: a refund is a
// payment edited or removed, which the recompute picks up, and a negative payment just lowers its month.
//
// basis is 'accrual' because an invoice counts when it's issued. This is what was billed in Harvest, not revenue:
// the money arrives in the bank, and QuickBooks or Xero may already hold the same invoice.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, toMinor } from '@agfn/connector-sdk'

export interface MonthTotals {
  invoiced: number
  tax: number
  paid: number
}

export const emptyTotals = (): MonthTotals => ({ invoiced: 0, tax: 0, paid: 0 })

export const isMonthTotals = (v: unknown): v is MonthTotals =>
  !!v && typeof v === 'object' && Object.keys(emptyTotals()).every((k) => Number.isSafeInteger((v as Record<string, unknown>)[k]))

/** toMinor, but its error quotes the value it choked on, and a value from Harvest is never repeated. */
export function minor(value: number | string | null | undefined, currency: string): number {
  try {
    if (value !== null && value !== undefined && typeof value !== 'number' && typeof value !== 'string') throw new Error('not an amount')
    return toMinor(value ?? 0, currency)
  } catch {
    throw new ConnectorError('permanent', 'Harvest sent an amount Aggregate can’t read.', { provider: 'harvest', forUser: true })
  }
}

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Harvest totals are too large to add exactly.', { provider: 'harvest', forUser: true })
  return n
}

/** The row the connection's drawer shows. */
export const REPORT_ROW_INVOICED = 'Invoiced in Harvest'
export const REPORT_ROW_TAX = 'Tax on those invoices'
export const REPORT_ROW_PAID = 'Payments recorded in Harvest'

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** No `totals` and no "Net income" row on purpose: this is a billing report, not a profit figure. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  return [
    { account: REPORT_ROW_INVOICED, amount: m(t.invoiced, currency), section: 'Invoices', depth: 0 },
    { account: REPORT_ROW_TAX, amount: m(t.tax, currency), section: 'Invoices', depth: 0 },
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
