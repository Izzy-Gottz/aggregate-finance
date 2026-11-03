// PayPal → NormalizedEvent mapping.
// Transaction Search amounts are already signed from the account's side (+ money into the PayPal balance).
// fee_amount is NEGATIVE when PayPal charged a fee (and positive when a refund returns one); Aggregate's fee is the
// positive cost, so fee = −fee_amount and net = gross − fee (= transaction_amount + fee_amount).

import type { AccountUpsert, BalanceSnapshot, InvoiceUpsert, Money, ProcessorBalanceTxn } from '@agfn/contracts'
import { isoDate, isoTimestamp, money, normalizeCurrency } from '@agfn/connector-sdk'
import type { PayPalBalanceDetail, PayPalInvoice, PayPalPayerInfo, PayPalTransactionDetail } from './types.ts'

export type ProcessorKind = ProcessorBalanceTxn['kind']

export function accountExternalId(accountId: string, currency: string): string {
  return `${accountId}:${currency}`
}

export function mapAccount(accountId: string, currency: string, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: accountExternalId(accountId, currency),
    connectionId,
    rawRef,
    name: `PayPal balance (${currency})`,
    accountType: 'processor_balance',
    currency,
    institution: 'PayPal',
    businessHint: 'business',
  }
}

export function mapBalance(accountId: string, b: PayPalBalanceDetail, connectionId: string, rawRef: string, at: string, day: string): BalanceSnapshot {
  const cur = normalizeCurrency(b.currency)
  const acct = accountExternalId(accountId, cur)
  return {
    type: 'balance.snapshot',
    externalId: `${acct}@${day}`,
    connectionId,
    rawRef,
    accountExternalId: acct,
    at,
    current: money(b.total_balance.value, cur),
    ...(b.available_balance ? { available: money(b.available_balance.value, cur) } : {}),
  }
}

/**
 * Event code families (PayPal "Transaction event codes"):
 * T00xx PayPal-account-to-PayPal-account payments, T01xx non-payment fees, T02xx currency conversion,
 * T03xx bank deposits into PayPal, T04xx bank withdrawals out of PayPal, T05xx/T06xx debit/credit card,
 * T07xx/T08xx/T09xx other, T11xx reversals (T1106 payment reversal, T1107 refund, and fee, bank and hold reversals),
 * T12xx adjustments and chargebacks, T15xx holds, T16xx buyer credit, T21xx holds and reserves,
 * T17xx/T18xx/T19xx/T20xx other, T98xx display-only rows that don't touch the balance.
 * https://developer.paypal.com/docs/transaction-search/transaction-event-codes/
 */
export function kindForEventCode(code: string | undefined): ProcessorKind {
  if (!code || !/^T\d{4}$/.test(code)) return 'other'
  const family = code.slice(0, 3)
  switch (family) {
    case 'T00':
      return 'charge'
    case 'T01':
      return 'fee'
    case 'T02':
      return 'transfer'
    case 'T03':
      return 'transfer'
    case 'T04':
      return 'payout'
    case 'T11':
      if (code === 'T1108' || code === 'T1109') return 'fee'
      if (code === 'T1101' || code === 'T1104' || code === 'T1112') return 'transfer'
      if (code === 'T1105' || code === 'T1110' || code === 'T1111') return 'adjustment'
      return code === 'T1106' ? 'dispute' : 'refund'
    case 'T12':
      return code === 'T1200' || code === 'T1203' || code === 'T1204' ? 'adjustment' : 'dispute'
    case 'T15':
    case 'T16':
    case 'T21':
      return 'adjustment'
    default:
      return 'other'
  }
}

export function payerName(p: PayPalPayerInfo | undefined): string | undefined {
  const n = p?.payer_name
  if (!n) return undefined
  const full = n.alternate_full_name || n.full_name || [n.given_name, n.surname].filter(Boolean).join(' ')
  return full ? full.slice(0, 120) : undefined
}

/** Holds and reserves (T15xx, T21xx, dispute holds), or a bank deposit into PayPal and its reversal: on the balance sheet, not income or spending. */
export function balanceRoleForEventCode(code: string): ProcessorBalanceTxn['balanceRole'] {
  if (code === 'T2109' || code === 'T2110') return undefined // gift certificates
  if (code.startsWith('T15') || code.startsWith('T21') || code === 'T1105' || code === 'T1110' || code === 'T1111') return 'other_assets'
  if (code.startsWith('T03') || code === 'T1104') return 'clearing_payouts'
  return undefined
}

/**
 * Denied rows (status D) never moved money, pending ones (P) haven't yet, and display-only rows (T98xx) don't touch the
 * balance; we skip them. A pending row keeps its id when it completes, inside the connector's re-read. Returns undefined
 * for rows without an amount.
 */
export function mapTxn(d: PayPalTransactionDetail, accountId: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | undefined {
  const t = d.transaction_info
  if (!t.transaction_amount || t.transaction_status === 'D' || t.transaction_status === 'P' || t.transaction_event_code?.startsWith('T98')) return undefined
  const cur = normalizeCurrency(t.transaction_amount.currency_code)
  const gross = money(t.transaction_amount.value, cur)
  const feeRaw = t.fee_amount ? money(t.fee_amount.value, cur) : { minor: 0, currency: cur }
  const fee: Money = { minor: feeRaw.minor === 0 ? 0 : -feeRaw.minor, currency: cur }
  const net: Money = { minor: gross.minor - fee.minor, currency: cur }
  // T00xx is money received or sent. Sent isn't negative revenue; T0015 and T0016 are payouts and recoupments.
  const code = t.transaction_event_code ?? ''
  const outgoing = code.startsWith('T00') && (gross.minor < 0 || code === 'T0015' || code === 'T0016')
  const kind = outgoing ? 'other' : kindForEventCode(code)
  const role = balanceRoleForEventCode(t.transaction_event_code ?? '')
  // Only what PayPal states, and only on a sale or refund inside the gross.
  const taxMinor = (kind === 'charge' || kind === 'refund') && t.sales_tax_amount && t.tax_inclusive !== false && t.sales_tax_amount.currency_code === t.transaction_amount.currency_code ? Math.abs(money(t.sales_tax_amount.value, cur).minor) : 0
  const taxIncluded = taxMinor && taxMinor <= Math.abs(gross.minor) ? { minor: gross.minor < 0 ? -taxMinor : taxMinor, currency: cur } : undefined
  const at = isoTimestamp(t.transaction_initiation_date ?? t.transaction_updated_date ?? '')
  const customer = kind === 'charge' || kind === 'refund' || kind === 'dispute' ? payerName(d.payer_info) : undefined
  return {
    type: 'processor.balance_txn',
    externalId: t.transaction_id,
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(accountId, cur),
    at,
    kind,
    gross,
    fee,
    net,
    // A bank withdrawal IS the payout: its own transaction id is the payout id the bank side matches on.
    ...(kind === 'payout' ? { payoutExternalId: t.transaction_id } : {}),
    ...(t.paypal_reference_id && t.paypal_reference_id !== t.transaction_id ? { sourceExternalId: t.paypal_reference_id } : {}),
    ...(customer ? { customer } : {}),
    ...(role ? { balanceRole: role } : {}),
    ...(taxIncluded ? { taxIncluded } : {}),
  }
}

const INVOICE_STATUS: Record<string, InvoiceUpsert['status']> = {
  DRAFT: 'draft',
  SCHEDULED: 'draft',
  SHARED: 'open',
  SENT: 'open',
  UNPAID: 'open',
  PAYMENT_PENDING: 'open',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  MARKED_AS_PAID: 'paid',
  PAID_EXTERNAL: 'paid',
  PARTIALLY_REFUNDED: 'paid',
  REFUNDED: 'void',
  MARKED_AS_REFUNDED: 'void',
  REFUNDED_EXTERNAL: 'void',
  CANCELLED: 'void',
  AUTO_CANCELLED: 'void',
}

export function mapInvoice(inv: PayPalInvoice, connectionId: string, rawRef: string, fallbackDate: string): InvoiceUpsert {
  const cur = normalizeCurrency(inv.amount?.currency_code ?? inv.detail?.currency_code)
  const total = money(inv.amount?.value ?? '0', cur)
  const paid = inv.payments?.paid_amount ? money(inv.payments.paid_amount.value, cur) : { minor: 0, currency: cur }
  const bill = inv.primary_recipients?.[0]?.billing_info
  const person = bill?.name ? bill.name.full_name || [bill.name.given_name, bill.name.surname].filter(Boolean).join(' ') : ''
  const counterparty = (bill?.business_name || person || 'PayPal customer').slice(0, 120)
  const due = inv.detail?.payment_term?.due_date
  return {
    type: 'invoice.upsert',
    externalId: inv.id,
    connectionId,
    rawRef,
    direction: 'receivable',
    ...(inv.detail?.invoice_number ? { number: inv.detail.invoice_number } : {}),
    counterparty,
    issueDate: isoDate(inv.detail?.invoice_date ?? fallbackDate),
    ...(due ? { dueDate: isoDate(due) } : {}),
    total,
    amountPaid: paid,
    status: INVOICE_STATUS[inv.status] ?? 'open',
  }
}
