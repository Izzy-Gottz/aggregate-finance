// MRR normalization following Stripe's definition (docs.stripe.com/billing/subscriptions/analytics): the
// monthly-normalized value of active and past_due subscriptions, after discounts, excluding tax and metered usage.
//
// Exact rational arithmetic in BigInt: each item contributes unit_amount × quantity × (months per interval)⁻¹,
// discounts are applied in Stripe's order (item discounts on their item, then subscription discounts on the total),
// and the result is rounded half away from zero ONCE at the end. No floats touch money.
//
// Interval factors (per Stripe): month 1/n, year 1/(12n), week 52/(12n), day 365/(12n).
// Discounts: percent_off scales; amount_off is an amount per invoice, so it is spread monthly with the same factor.
// Only discounts still in effect count: 'forever' and 'repeating' coupons whose end is in the future. 'once' coupons
// are left out (they don't recur; Stripe makes subtracting one-time discounts a dashboard choice).
// Tiered prices (billing_scheme 'tiered') are valued from their tiers by Stripe's rules (tieredAmount); a tiered price
// whose tiers couldn't be read is left out rather than guessed. transform_quantity divides the quantity first.

import type { Money } from '@agfn/contracts'
import { normalizeCurrency } from '@agfn/connector-sdk'
import type { StripeCoupon, StripeDiscount, StripeInvoice, StripePrice, StripePriceTier, StripeSubscription, StripeSubscriptionItem } from './types.ts'

/** Non-negative-denominator fraction. */
export interface Ratio {
  n: bigint
  d: bigint
}

const ZERO: Ratio = { n: 0n, d: 1n }
const add = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })
const sub = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d })
const mul = (a: Ratio, b: Ratio): Ratio => ({ n: a.n * b.n, d: a.d * b.d })
const int = (x: number | bigint): Ratio => ({ n: BigInt(x), d: 1n })

/** "12.5" → 125/10, exactly. Accepts plain non-negative decimals only. */
export function decimalRatio(s: string): Ratio | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim())
  if (!m) return undefined
  const frac = m[2] ?? ''
  return { n: BigInt((m[1] ?? '0') + frac), d: 10n ** BigInt(frac.length) }
}

/** Round half away from zero to an integer. */
export function roundHalfAway(r: Ratio): number {
  const neg = r.n < 0n !== r.d < 0n
  const n = r.n < 0n ? -r.n : r.n
  const d = r.d < 0n ? -r.d : r.d
  const q = (2n * n + d) / (2n * d)
  return Number(neg ? -q : q)
}

export type Interval = 'day' | 'week' | 'month' | 'year'

/** Months per one billing period, inverted: the factor that turns a per-period amount into a monthly amount. */
export function monthlyFactor(interval: Interval, count: number): Ratio {
  const c = BigInt(Math.max(1, Math.trunc(count)))
  switch (interval) {
    case 'month':
      return { n: 1n, d: c }
    case 'year':
      return { n: 1n, d: 12n * c }
    case 'week':
      return { n: 52n, d: 12n * c }
    case 'day':
      return { n: 365n, d: 12n * c }
  }
}

/** Unit price as an exact ratio of minor units (unit_amount_decimal carries sub-cent precision). */
export function unitAmount(p: StripePrice): Ratio | undefined {
  if (typeof p.unit_amount_decimal === 'string') {
    const r = decimalRatio(p.unit_amount_decimal)
    if (r) return r
  }
  return typeof p.unit_amount === 'number' && Number.isSafeInteger(p.unit_amount) ? int(p.unit_amount) : undefined
}

const exact = (dec: string | null | undefined, whole: number | null | undefined): Ratio =>
  (typeof dec === 'string' ? decimalRatio(dec) : undefined) ?? (typeof whole === 'number' && Number.isSafeInteger(whole) ? int(whole) : ZERO)

/**
 * Per-period amount of `qty` units of a tiered price, exactly as Stripe bills it (docs.stripe.com/subscriptions/
 * pricing-models/tiered-pricing). Volume: the whole quantity at the tier it falls in, plus that tier's flat amount.
 * Graduated: each tier's share of the quantity at that tier's unit amount, plus the flat amount of every tier reached.
 * Quantity 0 bills the first tier's flat amount in both modes. Undefined when the tiers weren't read (no expand).
 */
export function tieredAmount(p: StripePrice, qty: number): Ratio | undefined {
  if (!p.tiers?.length || (p.tiers_mode !== 'graduated' && p.tiers_mode !== 'volume')) return undefined
  // Ascending, the unbounded tier (up_to null) last.
  const tiers = [...p.tiers].sort((a, b) => (a.up_to ?? Infinity) - (b.up_to ?? Infinity))
  const q = BigInt(Math.max(0, Math.trunc(qty)))
  const unit = (t: StripePriceTier) => exact(t.unit_amount_decimal, t.unit_amount)
  const flat = (t: StripePriceTier) => exact(t.flat_amount_decimal, t.flat_amount)
  if (p.tiers_mode === 'volume') {
    const t = tiers.find((x) => x.up_to === null || q <= BigInt(x.up_to)) ?? tiers.at(-1)!
    return add(mul(unit(t), { n: q, d: 1n }), flat(t))
  }
  let total: Ratio = ZERO
  let prev = 0n
  for (const [i, t] of tiers.entries()) {
    const top = t.up_to === null ? q : BigInt(t.up_to) < q ? BigInt(t.up_to) : q
    const units = top > prev ? top - prev : 0n
    if (units === 0n && i > 0) break
    total = add(total, add(mul(unit(t), { n: units, d: 1n }), flat(t)))
    if (t.up_to === null || q <= BigInt(t.up_to)) break
    prev = BigInt(t.up_to)
  }
  return total
}

/** Units billed for a per-unit price: transform_quantity divides (rounding up or down) before the unit amount applies. */
function billedUnits(p: StripePrice, qty: number): bigint {
  const q = BigInt(Math.max(0, Math.trunc(qty)))
  const by = p.transform_quantity?.divide_by
  if (!by || by <= 1 || !Number.isSafeInteger(by)) return q
  const d = BigInt(by)
  return p.transform_quantity?.round === 'up' ? (q + d - 1n) / d : q / d
}

export function isMetered(p: StripePrice): boolean {
  return p.recurring?.usage_type === 'metered' || !!p.recurring?.meter
}

/** Coupon reachable from a discount (clover `source.coupon`, or the legacy `coupon`), if expanded/resolved. */
export function discountCoupon(d: StripeDiscount): string | StripeCoupon | undefined {
  return d.source?.coupon ?? d.coupon ?? undefined
}

/** A discount still reduces future invoices. */
export function discountActive(d: StripeDiscount, coupon: StripeCoupon, nowSec: number): boolean {
  if (coupon.duration === 'once') return false
  if (typeof d.end === 'number' && d.end <= nowSec) return false
  return true
}

/** Apply one coupon to a monthly amount. amount_off is per invoice → spread with the subscription's factor. */
function applyCoupon(amount: Ratio, coupon: StripeCoupon, currency: string, factor: Ratio): Ratio {
  if (typeof coupon.percent_off === 'number' && coupon.percent_off > 0) {
    const pct = decimalRatio(String(coupon.percent_off)) ?? ZERO
    return mul(amount, sub(int(1), mul(pct, { n: 1n, d: 100n })))
  }
  const off = amountOff(coupon, currency)
  if (off !== undefined) return sub(amount, mul(int(off), factor))
  return amount
}

function amountOff(c: StripeCoupon, currency: string): number | undefined {
  const cur = currency.toLowerCase()
  if (typeof c.amount_off === 'number' && (c.currency ?? '').toLowerCase() === cur) return c.amount_off
  const opt = c.currency_options?.[cur]
  return opt && typeof opt.amount_off === 'number' ? opt.amount_off : undefined
}

const nonNegative = (r: Ratio): Ratio => (r.n < 0n !== r.d < 0n && r.n !== 0n ? ZERO : r)

export interface ResolvedItem {
  item: StripeSubscriptionItem
  /** Per-period amount (unit × quantity, or the tiers' total), rounded once; undefined for metered items and for
   *  tiered ones whose tiers weren't read. */
  amount?: Money
  /** Monthly contribution before subscription-level discounts (exact). */
  monthly: Ratio
  counted: boolean
}

export type CouponLookup = (d: StripeDiscount) => StripeCoupon | undefined

function discountsOf(list: Array<string | StripeDiscount> | null | undefined): StripeDiscount[] {
  return (list ?? []).filter((d): d is StripeDiscount => typeof d === 'object' && d !== null)
}

/**
 * Monthly recurring revenue of one subscription. `coupons` resolves a discount's coupon (expanded or fetched);
 * an unresolvable coupon is ignored. `nowSec` decides whether a repeating discount has ended.
 */
export function subscriptionMrr(
  s: StripeSubscription,
  coupons: CouponLookup,
  nowSec: number,
): { mrr: Money; items: ResolvedItem[] } {
  const currency = normalizeCurrency(s.currency)
  const items: ResolvedItem[] = []
  let total: Ratio = ZERO
  for (const item of s.items.data) {
    const p = item.price
    const qty = typeof item.quantity === 'number' ? item.quantity : 1
    const unit = p.billing_scheme === 'tiered' ? undefined : unitAmount(p)
    const perPeriod = p.billing_scheme === 'tiered' ? tieredAmount(p, qty) : unit ? mul(unit, { n: billedUnits(p, qty), d: 1n }) : undefined
    const counted = !!perPeriod && !!p.recurring && !isMetered(p)
    // Metered items, and tiered ones without their tiers, carry no fixed per-period amount: none (and out of `items`).
    const amount = counted && perPeriod ? { minor: roundHalfAway(perPeriod), currency: normalizeCurrency(p.currency) } : undefined
    let monthly: Ratio = ZERO
    if (counted && perPeriod && p.recurring) {
      const f = monthlyFactor(p.recurring.interval, p.recurring.interval_count)
      monthly = mul(perPeriod, f)
      for (const d of discountsOf(item.discounts)) {
        const c = coupons(d)
        if (c && discountActive(d, c, nowSec)) monthly = nonNegative(applyCoupon(monthly, c, s.currency, f))
      }
      total = add(total, monthly)
    }
    items.push({ item, ...(amount ? { amount } : {}), monthly, counted })
  }

  const iv = subscriptionInterval(s)
  const subFactor = monthlyFactor(iv.interval, iv.intervalCount)
  const subDiscounts = [...discountsOf(s.discounts)]
  if (s.discount && !subDiscounts.some((d) => d.id === s.discount?.id)) subDiscounts.push(s.discount)
  for (const d of subDiscounts) {
    const c = coupons(d)
    if (c && discountActive(d, c, nowSec)) total = nonNegative(applyCoupon(total, c, s.currency, subFactor))
  }

  const counts = s.status === 'active' || s.status === 'past_due'
  const minor = counts ? Math.max(0, roundHalfAway(nonNegative(total))) : 0
  return { mrr: { minor, currency }, items }
}

/** Billing interval of the subscription: every item shares one (Stripe requires it); first priced item wins. */
export function subscriptionInterval(s: StripeSubscription): { interval: Interval; intervalCount: number } {
  const r = s.items.data.find((i) => i.price.recurring)?.price.recurring
  return r ? { interval: r.interval, intervalCount: Math.max(1, Math.trunc(r.interval_count)) } : { interval: 'month', intervalCount: 1 }
}

/**
 * Past MRR of a subscription from its invoices, oldest first: one value per billed period (its regular subscription
 * lines, prorations left out, net of their discounts, made monthly with the subscription's interval). The first value
 * is dated at the subscription's start; later ones at the period they charge for. Equal neighbours collapse, nothing
 * after `nowSec`. Lines of items today's MRR leaves out (metered, tiered without tiers) stay out; items since removed count, so a
 * downgrade shows. Only paid and open invoices: a draft or void one never billed anyone.
 */
export function subscriptionHistory(
  s: StripeSubscription,
  invoices: readonly StripeInvoice[],
  excludedItems: ReadonlySet<string>,
  nowSec: number,
): Array<{ at: number; mrr: Money }> {
  const currency = normalizeCurrency(s.currency)
  const { interval, intervalCount } = subscriptionInterval(s)
  const factor = monthlyFactor(interval, intervalCount)
  const points: Array<{ at: number; minor: number }> = []
  for (const inv of invoices) {
    if (inv.status !== 'paid' && inv.status !== 'open') continue
    if (normalizeCurrency(inv.currency) !== currency) continue
    let total: Ratio = ZERO
    let at: number | undefined
    for (const l of inv.lines.data) {
      const d = l.parent?.subscription_item_details
      if (l.parent?.type !== 'subscription_item_details' || !d || d.proration) continue
      if (d.subscription && d.subscription !== s.id) continue
      if (d.subscription_item && excludedItems.has(d.subscription_item)) continue
      const off = (l.discount_amounts ?? []).reduce((sum, x) => sum + x.amount, 0)
      total = add(total, int(l.amount - off))
      if (l.period?.start !== undefined) at = at === undefined ? l.period.start : Math.min(at, l.period.start)
    }
    if (at === undefined || at > nowSec) continue
    points.push({ at, minor: Math.max(0, roundHalfAway(mul(total, factor))) })
  }
  points.sort((a, b) => a.at - b.at)
  const out: Array<{ at: number; mrr: Money }> = []
  for (const p of points) if (out.at(-1)?.mrr.minor !== p.minor) out.push({ at: p.at, mrr: { minor: p.minor, currency } })
  const start = s.start_date || s.created
  if (out[0] && start && start < out[0].at) out[0] = { ...out[0], at: start }
  return out
}
