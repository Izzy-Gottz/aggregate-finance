// Lemon Squeezy → NormalizedEvent mapping.
//
// Lemon Squeezy is merchant of record and keeps store balances in USD, so every order is booked from its *_usd fields
// into one USD processor_balance account per store:
//   charge: gross = total_usd − tax_usd (tax is collected and remitted by Lemon Squeezy, so it is never yours),
//           fee = 0, net = gross. Lemon Squeezy's own fee is NOT in the public API; we don't estimate it. Net is
//           therefore overstated by Lemon Squeezy's fee until the payout lands in the bank (connect() warns).
//   refund: one row per refunded order (`<orderId>:refund`), updated in place as refunded_amount grows. A full refund
//           mirrors the charge exactly; a partial refund's tax share is removed pro rata:
//           round(refunded_amount_usd × (total_usd − tax_usd) ÷ total_usd), half away from zero.

import type { AccountUpsert, Money, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { isoTimestamp, normalizeCurrency } from '@agfn/connector-sdk'
import { computeMrr, roundHalfAway } from './mrr.ts'
import type { LsOrder, LsPrice, LsStore, LsSubscription } from './types.ts'

export const accountId = (storeId: string) => `lemonsqueezy:${storeId}:USD`

export function mapAccount(storeId: string, store: LsStore, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: accountId(storeId),
    connectionId,
    rawRef,
    name: `${(store.name || 'Store').slice(0, 80)} balance (Lemon Squeezy)`,
    accountType: 'processor_balance',
    currency: 'USD',
    institution: 'Lemon Squeezy',
    businessHint: 'business',
  }
}

const usd = (minor: number): Money => {
  if (!Number.isSafeInteger(minor)) throw new TypeError(`not an integer amount: ${minor}`)
  return { minor: minor === 0 ? 0 : minor, currency: 'USD' }
}

const SETTLED = new Set(['paid', 'refunded', 'partial_refund'])

export function chargeGross(o: LsOrder): number {
  return o.total_usd - o.tax_usd
}

export function mapOrderCharge(id: string, o: LsOrder, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (!SETTLED.has(o.status)) return undefined
  const gross = chargeGross(o)
  return {
    type: 'processor.balance_txn',
    externalId: id,
    connectionId,
    rawRef,
    accountExternalId: accountId(String(o.store_id)),
    at: isoTimestamp(o.created_at),
    kind: 'charge',
    gross: usd(gross),
    fee: usd(0),
    net: usd(gross),
    sourceExternalId: id,
    customer: String(o.customer_id),
  }
}

export function refundExTax(o: LsOrder): number {
  if (o.refunded_amount_usd <= 0) return 0
  const gross = chargeGross(o)
  if (o.status === 'refunded' || o.refunded_amount_usd >= o.total_usd) return gross
  if (o.total_usd <= 0) return 0
  return roundHalfAway({ n: BigInt(o.refunded_amount_usd) * BigInt(gross), d: BigInt(o.total_usd) })
}

export function mapOrderRefund(id: string, o: LsOrder, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  const amount = refundExTax(o)
  if (amount <= 0) return undefined
  return {
    type: 'processor.balance_txn',
    externalId: `${id}:refund`,
    connectionId,
    rawRef,
    accountExternalId: accountId(String(o.store_id)),
    at: isoTimestamp(o.refunded_at ?? o.updated_at),
    kind: 'refund',
    gross: usd(-amount),
    fee: usd(0),
    net: usd(-amount),
    sourceExternalId: id,
    customer: String(o.customer_id),
  }
}

type Status = SubscriptionUpsert['status']

/** Lemon Squeezy 'cancelled' = canceled but still running until ends_at (Stripe's cancel_at_period_end). */
export function mapStatus(s: LsSubscription['status']): Status {
  switch (s) {
    case 'on_trial':
      return 'trialing'
    case 'cancelled':
    case 'active':
      return 'active'
    case 'expired':
      return 'canceled'
    default:
      return s
  }
}

/** Monthly recurring amount for one subscription from its price. Metered and tiered prices count 0 (not computable). */
export function subscriptionMrr(sub: LsSubscription, price: LsPrice | undefined, currency: string): Money {
  const cur = normalizeCurrency(currency)
  const status = mapStatus(sub.status)
  const item = sub.first_subscription_item
  if ((status !== 'active' && status !== 'past_due') || !price || !item) return { minor: 0, currency: cur }
  if (price.usage_aggregation !== null || item.is_usage_based || price.unit_price === null) return { minor: 0, currency: cur }
  const qty = item.quantity
  let units: number
  if (price.scheme === 'standard') units = qty
  else if (price.scheme === 'package') units = Math.ceil(qty / Math.max(1, price.package_size ?? 1))
  else return { minor: 0, currency: cur }
  const minor = computeMrr([
    { unitAmount: price.unit_price, quantity: units, interval: price.renewal_interval_unit ?? 'month', intervalCount: price.renewal_interval_quantity ?? 1 },
  ])
  return { minor, currency: cur }
}

export function mapSubscription(
  id: string,
  sub: LsSubscription,
  price: LsPrice | undefined,
  currency: string,
  connectionId: string,
  rawRef: string,
): SubscriptionUpsert {
  const status = mapStatus(sub.status)
  const item = sub.first_subscription_item
  const cur = normalizeCurrency(currency)
  const periodEnd = sub.status === 'cancelled' ? sub.ends_at : sub.renews_at
  return {
    type: 'subscription.upsert',
    externalId: id,
    connectionId,
    rawRef,
    customer: String(sub.customer_id),
    status,
    mrr: subscriptionMrr(sub, price, cur),
    interval: price?.renewal_interval_unit ?? 'month',
    intervalCount: price?.renewal_interval_quantity ?? 1,
    startedAt: isoTimestamp(sub.created_at),
    ...(periodEnd ? { currentPeriodEnd: isoTimestamp(periodEnd) } : {}),
    cancelAtPeriodEnd: sub.status === 'cancelled',
    ...(sub.status === 'expired' && sub.ends_at ? { endedAt: isoTimestamp(sub.ends_at) } : {}),
    ...(item
      ? {
          items: [
            {
              priceExternalId: String(item.price_id),
              product: String(sub.product_id),
              quantity: item.quantity,
              amount: { minor: price?.unit_price ?? 0, currency: cur },
            },
          ],
        }
      : {}),
  }
}
