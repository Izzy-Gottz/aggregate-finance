// Mercury → NormalizedEvent mapping. Mercury amounts are already signed + in / − out, in USD dollars.

import type { AccountType, AccountUpsert, BalanceSnapshot, TxnUpsert } from '@agfn/contracts'
import { isoDate, money } from '@agfn/connector-sdk'
import type { MercuryAccount, MercuryCreditAccount, MercuryTransaction, MercuryTreasuryAccount } from './types.ts'

/** Mercury accounts are USD. */
export const CURRENCY = 'USD'

export function depositoryType(a: MercuryAccount): AccountType {
  return /treasury|invest/i.test(a.kind) ? 'investment' : 'depository'
}

export function mapAccount(a: MercuryAccount, connectionId: string, rawRef: string): AccountUpsert {
  const mask = (a.accountNumber ?? '').replace(/\D/g, '').slice(-4)
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    // Mercury's names end in its own "••1234"; the app adds the last four itself, so drop it here.
    name: ((a.nickname || a.name || '').replace(/\s*[•·*]{2}\s*\d{4}\s*$/, '').trim() || `Mercury ${a.kind}`).slice(0, 120),
    accountType: depositoryType(a),
    currency: CURRENCY,
    ...(mask ? { mask } : {}),
    institution: 'Mercury',
    businessHint: 'business',
  }
}

export function mapCreditAccount(a: MercuryCreditAccount, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    name: 'Mercury Credit Card',
    accountType: 'credit_card',
    currency: CURRENCY,
    institution: 'Mercury',
    businessHint: 'business',
    liability: { kind: 'credit' },
  }
}

export function mapTreasuryAccount(a: MercuryTreasuryAccount, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    name: 'Mercury Treasury',
    accountType: 'investment',
    currency: CURRENCY,
    institution: 'Mercury',
    businessHint: 'business',
  }
}

export function mapBalance(
  a: { id: string; currentBalance: number; availableBalance: number },
  connectionId: string,
  rawRef: string,
  at: string,
  kind: 'depository' | 'credit' | 'treasury',
): BalanceSnapshot {
  let current = money(a.currentBalance, CURRENCY)
  // Credit: the amount owed. Mercury reports credit balances inconsistently signed across endpoints, so the owed
  // amount is always emitted negative (an overpaid card would show as owed; rare, flagged in the report).
  if (kind === 'credit') current = { minor: -Math.abs(current.minor), currency: CURRENCY }
  return {
    type: 'balance.snapshot',
    externalId: `${a.id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: a.id,
    at,
    current,
    ...(kind === 'credit' ? {} : { available: money(a.availableBalance, CURRENCY) }),
  }
}

export function mapStatus(s: string): TxnUpsert['status'] {
  if (s === 'pending') return 'pending'
  if (s === 'sent') return 'posted'
  // cancelled, failed, reversed, blocked: the money did not (or no longer) move.
  return 'void'
}

export function mapTxn(t: MercuryTransaction, accountId: string, connectionId: string, rawRef: string): TxnUpsert {
  const counterparty = (t.counterpartyNickname || t.counterpartyName || '').trim()
  const raw = [t.bankDescription, t.note, t.externalMemo].filter((x): x is string => !!x && x.trim() !== '').join(' | ')
  const linkRefs: Record<string, string> = {}
  if (t.cardId) linkRefs.card_id = t.cardId
  if (t.checkNumber) linkRefs.check_number = t.checkNumber
  // Mercury exposes no shared id for the two legs of an internal transfer, so no linkRefs.transfer. The other
  // leg's account is the counterparty; kept as a hint for rule-based matching.
  if (t.kind === 'internalTransfer' && t.counterpartyId) linkRefs.counterparty_account = t.counterpartyId
  return {
    type: 'txn.upsert',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: accountId,
    date: isoDate(t.postedAt || t.createdAt),
    amount: money(t.amount, CURRENCY),
    status: mapStatus(t.status),
    ...(counterparty ? { counterparty: counterparty.slice(0, 120) } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    ...(t.kind ? { categoryHint: t.kind } : {}),
    ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
  }
}
