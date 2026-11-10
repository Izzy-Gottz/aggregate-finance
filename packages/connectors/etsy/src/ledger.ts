// Etsy payment account ledger: every entry read, checked, and turned into exactly one row.
//
// Every amount is an integer in the currency's minor units, signed as money into the shop's balance (a sale positive, a
// fee or a deposit to the bank negative). Amounts are used as sent, never by absolute value, so a sign this file reads
// wrongly can't hide: the chain check below fails instead.
//
// Categories, from `ledger_type`. Etsy's spec doesn't list the values; these are the names seen in Etsy's responses as
// third-party integrations record them (README, Unverified). Matched without regard to case. Any other name stops the
// sync with that name in the message: leaving an entry out would make every total after it wrong.
//
//   charge    PAYMENT_GROSS: a buyer's payment, as Etsy credits it to the balance.
//   refund    REFUND: money back to a buyer.
//   fee       Etsy's fees: payment processing, transaction (per item, per quantity, on shipping, on gift wrap), listing
//             and renewals, Offsite Ads, shipping labels, the regulatory operating fee, the deposit fee, the seller
//             onboarding fee, and the VAT Etsy charges on its own fees. A `*_refund` of any of these is Etsy handing the
//             fee back: still kind fee, a negative fee.
//   sales_tax sales_tax: tax Etsy collects from the buyer and remits itself. `salesTax: true`, so it is never revenue.
//   payout    DISBURSE, DISBURSE2: a deposit to the seller's bank. Its own payoutExternalId, matched to the deposit by core.
//
// No dispute (chargeback, case) or reserve ledger_type has been seen yet, so none is mapped: the first one stops the sync
// with its name, and is added here once it's known what it is.
//
// THE CHAIN. Each entry's `balance` must be the balance before it plus its `amount`, in sequence_number order, per
// ledger. A window whose entries don't chain (or don't chain from the last entry already recorded) stops the sync, and
// nothing from that window is sent: an entry missing, repeated or misread would make the balance and every total wrong.

import type { BalanceSnapshot, ProcessorBalanceTxn } from '@agfn/contracts'
import { ConnectorError, currencyExponent, isoTimestamp, isRecord } from '@agfn/connector-sdk'
import { unreadable } from './client.ts'
import type { EtsyLedgerEntry } from './types.ts'

const PROVIDER = 'etsy'

export type Category = 'charge' | 'refund' | 'fee' | 'sales_tax' | 'payout'

const names = (c: Category, list: string[]) => list.map((n) => [n.toLowerCase(), c] as const)
export const LEDGER_TYPES: ReadonlyMap<string, Category> = new Map<string, Category>([
  ...names('charge', ['PAYMENT_GROSS']),
  ...names('refund', ['REFUND']),
  ...names('sales_tax', ['sales_tax']),
  ...names('payout', ['DISBURSE', 'DISBURSE2']),
  ...names('fee', [
    'PAYMENT_PROCESSING_FEE',
    'transaction',
    'transaction_quantity',
    'shipping_transaction',
    'gift_wrap_fees',
    'listing',
    'listing_private',
    'renew_expired',
    'renew_sold',
    'renew_sold_auto',
    'auto_renew_expired',
    'offsite_ads_fee',
    'shipping_labels',
    'regulatory_operating_fee',
    'DEPOSIT_FEE',
    'seller_onboarding_fee',
    'vat_on_processing_fees',
    'vat_seller_services',
    // Etsy handing a fee back.
    'transaction_refund',
    'transaction_quantity_refund',
    'shipping_transaction_refund',
    'listing_refund',
    'listing_private_refund',
    'renew_sold_auto_refund',
    'offsite_ads_fee_refund',
    'shipping_label_refund',
  ]),
])

/** One ledger entry, with only what a row needs. This is what raw keeps: no description, no payment adjustments. */
export interface Entry {
  id: string
  ledger: string
  seq: number
  amount: number
  balance: number
  currency: string
  /** Epoch seconds. */
  created: number
  type: string
  refType?: string
  refId?: string
  parent?: string
}

/** The last entry recorded in one ledger. */
export interface ChainEnd {
  seq: number
  balance: number
  currency: string
  /** Epoch seconds. */
  at: number
}

export const isEntry = (v: unknown): v is Entry =>
  isRecord(v) &&
  ['id', 'ledger', 'currency', 'type'].every((k) => typeof v[k] === 'string') &&
  ['seq', 'amount', 'balance', 'created'].every((k) => Number.isSafeInteger(v[k])) &&
  ['refType', 'refId', 'parent'].every((k) => v[k] === undefined || typeof v[k] === 'string')

export const isChainEnd = (v: unknown): v is ChainEnd =>
  isRecord(v) && Number.isSafeInteger(v.seq) && Number.isSafeInteger(v.balance) && Number.isSafeInteger(v.at) && typeof v.currency === 'string'

const int = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw unreadable(what)
  return v
}
const id = (v: unknown, what: string): string => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v)
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v)) return v
  throw unreadable(what)
}
const optional = (v: unknown, re: RegExp): string | undefined => {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return undefined
  const s = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : typeof v === 'string' ? v : ''
  return re.test(s) ? s : undefined
}

export const etsyUnknownType = (name: string) =>
  `Etsy listed a kind of payment account entry Aggregate doesn’t read yet (${name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'unnamed'}). Leaving it out would make the totals wrong, so this sync stopped. Nothing from those days was recorded, and the days before are unchanged.`

const day = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10)
export const etsyChainBroken = (from: number, to: number) =>
  `Etsy’s payment account entries between ${day(from)} and ${day(to)} don’t add up: an entry’s balance isn’t the balance before it plus its amount. This sync stopped before recording anything from those days, and the days before are unchanged.`
export const etsyMixedCurrency = (ledgerCurrency: string, entryCurrency: string) =>
  `Etsy listed an entry in ${entryCurrency} in a payment account kept in ${ledgerCurrency}. Adding them would be wrong, so this sync stopped. Nothing from those days was recorded.`

export const etsyTwoLedgers = (currency: string) =>
  `Etsy lists a second payment account in ${currency} for this shop. Aggregate keeps one balance per currency and can’t tell which is which yet, so this sync stopped. Nothing from those days was recorded.`

/** A raw entry from Etsy → an Entry, or stop. Its ledger_type must be one this file knows. */
export function readEntry(e: EtsyLedgerEntry): Entry {
  if (!isRecord(e)) throw unreadable('a ledger entry')
  const type = typeof e.ledger_type === 'string' ? e.ledger_type : ''
  if (!LEDGER_TYPES.has(type.toLowerCase())) throw new ConnectorError('permanent', etsyUnknownType(type), { provider: PROVIDER, forUser: true })
  const currency = e.currency
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw unreadable('a ledger entry’s currency')
  // Etsy's integers are taken as ISO minor units; a currency with none would need checking first.
  if (currencyExponent(currency) === 0) throw new ConnectorError('permanent', `Etsy lists this shop’s payment account in ${currency}, which Aggregate hasn’t checked yet, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })
  const created = int(e.created_timestamp ?? e.create_date, 'a ledger entry’s date')
  if (created < 946_684_800) throw unreadable('a ledger entry’s date')
  const refType = optional(e.reference_type, /^[a-z_]{1,40}$/)
  const refId = optional(e.reference_id, /^[0-9]{1,20}$/)
  const parent = optional(e.parent_entry_id, /^[0-9]{1,20}$/)
  return {
    id: id(e.entry_id, 'a ledger entry id'),
    ledger: id(e.ledger_id, 'a ledger id'),
    seq: int(e.sequence_number, 'a ledger entry’s order'),
    amount: int(e.amount, 'a ledger amount'),
    balance: int(e.balance, 'a ledger balance'),
    currency,
    created,
    type,
    ...(refType ? { refType } : {}),
    ...(refId ? { refId } : {}),
    ...(parent ? { parent } : {}),
  }
}

/**
 * Orders a window's entries and checks each ledger's chain, from `ends` (the last entry recorded per ledger, if any).
 * Entries already recorded (at or before a ledger's end, and in `recorded`) are dropped; one at or before the end that
 * wasn't recorded can't be placed, so it breaks the chain. Returns the new entries in order and the new ends.
 */
export function chain(
  entries: Entry[],
  ends: Record<string, ChainEnd>,
  recorded: ReadonlySet<string>,
  window: { from: number; to: number },
): { fresh: Entry[]; ends: Record<string, ChainEnd> } {
  const broken = () => new ConnectorError('permanent', etsyChainBroken(window.from, window.to), { provider: PROVIDER, forUser: true })
  const sorted = [...new Map(entries.map((e) => [e.id, e])).values()].sort((a, b) => a.seq - b.seq || Number(BigInt(a.id) - BigInt(b.id)))
  const next: Record<string, ChainEnd> = { ...ends }
  const fresh: Entry[] = []
  for (const e of sorted) {
    const end = next[e.ledger]
    if (end && e.currency !== end.currency) throw new ConnectorError('permanent', etsyMixedCurrency(end.currency, e.currency), { provider: PROVIDER, forUser: true })
    if (end && e.seq <= end.seq) {
      if (recorded.has(e.id)) continue
      throw broken()
    }
    if (recorded.has(e.id)) throw broken()
    // One balance per currency: a second ledger in a currency already kept would share its account and its snapshot.
    if (!end && Object.entries(next).some(([l, x]) => l !== e.ledger && x.currency === e.currency)) throw new ConnectorError('permanent', etsyTwoLedgers(e.currency), { provider: PROVIDER, forUser: true })
    // The very first entry read in a ledger has nothing before it: its balance less its amount is where the account
    // stood, and core takes that from the balance snapshot as the opening balance.
    if (end && end.balance + e.amount !== e.balance) throw broken()
    if (!Number.isSafeInteger(e.balance - e.amount)) throw broken()
    next[e.ledger] = { seq: e.seq, balance: e.balance, currency: e.currency, at: e.created }
    fresh.push(e)
  }
  return { fresh, ends: next }
}

export const accountId = (shopId: number, currency: string) => `etsy:${shopId}:${currency}`

/** One entry → its one row. Zero amounts send nothing (they move no money), but were still checked above. */
export function row(e: Entry, ctx: { shopId: number; connectionId: string; rawRef: string }): ProcessorBalanceTxn | null {
  if (e.amount === 0) return null
  const cat = LEDGER_TYPES.get(e.type.toLowerCase())
  if (!cat) throw new ConnectorError('permanent', etsyUnknownType(e.type), { provider: PROVIDER, forUser: true })
  const m = (minor: number) => ({ minor: minor === 0 ? 0 : minor, currency: e.currency })
  const base = {
    type: 'processor.balance_txn' as const,
    externalId: `etsy:${e.id}`,
    connectionId: ctx.connectionId,
    rawRef: ctx.rawRef,
    accountExternalId: accountId(ctx.shopId, e.currency),
    at: isoTimestamp(e.created),
  }
  switch (cat) {
    case 'charge':
      return { ...base, kind: 'charge', gross: m(e.amount), fee: m(0), net: m(e.amount) }
    case 'refund':
      return { ...base, kind: 'refund', gross: m(e.amount), fee: m(0), net: m(e.amount) }
    case 'fee':
      // `fee` is the cost: a fee taken (negative amount) is a positive fee, a fee handed back a negative one.
      return { ...base, kind: 'fee', gross: m(0), fee: m(-e.amount), net: m(e.amount) }
    case 'sales_tax':
      return { ...base, kind: 'adjustment', gross: m(e.amount), fee: m(0), net: m(e.amount), salesTax: true }
    case 'payout':
      // Out of the balance to the bank: core looks for a deposit of −net from this day on.
      return { ...base, kind: 'payout', gross: m(e.amount), fee: m(0), net: m(e.amount), payoutExternalId: `etsy:${e.id}`, arrivalDate: day(e.created) }
  }
}

/** The balance after a window's last entry, per ledger it touched. */
export function snapshots(fresh: Entry[], ends: Record<string, ChainEnd>, ctx: { shopId: number; connectionId: string; rawRef: string }): BalanceSnapshot[] {
  const touched = [...new Set(fresh.map((e) => e.ledger))].sort()
  return touched.map((ledger) => {
    const end = ends[ledger]!
    const at = isoTimestamp(end.at)
    const acct = accountId(ctx.shopId, end.currency)
    return { type: 'balance.snapshot', externalId: `${acct}@${at.slice(0, 10)}`, connectionId: ctx.connectionId, rawRef: ctx.rawRef, accountExternalId: acct, at, current: { minor: end.balance, currency: end.currency } }
  })
}
