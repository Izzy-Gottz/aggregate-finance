// Amazon Selling Partner API client: https://sellingpartnerapi-na.amazon.com, the seller's LWA access token in
// x-amz-access-token on every call. No AWS Signature V4: Amazon's "Connect to the SP-API" page shows a call "with a URI and
// headers but no signing information" (read 2026-11-05).
//
// READ-ONLY BY CONSTRUCTION. The app has the Finance and Accounting role only, and getOnly wraps the fetch underneath this
// client, so any method but GET throws before a byte leaves. The one POST, the LWA token call (api.amazon.com/auth/o2/token),
// goes through the SDK's OAuth helper on its own fetch, never through this client, and holds no seller data.
//
// Errors are written here from the status alone: a provider message can quote the request.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { AmazonFinancialEventGroup, AmazonFinancialEvents } from './types.ts'

const PROVIDER = 'amazon'

/**
 * Where a seller is read. US only for now: the North America endpoint and the US store's Seller Central. Canada, Mexico
 * and Brazil share this endpoint but have their own Seller Central hosts and currencies; Europe and the Far East have
 * their own endpoints (developer-docs.amazon.com/sp-api/docs/sp-api-endpoints). A new region is a new entry here.
 */
export const AMAZON_REGION = {
  endpoint: 'https://sellingpartnerapi-na.amazon.com',
  sellerCentral: 'https://sellercentral.amazon.com',
  marketplaceId: 'ATVPDKIKX0DER',
} as const

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token'
/** Amazon requires a user-agent with the app's name, version and language on every SP-API call. */
export const USER_AGENT = 'Aggregate/1.0 (Language=TypeScript; Platform=Node)'
/** listFinancialEventGroups and listFinancialEventsByGroupId both cap a page at 100. */
export const PAGE_SIZE = 100

export const AMAZON_TOKEN_REJECTED = 'Amazon no longer accepts Aggregate’s access to this seller account, so this sync stopped. No totals were changed. Connect Amazon again.'
export const AMAZON_REFUSED = 'Amazon refused to show this seller account’s settlements, so this sync stopped. No totals were changed. In Seller Central, open Apps and Services → Manage Your Apps and check Aggregate is still authorized, then connect Amazon again. If it is, Amazon may not have granted Aggregate the Finance and Accounting role.'

/** Everything the SP-API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Amazon connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/**
 * Written from the status alone. A 403 is `auth`, not `permanent`: Amazon's error guide gives an expired or revoked
 * authorization and a missing role as its causes, and each is fixed by connecting again. A 429 waits one request's worth
 * of the operation's rate (x-amzn-RateLimit-Limit is requests per second, when Amazon sends it; 0.5 per the model).
 */
export function classifyAmazonError(status: number, headers?: Headers): ConnectorError {
  if (status === 401) return new ConnectorError('auth', AMAZON_TOKEN_REJECTED, { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', AMAZON_REFUSED, { provider: PROVIDER, status, forUser: true })
  const rate = Number(headers?.get('x-amzn-ratelimit-limit'))
  const wait = Number.isFinite(rate) && rate > 0 ? Math.ceil(1000 / rate) : 2000
  return new ConnectorError(kindForStatus(status), `Amazon HTTP ${status}`, { provider: PROVIDER, status, ...(status === 429 ? { retryAfterMs: wait } : {}) })
}

/** A 200 that isn't what the model says. Treating it as empty would report a settlement of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Amazon sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

const token = (v: unknown): string | null => {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string') throw unreadable('a page token')
  return v
}

export class AmazonClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    const clock = deps.clock
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: AMAZON_REGION.endpoint,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(clock ? { clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: () => ({
        'x-amz-access-token': accessToken,
        'x-amz-date': new Date(clock ? clock.now() : Date.now()).toISOString().replace(/[-:]|\.\d{3}/g, ''),
        'user-agent': USER_AGENT,
      }),
      // Both operations: 0.5 requests a second, burst 30, shared with every other app the seller uses. Stay at the rate.
      rateLimit: { perSecond: 0.5, burst: 5 },
      timeoutMs: 30_000,
      requestIdHeader: 'x-amzn-requestid',
      classifyError: ({ status, headers }) => classifyAmazonError(status, headers),
    })
  }

  /** One page of settlements that opened at or after `startedAfter` (ISO). */
  async groups(startedAfter: string, nextToken: string | null): Promise<{ groups: AmazonFinancialEventGroup[]; nextToken: string | null }> {
    // A NextToken carries its own arguments; the docs say to send the same ones again with it.
    const res = await this.http.request<unknown>({ path: '/finances/v0/financialEventGroups', query: { MaxResultsPerPage: PAGE_SIZE, FinancialEventGroupStartedAfter: startedAfter, ...(nextToken ? { NextToken: nextToken } : {}) } })
    const p = isRecord(res.data) ? res.data.payload : undefined
    if (!isRecord(p)) throw unreadable('a settlement list')
    const list = p.FinancialEventGroupList ?? []
    if (!Array.isArray(list) || !list.every(isRecord)) throw unreadable('a settlement list')
    const next = token(p.NextToken)
    if (next !== null && next === nextToken) throw unreadable('a page it had already sent')
    return { groups: list as unknown as AmazonFinancialEventGroup[], nextToken: next }
  }

  /** One page of a settlement's financial events. */
  async events(groupId: string, nextToken: string | null): Promise<{ events: AmazonFinancialEvents; nextToken: string | null }> {
    const res = await this.http.request<unknown>({ path: `/finances/v0/financialEventGroups/${encodeURIComponent(groupId)}/financialEvents`, query: { MaxResultsPerPage: PAGE_SIZE, ...(nextToken ? { NextToken: nextToken } : {}) } })
    const p = isRecord(res.data) ? res.data.payload : undefined
    if (!isRecord(p)) throw unreadable('a settlement’s events')
    const events = p.FinancialEvents ?? {}
    if (!isRecord(events)) throw unreadable('a settlement’s events')
    const next = token(p.NextToken)
    if (next !== null && next === nextToken) throw unreadable('a page it had already sent')
    return { events, nextToken: next }
  }
}
