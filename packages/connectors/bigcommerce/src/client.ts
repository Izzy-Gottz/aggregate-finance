// BigCommerce REST client: https://api.bigcommerce.com/stores/{store_hash}, the store-level API account's access token in
// X-Auth-Token on every call.
//
// READ-ONLY BY CONSTRUCTION. The connect steps ask for an API account with read-only scopes only, but BigCommerce doesn't
// report a token's scopes over the API, so that can't be checked here (README, Unverified). getOnly wraps the fetch
// underneath everything instead: any method but GET throws before a byte leaves.
//
// Errors are written here from the status alone: a provider message can quote order or customer text.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'bigcommerce'
export const BIGCOMMERCE_API = 'https://api.bigcommerce.com'
/** Page size asked for. The stop is an empty page, so a store that sends fewer per page still reads to the end. */
export const PER_PAGE = 250

export const BIGCOMMERCE_TOKEN_REJECTED = 'BigCommerce no longer accepts this access token, so this sync stopped. No totals were changed. Make a new store-level API account in BigCommerce and connect it again.'
export const BIGCOMMERCE_REFUSED = 'BigCommerce refused to show this store’s orders, refunds or settings, so this sync stopped. No totals were changed. In BigCommerce, check the API account has Orders and Information & Settings set to read-only.'
export const BIGCOMMERCE_NO_TIME_ZONE = 'BigCommerce shows no time zone for this store, so Aggregate can’t tell which month an order falls in, and this sync stopped. No totals were changed. Set the store’s time zone in BigCommerce, then sync again.'

/** Everything BigCommerce's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The BigCommerce connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone. BigCommerce's rate limit says how long to wait in X-Rate-Limit-Time-Reset-Ms. */
export function classifyBigCommerceError(status: number, headers?: Headers): ConnectorError {
  if (status === 401) return new ConnectorError('auth', BIGCOMMERCE_TOKEN_REJECTED, { provider: PROVIDER, status, forUser: true })
  // A scope the API account wasn't given: a retry won't change it, and it must not read as no orders.
  if (status === 403) return new ConnectorError('permanent', BIGCOMMERCE_REFUSED, { provider: PROVIDER, status, forUser: true })
  const reset = Number(headers?.get('x-rate-limit-time-reset-ms'))
  return new ConnectorError(kindForStatus(status), `BigCommerce HTTP ${status}`, { provider: PROVIDER, status, ...(status === 429 && Number.isFinite(reset) && reset > 0 ? { retryAfterMs: reset } : {}) })
}

export const unreadable = (what: string) => new ConnectorError('permanent', `BigCommerce sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

const knownZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

export interface StoreInfo {
  zone: string
  /** The store's default currency. */
  currency: string
}

type Query = Record<string, string | number>

export class BigCommerceClient {
  private readonly http: HttpClient

  constructor(storeHash: string, accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: `${BIGCOMMERCE_API}/stores/${encodeURIComponent(storeHash)}`,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { 'x-auth-token': accessToken, accept: 'application/json', 'user-agent': 'Aggregate' },
      // Every app on a store shares its quota (150 requests per 30 seconds on Growth and Core), so stay well under it.
      rateLimit: { perSecond: 2, burst: 4 },
      timeoutMs: 20_000,
      classifyError: ({ status, headers }) => classifyBigCommerceError(status, headers),
    })
  }

  /** The store's time zone and default currency. Its name, owner and emails come back too and are read past. */
  async store(): Promise<StoreInfo> {
    const res = await this.http.request<unknown>({ path: '/v2/store' })
    if (!isRecord(res.data)) throw unreadable('store settings')
    const zone = isRecord(res.data.timezone) ? res.data.timezone.name : undefined
    // Months are filed on this clock. Guessing UTC would move orders near a month's edge into the wrong month.
    if (typeof zone !== 'string' || !zone || !knownZone(zone)) throw new ConnectorError('permanent', BIGCOMMERCE_NO_TIME_ZONE, { provider: PROVIDER, forUser: true })
    const currency = res.data.currency
    if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw unreadable('a store currency')
    return { zone, currency }
  }

  /** Every currency code the store has set up, enabled or not. */
  async currencies(): Promise<string[]> {
    const seen = new Set<string>()
    for (let page = 1; page <= 50; page++) {
      const rows = await this.v2List('/v2/currencies', { page, limit: PER_PAGE })
      if (!rows.length) return [...seen].sort()
      for (const c of rows) {
        if (typeof c.currency_code !== 'string' || !/^[A-Z]{3}$/.test(c.currency_code)) throw unreadable('a currency')
        seen.add(c.currency_code)
      }
    }
    throw unreadable('a currency list that doesn’t end')
  }

  /** A V2 list. V2 may answer an empty page with 204 and no body; a 200 that isn't a list is never read as empty. */
  async v2List(path: string, query: Query): Promise<Array<Record<string, unknown>>> {
    const res = await this.http.request<unknown>({ path, query })
    if (res.status === 204) return []
    if (!Array.isArray(res.data) || !res.data.every(isRecord)) throw unreadable('a list')
    return res.data
  }

  /** A V3 list: rows under `data`. */
  async v3List(path: string, query: Query): Promise<Array<Record<string, unknown>>> {
    const res = await this.http.request<unknown>({ path, query })
    if (res.status === 204) return []
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.data) || !d.data.every(isRecord)) throw unreadable('a list')
    return d.data
  }

  /** One order, or null when BigCommerce no longer has it. */
  async order(id: number): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.http.request<unknown>({ path: `/v2/orders/${id}` })
      if (!isRecord(res.data)) throw unreadable('an order')
      return res.data
    } catch (e) {
      if (e instanceof ConnectorError && e.status === 404) return null
      throw e
    }
  }
}
