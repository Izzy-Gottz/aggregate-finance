// Pinterest API v5 client: https://api.pinterest.com/v5 with a Pinterest sign-in's access token.
//
// READ-ONLY BY CONSTRUCTION, twice over. The token holds ads:read and nothing else (the connector refuses any other grant it
// sees), and getOnly wraps the fetch underneath everything, so any method but GET throws before a byte leaves. The token call
// is the only POST, it holds no advertiser data, and it doesn't go through this fetch. The asynchronous report (POST, then a
// file) is what reaches past 90 days, and it's left out on purpose: no report here needs a POST.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'pinterest'
export const PINTEREST_API = 'https://api.pinterest.com/v5'
export const PINTEREST_AUTHORIZE_URL = 'https://www.pinterest.com/oauth/'
export const PINTEREST_TOKEN_URL = 'https://api.pinterest.com/v5/oauth/token'
export const PINTEREST_SCOPE = 'ads:read'
/** Micro-units of the ad account's currency: the docs say so for every MICRO_DOLLAR metric, USD or not. */
export const SPEND_COLUMN = 'SPEND_IN_MICRO_DOLLAR'

export const PINTEREST_REFUSED = 'Pinterest refused this read, so Aggregate doesn’t know this account’s ad spend and no totals were changed. It can mean this person’s role on the ad account doesn’t allow reporting, or a limit on Aggregate’s app.'

/** Digits only, at most 18. It goes in a URL path, so nothing looser is passed along. */
export const AD_ACCOUNT_ID = /^\d{1,18}$/
/** The docs list UNK as a currency. That isn't one, and a sum in it means nothing. */
export const AD_CURRENCY = /^(?!UNK$)[A-Z]{3}$/

export interface PinterestAdAccount {
  id: string
  name: string
  currency: string
}

export interface PinterestDay {
  date: string
  micros: number
}

/** Everything Pinterest's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Pinterest connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/**
 * Written from the status alone: a provider's message can quote the request. A 403 can be a role or an app limit, and a new
 * sign-in fixes neither, so it isn't 'auth'. It says unknown, and the caller gets no number.
 */
export function classifyPinterestError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Pinterest no longer accepts this sign-in. Connect Pinterest again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('permanent', PINTEREST_REFUSED, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Pinterest HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Pinterest sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export class PinterestClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: PINTEREST_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
      rateLimit: { perSecond: 2, burst: 4 },
      classifyError: ({ status }: { status: number }) => classifyPinterestError(status),
    })
  }

  /** Every ad account this sign-in reaches, its own and shared ones. Owner names and permissions aren't kept. */
  async adAccounts(): Promise<PinterestAdAccount[]> {
    const out: PinterestAdAccount[] = []
    let bookmark: string | undefined
    do {
      const res = await this.http.request<unknown>({ path: '/ad_accounts', query: { page_size: 100, ...(bookmark ? { bookmark } : {}) } })
      if (!isRecord(res.data) || !Array.isArray(res.data.items) || !res.data.items.every(isRecord)) throw unreadable('an ad account list')
      for (const a of res.data.items as Array<Record<string, unknown>>) {
        if (typeof a.id !== 'string' || !AD_ACCOUNT_ID.test(a.id) || typeof a.currency !== 'string' || !AD_CURRENCY.test(a.currency)) throw unreadable('an ad account')
        out.push({ id: a.id, name: typeof a.name === 'string' && a.name ? a.name : a.id, currency: a.currency })
      }
      const next = res.data.bookmark
      if (next !== undefined && next !== null && typeof next !== 'string') throw unreadable('an ad account list')
      if (next && next === bookmark) throw unreadable('an ad account list')
      bookmark = next || undefined
    } while (bookmark)
    return out
  }

  /**
   * Spend by UTC day from `start` to `end`, both inclusive: the whole account, in micro-units. Pinterest may leave out a
   * column with no value. Here that's an unknown day, so it stops the sync, and a day never counts as zero by being absent.
   */
  async dailySpend(adAccountId: string, start: string, end: string): Promise<PinterestDay[]> {
    const res = await this.http.request<unknown>({
      path: `/ad_accounts/${adAccountId}/analytics`,
      query: { start_date: start, end_date: end, columns: SPEND_COLUMN, granularity: 'DAY' },
    })
    if (!Array.isArray(res.data)) throw unreadable('a report')
    return res.data.map((r: unknown) => {
      if (!isRecord(r) || String(r.AD_ACCOUNT_ID) !== adAccountId) throw unreadable('a report for another account')
      if (typeof r.DATE !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.DATE)) throw unreadable('a report row')
      const micros = r[SPEND_COLUMN]
      if (typeof micros !== 'number' || !Number.isSafeInteger(micros) || micros < 0) throw unreadable('a day of spend')
      return { date: r.DATE, micros }
    })
  }
}
