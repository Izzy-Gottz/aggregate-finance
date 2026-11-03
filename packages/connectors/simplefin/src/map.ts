// SimpleFIN → NormalizedEvent mapping. Amounts are decimal strings, positive = money in. SimpleFIN doesn't say what
// kind an account is, so the type is guessed from its name; liabilities are emitted as negative balances (owed).

import type { AccountType, AccountUpsert, BalanceSnapshot, TxnUpsert } from '@agfn/contracts'
import { money, textCategoryHint } from '@agfn/connector-sdk'
import type { SfAccount, SfError, SfTransaction } from './types.ts'

export const dayOf = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10)

export function guessType(name: string): AccountType {
  if (/credit|card|visa|mastercard|amex|american express|discover/i.test(name)) return 'credit_card'
  if (/loan|mortgage|heloc|line of credit/i.test(name)) return 'loan'
  if (/invest|brokerage|401\(?k|\bira\b|roth|retirement|hsa/i.test(name)) return 'investment'
  return 'depository'
}

const isLiability = (t: AccountType) => t === 'credit_card' || t === 'loan'

/** Account ids are only unique per connection at the Bridge; prefix with conn_id when present. */
export const accountKey = (a: SfAccount): string => (a.conn_id ? `${a.conn_id}:${a.id}` : a.id)

export function mapAccount(a: SfAccount, institution: string | undefined, connectionId: string, rawRef: string): AccountUpsert {
  const accountType = guessType(a.name)
  const mask = (a.name.match(/(\d{4})\D*$/)?.[1] ?? '')
  return {
    type: 'account.upsert',
    externalId: accountKey(a),
    connectionId,
    rawRef,
    name: (a.name || 'SimpleFIN account').slice(0, 120),
    accountType,
    currency: currencyOf(a),
    ...(mask ? { mask } : {}),
    ...(institution ? { institution: institution.slice(0, 120) } : {}),
    businessHint: 'unknown',
    ...(accountType === 'credit_card' ? { liability: { kind: 'credit' as const } } : {}),
  }
}

/** SimpleFIN uses ISO 4217 codes, or a URL for custom currencies (points, crypto): those aren't money here. */
export function currencyOf(a: SfAccount): string {
  return /^[A-Z]{3}$/.test(a.currency) ? a.currency : 'XXX'
}

export function mapBalance(a: SfAccount, connectionId: string, rawRef: string): BalanceSnapshot {
  const cur = currencyOf(a)
  const t = guessType(a.name)
  let current = money(a.balance, cur)
  if (isLiability(t)) current = { minor: -Math.abs(current.minor), currency: cur }
  const at = new Date(a['balance-date'] * 1000).toISOString()
  const avail = a['available-balance']
  return {
    type: 'balance.snapshot',
    externalId: `${accountKey(a)}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: accountKey(a),
    at,
    current,
    ...(avail !== undefined && avail !== '' && !isLiability(t) ? { available: money(avail, cur) } : {}),
  }
}

export function mapTxn(t: SfTransaction, a: SfAccount, connectionId: string, rawRef: string): TxnUpsert {
  const when = t.posted || t.transacted_at || 0
  const clean = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '')
  const text = clean(t.description)
  // Protocol v2 adds payee (the cleaned-up name) and memo (the bank's raw line); either may be missing.
  const payee = clean(t.payee)
  const memo = clean(t.memo)
  const raw = [text, memo].filter((x, i, all) => x && all.indexOf(x) === i).join(' · ')
  const name = payee || text
  const hint = textCategoryHint(raw, Number(t.amount) > 0)
  return {
    type: 'txn.upsert',
    externalId: `${accountKey(a)}:${t.id}`,
    connectionId,
    rawRef,
    accountExternalId: accountKey(a),
    date: dayOf(when),
    amount: money(t.amount, currencyOf(a)),
    status: t.pending ? 'pending' : 'posted',
    ...(name ? { counterparty: sanitize(name).slice(0, 120) } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    ...(hint ? { categoryHint: hint } : {}),
  }
}

/** errlist messages come from banks via the Bridge: strip control characters and markup, cap the length. */
export function sanitize(msg: string): string {
  return msg.slice(0, 4000).replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300)
}

export function errorWarnings(errlist: SfError[] | undefined, errors: string[] | undefined): string[] {
  const out = new Set<string>()
  for (const e of errlist ?? []) {
    const m = sanitize(e.msg || e.code)
    if (m) out.add(`SimpleFIN: ${m}`)
  }
  // v1-style strings: the Bridge also uses them for request-quota warnings. Its date-range advice is for us, not the person.
  for (const e of errors ?? []) {
    if (/date range/i.test(e)) continue
    const m = sanitize(e)
    if (m) out.add(`SimpleFIN: ${m}`)
  }
  return [...out]
}

/** A connection the bank stopped letting through (con.auth): the person fixes it at the Bridge, not here. */
export const needsBridgeFix = (errlist: SfError[] | undefined): boolean => (errlist ?? []).some((e) => e.code === 'con.auth' || e.code.startsWith('con.auth'))
