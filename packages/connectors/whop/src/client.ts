// Whop API client: https://api.whop.com/api/v1 with a user's OAuth token, pinned to one dated API version.
//
// READ-ONLY BY CONSTRUCTION, twice over. The sign-in asks for one scope, `company:balance:read`, and a token response naming
// anything else is refused at connect. getOnly also wraps the fetch underneath everything, so any method but GET throws
// before a byte leaves. The token and revoke calls hold no business data and don't go through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'whop'
export const WHOP_API = 'https://api.whop.com/api/v1'
export const WHOP_AUTHORIZE_URL = 'https://api.whop.com/oauth/authorize'
export const WHOP_TOKEN_URL = 'https://api.whop.com/oauth/token'
export const WHOP_REVOKE_URL = 'https://api.whop.com/oauth/revoke'
export const WHOP_SCOPE = 'company:balance:read'
/** The API version the docs were read at. A later version can change the report's shape, so it's pinned. */
export const WHOP_API_VERSION = '2026-11-02-1'

export const WHOP_REFUSED = 'Whop refused to show this business’s balance records, so this sync stopped. No totals were changed. Connect Whop again and allow reading the balance.'
export const WHOP_NO_LEDGER = 'Whop has no balance records for this business yet, so nothing was reported.'

/** Everything Whop's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Whop connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote customer or product text. */
export function classifyWhopError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Whop no longer accepts this sign-in. Connect Whop again.', { provider: PROVIDER, status, forUser: true })
  // A scope that doesn't reach the balance, or a removed grant: a retry won't change it, and it must not read as no money.
  if (status === 403) return new ConnectorError('permanent', WHOP_REFUSED, { provider: PROVIDER, status, forUser: true })
  if (status === 404) return new ConnectorError('permanent', WHOP_NO_LEDGER, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Whop HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Whop sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export interface WhopAccount {
  id: string
  name: string
}

export interface WhopReport {
  rows: Array<Record<string, unknown>>
  total: unknown
  currencies: string[]
}

export class WhopClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: WHOP_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'api-version-date': WHOP_API_VERSION },
      rateLimit: { perSecond: 2, burst: 5 },
      classifyError: ({ status }: { status: number }) => classifyWhopError(status),
    })
  }

  /** The business accounts this sign-in reaches. Only the id and a name are read; the rest of each account is read past. */
  async accounts(): Promise<WhopAccount[]> {
    const out: WhopAccount[] = []
    let after: string | undefined
    for (let i = 0; i < 20; i++) {
      const res = await this.http.request<unknown>({ path: '/accounts', query: { first: 50, ...(after ? { after } : {}) } })
      const d = res.data
      if (!isRecord(d) || !Array.isArray(d.data) || !isRecord(d.page_info)) throw unreadable('an account list')
      for (const a of d.data) {
        if (!isRecord(a) || typeof a.id !== 'string' || !a.id.startsWith('biz_')) throw unreadable('an account')
        const name = [a.title, a.business_name].find((v): v is string => typeof v === 'string' && v.trim() !== '')
        out.push({ id: a.id, name: (name ?? 'Whop business').slice(0, 80) })
      }
      const next = d.page_info.end_cursor
      if (d.page_info.has_next_page !== true) return out
      if (typeof next !== 'string' || !next || next === after) throw unreadable('an account list')
      after = next
    }
    throw unreadable('an account list that doesn’t end')
  }

  /** Whop's income statement for one currency, in months on UTC. No conversion: each currency is read as itself. */
  async incomeStatement(accountId: string, currency: string, from: string, to: string): Promise<WhopReport> {
    const res = await this.http.request<unknown>({
      path: '/financial_reports',
      query: { account_id: accountId, report_type: 'income_statement', currency, from, to, group_by: 'month', timezone: 'UTC' },
    })
    const d = res.data
    if (!isRecord(d) || d.report_type !== 'income_statement' || !Array.isArray(d.rows) || !d.rows.every(isRecord)) throw unreadable('a report')
    if (!Array.isArray(d.currencies) || !d.currencies.every((c) => typeof c === 'string')) throw unreadable('a report')
    return { rows: d.rows as Array<Record<string, unknown>>, total: d.total, currencies: d.currencies as string[] }
  }
}
