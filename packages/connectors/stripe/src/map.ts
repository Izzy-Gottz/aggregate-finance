// Stripe → NormalizedEvent mapping. Stripe's balance amounts are already signed into the balance (+ in, − out),
// so no sign flip is needed: gross = amount, fee = fee (positive cost, negative when returned), net = gross − fee.

import { scrubKeys } from './client.ts'
import type {
  AccountUpsert,
  BalanceSnapshot,
  InvoiceUpsert,
  Money,
  ProcessorBalanceTxn,
  SubscriptionUpsert,
} from '@agfn/contracts'
import { isoDate, isoTimestamp, minorMoney, normalizeCurrency } from '@agfn/connector-sdk'
import { subscriptionInterval, subscriptionMrr, type CouponLookup } from './mrr.ts'
import type {
  StripeBalance,
  StripeBalanceTransaction,
  StripeExpandedSource,
  StripeInvoice,
  StripeInvoiceLine,
  StripeSubscription,
} from './types.ts'

/** One processor_balance account per (Stripe account, currency). */
export const balanceAccountId = (accountId: string, currency: string) => `${accountId}:${normalizeCurrency(currency)}`

export function mapAccount(
  accountId: string,
  displayName: string,
  currency: string,
  connectionId: string,
  rawRef: string,
): AccountUpsert {
  const cur = normalizeCurrency(currency)
  return {
    type: 'account.upsert',
    externalId: balanceAccountId(accountId, cur),
    connectionId,
    rawRef,
    name: `${displayName} Stripe balance (${cur})`.slice(0, 120),
    accountType: 'processor_balance',
    currency: cur,
    institution: 'Stripe',
    businessHint: 'business',
  }
}

export interface BalanceByCurrency {
  currency: string
  current: number
  available: number
}

/** current = available + pending + connect_reserved, per currency; available = available. */
export function balanceByCurrency(b: StripeBalance): BalanceByCurrency[] {
  const out = new Map<string, BalanceByCurrency>()
  const row = (c: string) => {
    const cur = normalizeCurrency(c)
    let r = out.get(cur)
    if (!r) out.set(cur, (r = { currency: cur, current: 0, available: 0 }))
    return r
  }
  for (const a of b.available) {
    const r = row(a.currency)
    r.current += a.amount
    r.available += a.amount
  }
  for (const a of [...b.pending, ...(b.connect_reserved ?? [])]) row(a.currency).current += a.amount
  return [...out.values()].sort((x, y) => x.currency.localeCompare(y.currency))
}

export function mapBalance(
  accountId: string,
  bal: BalanceByCurrency,
  connectionId: string,
  rawRef: string,
  at: string,
): BalanceSnapshot {
  const acct = balanceAccountId(accountId, bal.currency)
  return {
    type: 'balance.snapshot',
    externalId: `${acct}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: acct,
    at,
    current: minorMoney(bal.current, bal.currency),
    available: minorMoney(bal.available, bal.currency),
  }
}

export type BalanceKind = ProcessorBalanceTxn['kind']

/** Stripe balance transaction type (+ reporting_category for disputes, which Stripe books as 'adjustment') → kind. */
export function txnKind(type: string, reportingCategory?: string | null): BalanceKind {
  if (reportingCategory && reportingCategory.startsWith('dispute')) return 'dispute'
  switch (type) {
    case 'charge':
    case 'payment':
      return 'charge'
    case 'refund':
    case 'payment_refund':
    case 'payment_failure_refund':
    case 'payment_reversal':
    case 'refund_failure':
      return 'refund'
    case 'issuing_dispute':
      return 'dispute'
    case 'adjustment':
      return 'adjustment'
    case 'payout':
    case 'payout_cancel':
    case 'payout_failure':
      return 'payout'
    case 'stripe_fee':
    case 'stripe_fx_fee':
    case 'tax_fee':
    case 'application_fee':
    case 'application_fee_refund':
      return 'fee'
    case 'transfer':
    case 'transfer_cancel':
    case 'transfer_failure':
    case 'transfer_refund':
    case 'connect_collection_transfer':
    case 'topup':
    case 'topup_reversal':
      return 'transfer'
    default:
      return 'other'
  }
}

const HELD = new Set([
  'reserved_funds', 'reserve_hold', 'reserve_release', 'reserve_transaction', 'payment_network_reserve_hold', 'payment_network_reserve_release',
  'payout_minimum_balance_hold', 'payout_minimum_balance_release', 'advance', 'advance_funding',
])

/** Funds held or settled early, a loan repayment, or a topup: on the balance sheet, not income or spending. */
export function balanceRole(type: string): ProcessorBalanceTxn['balanceRole'] {
  if (HELD.has(type)) return 'other_assets'
  if (type === 'anticipation_repayment') return 'other_liabilities'
  if (type === 'topup' || type === 'topup_reversal') return 'clearing_payouts'
  return undefined
}

export const idOf = (v: string | { id: string } | null | undefined): string | undefined =>
  typeof v === 'string' ? v : v && typeof v.id === 'string' ? v.id : undefined

/**
 * externalId: the txn id, except a 'payout' row, whose id is the payout id (po_...) so the bank deposit and the
 * processor row share one key. payoutExternalId: the payout that settled the row (from the ?payout= listing), or the
 * payout itself for payout/payout_cancel/payout_failure rows.
 */
export function mapBalanceTxn(
  t: StripeBalanceTransaction,
  accountId: string,
  connectionId: string,
  rawRef: string,
  settledBy?: string,
  customerNames?: ReadonlyMap<string, string>,
): ProcessorBalanceTxn {
  const kind = txnKind(t.type, t.reporting_category)
  const sourceId = idOf(t.source)
  const isPayoutRow = t.type === 'payout' || t.type === 'payout_cancel' || t.type === 'payout_failure'
  const ownPayout = isPayoutRow && sourceId?.startsWith('po_') ? sourceId : undefined
  const externalId = t.type === 'payout' && ownPayout ? ownPayout : t.id
  const payoutExternalId = ownPayout ?? settledBy
  const gross = minorMoney(t.amount, t.currency)
  const fee = minorMoney(t.fee, t.currency)
  const net: Money = { minor: gross.minor - fee.minor, currency: gross.currency }
  const src = typeof t.source === 'object' && t.source ? t.source : undefined
  const customer = idOf(src?.customer)
  const counterparty = counterpartyOf(src, customer, customerNames)
  // A charge's payment intent ties it to the invoice it paid (InvoiceUpsert.paymentRefs). Charges only: a refund carries
  // the same intent but isn't a payment of the invoice.
  const chargePi = kind === 'charge' && src?.object === 'charge' ? idOf(src.payment_intent) : undefined
  // Payout rows: the expanded source is the payout; its arrival date and bank trace id drive deposit matching.
  const payoutObj = ownPayout && src ? (src as unknown as Record<string, unknown>) : undefined
  const arrival = typeof payoutObj?.arrival_date === 'number' ? isoDate(payoutObj.arrival_date) : undefined
  const trace = payoutObj?.trace_id as { value?: unknown } | null | undefined
  const traceId = typeof trace?.value === 'string' && trace.value ? trace.value : undefined
  return {
    type: 'processor.balance_txn',
    externalId,
    connectionId,
    rawRef,
    accountExternalId: balanceAccountId(accountId, t.currency),
    at: isoTimestamp(t.created),
    kind,
    gross,
    fee,
    net,
    ...(payoutExternalId ? { payoutExternalId } : {}),
    ...(sourceId ? { sourceExternalId: sourceId } : {}),
    ...(balanceRole(t.type) ? { balanceRole: balanceRole(t.type) } : {}),
    ...(customer ? { customer } : {}),
    ...(counterparty ? { counterparty } : {}),
    ...(traceId || chargePi ? { linkRefs: { ...(traceId ? { trace_id: traceId } : {}), ...(chargePi ? { payment_intent: chargePi } : {}) } } : {}),
    ...(arrival ? { arrivalDate: arrival } : {}),
    // Stripe's own words for the row ("Subscription update", "Payment for Invoice …"): display only, untrusted.
    ...(t.description?.trim() ? { description: scrubKeys(t.description.trim()).slice(0, 500) } : {}),
  }
}

export function invoiceStatus(inv: StripeInvoice): InvoiceUpsert['status'] {
  switch (inv.status) {
    case 'paid':
      return 'paid'
    case 'void':
      return 'void'
    case 'uncollectible':
      return 'uncollectible'
    case 'open':
      return inv.amount_paid > 0 && inv.amount_paid < inv.total ? 'partially_paid' : 'open'
    default:
      return 'draft'
  }
}

export function invoiceTax(inv: StripeInvoice): number | undefined {
  if (Array.isArray(inv.total_taxes)) return inv.total_taxes.reduce((s, t) => s + t.amount, 0)
  return typeof inv.tax === 'number' ? inv.tax : undefined
}

/** `lines` must be the complete list (the caller fetches /v1/invoices/:id/lines when the embedded list is cut off). */
export function mapInvoice(
  inv: StripeInvoice,
  lines: StripeInvoiceLine[],
  connectionId: string,
  rawRef: string,
): InvoiceUpsert {
  const cur = inv.currency
  const tax = invoiceTax(inv)
  const counterparty = inv.customer_name?.trim() || idOf(inv.customer) || 'Unknown customer'
  return {
    type: 'invoice.upsert',
    externalId: inv.id,
    connectionId,
    rawRef,
    direction: 'receivable',
    ...(inv.number ? { number: inv.number } : {}),
    counterparty: counterparty.slice(0, 120),
    ...(paymentRefsOf(inv).length ? { paymentRefs: paymentRefsOf(inv) } : {}),
    issueDate: isoDate(inv.status_transitions?.finalized_at ?? inv.created),
    ...(typeof inv.due_date === 'number' ? { dueDate: isoDate(inv.due_date) } : {}),
    total: minorMoney(inv.total, cur),
    amountPaid: minorMoney(inv.amount_paid, cur),
    status: invoiceStatus(inv),
    subtotal: minorMoney(inv.subtotal, cur),
    ...(tax !== undefined ? { tax: minorMoney(tax, cur) } : {}),
    lines: lines.map((l) => ({
      description: (l.description ?? '').slice(0, 300),
      amount: minorMoney(l.amount, l.currency || cur),
      ...(typeof l.quantity === 'number' ? { quantity: l.quantity } : {}),
    })),
  }
}

export function mapSubscription(
  s: StripeSubscription,
  coupons: CouponLookup,
  nowSec: number,
  connectionId: string,
  rawRef: string,
): SubscriptionUpsert {
  const { mrr, items } = subscriptionMrr(s, coupons, nowSec)
  const { interval, intervalCount } = subscriptionInterval(s)
  const periodEnd = s.current_period_end ?? s.items.data.find((i) => typeof i.current_period_end === 'number')?.current_period_end
  return {
    type: 'subscription.upsert',
    externalId: s.id,
    connectionId,
    rawRef,
    customer: idOf(s.customer) ?? 'unknown',
    status: s.status,
    mrr,
    interval,
    intervalCount,
    startedAt: isoTimestamp(s.start_date || s.created),
    ...(typeof periodEnd === 'number' ? { currentPeriodEnd: isoTimestamp(periodEnd) } : {}),
    ...(typeof s.cancel_at_period_end === 'boolean' ? { cancelAtPeriodEnd: s.cancel_at_period_end } : {}),
    ...(typeof s.canceled_at === 'number' ? { canceledAt: isoTimestamp(s.canceled_at) } : {}),
    ...(typeof s.ended_at === 'number' ? { endedAt: isoTimestamp(s.ended_at) } : {}),
    items: items.flatMap((r) =>
      r.amount
        ? [
            {
              priceExternalId: r.item.price.id,
              ...(idOf(r.item.price.product) ? { product: idOf(r.item.price.product) as string } : {}),
              quantity: typeof r.item.quantity === 'number' ? r.item.quantity : 1,
              amount: r.amount,
            },
          ]
        : [],
    ),
  }
}

/** Stripe's own generic descriptions say nothing about who paid. */
const GENERIC_DESCRIPTION = /^(subscription (creation|update|cycle|threshold)|payment for invoice|invoice [a-z0-9-]+)$/i

/**
 * Who a charge or refund was with, as people read it: the customer's name or email (looked up by id), else the
 * cardholder or receipt email on the payment, else its description. Never the cus_ id (that stays `customer`).
 */
export function counterpartyOf(src: StripeExpandedSource | undefined, customer: string | undefined, names?: ReadonlyMap<string, string>): string | undefined {
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined)
  const named = customer ? names?.get(customer) : undefined
  const desc = clean(src?.description)
  return clean(named) ?? clean(src?.billing_details?.name) ?? clean(src?.billing_details?.email) ?? clean(src?.receipt_email) ?? (desc && !GENERIC_DESCRIPTION.test(desc) ? desc : undefined) ?? (customer ? 'Stripe customer' : undefined)
}

/** The payment intents that paid an invoice (from its expanded payments). */
export function paymentRefsOf(inv: StripeInvoice): string[] {
  const out = (inv.payments?.data ?? []).filter((p) => !p.status || p.status === 'paid').map((p) => idOf(p.payment?.payment_intent)).filter((x): x is string => !!x)
  return [...new Set(out)]
}
