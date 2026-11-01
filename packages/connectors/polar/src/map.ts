// Polar → NormalizedEvent mapping.
//
// Polar is merchant of record: it charges the customer, collects and remits sales tax/VAT, takes its fee, and credits
// the seller's Polar balance. One processor_balance account per currency the seller sells in:
//   charge (a paid order): gross = net_amount (after discounts, before tax: tax never belongs to the seller),
//            fee = platform_fee_amount, net = gross − fee. When Polar states its fee in another currency than the
//            order's (it keeps balances in USD), the fee becomes its own 'fee' row on that currency's account instead.
//   refund (succeeded): gross = net = −amount (tax excluded, as above); fee 0: Polar doesn't return its fee on a refund.
//   dispute: Polar charges $15 a dispute "regardless of outcome" (polar.sh/docs/merchant-of-record/fees) once one is
//            opened (needs_response, under_review, won, lost; not a prevented one or an early warning). A lost dispute
//            also takes the disputed amount (tax excluded): gross = −amount, fee = 15.00 USD, net = gross − fee.
// Payouts aren't in Polar's public API, so payout rows aren't emitted; Polar deposits are matched in the bank feed.

import type { AccountUpsert, Money, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { isoTimestamp, normalizeCurrency } from '@agfn/connector-sdk'
import { computeMrr, type MrrDiscount } from './mrr.ts'
import type { PolarEnv } from './client.ts'
import type { PolarDispute, PolarOrder, PolarRefund, PolarSubscription } from './types.ts'

/** Polar's dispute fee (USD), from its published fees. */
export const POLAR_DISPUTE_FEE_USD = 1500

export const accountId = (env: PolarEnv | string, org: string, currency: string) => `polar:${env}:${org}:${normalizeCurrency(currency)}`

export function mapAccount(env: PolarEnv, org: string, currency: string, connectionId: string, rawRef: string): AccountUpsert {
  const c = normalizeCurrency(currency)
  return {
    type: 'account.upsert',
    externalId: accountId(env, org, c),
    connectionId,
    rawRef,
    name: `Polar balance (${c})`,
    accountType: 'processor_balance',
    currency: c,
    institution: 'Polar',
    businessHint: 'business',
  }
}

const m = (minor: number, currency: string): Money => ({ minor: minor === 0 ? 0 : minor, currency: normalizeCurrency(currency) })
const who = (o: PolarOrder) => o.customer?.name?.trim() || o.customer?.email?.trim() || undefined

/** A paid order as money into the balance (plus a fee row when Polar's fee is in another currency); none otherwise. */
export function mapOrder(o: PolarOrder, env: PolarEnv, org: string, connectionId: string, rawRef: string): ProcessorBalanceTxn[] {
  if (!o.paid || (o.status !== 'paid' && o.status !== 'refunded' && o.status !== 'partially_refunded')) return []
  const cur = normalizeCurrency(o.currency)
  const feeMinor = typeof o.platform_fee_amount === 'number' ? o.platform_fee_amount : 0
  const feeCur = o.platform_fee_currency ? normalizeCurrency(o.platform_fee_currency) : cur
  if (o.net_amount === 0 && feeMinor === 0) return []
  const same = feeCur === cur
  const counterparty = who(o)
  const base = {
    type: 'processor.balance_txn' as const,
    connectionId,
    rawRef,
    at: isoTimestamp(o.created_at),
    sourceExternalId: o.id,
    customer: o.customer_id,
    ...(counterparty ? { counterparty: counterparty.slice(0, 120) } : {}),
    ...(o.description ? { description: o.description.slice(0, 500) } : {}),
  }
  const out: ProcessorBalanceTxn[] = [
    {
      ...base,
      externalId: o.id,
      accountExternalId: accountId(env, org, cur),
      kind: 'charge',
      gross: m(o.net_amount, cur),
      fee: m(same ? feeMinor : 0, cur),
      net: m(o.net_amount - (same ? feeMinor : 0), cur),
    },
  ]
  if (!same && feeMinor !== 0) {
    out.push({ ...base, externalId: `${o.id}:fee`, accountExternalId: accountId(env, org, feeCur), kind: 'fee', gross: m(0, feeCur), fee: m(feeMinor, feeCur), net: m(-feeMinor, feeCur) })
  }
  return out
}

export function mapRefund(r: PolarRefund, env: PolarEnv, org: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (r.status !== 'succeeded' || r.amount === 0) return undefined
  const cur = normalizeCurrency(r.currency)
  return {
    type: 'processor.balance_txn',
    externalId: r.id,
    connectionId,
    rawRef,
    accountExternalId: accountId(env, org, cur),
    at: isoTimestamp(r.created_at),
    kind: 'refund',
    gross: m(-r.amount, cur),
    fee: m(0, cur),
    net: m(-r.amount, cur),
    sourceExternalId: r.order_id,
    customer: r.customer_id,
  }
}

const OPENED = new Set<PolarDispute['status']>(['needs_response', 'under_review', 'won', 'lost'])

/** A dispute's cost to the balance: the $15 fee once opened, and the disputed amount once lost. */
export function mapDispute(d: PolarDispute, env: PolarEnv, org: string, connectionId: string, rawRef: string): ProcessorBalanceTxn[] {
  if (!OPENED.has(d.status)) return []
  const cur = normalizeCurrency(d.currency)
  const lost = d.status === 'lost' ? d.amount : 0
  const base = { type: 'processor.balance_txn' as const, connectionId, rawRef, at: isoTimestamp(d.created_at), kind: 'dispute' as const, sourceExternalId: d.order_id }
  if (cur === 'USD') {
    return [{ ...base, externalId: d.id, accountExternalId: accountId(env, org, cur), gross: m(-lost, cur), fee: m(POLAR_DISPUTE_FEE_USD, cur), net: m(-lost - POLAR_DISPUTE_FEE_USD, cur) }]
  }
  // The fee is in USD; a lost amount stays in the dispute's own currency.
  const out: ProcessorBalanceTxn[] = [{ ...base, externalId: `${d.id}:fee`, accountExternalId: accountId(env, org, 'USD'), gross: m(0, 'USD'), fee: m(POLAR_DISPUTE_FEE_USD, 'USD'), net: m(-POLAR_DISPUTE_FEE_USD, 'USD') }]
  if (lost) out.push({ ...base, externalId: d.id, accountExternalId: accountId(env, org, cur), gross: m(-lost, cur), fee: m(0, cur), net: m(-lost, cur) })
  return out
}

/** Months between two instants, counted the way a calendar does (Jan 31 + 1 month ≈ end of February). */
function addMonths(iso: string, months: number): number {
  const d = new Date(iso)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.getTime()
}

/** The discount still lowers future charges: forever, or repeating within its months; a 'once' discount doesn't recur. */
function discountFor(s: PolarSubscription, now: number): MrrDiscount | undefined {
  const d = s.discount
  if (!d || d.duration === 'once') return undefined
  if (d.duration === 'repeating') {
    const from = s.started_at ?? s.created_at
    if (!d.duration_in_months || addMonths(from, d.duration_in_months) <= now) return undefined
  }
  if (d.type === 'percentage') return typeof d.basis_points === 'number' ? { kind: 'percent', basisPoints: d.basis_points } : undefined
  const cur = s.currency.toLowerCase()
  const off = d.amounts?.[cur] ?? (d.currency?.toLowerCase() === cur ? d.amount : undefined)
  return typeof off === 'number' ? { kind: 'amount', amount: off, interval: s.recurring_interval, intervalCount: s.recurring_interval_count ?? 1 } : undefined
}

/** Monthly recurring revenue (Stripe's definition): active and past_due only, after discounts, no tax or metered usage. */
export function subscriptionMrr(s: PolarSubscription, now: number): Money {
  const cur = normalizeCurrency(s.currency)
  if (s.status !== 'active' && s.status !== 'past_due') return m(0, cur)
  const disc = discountFor(s, now)
  const minor = computeMrr([{ unitAmount: s.amount, quantity: 1, interval: s.recurring_interval, intervalCount: s.recurring_interval_count ?? 1 }], disc ? [disc] : [])
  return m(minor, cur)
}

export function mapSubscription(s: PolarSubscription, now: number, connectionId: string, rawRef: string): SubscriptionUpsert {
  const cur = normalizeCurrency(s.currency)
  const quantity = s.seats ?? s.units ?? 1
  return {
    type: 'subscription.upsert',
    externalId: s.id,
    connectionId,
    rawRef,
    customer: s.customer_id,
    status: s.status,
    mrr: subscriptionMrr(s, now),
    interval: s.recurring_interval,
    intervalCount: Math.max(1, s.recurring_interval_count ?? 1),
    startedAt: isoTimestamp(s.started_at ?? s.created_at),
    ...(s.current_period_end ? { currentPeriodEnd: isoTimestamp(s.current_period_end) } : {}),
    cancelAtPeriodEnd: s.cancel_at_period_end,
    ...(s.canceled_at ? { canceledAt: isoTimestamp(s.canceled_at) } : {}),
    ...(s.ended_at ? { endedAt: isoTimestamp(s.ended_at) } : {}),
    // Polar's amount is the subscription's total per period (all seats or units), so the item carries it whole.
    items: [{ priceExternalId: s.prices?.[0]?.id ?? s.product_id, product: s.product_id, quantity, amount: m(s.amount, cur) }],
  }
}
