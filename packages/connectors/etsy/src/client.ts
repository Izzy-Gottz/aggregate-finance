// Etsy Open API v3 client: https://openapi.etsy.com/v3/application, the seller's access token as a Bearer token and the
// app's `x-api-key` on every call. Etsy's docs and spec give the key as `keystring:shared_secret` ("Every request to a v3
// API endpoint must include this data in the format keystring:shared_secret", read 2026-11-05).
//
// READ-ONLY BY CONSTRUCTION. Sign-in asks for `transactions_r shops_r` only, and getOnly wraps the fetch underneath this
// client, so any method but GET throws before a byte leaves. The one POST, the OAuth token call
// (api.etsy.com/v3/public/oauth/token), goes through the SDK's OAuth helper on its own fetch, never through this client,
// and holds no shop data.
//
// Errors are written here from the status alone: a provider message can quote the request.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { EtsyLedgerEntry, EtsySelf, EtsyShop } from './types.ts'

const PROVIDER = 'etsy'

export const ETSY_API = 'https://openapi.etsy.com'
export const ETSY_AUTHORIZE_URL = 'https://www.etsy.com/oauth/connect'
/** The docs' token URL. The spec's securitySchemes names openapi.etsy.com/v3/public/oauth/token (README, Unverified). */
export const ETSY_TOKEN_URL = 'https://api.etsy.com/v3/public/oauth/token'
/** Exactly these, space-separated. Never email_r, address_r or anything that writes. */
export const ETSY_SCOPES = ['transactions_r', 'shops_r'] as const
/** getShopPaymentAccountLedgerEntries caps `limit` at 100 (spec). */
export const PAGE_SIZE = 100
/** Etsy gives each app 5 requests a second (and 5,000 a day, shared by every seller). Stay under it. */
export const REQUESTS_PER_SECOND = 4

export const ETSY_TOKEN_REJECTED = 'Etsy no longer accepts Aggregate’s access to this shop, so this sync stopped. No totals were changed. Connect Etsy again.'
export const ETSY_REFUSED = 'Etsy refused to show this shop’s payment account, so this sync stopped. No totals were changed. In Etsy, check Aggregate is still allowed under your account’s apps, then connect Etsy again.'

/** Everything the Open API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Etsy connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone. 401 and 403 both mean connecting again (an expired or removed grant, a missing scope). */
export function classifyEtsyError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', ETSY_TOKEN_REJECTED, { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', ETSY_REFUSED, { provider: PROVIDER, status, forUser: true })
  // 429: the HTTP client takes Etsy's retry-after (seconds) over this guess.
  return new ConnectorError(kindForStatus(status), `Etsy HTTP ${status}`, { provider: PROVIDER, status, ...(status === 429 ? { retryAfterMs: 1000 } : {}) })
}

/** A 200 that isn't what the spec says. Treating it as empty would report a shop with no money. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Etsy sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

const positiveId = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw unreadable(what)
  return v
}

export interface LedgerPage {
  entries: EtsyLedgerEntry[]
  /** Entries in the whole window, as Etsy counts them. */
  count: number
}

export class EtsyClient {
  private readonly http: HttpClient

  /** `apiKey` is `keystring:shared_secret`. */
  constructor(accessToken: string, apiKey: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: ETSY_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, 'x-api-key': apiKey },
      rateLimit: { perSecond: REQUESTS_PER_SECOND, burst: REQUESTS_PER_SECOND },
      timeoutMs: 30_000,
      classifyError: ({ status }) => classifyEtsyError(status),
    })
  }

  /** The signed-in seller: user id and shop id. */
  async me(): Promise<{ userId: number; shopId: number | null }> {
    const res = await this.http.request<EtsySelf>({ path: '/v3/application/users/me' })
    if (!isRecord(res.data)) throw unreadable('an account')
    const userId = positiveId(res.data.user_id, 'an account')
    const shopId = res.data.shop_id === undefined || res.data.shop_id === null ? null : positiveId(res.data.shop_id, 'a shop')
    return { userId, shopId }
  }

  /** The shop's name and currency. Nothing else from the shop is read. */
  async shop(shopId: number): Promise<{ name: string | null; currency: string }> {
    const res = await this.http.request<EtsyShop>({ path: `/v3/application/shops/${shopId}` })
    if (!isRecord(res.data)) throw unreadable('a shop')
    const currency = res.data.currency_code
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw unreadable('a shop currency')
    const name = typeof res.data.shop_name === 'string' && res.data.shop_name.trim() ? res.data.shop_name.trim().slice(0, 80) : null
    return { name, currency }
  }

  /** One page of payment account ledger entries created in [from, to] (epoch seconds). */
  async ledger(shopId: number, from: number, to: number, offset: number): Promise<LedgerPage> {
    const res = await this.http.request<unknown>({
      path: `/v3/application/shops/${shopId}/payment-account/ledger-entries`,
      query: { min_created: from, max_created: to, limit: PAGE_SIZE, offset },
    })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.results) || !d.results.every(isRecord)) throw unreadable('a ledger page')
    if (typeof d.count !== 'number' || !Number.isSafeInteger(d.count) || d.count < 0) throw unreadable('a ledger page')
    return { entries: d.results as unknown as EtsyLedgerEntry[], count: d.count }
  }
}
