// Chargebee → SubscriptionUpsert, with MRR computed here (exact fractions, rounded once), not taken from Chargebee's
// own `mrr` field, which its docs say "may not return accurate values since updated asynchronously".
//
// Only subscriptions are read. Chargebee bills through a payment gateway (Stripe, Braintree...): the money and the
// gateway's fees arrive through that gateway's connection or the bank feed. Booking Chargebee's invoices and payments
// as well would count the same sale twice, so they're left out.
//
// MRR follows the contract's definition (Stripe's): recurring plan and addon lines, monthly-normalized, after
// discounts, excluding tax, one-off charges and metered usage.
//   line      = the item's `amount` (Chargebee's own total from unit price, quantity, free quantity and tiers),
//               per the item's billing period (multi-frequency) or the subscription's.
//   per item  = discounts and coupons aimed at that item price: percent off, fixed amount off, or free units
//               (quantity × unit price off), each line floored at 0.
//   per sub   = then invoice-level percentages scale the total, then invoice-level fixed amounts (per the
//               subscription's billing period) come off. Floored at 0.
// Discounts count when forever or limited_period (Chargebee drops expired ones from the list); one_time ones only when
// Chargebee marks them included_in_mrr. Coupons count the same way, and not after their apply_till.
// What can't be computed exactly (a coupon with criteria-based item constraints, a line with no amount and no unit
// price, no billing period) falls back to Chargebee's own `mrr`, and the sync says how many did.

import type { Money, SubscriptionUpsert } from '@agfn/contracts'
import { isoTimestamp, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import { add, monthlyFraction, norm, roundHalfAway, type Frac, type Interval } from './mrr.ts'
import type { CbDiscount, CbSubscription, CbSubscriptionItem } from './types.ts'

/** A coupon from GET /coupons/{id}, only what MRR needs. */
export interface CbCoupon {
  id: string
  discount_type: 'fixed_amount' | 'percentage' | 'offer_quantity'
  discount_percentage?: number
  discount_amount?: number
  discount_quantity?: number
  duration_type: 'one_time' | 'forever' | 'limited_period'
  included_in_mrr?: boolean
  apply_on: 'invoice_amount' | 'each_specified_item'
  item_constraints?: Array<{ item_type: 'plan' | 'addon' | 'charge'; constraint: 'none' | 'all' | 'specific' | 'criteria'; item_price_ids?: string[] }>
}

/** A discount reduced to what the math needs: where it applies and how much. */
interface Off {
  /** Item price ids it applies to; undefined = the whole subscription (invoice level). */
  target?: (item: CbSubscriptionItem) => boolean
  kind: 'percent' | 'amount' | 'units'
  /** Percent as an exact fraction of 1, a minor amount, or a unit count. */
  value: Frac | number
}

export interface MrrResult {
  minor: number
  /** True when Chargebee's own figure was used because ours couldn't be computed exactly. */
  fallback: boolean
}

const ONE: Frac = { n: 1n, d: 1n }
const ZERO: Frac = { n: 0n, d: 1n }
const mul = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.n, d: a.d * b.d })
const sub = (a: Frac, b: Frac): Frac => add(a, { n: -b.n, d: b.d })
const floor0 = (f: Frac): Frac => (f.n < 0n ? ZERO : f)

/** 12.5 → 1/8, exactly from the decimal digits (no float error). */
export function percentFraction(p: number): Frac | undefined {
  if (!Number.isFinite(p) || p < 0 || p > 100) return undefined
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(p))
  if (!m) return undefined
  const frac = m[2] ?? ''
  return norm({ n: BigInt(m[1]! + frac), d: 100n * 10n ** BigInt(frac.length) })
}

const counts = (d: { duration_type: string; included_in_mrr?: boolean }) => d.duration_type !== 'one_time' || d.included_in_mrr === true

class Inexact extends Error {}

function offFromDiscount(d: CbDiscount, currency: string): Off | undefined {
  if (!counts(d)) return undefined
  const target = d.apply_on === 'specific_item_price' ? (i: CbSubscriptionItem) => i.item_price_id === d.item_price_id : undefined
  if (d.type === 'percentage') {
    const f = percentFraction(d.percentage ?? NaN)
    if (!f) throw new Inexact()
    return { ...(target ? { target } : {}), kind: 'percent', value: f }
  }
  if (d.type === 'fixed_amount') {
    if (typeof d.amount !== 'number' || (d.currency_code && normalizeCurrency(d.currency_code) !== currency)) throw new Inexact()
    return { ...(target ? { target } : {}), kind: 'amount', value: d.amount }
  }
  if (!target || typeof d.quantity !== 'number') throw new Inexact()
  return { target, kind: 'units', value: d.quantity }
}

function offFromCoupon(c: CbCoupon): Off | undefined {
  if (!counts(c)) return undefined
  let target: Off['target']
  if (c.apply_on === 'each_specified_item') {
    const cons = c.item_constraints ?? []
    if (cons.some((k) => k.constraint === 'criteria')) throw new Inexact()
    target = (i) => {
      const k = cons.find((x) => x.item_type === i.item_type)
      return !!k && (k.constraint === 'all' || (k.constraint === 'specific' && (k.item_price_ids ?? []).includes(i.item_price_id)))
    }
  }
  if (c.discount_type === 'percentage') {
    const f = percentFraction(c.discount_percentage ?? NaN)
    if (!f) throw new Inexact()
    return { ...(target ? { target } : {}), kind: 'percent', value: f }
  }
  if (c.discount_type === 'fixed_amount') {
    if (typeof c.discount_amount !== 'number') throw new Inexact()
    return { ...(target ? { target } : {}), kind: 'amount', value: c.discount_amount }
  }
  if (!target || typeof c.discount_quantity !== 'number') throw new Inexact()
  return { target, kind: 'units', value: c.discount_quantity }
}

/** The item's own total per its billing period, in minor units. */
export function lineAmount(i: CbSubscriptionItem, currency: string): number {
  if (typeof i.amount === 'number') return i.amount
  if (i.amount_in_decimal) return toMinor(i.amount_in_decimal, currency)
  if (typeof i.unit_price === 'number') return i.unit_price * Math.max(0, (i.quantity ?? 1) - (i.free_quantity ?? 0))
  throw new Inexact()
}

const recurring = (i: CbSubscriptionItem) => i.item_type === 'plan' || i.item_type === 'addon'

/** Monthly MRR of the subscription as it's priced now, whatever its status. Throws Inexact when it can't be exact. */
function pricedMrr(s: CbSubscription, coupons: Map<string, CbCoupon | undefined>, nowSec: number): number {
  const currency = normalizeCurrency(s.currency_code)
  const offs: Off[] = []
  for (const d of s.discounts ?? []) {
    const o = offFromDiscount(d, currency)
    if (o) offs.push(o)
  }
  for (const r of s.coupons ?? []) {
    if (typeof r.apply_till === 'number' && r.apply_till <= nowSec) continue
    if (!coupons.has(r.coupon_id)) throw new Inexact()
    const c = coupons.get(r.coupon_id)
    if (!c) throw new Inexact()
    const o = offFromCoupon(c)
    if (o) offs.push(o)
  }
  const subUnit = s.billing_period_unit
  const subCount = s.billing_period ?? 1
  let total = ZERO
  for (const item of (s.subscription_items ?? []).filter(recurring)) {
    const unit = item.billing_period_unit ?? subUnit
    if (!unit) throw new Inexact()
    const count = item.billing_period ?? (item.billing_period_unit ? 1 : subCount)
    let line: Frac = { n: BigInt(lineAmount(item, currency)), d: 1n }
    for (const o of offs.filter((x) => x.target?.(item))) {
      if (o.kind === 'percent') line = mul(line, sub(ONE, o.value as Frac))
      else if (o.kind === 'amount') line = sub(line, { n: BigInt(o.value as number), d: 1n })
      else {
        if (typeof item.unit_price !== 'number') throw new Inexact()
        line = sub(line, { n: BigInt(item.unit_price) * BigInt(o.value as number), d: 1n })
      }
      line = floor0(line)
    }
    const monthly = monthlyFraction(1n, unit as Interval, count)
    total = add(total, mul(line, monthly))
  }
  for (const o of offs.filter((x) => !x.target && x.kind === 'percent')) total = mul(total, sub(ONE, o.value as Frac))
  for (const o of offs.filter((x) => !x.target && x.kind === 'amount')) {
    if (!subUnit) throw new Inexact()
    total = sub(total, mul({ n: BigInt(o.value as number), d: 1n }, monthlyFraction(1n, subUnit as Interval, subCount)))
  }
  const r = roundHalfAway(floor0(total))
  return r > 0 ? r : 0
}

export function subscriptionMrr(s: CbSubscription, coupons: Map<string, CbCoupon | undefined>, nowSec: number): MrrResult {
  try {
    return { minor: pricedMrr(s, coupons, nowSec), fallback: false }
  } catch (e) {
    if (!(e instanceof Inexact)) throw e
    return { minor: Math.max(0, s.mrr ?? 0), fallback: true }
  }
}

type Status = SubscriptionUpsert['status']

export function mapStatus(s: CbSubscription): Status {
  switch (s.status) {
    case 'future':
      return 'incomplete'
    case 'in_trial':
      return 'trialing'
    case 'active':
    case 'non_renewing':
      return (s.due_invoices_count ?? 0) > 0 ? 'past_due' : 'active'
    case 'paused':
      return 'paused'
    default:
      return 'canceled'
  }
}

/**
 * undefined = don't emit: a transferred subscription carries on under a new id in another business entity, so
 * reporting it as canceled would show churn that didn't happen.
 */
export function mapSubscription(s: CbSubscription, coupons: Map<string, CbCoupon | undefined>, nowSec: number, connectionId: string, rawRef: string): { event: SubscriptionUpsert; fallback: boolean } | undefined {
  if (s.status === 'transferred') return undefined
  const currency = normalizeCurrency(s.currency_code)
  const money = (minor: number): Money => ({ minor, currency })
  const startedAt = isoTimestamp(s.started_at ?? s.activated_at ?? s.created_at)
  const items = (s.subscription_items ?? []).filter(recurring)
  const plan = items.find((i) => i.item_type === 'plan')
  const unit = s.billing_period_unit ?? plan?.billing_period_unit ?? 'month'
  const base = {
    type: 'subscription.upsert' as const,
    externalId: s.id,
    connectionId,
    rawRef,
    customer: s.customer_id,
    interval: unit,
    intervalCount: s.billing_period ?? plan?.billing_period ?? 1,
    startedAt,
    ...(items.length
      ? { items: items.map((i) => ({ priceExternalId: i.item_price_id, quantity: 1, amount: money(safeLine(i, currency)) })) }
      : {}),
  }
  // Deleted in Chargebee (usually a mistake or test data): no MRR and no end date, so it leaves the history entirely.
  if (s.deleted) return { event: { ...base, status: 'incomplete_expired', mrr: money(0) }, fallback: false }
  const status = mapStatus(s)
  const priced = subscriptionMrr(s, coupons, nowSec)
  const live = status === 'active' || status === 'past_due'
  const event: SubscriptionUpsert = {
    ...base,
    status,
    mrr: money(live ? priced.minor : 0),
    ...(s.current_term_end ? { currentPeriodEnd: isoTimestamp(s.current_term_end) } : {}),
    cancelAtPeriodEnd: s.status === 'non_renewing',
  }
  if (status === 'canceled') {
    const ended = isoTimestamp(s.cancelled_at ?? s.current_term_end ?? s.updated_at)
    event.canceledAt = ended
    event.endedAt = ended
    // What it was worth while it ran, after discounts, so churn counts the discounted amount (not list price).
    if (priced.minor > 0) event.changes = [{ at: startedAt <= ended ? startedAt : ended, mrr: money(priced.minor) }]
  }
  return { event, fallback: priced.fallback }
}

function safeLine(i: CbSubscriptionItem, currency: string): number {
  try {
    return lineAmount(i, currency)
  } catch (e) {
    if (e instanceof Inexact) return 0
    throw e
  }
}
