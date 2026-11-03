// AdSense Management API v2 client: https://adsense.googleapis.com with a Google sign-in's access token.
//
// READ-ONLY BY CONSTRUCTION, twice over. The token holds adsense.readonly and nothing else (the connector refuses any other
// grant), and getOnly wraps the fetch underneath everything, so any method but GET throws before a byte leaves. The token
// and revoke calls are the only POSTs, they hold no publisher data, and neither goes through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { AdSenseAccount, AdSensePayment, AdSenseReport } from './types.ts'

const PROVIDER = 'adsense'
export const ADSENSE_API = 'https://adsense.googleapis.com'
export const ADSENSE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const ADSENSE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const ADSENSE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
export const ADSENSE_SCOPE = 'https://www.googleapis.com/auth/adsense.readonly'

export const ADSENSE_ROLE_MESSAGE = 'Google won’t show this AdSense account to this person. Someone with access to the account needs to connect AdSense.'

/** accounts/pub-123. It goes in a URL path, so nothing looser is passed along. */
export const ACCOUNT_NAME = /^accounts\/pub-\d+$/

/** Everything AdSense's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The AdSense connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote the request. */
export function classifyAdSenseError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Google no longer accepts this sign-in. Connect AdSense again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', ADSENSE_ROLE_MESSAGE, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `AdSense HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `AdSense sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

const parts = (day: string): [number, number, number] => day.split('-').map(Number) as [number, number, number]

export class AdSenseClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: ADSENSE_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
      rateLimit: { perSecond: 2, burst: 4 },
      classifyError: ({ status }: { status: number }) => classifyAdSenseError(status),
    })
  }

  /** Every AdSense account this sign-in reaches. */
  async accounts(): Promise<AdSenseAccount[]> {
    const out: AdSenseAccount[] = []
    let pageToken: string | undefined
    do {
      const res = await this.http.request<unknown>({ path: '/v2/accounts', query: pageToken ? { pageToken } : {} })
      if (!isRecord(res.data)) throw unreadable('an account list')
      const { accounts, nextPageToken } = res.data
      if (accounts !== undefined && (!Array.isArray(accounts) || !accounts.every(isRecord))) throw unreadable('an account list')
      for (const a of (accounts ?? []) as Array<Record<string, unknown>>) {
        if (typeof a.name !== 'string' || !ACCOUNT_NAME.test(a.name)) throw unreadable('an account')
        const zone = isRecord(a.timeZone) ? a.timeZone.id : undefined
        out.push({ name: a.name, displayName: typeof a.displayName === 'string' && a.displayName ? a.displayName : a.name.slice('accounts/'.length), timeZone: typeof zone === 'string' ? zone : 'UTC' })
      }
      if (nextPageToken !== undefined && typeof nextPageToken !== 'string') throw unreadable('an account list')
      if (nextPageToken && nextPageToken === pageToken) throw unreadable('an account list')
      pageToken = nextPageToken || undefined
    } while (pageToken)
    return out
  }

  /** Earnings by month from `start` to `end`, both inclusive, in the account's currency and time zone. */
  async report(account: string, start: string, end: string): Promise<AdSenseReport> {
    const [sy, sm, sd] = parts(start)
    const [ey, em, ed] = parts(end)
    const res = await this.http.request<unknown>({
      path: `/v2/${account}/reports:generate`,
      query: { dateRange: 'CUSTOM', 'startDate.year': sy, 'startDate.month': sm, 'startDate.day': sd, 'endDate.year': ey, 'endDate.month': em, 'endDate.day': ed, dimensions: 'MONTH', metrics: 'ESTIMATED_EARNINGS' },
    })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.headers) || d.headers.length !== 2) throw unreadable('a report')
    const [dimension, metric] = d.headers as unknown[]
    if (!isRecord(dimension) || dimension.name !== 'MONTH' || dimension.type !== 'DIMENSION') throw unreadable('a report')
    if (!isRecord(metric) || metric.name !== 'ESTIMATED_EARNINGS' || metric.type !== 'METRIC_CURRENCY' || typeof metric.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(metric.currencyCode)) throw unreadable('a report')
    const raw = d.rows ?? []
    if (!Array.isArray(raw)) throw unreadable('a report')
    const rows = raw.map((r: unknown) => {
      const cells = isRecord(r) ? r.cells : undefined
      if (!Array.isArray(cells) || cells.length !== 2 || !cells.every(isRecord)) throw unreadable('a report row')
      const [month, amount] = cells.map((c) => (c as Record<string, unknown>).value)
      if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month) || typeof amount !== 'string') throw unreadable('a report row')
      return { month, amount }
    })
    // A cut-off report would read as months of nothing.
    if (d.totalMatchedRows !== undefined && Number(d.totalMatchedRows) !== rows.length) throw unreadable('a report that was cut short')
    const totalCells = isRecord(d.totals) ? d.totals.cells : undefined
    const totalCell = Array.isArray(totalCells) ? (totalCells[1] as unknown) : undefined
    const total = isRecord(totalCell) && typeof totalCell.value === 'string' ? totalCell.value : null
    return { currency: metric.currencyCode, rows, total }
  }

  /** Paid payments and the unpaid balance. The docs show no pages. */
  async payments(account: string): Promise<AdSensePayment[]> {
    const res = await this.http.request<unknown>({ path: `/v2/${account}/payments` })
    if (!isRecord(res.data)) throw unreadable('a payment list')
    const { payments } = res.data
    if (payments === undefined) return []
    if (!Array.isArray(payments) || !payments.every(isRecord)) throw unreadable('a payment list')
    return payments as unknown as AdSensePayment[]
  }
}
