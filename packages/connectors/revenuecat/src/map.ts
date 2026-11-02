// RevenueCat → SubscriptionUpsert. See connector.ts for what is left out and why.
//
// Price, best source first:
//   exact = the customer's latest paid transaction, in the currency they paid, less RevenueCat's estimated tax (MRR
//           excludes tax; store commission stays in, as Stripe's MRR keeps processor fees in). Only the App Store and
//           Play Store have this endpoint. Discounted renewals count as paid, which is the contract's "after discounts".
//   list  = the product's indicative_price, which RevenueCat only gives for USD / US, so a customer paying in another
//           currency or at an offer price is shown at the US list price. Flagged with a warning.
//   none  = no price at all: MRR 0, flagged with a warning.
//
// `gross` is documented two ways ("excluding taxes and commission", and tax and commission "deducted from gross").
// Gross less tax follows the second, which matches how RevenueCat's other docs use it (before commission and taxes).

import { createHash } from 'node:crypto'
import type { Money, SubscriptionUpsert } from '@agfn/contracts'
import { currencyExponent, isoTimestamp, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import { computeMrr, roundHalfAway, type Interval } from './mrr.ts'
import type { RcProduct, RcSubscription, RcTransaction } from './types.ts'

export interface Period {
  interval: Interval
  intervalCount: number
}

export type PriceSource = 'exact' | 'list' | 'none'

const DAY = 86_400_000

/**
 * Status map. `unknown` and `incomplete` (and any status RevenueCat adds later, which its docs warn of) become
 * `incomplete` with no MRR: RevenueCat can't say the customer is paying, `gives_access` says only whether they may use
 * the app, and a subscription that really is paying comes back as active on a later sync.
 */
export function mapStatus(status: string): SubscriptionUpsert['status'] {
  switch (status) {
    case 'trialing':
      return 'trialing'
    case 'active':
      return 'active'
    case 'in_grace_period':
    case 'in_billing_retry':
      return 'past_due'
    case 'expired':
      return 'canceled'
    case 'paused':
      return 'paused'
    default:
      return 'incomplete'
  }
}

/** "P1W", "P3M", "P1Y", "P3D" → a period. Mixed or time-based durations aren't billing periods: undefined. */
export function parseDuration(d: string | null | undefined): Period | undefined {
  const m = /^P(\d+)([DWMY])$/.exec(d ?? '')
  if (!m || Number(m[1]) < 1) return undefined
  const unit = ({ D: 'day', W: 'week', M: 'month', Y: 'year' } as const)[m[2] as 'D' | 'W' | 'M' | 'Y']
  return { interval: unit, intervalCount: Number(m[1]) }
}

const nominalDays = (p: Period) => p.intervalCount * { day: 1, week: 7, month: 30.4, year: 365 }[p.interval]

/** A billing period from its length in days. Only the lengths stores sell; anything else is undefined. */
function periodFromDays(days: number): Period | undefined {
  const near = (d: number, by: number) => Math.abs(days - d) <= by
  if (near(7, 1)) return { interval: 'week', intervalCount: 1 }
  if (near(30, 3)) return { interval: 'month', intervalCount: 1 }
  if (near(61, 3)) return { interval: 'month', intervalCount: 2 }
  if (near(91, 4)) return { interval: 'month', intervalCount: 3 }
  if (near(182, 5)) return { interval: 'month', intervalCount: 6 }
  if (near(365, 5)) return { interval: 'year', intervalCount: 1 }
  return undefined
}

const spanDays = (from: number, to: number | null | undefined) => (to ? Math.round((to - from) / DAY) : undefined)

/** The product's period when the dates agree with it (or there are none), else what the dates say, else the product's. */
function period(declared: Period | undefined, days: number | undefined): Period | undefined {
  if (days === undefined) return declared
  if (declared && Math.abs(nominalDays(declared) - days) <= 5) return declared
  return periodFromDays(days) ?? declared
}

/** Integer micros → minor units, exactly (rounded half away from zero). */
export function microsToMinor(micros: number, currency: string): number {
  return roundHalfAway({ n: BigInt(Math.trunc(micros)) * 10n ** BigInt(currencyExponent(currency)), d: 1_000_000n })
}

/** App user ids are chosen by the developer and can be emails. Stable per project, and not the id itself. */
export function opaqueCustomer(projectId: string, customerId: string): string {
  return `rc_${createHash('sha256').update(`revenuecat\0${projectId}\0${customerId}`).digest('hex').slice(0, 24)}`
}

interface Priced {
  /** Per billing period, in minor units. */
  amount: Money
  period: Period
  mrr: Money
  /** Oldest first, one entry per change of value. */
  history: Array<{ at: string; mrr: Money }>
}

const monthly = (amount: Money, p: Period): Money => ({ minor: computeMrr([{ unitAmount: amount.minor, quantity: 1, ...p }]), currency: amount.currency })

function netOfTax(t: RcTransaction): Money | undefined {
  const r = t.revenue_in_local_currency
  if (!r) return undefined
  const currency = normalizeCurrency(r.currency)
  const minor = toMinor(r.gross, currency) - toMinor(r.tax, currency)
  return minor > 0 ? { minor, currency } : undefined
}

function exactPrice(txns: RcTransaction[], declared: Period | undefined): Priced | undefined {
  const paid = txns
    .map((t) => ({ t, amount: netOfTax(t) }))
    .filter((x): x is { t: RcTransaction; amount: Money } => x.amount !== undefined)
    .sort((a, b) => a.t.purchased_at - b.t.purchased_at)
  const latest = paid[paid.length - 1]
  if (!latest) return undefined
  const history: Priced['history'] = []
  let last: Priced | undefined
  for (const { t, amount } of paid) {
    if (amount.currency !== latest.amount.currency) continue
    const p = period(declared, spanDays(t.purchased_at, t.expiration_date))
    if (!p) continue
    const mrr = monthly(amount, p)
    if (history[history.length - 1]?.mrr.minor !== mrr.minor) history.push({ at: isoTimestamp(t.purchased_at), mrr })
    last = { amount, period: p, mrr, history }
  }
  // The newest paid row couldn't be read as a period: an older row would be a stale price.
  return last?.amount === latest.amount ? last : undefined
}

function listPrice(product: RcProduct | undefined, p: Period | undefined): Priced | undefined {
  const ip = product?.indicative_price
  if (!ip || !p || !Number.isSafeInteger(ip.amount_micros) || ip.amount_micros <= 0) return undefined
  const currency = normalizeCurrency(ip.currency)
  const amount: Money = { minor: microsToMinor(ip.amount_micros, currency), currency }
  return { amount, period: p, mrr: monthly(amount, p), history: [] }
}

export function mapSubscription(s: RcSubscription, product: RcProduct | undefined, txns: RcTransaction[], projectId: string, connectionId: string, rawRef: string): { event: SubscriptionUpsert; source: PriceSource } {
  const status = mapStatus(s.status)
  const live = status === 'active' || status === 'past_due'
  const declared = parseDuration(product?.subscription?.duration)
  // A list price is the price of the product's period. The current period's dates only stand in when the product has none
  // (duration is nullable), because they can be a trial or an extension.
  const own = declared ?? period(undefined, spanDays(s.current_period_starts_at, s.current_period_ends_at))
  const exact = exactPrice(txns, own)
  const priced = exact ?? listPrice(product, own)
  const source: PriceSource = exact ? 'exact' : priced ? 'list' : 'none'
  const shown = priced?.period ?? own ?? { interval: 'month' as const, intervalCount: 1 }
  const currency = priced?.mrr.currency ?? 'USD'
  const startedAt = isoTimestamp(s.starts_at)
  const event: SubscriptionUpsert = {
    type: 'subscription.upsert',
    externalId: s.id,
    connectionId,
    rawRef,
    customer: opaqueCustomer(projectId, s.customer_id),
    status,
    mrr: { minor: live && priced ? priced.mrr.minor : 0, currency },
    interval: shown.interval,
    intervalCount: shown.intervalCount,
    startedAt,
    cancelAtPeriodEnd: s.auto_renewal_status === 'will_not_renew',
    ...(s.current_period_ends_at ? { currentPeriodEnd: isoTimestamp(s.current_period_ends_at) } : {}),
    ...(priced && s.product_id
      ? { items: [{ priceExternalId: s.product_id, ...(product?.display_name ? { product: product.display_name } : {}), quantity: 1, amount: priced.amount }] }
      : {}),
  }
  if (exact && exact.history.length > 0) event.changes = exact.history
  if (status === 'canceled') {
    const ended = isoTimestamp(s.ends_at ?? s.current_period_ends_at ?? s.current_period_starts_at)
    event.canceledAt = ended
    event.endedAt = ended
    // Without transactions, whether it ever paid is the difference between churn and a trial that lapsed. No amount
    // from total_revenue_in_usd is used: it's a lifetime USD total, and the stores' own connectors book that money.
    // The ledger values an ended subscription from its items, so one that never paid has none.
    if (!exact) {
      if (priced && (s.total_revenue_in_usd?.gross ?? 0) > 0) event.changes = [{ at: startedAt <= ended ? startedAt : ended, mrr: priced.mrr }]
      else delete event.items
    }
  }
  return { event, source }
}
