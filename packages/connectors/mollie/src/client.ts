// Mollie API client: https://api.mollie.com/v2 with a merchant's OAuth token (Mollie Connect). Live data only: `testmode` is
// never sent.
//
// READ-ONLY BY CONSTRUCTION, twice over. The sign-in asks for `balances.read` and `balance-reports.read` only, and a token
// response naming any other scope is refused at connect. getOnly also wraps the fetch underneath everything, so any method
// but GET throws before a byte leaves. The token and revoke calls hold no merchant data and don't go through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'

const PROVIDER = 'mollie'
export const MOLLIE_API = 'https://api.mollie.com/v2'
export const MOLLIE_AUTHORIZE_URL = 'https://my.mollie.com/oauth2/authorize'
export const MOLLIE_TOKEN_URL = 'https://api.mollie.com/oauth2/tokens'
export const MOLLIE_SCOPES = ['balances.read', 'balance-reports.read'] as const
/** Mollie's balance reports run on this clock only. */
export const MOLLIE_ZONE = 'Europe/Amsterdam'
const API_HOST = new URL(MOLLIE_API).host

export const MOLLIE_REFUSED = 'Mollie refused to show this account’s balance reports, so this sync stopped. No totals were changed. Connect Mollie again and allow reading balance reports.'

/** Everything Mollie's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Mollie connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote payment descriptions. */
export function classifyMollieError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Mollie no longer accepts this sign-in. Connect Mollie again.', { provider: PROVIDER, status, forUser: true })
  // A scope that doesn't reach the reports, or a balance that's gone: a retry won't change it, and it must not read as no money.
  if (status === 403 || status === 404) return new ConnectorError('permanent', MOLLIE_REFUSED, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Mollie HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Mollie sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

export interface MollieBalance {
  id: string
  currency: string
}

/** Mollie says to follow _links.next. Only its query is kept, so the token can't be led to another host or path. */
function nextQuery(links: unknown, path: string): Record<string, string> | null {
  const next = isRecord(links) && isRecord(links.next) ? links.next.href : null
  if (next === null || next === undefined) return null
  let url: URL | undefined
  try {
    url = new URL(String(next))
  } catch {
    // Reported below.
  }
  if (url?.protocol !== 'https:' || url.host !== API_HOST || url.pathname !== `/v2${path}`) throw new ConnectorError('permanent', 'Mollie sent a next page Aggregate won’t follow.', { provider: PROVIDER })
  return Object.fromEntries(url.searchParams)
}

export class MollieClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: MOLLIE_API,
      fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/hal+json' },
      rateLimit: { perSecond: 2, burst: 5 },
      classifyError: ({ status }: { status: number }) => classifyMollieError(status),
    })
  }

  /** Every balance on the account. Only the id and currency are read; amounts and payout details are read past. */
  async balances(): Promise<MollieBalance[]> {
    const out: MollieBalance[] = []
    let query: Record<string, string | number> = { limit: 250 }
    for (let i = 0; i < 40; i++) {
      const res = await this.http.request<unknown>({ path: '/balances', query })
      const d = res.data
      const list = isRecord(d) && isRecord(d._embedded) ? d._embedded.balances : undefined
      if (!Array.isArray(list)) throw unreadable('a balance list')
      for (const b of list) {
        if (!isRecord(b) || typeof b.id !== 'string' || !b.id.startsWith('bal_') || typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency)) throw unreadable('a balance')
        out.push({ id: b.id, currency: b.currency })
      }
      const next = nextQuery(isRecord(d) ? d._links : undefined, '/balances')
      if (!next) return out
      if (JSON.stringify(next) === JSON.stringify(Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])))) throw unreadable('a balance list')
      query = next
    }
    throw unreadable('a balance list that doesn’t end')
  }

  /** Mollie's report for one balance, grouped by kind of money. Dates are on Amsterdam's clock, `until` exclusive. */
  async report(balanceId: string, from: string, until: string): Promise<Record<string, unknown>> {
    const res = await this.http.request<unknown>({ path: `/balances/${encodeURIComponent(balanceId)}/report`, query: { from, until, grouping: 'transaction-categories' } })
    const d = res.data
    if (!isRecord(d) || d.resource !== 'balance-report' || d.grouping !== 'transaction-categories' || !isRecord(d.totals)) throw unreadable('a report')
    if (d.timeZone !== undefined && d.timeZone !== MOLLIE_ZONE) throw unreadable('a report')
    return d.totals
  }
}
