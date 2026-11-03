// One Mollie balance report, read into minor units, checked, and turned into report rows.
//
// The report groups a month's balance movements by kind (payments, refunds, chargebacks, Mollie's fees ...). Within each kind
// Mollie splits money landing in the pending balance, money landing straight in the available balance, and money moving from
// pending to available. Only the first two change the balance; the move is counted once already. So a kind's month is
// pending + immediatelyAvailable, and the check is exact: opening balance plus every kind must equal the closing balance to
// the cent, or the sync stops.
//
// basis is 'cash' because a balance moves when money does. None of this posts: payouts reach the bank, which may be
// connected already, so they're shown on their own line.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isRecord, toMinor } from '@agfn/connector-sdk'
import { unreadable } from './client.ts'

/** Mollie's kinds, in the order shown. A kind not listed here stops the sync: it could be money of any sort. */
export const KINDS: ReadonlyArray<readonly [string, string]> = [
  ['payments', 'Payments'],
  ['refunds', 'Refunds'],
  ['chargebacks', 'Chargebacks'],
  ['fee-prepayments', 'Mollie fees'],
  ['corrections', 'Corrections'],
  ['capital', 'Mollie Capital'],
  ['topups', 'Top-ups'],
  ['transfers', 'Paid out to your bank'],
]
const KNOWN = new Set(KINDS.map(([k]) => k))
/** Money from selling: the drawer's line. Payouts, loans, top-ups and corrections aren't sales. */
const SALES = ['payments', 'refunds', 'chargebacks', 'fee-prepayments']

export const REPORT_ROW_NET_SALES = 'Net from sales, after Mollie fees'
export const REPORT_ROW_CLOSE = 'Mollie balance at month end'

export interface MonthTotals {
  kinds: Record<string, number>
  close: number
}

const stop = (msg: string) => new ConnectorError('permanent', msg, { provider: 'mollie', forUser: true })

export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw stop('These Mollie totals are too large to add exactly.')
  return n
}

/** A Mollie amount object. Its currency must be the balance's, and its value a decimal string within the currency's places. */
export function money(v: unknown, currency: string): number {
  if (!isRecord(v) || v.currency !== currency || typeof v.value !== 'string' || !/^-?\d+(\.\d+)?$/.test(v.value)) throw unreadable('an amount')
  if ((v.value.split('.')[1]?.length ?? 0) > currencyExponent(currency)) throw unreadable('an amount')
  try {
    return toMinor(v.value, currency)
  } catch {
    throw unreadable('an amount')
  }
}

/** A sub-group's amount; a sub-group that isn't there is nothing. */
function part(group: Record<string, unknown>, key: string, currency: string): number {
  const g = group[key]
  if (g === undefined || g === null) return 0
  if (!isRecord(g)) throw unreadable('a report')
  return money(g.amount, currency)
}

/** One report's totals, checked against Mollie's own opening and closing balances. */
export function readTotals(totals: Record<string, unknown>, currency: string): MonthTotals {
  const group = (k: string): Record<string, unknown> => {
    const g = totals[k]
    if (g === undefined || g === null) return {}
    if (!isRecord(g)) throw unreadable('a report')
    return g
  }
  for (const k of Object.keys(totals)) if (k !== 'open' && k !== 'close' && !KNOWN.has(k)) throw unreadable('a kind of money')
  if (!isRecord(totals.open) || !isRecord(totals.close)) throw unreadable('a report')
  const open = exact(part(group('open'), 'pending', currency) + part(group('open'), 'available', currency))
  const close = exact(part(group('close'), 'pending', currency) + part(group('close'), 'available', currency))
  const kinds: Record<string, number> = {}
  let moved = 0
  for (const [k] of KINDS) {
    const g = group(k)
    const n = exact(part(g, 'pending', currency) + part(g, 'immediatelyAvailable', currency))
    kinds[k] = n
    moved = exact(moved + n)
  }
  if (exact(open + moved) !== close) throw stop('Mollie’s balance report doesn’t add up from its opening to its closing balance, so this sync stopped. No totals were changed.')
  return { kinds, close }
}

export function add(a: MonthTotals, b: MonthTotals): MonthTotals {
  const kinds: Record<string, number> = {}
  for (const [k] of KINDS) kinds[k] = exact((a.kinds[k] ?? 0) + (b.kinds[k] ?? 0))
  return { kinds, close: exact(a.close + b.close) }
}

export const emptyTotals = (): MonthTotals => ({ kinds: Object.fromEntries(KINDS.map(([k]) => [k, 0])), close: 0 })

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** One month's rows, in Mollie's sign: sales kinds, their net, the other kinds, then the closing balance. */
export function monthRows(t: MonthTotals, currency: string): ReportSnapshot['rows'] {
  const row = (k: string) => ({ account: KINDS.find(([key]) => key === k)![1], amount: m(t.kinds[k] ?? 0, currency), section: 'Mollie balance', depth: 0 })
  const net = SALES.reduce((s, k) => exact(s + (t.kinds[k] ?? 0)), 0)
  return [
    ...SALES.map(row),
    { account: REPORT_ROW_NET_SALES, amount: m(net, currency), section: 'Mollie balance', depth: 0 },
    ...KINDS.filter(([k]) => !SALES.includes(k)).map(([k]) => row(k)),
    { account: REPORT_ROW_CLOSE, amount: m(t.close, currency), section: 'Balance', depth: 0 },
  ]
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

/** "2026-09-14" on Amsterdam's clock. */
export function amsterdamDay(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
}

export const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
