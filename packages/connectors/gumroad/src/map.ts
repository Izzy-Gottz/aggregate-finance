// Gumroad → NormalizedEvent mapping.
//
// Gumroad keeps the seller's balance in USD and reports every sale in USD cents (whatever the buyer paid in), so one
// USD processor_balance account per seller holds it:
//   charge:     gross = price (what the seller sold for; Gumroad-remitted VAT/GST is never in it), fee = gumroad_fee +
//               the affiliate's cut, net = gross − fee.
//   refund:     one row per refunded sale (`<saleId>:refund`), updated in place as more is refunded. A full refund
//               mirrors the charge (Gumroad returns its fee with the money, per its payout reports); a partial refund
//               takes the same share of the fee: round(fee × refunded ÷ price), half away from zero. The sales API has
//               no refund date, so the row is dated with the sale.
//   chargeback: a lost dispute (`<saleId>:chargeback`) mirrors the charge, as `dispute`.
//   payout:     paid or in-flight payouts (completed, processing, pending, unclaimed) leave the balance, dated when
//               Gumroad processed them; failed, cancelled and returned ones move nothing. The upcoming payout (no id)
//               is skipped: its sales are already in.

import type { AccountUpsert, Money, ProcessorBalanceTxn } from '@agfn/contracts'
import { isoTimestamp } from '@agfn/connector-sdk'
import type { GumroadPayout, GumroadSale } from './types.ts'

export const accountId = (sellerId: string) => `gumroad:${sellerId}:USD`

export function mapAccount(sellerId: string, name: string | undefined, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: accountId(sellerId),
    connectionId,
    rawRef,
    name: name ? `${name.slice(0, 80)} balance (Gumroad)` : 'Gumroad balance',
    accountType: 'processor_balance',
    currency: 'USD',
    institution: 'Gumroad',
    businessHint: 'business',
  }
}

const usd = (minor: number): Money => {
  if (!Number.isSafeInteger(minor)) throw new TypeError(`not an integer amount: ${minor}`)
  return { minor: minor === 0 ? 0 : minor, currency: 'USD' }
}

/** "1,234.5" / "$2.50" / "150.00" → minor units (2 decimals). Undefined when it isn't a plain amount. */
export function decimalToMinor(s: string | null | undefined): number | undefined {
  if (typeof s !== 'string') return undefined
  const t = s.replace(/[$,\s]/g, '')
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(t)
  if (!m) return undefined
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || '0')
  return m[1] ? -minor : minor
}

/** Round n/d half away from zero (integers in, integer out). */
export function roundDiv(n: number, d: number): number {
  if (d === 0) return 0
  const q = Math.abs(n) * 2 + Math.abs(d)
  const r = Math.floor(q / (Math.abs(d) * 2))
  return (n < 0) !== (d < 0) ? -r : r
}

/** Gumroad's fee plus the affiliate's cut, in USD cents. */
export function saleFee(s: GumroadSale): number {
  return s.gumroad_fee + (decimalToMinor(s.affiliate?.amount) ?? 0)
}

function base(s: GumroadSale, sellerId: string, connectionId: string, rawRef: string) {
  return {
    type: 'processor.balance_txn' as const,
    connectionId,
    rawRef,
    accountExternalId: accountId(sellerId),
    at: isoTimestamp(s.created_at),
    sourceExternalId: s.id,
    ...(s.purchaser_id ? { customer: String(s.purchaser_id) } : {}),
    ...(s.product_name ? { description: s.product_name.slice(0, 500) } : {}),
  }
}

export function mapSaleCharge(s: GumroadSale, sellerId: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (!(s.price > 0)) return undefined
  const fee = saleFee(s)
  return { ...base(s, sellerId, connectionId, rawRef), externalId: s.id, kind: 'charge', gross: usd(s.price), fee: usd(fee), net: usd(s.price - fee) }
}

/**
 * USD cents refunded so far: all of it when Gumroad says refunded; for a partial refund, price minus what's still
 * refundable (only readable when the sale was in USD). Undefined: partly refunded but the amount can't be read.
 */
export function refundedMinor(s: GumroadSale): number | undefined {
  if (s.refunded) return s.price
  if (!s.partially_refunded) return 0
  if ((s.currency ?? 'usd').toLowerCase() !== 'usd') return undefined
  const left = decimalToMinor(s.amount_refundable_in_currency)
  if (left === undefined) return undefined
  return Math.min(s.price, Math.max(0, s.price - left))
}

export function mapSaleRefund(s: GumroadSale, sellerId: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  const amount = refundedMinor(s)
  if (!amount || amount <= 0 || s.price <= 0) return undefined
  const fee = amount >= s.price ? saleFee(s) : roundDiv(saleFee(s) * amount, s.price)
  return { ...base(s, sellerId, connectionId, rawRef), externalId: `${s.id}:refund`, kind: 'refund', gross: usd(-amount), fee: usd(-fee), net: usd(-(amount - fee)) }
}

export function mapSaleChargeback(s: GumroadSale, sellerId: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (!s.chargedback || s.refunded || s.price <= 0) return undefined
  const fee = saleFee(s)
  return { ...base(s, sellerId, connectionId, rawRef), externalId: `${s.id}:chargeback`, kind: 'dispute', gross: usd(-s.price), fee: usd(-fee), net: usd(-(s.price - fee)) }
}

const LEAVING = new Set(['completed', 'processing', 'pending', 'unclaimed'])

/** A payout with an id, in USD. Undefined for the upcoming payout or another currency (see connector warnings). */
export function mapPayout(p: GumroadPayout, sellerId: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (!p.id || (p.currency ?? '').toUpperCase() !== 'USD') return undefined
  const amt = decimalToMinor(p.amount)
  if (amt === undefined) return undefined
  const out = LEAVING.has(p.status) ? -Math.abs(amt) : 0
  const at = p.processed_at ?? p.created_at
  return {
    type: 'processor.balance_txn',
    externalId: `payout:${p.id}`,
    connectionId,
    rawRef,
    accountExternalId: accountId(sellerId),
    at: isoTimestamp(at),
    kind: 'payout',
    gross: usd(out),
    fee: usd(0),
    net: usd(out),
    payoutExternalId: p.id,
    arrivalDate: isoTimestamp(at).slice(0, 10),
  }
}
