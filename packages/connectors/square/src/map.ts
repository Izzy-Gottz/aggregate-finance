// Square → NormalizedEvent mapping. Square money is integer minor units. Payout entries are already signed as money
// into the Square balance (a CHARGE has positive gross/net; a REFUND negative gross and a negative fee, i.e. the fee
// returned), and gross − fee = net. The payout itself takes money OUT of the balance, so its row is −amount.

import type { AccountUpsert, InvoiceUpsert, Money, ProcessorBalanceTxn, TxnUpsert } from '@agfn/contracts'
import { isoDate, isoTimestamp, localDay, minorMoney, normalizeCurrency } from '@agfn/connector-sdk'
import type { SquareInvoice, SquareMoney, SquarePayment, SquarePayout, SquarePayoutEntry, SquareProcessingFee, SquareRefund } from './types.ts'

export type ProcessorKind = ProcessorBalanceTxn['kind']

export function accountExternalId(merchantId: string, currency: string): string {
  return `${merchantId}:${currency}`
}

export function mapAccount(merchantId: string, currency: string, connectionId: string, rawRef: string, businessName?: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: accountExternalId(merchantId, currency),
    connectionId,
    rawRef,
    name: `${businessName ? businessName.slice(0, 80) + ' ' : ''}Square balance (${currency})`,
    accountType: 'processor_balance',
    currency,
    institution: 'Square',
    businessHint: 'business',
  }
}

/** One cash drawer per location: cash and "other" tenders are counted where they're taken, not in the Square balance. */
export function cashAccountExternalId(merchantId: string, locationId: string): string {
  return `${merchantId}:cash:${locationId}`
}

export function mapCashAccount(merchantId: string, loc: { id: string; cur: string; name?: string }, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: cashAccountExternalId(merchantId, loc.id),
    connectionId,
    rawRef,
    name: `Square cash drawer (${(loc.name || loc.id).slice(0, 80)})`,
    accountType: 'cash_on_hand',
    currency: loc.cur,
    institution: 'Square',
    businessHint: 'business',
  }
}

export function sqMoney(m: SquareMoney | undefined | null, fallbackCurrency: string): Money {
  return minorMoney(m?.amount ?? 0, normalizeCurrency(m?.currency, fallbackCurrency))
}

const FEE = new Set([
  'FEE', 'TAX_ON_FEE', 'DEPOSIT_FEE', 'DEPOSIT_FEE_REVERSED', 'THIRD_PARTY_FEE', 'THIRD_PARTY_FEE_REFUND',
  'APP_FEE_REFUND', 'APP_FEE_REVENUE',
])
const ADJUSTMENT = new Set([
  'ADJUSTMENT', 'OTHER_ADJUSTMENT', 'HOLD_ADJUSTMENT', 'RELEASE_ADJUSTMENT', 'RESERVE_HOLD', 'RESERVE_RELEASE',
  'FREE_PROCESSING', 'CREDIT_CARD_REPAYMENT', 'CREDIT_CARD_REPAYMENT_REVERSED',
])
const TRANSFER = new Set([
  'AUTOMATIC_SAVINGS', 'AUTOMATIC_SAVINGS_REVERSED', 'SQUARE_CAPITAL_PAYMENT', 'SQUARE_CAPITAL_REVERSED_PAYMENT',
  'SQUARE_PAYROLL_TRANSFER', 'SQUARE_PAYROLL_TRANSFER_REVERSED', 'BALANCE_FOLDERS_TRANSFER', 'BALANCE_FOLDERS_TRANSFER_REVERSED',
  'GIFT_CARD_POOL_TRANSFER', 'GIFT_CARD_POOL_TRANSFER_REVERSED',
])

export function kindForEntryType(type: string | undefined): ProcessorKind {
  const t = (type ?? '').toUpperCase()
  if (t === 'CHARGE') return 'charge'
  if (t === 'REFUND') return 'refund'
  if (t === 'DISPUTE' || t === 'OPEN_DISPUTE' || t === 'DISPUTE_REVERSAL') return 'dispute'
  if (FEE.has(t)) return 'fee'
  if (ADJUSTMENT.has(t)) return 'adjustment'
  if (TRANSFER.has(t)) return 'transfer'
  return 'other'
}

/** Funds held back or Square Loans: on the balance sheet, not income or spending. */
export function balanceRoleForEntry(type: string | undefined): ProcessorBalanceTxn['balanceRole'] {
  const t = (type ?? '').toUpperCase()
  if (['HOLD_ADJUSTMENT', 'RELEASE_ADJUSTMENT', 'RESERVE_HOLD', 'RESERVE_RELEASE'].includes(t)) return 'other_assets'
  if (t === 'SQUARE_CAPITAL_PAYMENT' || t === 'SQUARE_CAPITAL_REVERSED_PAYMENT') return 'other_liabilities'
  return undefined
}

/** The source object of an entry (payment, refund, dispute...) from its type_*_details. */
export function entrySource(e: SquarePayoutEntry): string | undefined {
  for (const [k, v] of Object.entries(e)) {
    if (!/^type_.+_details$/.test(k) || !v || typeof v !== 'object') continue
    const d = v as Record<string, unknown>
    for (const f of ['refund_id', 'dispute_id', 'payment_id', 'payout_id']) {
      if (typeof d[f] === 'string' && d[f]) return d[f] as string
    }
  }
  return undefined
}

/** Keep the provider's gross and net (net is what moved the balance); derive the fee if the three don't add up. */
function grossFeeNet(gross: Money, fee: Money, net: Money): { gross: Money; fee: Money; net: Money } {
  if (gross.minor - fee.minor === net.minor) return { gross, fee, net }
  return { gross, fee: { minor: gross.minor - net.minor, currency: net.currency }, net }
}

export function mapEntry(e: SquarePayoutEntry, merchantId: string, fallbackCurrency: string, connectionId: string, rawRef: string, fallbackAt: string): ProcessorBalanceTxn {
  const cur = normalizeCurrency(e.net_amount_money?.currency ?? e.gross_amount_money?.currency, fallbackCurrency)
  const amounts = grossFeeNet(sqMoney(e.gross_amount_money, cur), sqMoney(e.fee_amount_money, cur), sqMoney(e.net_amount_money, cur))
  const source = entrySource(e)
  return {
    type: 'processor.balance_txn',
    // A sale or refund is one record whichever source sees it first: the payment (or refund) itself, or the payout
    // entry that later settles it. Other entries (fees, adjustments…) keep their own id.
    externalId: saleId(e) ?? e.id,
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(merchantId, cur),
    at: isoTimestamp(e.effective_at ?? fallbackAt),
    kind: kindForEntryType(e.type),
    ...amounts,
    payoutExternalId: e.payout_id,
    ...(source ? { sourceExternalId: source } : {}),
    ...(balanceRoleForEntry(e.type) ? { balanceRole: balanceRoleForEntry(e.type) } : {}),
  }
}

/**
 * The payout as a negative row on the balance. Its deposit fee is a separate DEPOSIT_FEE entry, so fee is 0 here.
 * A FAILED payout never left (Square returns the money), so it is emitted with zero amounts (replaces an earlier SENT row).
 */
export function mapPayout(p: SquarePayout, merchantId: string, fallbackCurrency: string, connectionId: string, rawRef: string): ProcessorBalanceTxn {
  const amount = sqMoney(p.amount_money, fallbackCurrency)
  const failed = p.status === 'FAILED'
  const net: Money = { minor: failed || amount.minor === 0 ? 0 : -amount.minor, currency: amount.currency }
  return {
    type: 'processor.balance_txn',
    externalId: p.id,
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(merchantId, amount.currency),
    at: isoTimestamp(p.created_at ?? p.updated_at ?? ''),
    kind: 'payout',
    gross: net,
    fee: { minor: 0, currency: amount.currency },
    net,
    payoutExternalId: p.id,
  }
}

const INVOICE_STATUS: Record<string, InvoiceUpsert['status']> = {
  DRAFT: 'draft',
  SCHEDULED: 'open',
  UNPAID: 'open',
  PAYMENT_PENDING: 'open',
  PARTIALLY_PAID: 'partially_paid',
  PAID: 'paid',
  PARTIALLY_REFUNDED: 'paid',
  REFUNDED: 'void',
  CANCELED: 'void',
  FAILED: 'uncollectible',
}

export function mapInvoice(inv: SquareInvoice, fallbackCurrency: string, connectionId: string, rawRef: string): InvoiceUpsert {
  const reqs = inv.payment_requests ?? []
  const cur = normalizeCurrency(reqs.find((r) => r.computed_amount_money?.currency)?.computed_amount_money?.currency, fallbackCurrency)
  let total = 0
  let paid = 0
  let due: string | undefined
  for (const r of reqs) {
    total += sqMoney(r.computed_amount_money, cur).minor
    paid += sqMoney(r.total_completed_amount_money, cur).minor
    if (r.due_date && (!due || r.due_date > due)) due = r.due_date
  }
  const p = inv.primary_recipient
  const person = [p?.given_name, p?.family_name].filter(Boolean).join(' ')
  return {
    type: 'invoice.upsert',
    externalId: inv.id,
    connectionId,
    rawRef,
    direction: 'receivable',
    ...(inv.invoice_number ? { number: inv.invoice_number } : {}),
    counterparty: (p?.company_name || person || 'Square customer').slice(0, 120),
    issueDate: isoDate(inv.sale_or_service_date ?? inv.created_at ?? ''),
    ...(due ? { dueDate: isoDate(due) } : {}),
    total: minorMoney(total, cur),
    amountPaid: minorMoney(paid, cur),
    status: INVOICE_STATUS[inv.status ?? ''] ?? 'open',
  }
}

/** Card, wallet, bank and BNPL payments go through the Square balance; cash and "other" tenders never touch it. */
const OFF_BALANCE = new Set(['CASH', 'EXTERNAL'])

export const paymentId = (id: string): string => `pay:${id}`
export const refundId = (id: string): string => `ref:${id}`

/** The shared id of a CHARGE or REFUND payout entry (its payment or refund), so it lands on the same record. */
export function saleId(e: SquarePayoutEntry): string | undefined {
  const t = (e.type ?? '').toUpperCase()
  const d = (k: string) => (e as unknown as Record<string, Record<string, unknown> | undefined>)[k]
  if (t === 'CHARGE') {
    const id = d('type_charge_details')?.payment_id
    return typeof id === 'string' && id ? paymentId(id) : undefined
  }
  if (t === 'REFUND') {
    const id = d('type_refund_details')?.refund_id
    return typeof id === 'string' && id ? refundId(id) : undefined
  }
  return undefined
}

function feeOf(fees: SquareProcessingFee[] | null | undefined, cur: string): Money {
  return minorMoney((fees ?? []).reduce((t, f) => t + (f.amount_money?.amount ?? 0), 0), cur)
}

/** Whether a payment was taken in cash or an "other" tender (never through the Square balance). */
export function isOffBalance(p: SquarePayment): boolean {
  return OFF_BALANCE.has((p.source_type ?? '').toUpperCase())
}

/** Whether a refund was paid back in cash or another tender (out of the drawer, not the Square balance). */
export function isOffBalanceRefund(r: SquareRefund): boolean {
  return OFF_BALANCE.has((r.destination_type ?? '').toUpperCase())
}

const tenderText = (p: SquarePayment): string => {
  if ((p.source_type ?? '').toUpperCase() === 'CASH') return 'Square cash sale'
  const how = (p.external_details?.type ?? '').replace(/_/g, ' ').toLowerCase().trim()
  return how && how !== 'other' ? `Square sale paid by ${how}` : 'Square sale, other tender'
}

/** The day a sale happened where it happened: the location's own zone (an evening sale in Los Angeles is that day, not
 *  tomorrow's UTC date). Without a zone, the UTC day. */
export function locationDay(at: string | undefined, tz: string | undefined): string {
  const t = Date.parse(at ?? '')
  return Number.isFinite(t) && tz ? localDay(t, tz) : isoDate(at ?? '')
}

/** A completed cash or "other" tender sale: money into the location's cash drawer. */
export function mapCashPayment(p: SquarePayment, merchantId: string, loc: { id: string; cur: string; tz?: string }, connectionId: string, rawRef: string): TxnUpsert | null {
  if (p.status !== 'COMPLETED' || !isOffBalance(p)) return null
  const amount = sqMoney(p.total_money ?? p.amount_money, loc.cur)
  if (amount.minor <= 0) return null
  return {
    type: 'txn.upsert',
    externalId: `cash:${p.id}`,
    connectionId,
    rawRef,
    accountExternalId: cashAccountExternalId(merchantId, loc.id),
    date: locationDay(p.created_at, loc.tz),
    amount,
    status: 'posted',
    ...(payer(p) ? { counterparty: payer(p) } : {}),
    rawText: tenderText(p),
    categoryHint: 'INCOME_SALES',
    linkRefs: { square_payment: p.id },
  }
}

/** A completed refund paid back in cash or another tender: money out of the drawer, tagged with the sale it undoes. */
export function mapCashRefund(r: SquareRefund, merchantId: string, loc: { id: string; cur: string; tz?: string }, connectionId: string, rawRef: string): TxnUpsert | null {
  if (r.status !== 'COMPLETED' || !isOffBalanceRefund(r)) return null
  const amt = sqMoney(r.amount_money, loc.cur)
  if (amt.minor === 0) return null
  return {
    type: 'txn.upsert',
    externalId: `cashref:${r.id}`,
    connectionId,
    rawRef,
    accountExternalId: cashAccountExternalId(merchantId, loc.id),
    date: locationDay(r.created_at, loc.tz),
    amount: { minor: -Math.abs(amt.minor), currency: amt.currency },
    status: 'posted',
    rawText: 'Square refund paid from the cash drawer',
    categoryHint: 'SALES_REFUND',
    linkRefs: { ...(r.payment_id ? { refund_of: r.payment_id } : {}), square_refund: r.id },
  }
}

/** A completed payment into the Square balance (null for cash, other tenders, and anything not completed). */
export function mapPayment(p: SquarePayment, merchantId: string, fallbackCurrency: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | null {
  if (p.status !== 'COMPLETED' || OFF_BALANCE.has((p.source_type ?? '').toUpperCase())) return null
  const gross = sqMoney(p.total_money ?? p.amount_money, fallbackCurrency)
  const fee = feeOf(p.processing_fee, gross.currency)
  return {
    type: 'processor.balance_txn',
    externalId: paymentId(p.id),
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(merchantId, gross.currency),
    at: isoTimestamp(p.created_at ?? ''),
    kind: 'charge',
    gross,
    fee,
    net: { minor: gross.minor - fee.minor, currency: gross.currency },
    sourceExternalId: p.id,
    ...(payer(p) ? { counterparty: payer(p) } : {}),
  }
}

/** Who paid, when Square knows: the cardholder, else the buyer's email, else the seller's note. Untrusted text. */
function payer(p: SquarePayment): string | undefined {
  const v = [p.card_details?.card?.cardholder_name, p.buyer_email_address, p.note].map((s) => s?.replace(/\s+/g, ' ').trim()).find((s) => s && /[a-z]/i.test(s))
  return v ? v.slice(0, 120) : undefined
}

/** A completed refund out of the Square balance: negative gross, and Square's returned fee (negative) if any. */
export function mapRefund(r: SquareRefund, merchantId: string, fallbackCurrency: string, connectionId: string, rawRef: string): ProcessorBalanceTxn | null {
  if (r.status !== 'COMPLETED' || isOffBalanceRefund(r)) return null
  const amt = sqMoney(r.amount_money, fallbackCurrency)
  const gross: Money = { minor: -Math.abs(amt.minor), currency: amt.currency }
  const fee = feeOf(r.processing_fee, amt.currency)
  return {
    type: 'processor.balance_txn',
    externalId: refundId(r.id),
    connectionId,
    rawRef,
    accountExternalId: accountExternalId(merchantId, amt.currency),
    at: isoTimestamp(r.created_at ?? ''),
    kind: 'refund',
    gross,
    fee,
    net: { minor: gross.minor - fee.minor, currency: amt.currency },
    sourceExternalId: r.id,
  }
}
