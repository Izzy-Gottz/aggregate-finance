// Wise → NormalizedEvent mapping. One depository account per currency balance; statement rows are already signed.
// Conversions between the profile's own balances appear on both balances' statements with the same referenceNumber:
// both legs get linkRefs.transfer = referenceNumber and an externalId suffixed with the currency (unique per leg).

import type { AccountUpsert, BalanceSnapshot, TxnUpsert } from '@agfn/contracts'
import { instantAt, isoDate, money, normalizeCurrency } from '@agfn/connector-sdk'
import type { WiseBalance, WiseProfile, WiseStatementTxn } from './types.ts'

export const balanceAccountId = (profileId: number | string, currency: string) => `${profileId}:${normalizeCurrency(currency)}`

export function profileName(p: WiseProfile): string {
  return (p.businessName || p.details?.name || p.fullName || [p.details?.firstName, p.details?.lastName].filter(Boolean).join(' ') || 'Wise').slice(0, 80)
}

export const isBusiness = (p: WiseProfile) => p.type.toUpperCase() === 'BUSINESS'

export function mapBalanceAccount(b: WiseBalance, profile: { id: number | string; name: string; business: boolean }, connectionId: string, rawRef: string): AccountUpsert {
  const currency = normalizeCurrency(b.currency)
  return {
    type: 'account.upsert',
    externalId: balanceAccountId(profile.id, currency),
    connectionId,
    rawRef,
    name: (b.name ? `${b.name} (${currency})` : `Wise ${currency}`).slice(0, 120),
    accountType: 'depository',
    currency,
    institution: 'Wise',
    businessHint: profile.business ? 'business' : 'personal',
  }
}

export function mapBalanceSnapshot(b: WiseBalance, profileId: number | string, connectionId: string, rawRef: string, at: string): BalanceSnapshot {
  const id = balanceAccountId(profileId, b.currency)
  const cur = normalizeCurrency(b.currency)
  return {
    type: 'balance.snapshot',
    externalId: `${id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: id,
    at,
    // totalWorth includes reserved funds; amount is what can be spent.
    current: money((b.totalWorth ?? b.amount).value, cur),
    available: money(b.amount.value, cur),
  }
}

const CROSS_BALANCE = new Set(['CONVERSION', 'INCOMING_CROSS_BALANCE', 'OUTGOING_CROSS_BALANCE'])

export function isCrossBalance(t: WiseStatementTxn): boolean {
  return CROSS_BALANCE.has(t.details.type)
}

export function statementTxnId(t: WiseStatementTxn): string {
  return isCrossBalance(t) ? `${t.referenceNumber}:${normalizeCurrency(t.amount.currency)}` : t.referenceNumber
}

export function mapStatementTxn(t: WiseStatementTxn, accountId: string, connectionId: string, rawRef: string): TxnUpsert {
  const d = t.details
  const counterparty = (d.merchant?.name || d.senderName || '').trim()
  const raw = [d.description, d.paymentReference].filter((x): x is string => !!x && x.trim() !== '').join(' | ')
  const linkRefs: Record<string, string> = isCrossBalance(t) ? { transfer: t.referenceNumber } : { wise_reference: t.referenceNumber }
  return {
    type: 'txn.upsert',
    externalId: statementTxnId(t),
    connectionId,
    rawRef,
    accountExternalId: accountId,
    date: isoDate(t.date),
    ...(instantAt(t.date) ? { at: instantAt(t.date) } : {}),
    amount: money(t.amount.value, normalizeCurrency(t.amount.currency)),
    // Statements list completed movements only.
    status: 'posted',
    ...(counterparty ? { counterparty: counterparty.slice(0, 120) } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    categoryHint: d.merchant?.category ? `${d.type}:${d.merchant.category}` : d.type,
    linkRefs,
  }
}
