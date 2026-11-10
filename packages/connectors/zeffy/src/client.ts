// Zeffy public API client: https://api.zeffy.com/api/v1, the organization's API key as a Bearer token on every call.
//
// READ-ONLY BY CONSTRUCTION. A Zeffy API key can also record payments (POST /payments) and delete them (DELETE
// /payments/{id}), and Zeffy documents no way to limit a key to reading. getOnly wraps the fetch underneath everything:
// any method but GET throws before a byte leaves.
//
// Errors are written here from the status alone: Zeffy's message can quote ids or field values.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'zeffy'
export const ZEFFY_API = 'https://api.zeffy.com'
/** Zeffy's largest page. */
export const PER_PAGE = 100

export const ZEFFY_KEY_REJECTED = 'Zeffy no longer accepts this API key, so this sync stopped. No totals were changed. In Zeffy, open Settings → Integrations, make a new key and connect it again.'
export const ZEFFY_REFUSED = 'Zeffy refused to show this organization’s payments, so this sync stopped. No totals were changed. Only the organization’s owner can make an API key in Zeffy.'

/** Everything Zeffy's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Zeffy connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone. A 429's Retry-After is read by the HTTP client. */
export function classifyZeffyError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', ZEFFY_KEY_REJECTED, { provider: PROVIDER, status, forUser: true })
  // A retry won't change a refusal, and it must not read as no payments.
  if (status === 403) return new ConnectorError('permanent', ZEFFY_REFUSED, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Zeffy HTTP ${status}`, { provider: PROVIDER, status })
}

export const unreadable = (what: string) => new ConnectorError('permanent', `Zeffy sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export interface Page {
  rows: Array<Record<string, unknown>>
  /** The id to start after for the next page, or null at the end. */
  next: string | null
}

export class ZeffyClient {
  private readonly http: HttpClient

  constructor(apiKey: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: `${ZEFFY_API}/api/v1`,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json', 'user-agent': 'Aggregate' },
      // Every key of an organization shares 100 requests a minute and 20 a second, so stay well under both.
      rateLimit: { perSecond: 1, burst: 3 },
      timeoutMs: 20_000,
      classifyError: ({ status }) => classifyZeffyError(status),
    })
  }

  /** One page of payments created at or after `since` (unix seconds), newest first. */
  async payments(since: number, after: string | null, limit = PER_PAGE): Promise<Page> {
    const query: Record<string, string | number> = { 'created[gte]': since, limit }
    if (after) query.starting_after = after
    const res = await this.http.request<unknown>({ path: '/payments', query })
    const d = res.data
    if (!isRecord(d) || d.object !== 'list' || !Array.isArray(d.data) || !d.data.every(isRecord) || typeof d.has_more !== 'boolean') throw unreadable('a list')
    if (!d.has_more) return { rows: d.data, next: null }
    // More to come must say where from, or the read would start over.
    if (typeof d.next_cursor !== 'string' || !d.next_cursor || d.next_cursor === after) throw unreadable('a page it had already sent')
    return { rows: d.data, next: d.next_cursor }
  }
}
