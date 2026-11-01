// Paddle → NormalizedEvent mapping.
//
// Paddle is merchant of record: it charges the customer, collects and remits sales tax/VAT, takes its fee, and credits
// the seller's balance with `earnings`. We book that balance (one processor_balance account per payout currency):
//   charge:  net = payout_totals.earnings (what reached your balance), fee = payout_totals.fee (Paddle's fee),
//            gross = net + fee. Tax is EXCLUDED from gross: it never belongs to you (Paddle remits it), so gross is
//            the tax-exclusive amount after discounts and credits. gross − fee = net holds by construction.
//   refund / chargeback: the mirror, from the adjustment's payout_totals: net = −(earnings + chargeback_fee),
//            fee = −fee + chargeback_fee (a returned Paddle fee is negative; a chargeback fee is a positive cost).
// Only completed transactions (payout_totals present) and approved adjustments are emitted, so every row is in the
// balance currency. Credits (to a customer's Paddle balance) and chargeback warnings move no money and are skipped.

import type { AccountUpsert, Money, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { isoTimestamp, minorMoney, normalizeCurrency } from '@agfn/connector-sdk'
import { computeMrr, percentToBasisPoints, type MrrDiscount, type RecurringLine } from './mrr.ts'
import type { PaddleAdjustment, PaddleDiscount, PaddleSubscription, PaddleTransaction } from './types.ts'

export const accountId = (env: string, currency: string) => `paddle:${env}:${normalizeCurrency(currency)}`

export function mapAccount(env: string, currency: string, connectionId: string, rawRef: string): AccountUpsert {
  const c = normalizeCurrency(currency)
  return {
    type: 'account.upsert',
    externalId: accountId(env, c),
    connectionId,
    rawRef,
    name: `Paddle balance (${c})`,
    accountType: 'processor_balance',
    currency: c,
    institution: 'Paddle',
    businessHint: 'business',
  }
}

const amt = (v: string | null | undefined, currency: string): Money => minorMoney(v ?? '0', currency)

/** The money-into-balance view of a completed transaction, or undefined when Paddle hasn't settled it yet. */
export function mapTransaction(t: PaddleTransaction, env: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  const p = t.details.payout_totals
  if (t.status !== 'completed' || !p || p.earnings == null || p.fee == null) return undefined
  const cur = normalizeCurrency(p.currency_code)
  const net = amt(p.earnings, cur)
  const fee = amt(p.fee, cur)
  return {
    type: 'processor.balance_txn',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: accountId(env, cur),
    at: isoTimestamp(t.billed_at ?? t.created_at),
    kind: 'charge',
    gross: { minor: net.minor + fee.minor, currency: cur },
    fee,
    net,
    sourceExternalId: t.id,
    ...(t.customer_id ? { customer: t.customer_id } : {}),
  }
}

export function mapAdjustment(a: PaddleAdjustment, env: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (a.status !== 'approved') return undefined
  const sign = a.action === 'refund' || a.action === 'chargeback' ? -1 : a.action === 'chargeback_reverse' ? 1 : 0
  if (sign === 0) return undefined
  const p = a.payout_totals
  if (!p || p.earnings == null) return undefined
  const cur = normalizeCurrency(p.currency_code)
  const earnings = amt(p.earnings, cur).minor
  const returnedFee = amt(p.fee, cur).minor
  const cbFee = amt(p.chargeback_fee, cur).minor
  // Reversal of a chargeback: money (and the returned fee) comes back; Paddle's docs don't say the chargeback fee is
  // refunded, so it's ignored on reversals.
  const net = sign < 0 ? -(earnings + cbFee) : earnings
  const fee = sign < 0 ? -returnedFee + cbFee : returnedFee
  return {
    type: 'processor.balance_txn',
    externalId: a.id,
    connectionId,
    rawRef,
    accountExternalId: accountId(env, cur),
    at: isoTimestamp(a.updated_at ?? a.created_at),
    kind: a.action === 'refund' ? 'refund' : 'dispute',
    gross: { minor: net + fee, currency: cur },
    fee: { minor: fee === 0 ? 0 : fee, currency: cur },
    net: { minor: net === 0 ? 0 : net, currency: cur },
    sourceExternalId: a.transaction_id,
    ...(a.customer_id ? { customer: a.customer_id } : {}),
  }
}

/** Is a subscription discount in effect at `now`? */
function discountActive(sub: PaddleSubscription, now: number): boolean {
  const d = sub.discount
  if (!d) return false
  if (d.starts_at && Date.parse(d.starts_at) > now) return false
  if (d.ends_at && Date.parse(d.ends_at) <= now) return false
  return true
}

export function subscriptionMrr(sub: PaddleSubscription, discount: PaddleDiscount | undefined, now: number): Money {
  const cur = normalizeCurrency(sub.currency_code)
  if (sub.status !== 'active' && sub.status !== 'past_due') return { minor: 0, currency: cur }
  const lines: RecurringLine[] = []
  let seats = 0
  for (const it of sub.items) {
    // Only recurring, currently billed items count; one-time charges and trialing add-ons don't.
    if (!it.recurring || it.status !== 'active') continue
    const cycle = it.price.billing_cycle ?? sub.billing_cycle
    lines.push({ unitAmount: amt(it.price.unit_price.amount, cur).minor, quantity: it.quantity, interval: cycle.interval, intervalCount: cycle.frequency })
    seats += it.quantity
  }
  const discounts: MrrDiscount[] = []
  if (discount && discountActive(sub, now)) {
    const cycle = sub.billing_cycle
    if (discount.type === 'percentage') discounts.push({ kind: 'percent', basisPoints: percentToBasisPoints(discount.amount) })
    else if (!discount.currency_code || normalizeCurrency(discount.currency_code) === cur) {
      const per = amt(discount.amount, cur).minor * (discount.type === 'flat_per_seat' ? seats : 1)
      discounts.push({ kind: 'amount', amount: per, interval: cycle.interval, intervalCount: cycle.frequency })
    }
  }
  return { minor: computeMrr(lines, discounts), currency: cur }
}

export function mapSubscription(
  sub: PaddleSubscription,
  discount: PaddleDiscount | undefined,
  now: number,
  connectionId: string,
  rawRef: string,
): SubscriptionUpsert {
  const cur = normalizeCurrency(sub.currency_code)
  const items = sub.items
    .filter((i) => i.recurring)
    .map((i) => ({
      priceExternalId: i.price.id,
      product: i.price.product_id,
      quantity: i.quantity,
      amount: amt(i.price.unit_price.amount, i.price.unit_price.currency_code || cur),
    }))
  const canceled = sub.status === 'canceled'
  return {
    type: 'subscription.upsert',
    externalId: sub.id,
    connectionId,
    rawRef,
    customer: sub.customer_id,
    status: sub.status,
    mrr: subscriptionMrr(sub, discount, now),
    interval: sub.billing_cycle.interval,
    intervalCount: sub.billing_cycle.frequency,
    startedAt: isoTimestamp(sub.started_at ?? sub.created_at),
    ...(sub.current_billing_period ? { currentPeriodEnd: isoTimestamp(sub.current_billing_period.ends_at) } : {}),
    cancelAtPeriodEnd: sub.scheduled_change?.action === 'cancel',
    ...(sub.canceled_at ? { canceledAt: isoTimestamp(sub.canceled_at) } : {}),
    ...(canceled && sub.canceled_at ? { endedAt: isoTimestamp(sub.canceled_at) } : {}),
    items,
  }
}
