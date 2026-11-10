// Ramp → NormalizedEvent mapping.
// Card: Ramp amounts are from the card's view (purchase +, refund −); Aggregate's rule is + = money in, so negate.
// The business card balance is owed, emitted negative. Reimbursements are owed to employees: negative rows on a
// separate "Ramp Reimbursements" account. Bills are payable invoices.

import type { AccountUpsert, BalanceSnapshot, InvoiceUpsert, Money, TxnUpsert } from '@agfn/contracts'
import { instantAt, isoDate, minorMoney, money, negate, normalizeCurrency } from '@agfn/connector-sdk'
import type { RampBill, RampBusinessBalance, RampCurrencyAmount, RampReimbursement, RampTransaction } from './types.ts'

export const cardAccountId = (businessId: string) => `${businessId}:card`
export const reimbursementAccountId = (businessId: string) => `${businessId}:reimbursements`

export function currencyAmount(a: RampCurrencyAmount): Money {
  return minorMoney(a.amount, normalizeCurrency(a.currency_code ?? 'USD'))
}

export function mapCardAccount(businessId: string, name: string | undefined, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: cardAccountId(businessId),
    connectionId,
    rawRef,
    name: `${name ? `${name} ` : ''}Ramp Card`.slice(0, 120),
    accountType: 'credit_card',
    currency: 'USD',
    institution: 'Ramp',
    businessHint: 'business',
    liability: { kind: 'credit' },
  }
}

export function mapReimbursementAccount(businessId: string, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: reimbursementAccountId(businessId),
    connectionId,
    rawRef,
    name: 'Ramp Reimbursements',
    // Owed to employees. There is no 'employee_payable' account type; 'other' keeps it out of cash and card totals.
    accountType: 'other',
    currency: 'USD',
    institution: 'Ramp',
    businessHint: 'business',
  }
}

export function mapCardBalance(businessId: string, b: RampBusinessBalance, connectionId: string, rawRef: string, at: string): BalanceSnapshot | undefined {
  const owed = b.card_balance_excluding_pending_amount
    ? currencyAmount(b.card_balance_excluding_pending_amount)
    : typeof b.card_balance_including_pending === 'number'
      ? money(b.card_balance_including_pending, 'USD')
      : undefined
  if (!owed) return undefined
  const id = cardAccountId(businessId)
  return {
    type: 'balance.snapshot',
    externalId: `${id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: id,
    at,
    current: { minor: -Math.abs(owed.minor), currency: owed.currency },
  }
}

export function txnStatus(state: string): TxnUpsert['status'] {
  if (state === 'CLEARED' || state === 'COMPLETION') return 'posted'
  if (state === 'PENDING' || state === 'PENDING_INITIATION') return 'pending'
  return 'void'
}

export function mapCardTxn(t: RampTransaction, businessId: string, connectionId: string, rawRef: string): TxnUpsert {
  const card = t.entity_amount
    ? minorMoney(t.entity_amount.value, normalizeCurrency(t.entity_amount.currency))
    : money(t.amount ?? 0, normalizeCurrency(t.currency_code))
  const status = txnStatus(t.state)
  const raw = [t.merchant_descriptor, t.memo].filter((x): x is string => !!x && x.trim() !== '').join(' | ')
  return {
    type: 'txn.upsert',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: cardAccountId(businessId),
    date: status === 'posted' && t.settlement_date ? isoDate(t.settlement_date) : isoDate(t.user_transaction_time),
    // Mirrors the date source: settlement_date is a UTC-midnight day (instantAt → undefined, keep it), while a pending
    // row's user_transaction_time is a real moment the engine should place in the workspace tz.
    ...(instantAt(status === 'posted' && t.settlement_date ? t.settlement_date : t.user_transaction_time) ? { at: instantAt(status === 'posted' && t.settlement_date ? t.settlement_date : t.user_transaction_time) } : {}),
    amount: negate(card),
    status,
    ...(t.merchant_name ? { counterparty: t.merchant_name.slice(0, 120) } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    ...(t.sk_category_name ? { categoryHint: t.sk_category_name } : {}),
    ...(t.card_id ? { linkRefs: { card_id: t.card_id } } : {}),
  }
}

const VOID_REIMBURSEMENT = new Set(['CANCELED', 'DELETED', 'DRAFT', 'INIT', 'REJECTED'])
const PENDING_REIMBURSEMENT = new Set(['PENDING'])

export function reimbursementStatus(state: string): TxnUpsert['status'] {
  if (VOID_REIMBURSEMENT.has(state)) return 'void'
  if (PENDING_REIMBURSEMENT.has(state)) return 'pending'
  // Approved onward (awaiting payment, exported, reimbursed...): the company owes or has paid it.
  return 'posted'
}

export function mapReimbursement(r: RampReimbursement, businessId: string, connectionId: string, rawRef: string): TxnUpsert {
  const amt = r.entity_amount
    ? minorMoney(r.entity_amount.value, normalizeCurrency(r.entity_amount.currency))
    : money(r.amount ?? 0, normalizeCurrency(r.currency))
  // BUSINESS_TO_USER: the company owes the employee (money out, negative). USER_TO_BUSINESS repayments are positive.
  const signed = r.direction === 'USER_TO_BUSINESS' ? { minor: Math.abs(amt.minor), currency: amt.currency } : { minor: -Math.abs(amt.minor), currency: amt.currency }
  return {
    type: 'txn.upsert',
    externalId: r.id,
    connectionId,
    rawRef,
    accountExternalId: reimbursementAccountId(businessId),
    date: isoDate(r.transaction_date ?? r.created_at),
    amount: signed,
    status: reimbursementStatus(r.state),
    ...(r.merchant ? { counterparty: r.merchant.slice(0, 120) } : {}),
    ...(r.memo ? { rawText: r.memo.slice(0, 500) } : {}),
    categoryHint: `reimbursement${r.type ? `:${r.type}` : ''}`,
    ...(r.user_id ? { linkRefs: { ramp_user_id: r.user_id } } : {}),
  }
}

export function billStatus(b: RampBill): InvoiceUpsert['status'] {
  if (b.approval_status === 'REJECTED' || b.approval_status === 'TERMINATED' || b.status_summary === 'ARCHIVED') return 'void'
  if (b.status === 'PAID' || b.status_summary === 'PAYMENT_COMPLETED') return 'paid'
  if (b.approval_status === 'INITIALIZED' || b.approval_status === 'PENDING') return 'draft'
  return 'open'
}

export function mapBill(b: RampBill, connectionId: string, rawRef: string): InvoiceUpsert {
  const total = currencyAmount(b.amount)
  const status = billStatus(b)
  const lines = (b.line_items ?? [])
    .filter((l): l is { memo?: string | null; amount: RampCurrencyAmount } => !!l.amount)
    .map((l) => ({ description: (l.memo ?? '').slice(0, 200), amount: currencyAmount(l.amount) }))
  return {
    type: 'invoice.upsert',
    externalId: b.id,
    connectionId,
    rawRef,
    direction: 'payable',
    ...(b.invoice_number ? { number: b.invoice_number } : {}),
    counterparty: (b.vendor?.name ?? 'Unknown vendor').slice(0, 120),
    issueDate: isoDate(b.issued_at ?? b.created_at),
    ...(b.due_at ? { dueDate: isoDate(b.due_at) } : {}),
    total,
    amountPaid: { minor: status === 'paid' ? total.minor : 0, currency: total.currency },
    status,
    ...(lines.length ? { lines } : {}),
  }
}
