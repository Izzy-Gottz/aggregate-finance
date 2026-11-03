// YouTube clients: Data API v3 for which channel this is, Analytics API v2 for its revenue, with a Google sign-in's token.
//
// READ-ONLY BY CONSTRUCTION, twice over. The token holds two read-only scopes and nothing else (the connector refuses any
// other grant), and getOnly wraps the fetch underneath everything, so any method but GET throws before a byte leaves. The
// token and revoke calls are the only POSTs, they hold no channel data, and neither goes through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'youtube'
export const YOUTUBE_DATA_API = 'https://www.googleapis.com'
export const YOUTUBE_ANALYTICS_API = 'https://youtubeanalytics.googleapis.com'
export const YOUTUBE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const YOUTUBE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const YOUTUBE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
/** The Analytics reference requires youtube.readonly on every report; the monetary scope adds estimated revenue. */
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics-monetary.readonly']

export const YOUTUBE_REFUSED = 'YouTube refused this read, so Aggregate doesn’t know this channel’s revenue and no totals were changed. It can mean a channel outside the YouTube Partner Program or a temporary limit.'
export const YOUTUBE_NO_REVENUE = 'YouTube shows no revenue for this channel. Revenue appears for channels in the YouTube Partner Program, so there’s nothing to bring in yet.'

/** UC plus 22 characters. It goes in a query, so nothing looser is passed along. */
export const CHANNEL_ID = /^UC[\w-]{22}$/

/** Everything YouTube's APIs receive passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The YouTube connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/**
 * Written from the status alone: a provider's message can quote the request. A 403 can be a channel outside the
 * Partner Program or a quota, so it says the revenue is unknown, never that there is none, and doesn't ask for a new sign-in.
 */
export function classifyYouTubeError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Google no longer accepts this sign-in. Connect YouTube again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('permanent', YOUTUBE_REFUSED, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `YouTube HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `YouTube sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export class YouTubeClient {
  private readonly data: HttpClient
  private readonly analytics: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    const base = {
      provider: PROVIDER,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
      rateLimit: { perSecond: 2, burst: 4 },
      classifyError: ({ status }: { status: number }) => classifyYouTubeError(status),
    }
    this.data = new HttpClient({ ...base, baseUrl: YOUTUBE_DATA_API })
    this.analytics = new HttpClient({ ...base, baseUrl: YOUTUBE_ANALYTICS_API })
  }

  /** The channel this sign-in chose. Google's consent picks one, so anything else stops. */
  async channel(): Promise<{ id: string; title: string }> {
    const res = await this.data.request<unknown>({ path: '/youtube/v3/channels', query: { part: 'id,snippet', mine: 'true' } })
    if (!isRecord(res.data)) throw unreadable('a channel list')
    const { items } = res.data
    if (items === undefined || (Array.isArray(items) && items.length === 0)) throw new ConnectorError('invalid_input', 'This Google sign-in doesn’t have a YouTube channel.', { provider: PROVIDER, forUser: true })
    if (!Array.isArray(items) || items.length !== 1 || !isRecord(items[0])) throw unreadable('a channel list')
    const { id, snippet } = items[0]
    if (typeof id !== 'string' || !CHANNEL_ID.test(id)) throw unreadable('a channel')
    const title = isRecord(snippet) && typeof snippet.title === 'string' && snippet.title ? snippet.title : id
    return { id, title }
  }

  /** Estimated revenue in US dollars by month, `first` and `last` both YYYY-MM and inclusive. A month with no row is left out. */
  async revenue(channel: string, first: string, last: string): Promise<Array<{ month: string; amount: number }>> {
    const res = await this.analytics.request<unknown>({
      path: '/v2/reports',
      // With the month dimension both dates must be the first day of a month.
      query: { ids: `channel==${channel}`, startDate: `${first}-01`, endDate: `${last}-01`, metrics: 'estimatedRevenue', dimensions: 'month', sort: 'month', currency: 'USD' },
    })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.columnHeaders) || d.columnHeaders.length !== 2) throw unreadable('a report')
    const [dimension, metric] = d.columnHeaders as unknown[]
    if (!isRecord(dimension) || dimension.name !== 'month' || dimension.columnType !== 'DIMENSION') throw unreadable('a report')
    if (!isRecord(metric) || metric.name !== 'estimatedRevenue' || metric.columnType !== 'METRIC') throw unreadable('a report')
    const raw = d.rows ?? []
    if (!Array.isArray(raw)) throw unreadable('a report')
    return raw.map((r: unknown) => {
      if (!Array.isArray(r) || r.length !== 2) throw unreadable('a report row')
      const [month, amount] = r as unknown[]
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || typeof amount !== 'number' || !Number.isFinite(amount)) throw unreadable('a report row')
      return { month, amount }
    })
  }
}
