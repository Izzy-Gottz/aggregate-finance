// Shopify Payments → NormalizedEvent mapping. Balance transaction amounts are signed as money into the Shopify
// Payments balance (a charge is positive, a refund negative), fee is the positive cost, net = amount − fee.
// Payouts are emitted from the payouts connection as negative rows; the balance transactions that represent the same
// transfer (TRANSFER, TRANSFER_FAILURE, TRANSFER_CANCEL, TRANSFER_REFUND) are skipped so the payout isn't counted twice.

import type { AccountUpsert, BalanceSnapshot, Money, ProcessorBalanceTxn } from '@agfn/contracts'
import { isoTimestamp, money, normalizeCurrency } from '@agfn/connector-sdk'
import type { MoneyV2, ShopifyBalanceTransaction, ShopifyPayout, ShopifyPayoutSummary } from './types.ts'

export type ProcessorKind = ProcessorBalanceTxn['kind']

export function accountExternalId(shop: string, currency: string): string {
  return `${shop}:${currency}`
}

export const m2 = (v: MoneyV2 | undefined | null, fallback: string): Money => {
  const cur = normalizeCurrency(v?.currencyCode, fallback)
  return money(v?.amount ?? '0', cur)
}

export function mapAccount(shop: string, currency: string, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: accountExternalId(shop, currency),
    connectionId,
    rawRef,
    name: `Shopify Payments (${currency})`,
    accountType: 'processor_balance',
    currency,
    institution: 'Shopify Payments',
    businessHint: 'business',
  }
}

export function mapBalance(shop: string, b: MoneyV2, connectionId: string, rawRef: string, at: string): BalanceSnapshot {
  const cur = normalizeCurrency(b.currencyCode)
  const acct = accountExternalId(shop, cur)
  return {
    type: 'balance.snapshot',
    externalId: `${acct}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: acct,
    at,
    current: money(b.amount, cur),
  }
}

/** Balance transaction types that are the payout itself (emitted from the payout instead). */
export const PAYOUT_TYPES = new Set(['TRANSFER', 'TRANSFER_FAILURE', 'TRANSFER_CANCEL', 'TRANSFER_REFUND'])

export function kindForType(type: string): ProcessorKind {
  const t = type.toUpperCase()
  if (t === 'CHARGE') return 'charge'
  if (t === 'REFUND' || t === 'REFUND_ADJUSTMENT' || t === 'REFUND_FAILURE') return 'refund'
  if (t.startsWith('DISPUTE_') || t === 'CHARGEBACK_HOLD' || t === 'CHARGEBACK_HOLD_RELEASE') return 'dispute'
  if (
    t.endsWith('_FEE') || t.includes('_FEE_') || t === 'APPLICATION_FEE_REFUND' || t.startsWith('SHIPPING_') ||
    t.startsWith('BILLING_DEBIT') || t.startsWith('REFERRAL_FEE') || t === 'MARKETPLACE_FEE_CREDIT' || t === 'MARKETPLACE_FEE_CREDIT_REVERSAL'
  ) {
    return 'fee'
  }
  if (t === 'CURRENCY_CONVERSION' || t.startsWith('BALANCE_TRANSFER_') || t.startsWith('MERCHANT_TO_MERCHANT_') || t.startsWith('CHANNEL_TRANSFER_')) return 'transfer'
  if (PAYOUT_TYPES.has(t)) return 'payout'
  if (t.includes('ADJUSTMENT') || t.startsWith('RESERVED_FUNDS') || t.startsWith('RISK_') || t.startsWith('ANOMALY_') || t.startsWith('ADVANCE') || t.startsWith('LENDING_')) {
    return 'adjustment'
  }
  return 'other'
}

/** Funds held back, or a Shopify Capital advance and its repayments: on the balance sheet, not income or spending. */
export function balanceRoleForType(type: string): ProcessorBalanceTxn['balanceRole'] {
  const t = type.toUpperCase()
  if (t.startsWith('RESERVED_FUNDS')) return 'other_assets'
  if (t.startsWith('ADVANCE') || t.startsWith('LENDING_')) return 'other_liabilities'
  return undefined
}

function addUp(gross: Money, fee: Money, net: Money): { gross: Money; fee: Money; net: Money } {
  if (gross.minor - fee.minor === net.minor) return { gross, fee, net }
  return { gross, fee: { minor: gross.minor - net.minor, currency: net.currency }, net }
}

/** undefined for test-mode rows (no real money) and for the payout's own transfer rows. */
export function mapBalanceTxn(t: ShopifyBalanceTransaction, shop: string, fallbackCurrency: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  if (t.test || PAYOUT_TYPES.has(t.type)) return undefined
  const cur = normalizeCurrency(t.net?.currencyCode ?? t.amount?.currencyCode, fallbackCurrency)
  const amounts = addUp(m2(t.amount, cur), m2(t.fee, cur), m2(t.net, cur))
  const payout = t.associatedPayout?.id ?? undefined
  return {
    type: 'processor.balance_txn',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(shop, cur),
    at: isoTimestamp(t.transactionDate),
    kind: kindForType(t.type),
    ...amounts,
    ...(balanceRoleForType(t.type) ? { balanceRole: balanceRoleForType(t.type) } : {}),
    ...(payout ? { payoutExternalId: payout } : {}),
    ...(t.sourceId ? { sourceExternalId: String(t.sourceId) } : {}),
  }
}

/** A payout leaves the balance (negative) unless it's a WITHDRAWAL back from the bank; failed/canceled → zero. */
export function mapPayout(p: ShopifyPayout, shop: string, connectionId: string, rawRef: string): ProcessorBalanceTxn {
  const amt = m2(p.net, 'USD')
  const dead = p.status === 'FAILED' || p.status === 'CANCELED'
  const signed = dead ? 0 : p.transactionType === 'WITHDRAWAL' ? Math.abs(amt.minor) : -Math.abs(amt.minor)
  const net: Money = { minor: signed === 0 ? 0 : signed, currency: amt.currency }
  return {
    type: 'processor.balance_txn',
    externalId: p.id,
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(shop, amt.currency),
    at: isoTimestamp(p.issuedAt),
    kind: 'payout',
    gross: net,
    fee: { minor: 0, currency: amt.currency },
    net,
    payoutExternalId: p.id,
  }
}

const SUMMARY: Array<{ key: string; gross: keyof ShopifyPayoutSummary; fee: keyof ShopifyPayoutSummary; kind: ProcessorKind; balanceRole?: ProcessorBalanceTxn['balanceRole'] }> = [
  { key: 'charges', gross: 'chargesGross', fee: 'chargesFee', kind: 'charge' },
  { key: 'refunds', gross: 'refundsFeeGross', fee: 'refundsFee', kind: 'refund' },
  { key: 'adjustments', gross: 'adjustmentsGross', fee: 'adjustmentsFee', kind: 'adjustment' },
  { key: 'reserved_funds', gross: 'reservedFundsGross', fee: 'reservedFundsFee', kind: 'adjustment', balanceRole: 'other_assets' },
  { key: 'retried_payouts', gross: 'retriedPayoutsGross', fee: 'retriedPayoutsFee', kind: 'adjustment' },
  { key: 'advances', gross: 'advanceGross', fee: 'advanceFees', kind: 'adjustment', balanceRole: 'other_liabilities' },
]

/**
 * Fallback when balanceTransactions is access-denied: one row per non-zero summary category of each payout
 * (`<payout id>#charges` etc.), so revenue, fees and refunds still reach the ledger, per payout instead of per order.
 * Failed/canceled payouts get none (their money stayed in the balance and appears in a later payout's summary).
 */
export function mapPayoutSummary(p: ShopifyPayout, shop: string, connectionId: string, rawRef: string): ProcessorBalanceTxn[] {
  if (!p.summary || p.status === 'FAILED' || p.status === 'CANCELED') return []
  const cur = normalizeCurrency(p.net.currencyCode)
  const out: ProcessorBalanceTxn[] = []
  for (const s of SUMMARY) {
    const gross = m2(p.summary[s.gross], cur)
    const fee = m2(p.summary[s.fee], cur)
    if (gross.minor === 0 && fee.minor === 0) continue
    out.push({
      type: 'processor.balance_txn',
      externalId: `${p.id}#${s.key}`,
      connectionId,
      rawRef,
      accountExternalId: accountExternalId(shop, cur),
      at: isoTimestamp(p.issuedAt),
      kind: s.kind,
      gross,
      fee,
      net: { minor: gross.minor - fee.minor, currency: cur },
      payoutExternalId: p.id,
      ...(s.balanceRole ? { balanceRole: s.balanceRole } : {}),
    })
  }
  return out
}
