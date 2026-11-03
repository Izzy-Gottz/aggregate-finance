// OwnerRez API v2 client: https://api.ownerrez.com with an OAuth access token, and a User-Agent naming the app and its client
// id on every call (OwnerRez asks for both).
//
// READ-ONLY BY CONSTRUCTION, twice over. The sign-in asks for the `read` scope, which OwnerRez limits to GET requests, and a
// grant with any other scope is refused at connect. getOnly also wraps the fetch underneath everything, so any method but GET
// throws before a byte leaves. The token and revoke calls hold no rental data and don't go through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { OwnerRezPage } from './types.ts'

const PROVIDER = 'ownerrez'
export const OWNERREZ_API = 'https://api.ownerrez.com'
export const OWNERREZ_AUTHORIZE_URL = 'https://app.ownerrez.com/oauth/authorize'
export const OWNERREZ_TOKEN_URL = `${OWNERREZ_API}/oauth/token`
export const OWNERREZ_REVOKE_URL = `${OWNERREZ_API}/oauth/access_token`
export const OWNERREZ_SCOPE = 'read'
const API_HOST = new URL(OWNERREZ_API).host

/** "Your app name and client id", as OwnerRez's auth guide asks. */
export const userAgent = (clientId: string) => `Aggregate/1.0 (${clientId})`

export const OWNERREZ_REFUSED = 'OwnerRez refused to show this account’s payments, so this sync stopped. No totals were changed. Connect OwnerRez again, or check that the account isn’t locked.'

/** Everything OwnerRez's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The OwnerRez connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote guest or booking text. */
export function classifyOwnerRezError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'OwnerRez no longer accepts this sign-in. Connect OwnerRez again.', { provider: PROVIDER, status, forUser: true })
  // A locked or closed account, a blocked IP, or a scope that doesn't reach this: a retry won't change it, and it must not read as no payments.
  if (status === 403) return new ConnectorError('permanent', OWNERREZ_REFUSED, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `OwnerRez HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const OWNERREZ_NO_TIME_ZONE = 'OwnerRez shows no time zone for this account, so Aggregate can’t tell which month a payment falls in, and this sync stopped. No totals were changed. Set the account’s time zone in OwnerRez, then sync again.'

const knownZone = (z: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

export const unreadable = (what: string) => new ConnectorError('permanent', `OwnerRez sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

/** OwnerRez says to follow next_page_url. Only its query is kept, so the token can't be led to another host or path. */
function nextQuery(next: unknown, path: string): Record<string, string> | null {
  if (next === null || next === undefined || next === '') return null
  let url: URL | undefined
  try {
    url = new URL(String(next), OWNERREZ_API)
  } catch {
    // Reported below.
  }
  if (url?.protocol !== 'https:' || url.host !== API_HOST || url.pathname !== path) throw new ConnectorError('permanent', 'OwnerRez sent a next page Aggregate won’t follow.', { provider: PROVIDER })
  return Object.fromEntries(url.searchParams)
}

export class OwnerRezClient {
  private readonly http: HttpClient

  constructor(accessToken: string, clientId: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: OWNERREZ_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': userAgent(clientId), accept: 'application/json' },
      // 300 requests per 5 minutes per IP address, shared by every connection on this server.
      rateLimit: { perSecond: 0.8, burst: 5 },
      classifyError: ({ status }: { status: number }) => classifyOwnerRezError(status),
    })
  }

  /** One page of a list. */
  async page<T>(path: string, query: Record<string, string | number>): Promise<OwnerRezPage<T>> {
    const res = await this.http.request<unknown>({ path, query })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.items) || !d.items.every(isRecord)) throw unreadable('a list')
    const next = nextQuery(d.next_page_url, path)
    if (next && JSON.stringify(next) === JSON.stringify(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])))) throw unreadable('a list')
    return { items: d.items as unknown as T[], next }
  }

  /** The account's time zone. Its name and email come back too and are read past. */
  async timeZone(): Promise<string> {
    const res = await this.http.request<unknown>({ path: '/v2/users/me' })
    if (!isRecord(res.data)) throw unreadable('an account')
    const zone = res.data.time_zone
    // Months are filed on this clock. Guessing UTC would move payments near a month's edge into the wrong month.
    if (typeof zone !== 'string' || !zone || !knownZone(zone)) throw new ConnectorError('permanent', OWNERREZ_NO_TIME_ZONE, { provider: PROVIDER, forUser: true })
    return zone
  }

  /** Every currency the account's properties use. Payments don't carry one, so this is the only place it's written. */
  async propertyCurrencies(day: string): Promise<{ currencies: string[]; properties: number }> {
    const seen = new Set<string>()
    let properties = 0
    let query: Record<string, string | number> = { from: day, to: day, limit: 100 }
    for (let i = 0; i < 100; i++) {
      const page = await this.page<Record<string, unknown>>('/v2/calendar', query)
      for (const p of page.items) {
        const c = p.currency_code
        if (typeof c !== 'string' || !/^[A-Z]{3}$/.test(c)) throw unreadable('a property with no currency')
        seen.add(c)
        properties++
      }
      if (!page.next) return { currencies: [...seen].sort(), properties }
      query = page.next
    }
    throw unreadable('a property list that doesn’t end')
  }
}
