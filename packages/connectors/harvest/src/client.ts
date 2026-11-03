// Harvest API v2 client: https://api.harvestapp.com/v2, a Bearer token and a Harvest-Account-Id on every call, and a
// User-Agent naming the app (Harvest answers 400 without one).
//
// READ-ONLY BY CONSTRUCTION. Harvest has no read-only scope: its scopes are whole accounts (harvest:{ACCOUNT_ID},
// harvest:all, all), so a token that can read can also write whatever the person who signed in can write. Hosted's
// read-only rule therefore rests on this file alone. getOnly wraps the fetch underneath everything, and any method but GET
// throws before a byte leaves. The token call at id.getharvest.com is the one POST, and it holds no customer data; it goes
// through the SDK's OAuthClient and never through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { HarvestAccount } from './types.ts'

const PROVIDER = 'harvest'
export const HARVEST_API = 'https://api.harvestapp.com/v2'
export const HARVEST_ID = 'https://id.getharvest.com'
export const HARVEST_AUTHORIZE_URL = `${HARVEST_ID}/oauth2/authorize`
export const HARVEST_TOKEN_URL = `${HARVEST_ID}/api/v2/oauth2/token`
/** Harvest asks for the app's name and a link or email. */
export const HARVEST_USER_AGENT = 'Aggregate (https://aggregate.finance)'
const API_HOST = new URL(HARVEST_API).host

export const HARVEST_ROLE_MESSAGE = 'Harvest won’t show invoices to this person. An Administrator, or a Manager who can create and edit invoices, needs to connect Harvest.'

/** Everything Harvest's API receives passes through here. See the note at the top of this file. */
export function getOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET') return Promise.reject(new ConnectorError('permanent', 'The Harvest connection only reads.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** The token call needs the same User-Agent; OAuthClient has no header option. */
export const withUserAgent =
  (inner: FetchLike): FetchLike =>
  (input, init) =>
    inner(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'user-agent': HARVEST_USER_AGENT } })

/** Written from the status alone: invoice text and client names may sit in a provider's message. */
export function classifyHarvestError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Harvest no longer accepts this sign-in. Connect Harvest again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', HARVEST_ROLE_MESSAGE, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Harvest HTTP ${status}`, { provider: PROVIDER, status })
}

type Query = Record<string, string | number>

export interface HarvestPage<T> {
  rows: T[]
  /** The query for the next page, from links.next; null on the last page. */
  next: Record<string, string> | null
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
const unreadable = () => new ConnectorError('transient', 'Harvest sent something other than a list', { provider: PROVIDER })

/** Harvest says to follow links.next. Only its query is kept, so the token can't be led to another host. */
function nextQuery(links: unknown): Record<string, string> | null {
  const next = isRecord(links) ? links.next : null
  if (next === null || next === undefined) return null
  let url: URL | undefined
  try {
    url = new URL(String(next))
  } catch {
    // Reported below.
  }
  if (url?.protocol !== 'https:' || url.host !== API_HOST) throw new ConnectorError('permanent', 'Harvest sent a next page Aggregate won’t follow.', { provider: PROVIDER })
  return Object.fromEntries(url.searchParams)
}

export class HarvestClient {
  private readonly http: HttpClient

  constructor(accessToken: string, accountId: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient(clientOptions(HARVEST_API, accessToken, deps, { 'harvest-account-id': accountId }))
  }

  /** One page of a list. `key` is the name Harvest gives the rows in the response. */
  async page<T>(path: string, key: string, query: Query): Promise<HarvestPage<T>> {
    const res = await this.http.request<unknown>({ path, query })
    const rows = isRecord(res.data) ? res.data[key] : undefined
    if (!Array.isArray(rows)) throw unreadable()
    return { rows: rows as T[], next: nextQuery((res.data as Record<string, unknown>).links) }
  }
}

function clientOptions(baseUrl: string, accessToken: string, deps: Omit<ConnectorDeps, 'raw'>, headers: Record<string, string> = {}) {
  return {
    provider: PROVIDER,
    baseUrl,
    fetch: getOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.random ? { random: deps.random } : {}),
    headers: { authorization: `Bearer ${accessToken}`, 'user-agent': HARVEST_USER_AGENT, ...headers },
    // Harvest allows 100 requests per 15 seconds.
    rateLimit: { perSecond: 6, burst: 10 },
    classifyError: ({ status }: { status: number }) => classifyHarvestError(status),
  }
}

/** The Harvest accounts a sign-in reaches. The response's `user` (a name and an email) is read past. */
export async function harvestAccounts(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>): Promise<HarvestAccount[]> {
  const http = new HttpClient(clientOptions(`${HARVEST_ID}/api/v2`, accessToken, deps))
  const res = await http.request<unknown>({ path: '/accounts' })
  const rows = isRecord(res.data) ? res.data.accounts : undefined
  if (!Array.isArray(rows)) throw unreadable()
  return (rows as HarvestAccount[]).filter((a) => a.product === 'harvest')
}
