// Coinbase App API v2 shapes (docs.cdp.coinbase.com/coinbase-app/track-apis, read 2026-10-14). Only the fields used.

export interface CoinbaseAmount {
  amount: string
  currency: string
}

export interface CoinbaseCurrency {
  code: string
  name?: string
  /** 'crypto' | 'fiat' (open list). */
  type?: string
  exponent?: number
}

export interface CoinbaseAccount {
  id: string
  name?: string
  primary?: boolean
  /** 'wallet' | 'fiat' | 'vault' (open list). */
  type: string
  currency: CoinbaseCurrency
  balance: CoinbaseAmount
  created_at?: string
  updated_at?: string
}

export interface CoinbasePagination {
  next_uri?: string | null
  next_starting_after?: string | null
}

export interface CoinbaseList<T> {
  pagination?: CoinbasePagination
  data: T[]
}

export interface CoinbaseTransaction {
  id: string
  /** buy, sell, send, fiat_deposit, fiat_withdrawal, advanced_trade_fill, earn_payout, ... (open list). */
  type: string
  /** completed, pending, waiting_for_clearing, waiting_for_signature, canceled, failed, expired. */
  status: string
  /** Signed in the wallet's currency: + credits the wallet, − debits it. */
  amount: CoinbaseAmount
  native_amount?: CoinbaseAmount
  description?: string | null
  created_at: string
  /** On buy/sell rows: how it was paid (or paid out), e.g. "Apple Pay", a bank or a card. */
  buy?: CoinbaseTradeDetail
  sell?: CoinbaseTradeDetail
}

export interface CoinbaseTradeDetail {
  payment_method_name?: string
  fee?: CoinbaseAmount
  subtotal?: CoinbaseAmount
  total?: CoinbaseAmount
}

export interface CoinbaseExchangeRates {
  data: { currency: string; rates: Record<string, string> }
}

/** GET /api/v3/brokerage/key_permissions (CDP API keys only). */
export interface CoinbaseKeyPermissions {
  can_view?: boolean
  can_trade?: boolean
  can_transfer?: boolean
  portfolio_uuid?: string
  portfolio_type?: string
}
