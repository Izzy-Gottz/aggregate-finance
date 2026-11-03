// SumUp REST client: https://api.sumup.com with a Bearer token, either a sign-in's access token or a self-hoster's API key.
//
// READ-ONLY BY CONSTRUCTION. Sign-in asks for read scopes only, but an API key has the merchant's full permissions and
// SumUp offers no read-only key, so getOnly wraps the fetch underneath everything and any method but GET throws before a
// byte leaves. The token call is the one POST, and it holds no merchant data; it goes through the SDK's OAuthClient and
// never through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { SumUpMerchant, SumUpPayout, SumUpTransaction } from './types.ts'

const PROVIDER = 'sumup'
export const SUMUP_API = 'https://api.sumup.com'
export const SUMUP_AUTHORIZE_URL = `${SUMUP_API}/authorize`
export const SUMUP_TOKEN_URL = `${SUMUP_API}/token`
/**
 * Sent on every sign-in, because with no scope SumUp grants its defaults, and those include read-write user.app-settings.
 * transactions.history reads the sales. user.profile_readonly reads memberships and payouts. payouts.read and
 * transactions.read are on the endpoints but not in SumUp's OAuth scope table, so they aren't asked for.
 */
export const SUMUP_SCOPES = ['transactions.history', 'user.profile_readonly'] as const
/** The most records one payouts call returns. There are no pages: a full answer may have been cut short. */
export const PAYOUTS_LIMIT = 9999

export const SUMUP_ROLE_MESSAGE = 'SumUp won’t show this merchant’s payouts and sales to this person. The account owner needs to connect SumUp.'

/** Everything SumUp's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The SumUp connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote the request. */
export function classifySumUpError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'SumUp no longer accepts this sign-in. Connect SumUp again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', SUMUP_ROLE_MESSAGE, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `SumUp HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `SumUp sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

/** SumUp's links carry a query string for the same endpoint. Anything else isn't followed, so the token stays on SumUp's API. */
function nextQuery(links: unknown): Record<string, string> | null {
  if (!Array.isArray(links)) throw unreadable('a transaction page')
  const next = (links as unknown[]).find((l) => isRecord(l) && l.rel === 'next')
  if (next === undefined) return null
  const href = (next as Record<string, unknown>).href
  if (typeof href !== 'string' || !href || /^(\/|[a-z][a-z0-9+.-]*:)/i.test(href)) throw new ConnectorError('permanent', 'SumUp sent a next page Aggregate won’t follow.', { provider: PROVIDER, forUser: true })
  const params = new URLSearchParams(href.replace(/^\?/, ''))
  const query = Object.fromEntries(params)
  // A key sent twice can't be carried in `query`, and a page read with half its filter is a wrong total.
  if (Object.keys(query).length !== [...params.keys()].length) throw unreadable('a transaction page')
  return query
}

export interface SumUpHistoryPage {
  rows: SumUpTransaction[]
  /** The query for the next page; null on the last page. */
  next: Record<string, string> | null
}

export class SumUpClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: SUMUP_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
      // SumUp publishes no limit for these endpoints.
      rateLimit: { perSecond: 5, burst: 10 },
      classifyError: ({ status }: { status: number }) => classifySumUpError(status),
    })
  }

  /** The payout and deduction records dated from `start` to `end`, both inclusive. */
  async payouts(merchantCode: string, start: string, end: string, limit: number = PAYOUTS_LIMIT): Promise<SumUpPayout[]> {
    const res = await this.http.request<unknown>({ path: `/v1.0/merchants/${encodeURIComponent(merchantCode)}/payouts`, query: { start_date: start, end_date: end, format: 'json', limit, order: 'asc' } })
    if (!Array.isArray(res.data) || !res.data.every(isRecord)) throw unreadable('a payout list')
    return res.data as unknown as SumUpPayout[]
  }

  /** One page of transaction history. `items` carries each row's `user`; only the fields in types.ts are ever read. */
  async history(merchantCode: string, query: Record<string, string | number>): Promise<SumUpHistoryPage> {
    const res = await this.http.request<unknown>({ path: `/v2.1/merchants/${encodeURIComponent(merchantCode)}/transactions/history`, query })
    const items = isRecord(res.data) ? res.data.items : undefined
    if (!Array.isArray(items) || !items.every(isRecord)) throw unreadable('a transaction page')
    return { rows: items as unknown as SumUpTransaction[], next: nextQuery((res.data as Record<string, unknown>).links) }
  }

  /** The live merchant accounts this sign-in belongs to. Sandbox merchants are test money and never connect. */
  async merchants(): Promise<SumUpMerchant[]> {
    const out: SumUpMerchant[] = []
    for (let offset = 0; ; ) {
      const res = await this.http.request<unknown>({ path: '/v0.1/memberships', query: { kind: 'merchant', status: 'accepted', 'resource.attributes.sandbox': 'false', limit: 25, offset } })
      const items = isRecord(res.data) ? res.data.items : undefined
      const total = isRecord(res.data) ? res.data.total_count : undefined
      if (!Array.isArray(items) || !items.every(isRecord) || !Number.isSafeInteger(total)) throw unreadable('a merchant list')
      for (const m of items as Array<Record<string, unknown>>) {
        const r = m.resource
        if (m.status !== 'accepted' || m.type !== 'merchant' || !isRecord(r)) continue
        if (isRecord(r.attributes) && r.attributes.sandbox === true) continue
        if (typeof r.id !== 'string' || !MERCHANT_CODE.test(r.id)) throw unreadable('a merchant')
        out.push({ merchantCode: r.id, name: typeof r.name === 'string' ? r.name : r.id })
      }
      offset += items.length
      if (!items.length || offset >= (total as number)) return out
    }
  }
}

/** SumUp's example is MH4H92C7. It goes in a URL path, so nothing looser is passed along. */
export const MERCHANT_CODE = /^[A-Z0-9]{4,20}$/
