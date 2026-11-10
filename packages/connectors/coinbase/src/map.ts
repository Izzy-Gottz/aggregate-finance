// Coinbase wallets and transactions → normalized events.
//
// A cash wallet (USD, EUR, GBP...) is money: an account in its own currency with every completed row, so its balance
// checks against Coinbase's to the cent. Not counted as cash by default (a crypto account), like the core rule.
// A crypto wallet (BTC, ETH, USDC...) isn't money in any currency the ledger knows: its account is 'XXX' (kept and
// shown, never posted or converted), and its snapshot carries the exact quantity as a holding, valued in dollars at
// Coinbase's own rate. Crypto-side rows aren't sent: in 'XXX' they'd round to two decimals and mean nothing.
// Buying or selling crypto from a cash wallet moves money into or out of crypto the company or person still owns:
// CRYPTO_TRADE, which posts to Other assets rather than spending or income. A buy paid with a card, bank or Apple Pay
// shows on the cash wallet as two rows of type buy (checked live 2026-10-14): the payment coming in, then the same amount
// going to crypto. Only the leg that goes to crypto is the trade; the payment in is money from the person's bank or card,
// left unhinted so it pairs with that row as a transfer. A sell paid out the same way mirrors it.

import type { AccountUpsert, BalanceSnapshot, TxnUpsert } from '@agfn/contracts'
import { ConnectorError, instantAt, isoDate, money, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import { PROVIDER } from './client.ts'
import type { CoinbaseAccount, CoinbaseTransaction } from './types.ts'

export const NOT_MONEY = 'XXX'

/** A cash wallet: Coinbase's fiat type, in an ISO currency. */
export function isCashWallet(a: CoinbaseAccount): boolean {
  return (a.type === 'fiat' || a.currency.type === 'fiat') && /^[A-Z]{3}$/.test(a.currency.code.toUpperCase())
}

export function isZero(amount: string): boolean {
  return !/[1-9]/.test(amount)
}

export function walletName(a: CoinbaseAccount): string {
  const code = a.currency.code.toUpperCase()
  const vault = a.type === 'vault' ? ' vault' : ''
  return `Coinbase ${code}${vault}`.slice(0, 120)
}

export function mapAccount(a: CoinbaseAccount, connectionId: string, rawRef: string): AccountUpsert {
  return {
    type: 'account.upsert',
    externalId: a.id,
    connectionId,
    rawRef,
    name: walletName(a),
    accountType: 'crypto',
    currency: isCashWallet(a) ? normalizeCurrency(a.currency.code) : NOT_MONEY,
    institution: 'Coinbase',
    businessHint: 'unknown',
  }
}

/**
 * Dollar value of a quantity at Coinbase's rate (units of the asset per 1 USD), to the cent. Undefined without a rate.
 * Float math is fine here: it's a display value, rounded to cents, never posted.
 */
export function usdValue(quantity: string, rate: string | undefined): number | undefined {
  const q = Number(quantity)
  const r = Number(rate)
  if (!rate || !Number.isFinite(q) || !Number.isFinite(r) || r <= 0) return undefined
  return Math.round((q / r) * 100)
}

export function mapBalance(a: CoinbaseAccount, connectionId: string, rawRef: string, at: string, rates: Record<string, string>): BalanceSnapshot {
  const base = { type: 'balance.snapshot' as const, externalId: `${a.id}@${at.slice(0, 10)}`, connectionId, rawRef, accountExternalId: a.id, at }
  if (isCashWallet(a)) return { ...base, current: money(a.balance.amount, normalizeCurrency(a.currency.code)) }
  const code = a.currency.code.toUpperCase()
  const value = usdValue(a.balance.amount, rates[code])
  return {
    ...base,
    current: { minor: toMinor(a.balance.amount, NOT_MONEY), currency: NOT_MONEY },
    holdings: [
      {
        securityExternalId: `${PROVIDER}:${code}`,
        ticker: code,
        ...(a.currency.name ? { name: a.currency.name.slice(0, 120) } : {}),
        quantity: a.balance.amount,
        // The asset itself when Coinbase has no dollar rate for it (delisted, or a rate outage): quantity only.
        value: value === undefined ? { minor: 0, currency: NOT_MONEY } : { minor: value, currency: 'USD' },
      },
    ],
  }
}

/** Rows on a cash wallet that are a trade with crypto in the same Coinbase account (open list, so a prefix match too). */
const TRADE_TYPES = new Set(['buy', 'sell', 'trade', 'advanced_trade_fill', 'retail_simple_dust', 'wrap_asset', 'unwrap_asset'])
const INCOME_TYPES = new Set(['interest', 'earn_payout', 'staking_reward', 'inflation_reward', 'incentives_rewards_payout', 'subscription_rebate'])

/** The payment leg of a buy paid in (money in) or a sell paid out (money out), not the trade itself. */
export function isPaymentLeg(t: CoinbaseTransaction, inflow: boolean): boolean {
  return (t.type === 'buy' && inflow) || (t.type === 'sell' && !inflow)
}

export function txnHint(t: CoinbaseTransaction, inflow: boolean): string | undefined {
  if (isPaymentLeg(t, inflow)) return undefined
  if (TRADE_TYPES.has(t.type) || t.type.startsWith('fcm_futures')) return 'CRYPTO_TRADE'
  if (inflow && INCOME_TYPES.has(t.type)) return 'INCOME_INTEREST_EARNED'
  if (!inflow && t.type === 'subscription') return 'SUBSCRIPTION'
  return undefined
}

const LABELS: Record<string, string> = {
  buy: 'Bought crypto',
  sell: 'Sold crypto',
  trade: 'Converted crypto',
  advanced_trade_fill: 'Advanced Trade fill',
  fiat_deposit: 'Deposit to Coinbase',
  fiat_withdrawal: 'Withdrawal from Coinbase',
  send: 'Sent',
  receive: 'Received',
  interest: 'Interest',
  earn_payout: 'Rewards',
  subscription: 'Coinbase One',
}

export function txnStatus(status: string): TxnUpsert['status'] | undefined {
  if (status === 'completed') return 'posted'
  if (status === 'pending' || status.startsWith('waiting_for')) return 'pending'
  if (status === 'canceled' || status === 'failed' || status === 'expired') return 'void'
  return undefined
}

/** A cash-wallet row. Undefined for a status this mapping doesn't know (never guessed into the books). */
export function mapTxn(t: CoinbaseTransaction, walletId: string, walletCurrency: string, connectionId: string, rawRef: string): TxnUpsert | undefined {
  const status = txnStatus(t.status)
  if (!status) return undefined
  const cur = normalizeCurrency(walletCurrency)
  if (normalizeCurrency(t.amount.currency, '') !== cur) {
    throw new ConnectorError('permanent', `Coinbase row ${t.id} is in ${t.amount.currency}, not its wallet's ${cur}`, { provider: PROVIDER })
  }
  const amount = money(t.amount.amount, cur)
  const inflow = amount.minor > 0
  const hint = txnHint(t, inflow)
  const via = (t.buy ?? t.sell)?.payment_method_name?.trim()
  const label = isPaymentLeg(t, inflow) ? (t.type === 'buy' ? 'Paid in for a crypto buy' : 'Paid out from a crypto sale') : LABELS[t.type]
  const text = (t.description?.trim() || [label ?? t.type.replace(/_/g, ' '), via].filter(Boolean).join(' · ')).slice(0, 500)
  return {
    type: 'txn.upsert',
    externalId: t.id,
    connectionId,
    rawRef,
    accountExternalId: walletId,
    date: isoDate(t.created_at),
    ...(instantAt(t.created_at) ? { at: instantAt(t.created_at) } : {}),
    amount,
    status,
    counterparty: 'Coinbase',
    rawText: text,
    ...(hint ? { categoryHint: hint } : {}),
  }
}
