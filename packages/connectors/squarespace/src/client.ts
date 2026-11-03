// Squarespace Commerce API client: https://api.squarespace.com with a site owner's OAuth access token.
//
// READ-ONLY BY CONSTRUCTION, twice over. The sign-in asks for website.transactions.read and nothing else (the only permission
// the Transactions API has is read-only), and getOnly wraps the fetch underneath everything, so any method but GET throws
// before a byte leaves. The token call is the only POST, it holds no store data, and it doesn't go through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { SquarespaceDocument, SquarespaceSite, TransactionsPage } from './types.ts'

const PROVIDER = 'squarespace'
export const SQUARESPACE_API = 'https://api.squarespace.com'
export const SQUARESPACE_AUTHORIZE_URL = 'https://login.squarespace.com/api/1/login/oauth/provider/authorize'
export const SQUARESPACE_TOKEN_URL = 'https://login.squarespace.com/api/1/login/oauth/provider/tokens'
export const SQUARESPACE_SCOPE = 'website.transactions.read'
/** Squarespace refuses a request without a User-Agent, the token call too. */
export const USER_AGENT = 'Aggregate/1.0 (aggregate.finance)'

export const SQUARESPACE_ROLE_MESSAGE = 'Squarespace won’t show this site’s sales to this sign-in. Connect Squarespace again and allow access.'

/** Everything Squarespace's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Squarespace connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote the request. */
export function classifySquarespaceError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Squarespace no longer accepts this sign-in. Connect Squarespace again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', SQUARESPACE_ROLE_MESSAGE, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Squarespace HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Squarespace sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export class SquarespaceClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: SQUARESPACE_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, 'user-agent': USER_AGENT },
      // Commerce APIs allow 300 a minute.
      rateLimit: { perSecond: 4, burst: 8 },
      classifyError: ({ status }: { status: number }) => classifySquarespaceError(status),
    })
  }

  /** The one site this token belongs to. */
  async site(): Promise<SquarespaceSite> {
    const res = await this.http.request<unknown>({ path: '/1.0/authorization/website' })
    const d = res.data
    if (!isRecord(d) || typeof d.id !== 'string' || !d.id || typeof d.currency !== 'string' || !/^[A-Z]{3}$/.test(d.currency)) throw unreadable('a site')
    return { id: d.id, title: typeof d.title === 'string' && d.title ? d.title : 'Squarespace site', currency: d.currency, timeZone: typeof d.timeZone === 'string' ? d.timeZone : 'UTC' }
  }

  /** One page. The window and the cursor are never sent together: a cursor already holds its window. */
  async transactions(window: { after: string; before: string } | null, cursor: string | null): Promise<TransactionsPage> {
    const query = cursor ? { cursor } : window ? { modifiedAfter: window.after, modifiedBefore: window.before } : {}
    const res = await this.http.request<unknown>({ path: '/1.0/commerce/transactions', query })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.documents) || !d.documents.every(isRecord)) throw unreadable('a transaction list')
    const p = d.pagination
    if (!isRecord(p) || typeof p.hasNextPage !== 'boolean') throw unreadable('a transaction list')
    if (p.hasNextPage && (typeof p.nextPageCursor !== 'string' || !p.nextPageCursor || p.nextPageCursor === cursor)) throw unreadable('a transaction list')
    return { documents: d.documents as unknown as SquarespaceDocument[], nextPageCursor: p.hasNextPage ? (p.nextPageCursor as string) : null }
  }
}
