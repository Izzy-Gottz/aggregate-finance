// One month of what Pinterest says was spent on ads, turned into a ReportSnapshot's rows.
//
// Pinterest reports spend in micro-units of the ad account's currency (a dollar is 1,000,000), by UTC day. Days add up as
// whole micro-units, so nothing rounds until the month's total, once, to the currency's smallest unit.
//
// basis is 'accrual' because spend counts when the ad runs, not when the card is charged. None of this is an expense in the
// books: the same money shows up as card or bank spend.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent } from '@agfn/connector-sdk'

/** A fixed message when the sum stops being exact: better no number than a wrong one. */
export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw new ConnectorError('permanent', 'These Pinterest totals are too large to add exactly.', { provider: 'pinterest', forUser: true })
  return n
}

/** Micro-units to the currency's smallest unit, half up. A currency with no cents divides by a million. */
export function microsToMinor(micros: number, currency: string): number {
  const per = 10 ** (6 - currencyExponent(currency))
  const whole = Math.floor(micros / per)
  return (micros % per) * 2 >= per ? whole + 1 : whole
}

/** The row the connection's drawer shows. */
export const REPORT_ROW_SPEND = 'Spent on Pinterest ads'

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** One row, no `totals` and no "Net income" row on purpose: this is what Pinterest reports, not a profit figure. */
export function monthRows(minor: number, currency: string): ReportSnapshot['rows'] {
  return [{ account: REPORT_ROW_SPEND, amount: m(minor, currency), section: 'Advertising', depth: 0 }]
}

/** The first of the month after "2026-09-14". */
export function nextMonthStart(day: string): string {
  const [y, mo] = day.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10)
}

export const lastDay = (month: string) => new Date(Date.parse(`${nextMonthStart(`${month}-01`)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
