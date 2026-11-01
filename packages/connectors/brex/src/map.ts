// Brex → NormalizedEvent mapping. Card amounts are negated (Brex: purchase +, payment −; Aggregate: + = money in).
// Card balances are amounts owed, emitted negative.

import type { AccountUpsert, BalanceSnapshot, Money, TxnUpsert } from '@agfn/contracts'
import { minorMoney, negate, normalizeCurrency } from '@agfn/connector-sdk'
import type { BrexCardAccount, BrexCardTransaction, BrexCashAccount, BrexCashTransaction, BrexMoney } from './types.ts'

/** An amount owed on a card, as Aggregate stores it: always negative (or 0). */
const owed = (m: Money): Money => ({ minor: m.minor === 0 ? 0 : -Math.abs(m.minor), currency: m.currency })

export const cur = (m: BrexMoney | null | undefined): string => normalizeCurrency(m?.currency ?? 'USD')
const mny = (m: BrexMoney) => minorMoney(m.amount, cur(m))

export function mapCashAccount(a: BrexCashAccount, connectionId: string, rawRef: string): AccountUpsert {
  const mask = a.account_number ? a.account_number.replace(/\D/g, '').slice(-4) : ''
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    name: (a.name || 'Brex Cash').slice(0, 120),
    accountType: 'depository',
    currency: cur(a.current_balance),
    ...(mask ? { mask } : {}),
    institution: 'Brex',
    businessHint: 'business',
  }
}

export function mapCashBalance(a: BrexCashAccount, connectionId: string, rawRef: string, at: string): BalanceSnapshot {
  return {
    type: 'balance.snapshot',
    externalId: `${a.id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: a.id,
    at,
    current: mny(a.current_balance),
    available: mny(a.available_balance),
  }
}

export function mapCardAccount(a: BrexCardAccount, connectionId: string, rawRef: string, index: number): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    name: index === 0 ? 'Brex Card' : `Brex Card ${index + 1}`,
    accountType: 'credit_card',
    currency: cur(a.current_balance ?? a.account_limit),
    institution: 'Brex',
    businessHint: 'business',
    liability: { kind: 'credit' },
  }
}

export function mapCardBalance(a: BrexCardAccount, connectionId: string, rawRef: string, at: string): BalanceSnapshot | undefined {
  if (!a.current_balance) return undefined
  return {
    type: 'balance.snapshot',
    externalId: `${a.id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: a.id,
    at,
    // Owed on the card → negative. Brex's docs only say amounts are "signed"; purchases come positive, so a positive
    // balance is owed. Taken as −|x| so an owed amount sent the other way can't turn into a cash-like balance.
    current: owed(mny(a.current_balance)),
  }
}

const INTERNAL_TRANSFER = new Set(['INTRA_CUSTOMER_ACCOUNT_BOOK_TRANSFER', 'BOOK_TRANSFER'])

export function mapCashTxn(t: BrexCashTransaction, accountId: string, accountCurrency: string, connectionId: string, rawRef: string): TxnUpsert {
  const amount = t.amount ? mny(t.amount) : { minor: 0, currency: accountCurrency }
  const linkRefs: Record<string, string> = {}
  if (t.transfer_id) {
    // Both legs of a transfer between the company's own Brex accounts carry the same Payments API transfer id.
    if (t.type && INTERNAL_TRANSFER.has(t.type)) linkRefs.transfer = t.transfer_id
    else linkRefs.brex_transfer_id = t.transfer_id
  }
  return {
    type: 'txn.upsert',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: accountId,
    date: t.posted_at_date,
    amount,
    status: 'posted',
    ...(t.description ? { rawText: t.description.slice(0, 500) } : {}),
    ...(t.type ? { categoryHint: t.type === 'CARD_COLLECTION' ? 'card_payment' : t.type } : {}),
    ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
  }
}

export function mapCardTxn(t: BrexCardTransaction, accountId: string, connectionId: string, rawRef: string): TxnUpsert {
  const linkRefs: Record<string, string> = {}
  if (t.expense_id) linkRefs.expense_id = t.expense_id
  if (t.card_id) linkRefs.card_id = t.card_id
  const counterparty = t.type === 'PURCHASE' || t.type === 'REFUND' || t.type === 'CHARGEBACK' ? cleanMerchant(t.description) : undefined
  const raw = t.merchant?.raw_descriptor || t.description
  return {
    type: 'txn.upsert',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: accountId,
    date: t.posted_at_date,
    amount: negate(mny(t.amount)),
    // The card endpoint only returns settled transactions.
    status: 'posted',
    ...(counterparty ? { counterparty } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    ...(t.type ? { categoryHint: t.type === 'COLLECTION' ? 'card_payment' : t.merchant?.mcc ? `${t.type}:mcc_${t.merchant.mcc}` : t.type } : {}),
    ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
  }
}

function cleanMerchant(s: string | undefined): string | undefined {
  const c = (s ?? '').replace(/\s+/g, ' ').trim()
  return c ? c.slice(0, 120) : undefined
}
