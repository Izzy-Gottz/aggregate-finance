// Whop's own income statement, one currency at a time, added up exactly in minor units and turned into report rows.
//
// Whop already groups its ledger lines into families (payments, refunds, disputes, fees ...) and says which side of the
// income statement each falls on. Those families are the rows, in Whop's sign, and the net is their sum. Nothing is
// re-derived: the report's `total` must equal the sum of its rows to the cent, or the sync stops.
//
// basis is 'cash' because Whop's ledger records money when it moves. None of this posts: payouts reach the bank, which may
// be connected already.

import type { Money, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, currencyExponent, toMinor } from '@agfn/connector-sdk'
import { unreadable } from './client.ts'

/** Whop's families, in the order they're shown. A family not listed here stops the sync: it could be money of any kind. */
export const GROUPINGS: ReadonlyArray<readonly [string, string]> = [
  ['payments', 'Payments'],
  ['refunds', 'Refunds'],
  ['disputes', 'Disputes'],
  ['clawbacks', 'Clawbacks'],
  ['fees', 'Fees'],
  ['affiliates_and_revshare', 'Affiliates and revenue share'],
  ['advertising', 'Advertising'],
  ['operational_costs', 'Operational costs'],
  ['bad_debt', 'Bad debt'],
  ['fx', 'Currency conversion'],
  ['platform_credits', 'Platform credits'],
  ['reserves', 'Reserves'],
  ['connected_accounts', 'Connected accounts'],
  ['transfers', 'Transfers'],
  ['withdrawals', 'Withdrawals'],
  ['wallets_and_balance', 'Wallets and balance'],
  ['crypto', 'Crypto'],
  ['airdrops', 'Airdrops'],
  ['legacy', 'Legacy'],
  ['misc', 'Miscellaneous'],
  ['other', 'Other'],
]
const KNOWN = new Map(GROUPINGS)

/** The row the connection's drawer shows: the sum of every family. */
export const REPORT_ROW_NET = 'Net from Whop’s income statement'

/** Minor units per family. */
export type MonthTotals = Record<string, number>

const stop = (msg: string) => new ConnectorError('permanent', msg, { provider: 'whop', forUser: true })

export function exact(n: number): number {
  if (!Number.isSafeInteger(n)) throw stop('These Whop totals are too large to add exactly.')
  return n
}

const ISO = new Set(Intl.supportedValuesOf('currency'))

/** "usd" to "USD". Anything that isn't an ISO currency (a crypto balance such as btc, say) stops the sync rather than drop money. */
export function isoCurrency(c: unknown): string {
  const code = typeof c === 'string' ? c.toUpperCase() : ''
  if (!ISO.has(code)) throw stop('This Whop business has money in a currency Aggregate can’t read, so nothing was reported.')
  return code
}

/** A decimal amount. Whop sends report amounts as JSON numbers, so one with more decimals than the currency stops the sync. */
export function amount(v: unknown, currency: string): number {
  const value = typeof v === 'number' && Number.isFinite(v) ? String(v) : v
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) throw unreadable('an amount')
  if ((value.split('.')[1]?.length ?? 0) > currencyExponent(currency)) throw unreadable('an amount')
  try {
    return toMinor(value, currency)
  } catch {
    throw unreadable('an amount')
  }
}

/**
 * One report's rows, as minor units per month per family. Every row counts toward the check against `total`; only months
 * in [first, until] are kept.
 */
export function readReport(rows: Array<Record<string, unknown>>, total: unknown, currency: string, first: string, until: string): Record<string, MonthTotals> {
  const out: Record<string, MonthTotals> = {}
  let sum = 0
  for (const r of rows) {
    const period = r.period
    const grouping = r.grouping
    if (typeof period !== 'string' || !/^\d{4}-\d{2}/.test(period)) throw unreadable('a report row')
    if (typeof grouping !== 'string' || !KNOWN.has(grouping)) throw unreadable('a kind of money')
    const minor = amount(r.amount, currency)
    sum = exact(sum + minor)
    const month = period.slice(0, 7)
    if (month < first || month > until) continue
    const m = (out[month] ??= {})
    m[grouping] = exact((m[grouping] ?? 0) + minor)
  }
  if (amount(total, currency) !== sum) throw stop('Whop’s income statement doesn’t add up to its own total, so this sync stopped. No totals were changed.')
  return out
}

const m = (minorUnits: number, currency: string): Money => ({ minor: minorUnits === 0 ? 0 : minorUnits, currency })

/** One month's rows: every family seen in the reported months (zero where a month had none), then the net. */
export function monthRows(t: MonthTotals, families: readonly string[], currency: string): ReportSnapshot['rows'] {
  const shown = GROUPINGS.filter(([k]) => families.includes(k))
  let net = 0
  const rows: ReportSnapshot['rows'] = shown.map(([k, label]) => {
    net = exact(net + (t[k] ?? 0))
    return { account: label, amount: m(t[k] ?? 0, currency), section: 'Whop', depth: 0 }
  })
  rows.push({ account: REPORT_ROW_NET, amount: m(net, currency), section: 'Whop', depth: 0 })
  return rows
}

/** "2026-09" plus n months. */
export function addMonths(month: string, n: number): string {
  const [y, mo] = month.split('-').map(Number) as [number, number]
  const d = new Date(Date.UTC(y, mo - 1 + n, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export const lastDay = (month: string) => new Date(Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
