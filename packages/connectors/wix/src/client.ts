// Wix eCommerce client: https://www.wixapis.com with a token minted for one installed site.
//
// READ-ONLY BY CONSTRUCTION, as far as a POST allows. Wix has no GET for a list of orders: Search Orders is a POST with the
// query in its body, and it reads. So ordersOnly wraps the fetch underneath the read client and lets through one thing, a POST
// to exactly /ecom/v1/orders/search. Any other path or method throws before a byte leaves. Wix sets an app's permissions in its
// dashboard and not in the install link, so Read Orders being the only one is a registration step (README). The token call is
// the only other POST, it holds no store data, and it doesn't go through this fetch.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import type { OrdersPage, WixOrder } from './types.ts'

const PROVIDER = 'wix'
export const WIX_API = 'https://www.wixapis.com'
export const WIX_ORDERS_URL = `${WIX_API}/ecom/v1/orders/search`
export const WIX_INSTALL_URL = 'https://www.wix.com/app-installer'
const PAGE_SIZE = 100

export const WIX_ROLE_MESSAGE = 'Wix won’t show this site’s orders to Aggregate. Connect Wix again and allow access.'
export const WIX_SIGNED_OUT = 'Wix no longer accepts this connection. Connect Wix again.'

/** Everything the read client sends passes through here. See the note at the top of this file. */
export function ordersOnly(inner: FetchLike): FetchLike {
  return (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'POST' || String(input) !== WIX_ORDERS_URL) return Promise.reject(new ConnectorError('permanent', 'The Wix connection only reads orders.', { provider: PROVIDER }))
    return inner(input, init)
  }
}

/** Written from the status alone: a provider's message can quote the request. */
export function classifyWixError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', WIX_SIGNED_OUT, { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', WIX_ROLE_MESSAGE, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Wix HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of nothing. */
export const unreadable = (what: string) => new ConnectorError('permanent', `Wix sent ${what} Aggregate can’t read, so this sync stopped. No totals were changed.`, { provider: PROVIDER, forUser: true })

/** A new token for one site. Wix gives no refresh token: this call, with the app's secret, is how a token renews. A refusal is also how a removed app shows. */
export async function mintToken(app: { clientId: string; clientSecret: string }, instanceId: string, deps: Omit<ConnectorDeps, 'raw'>): Promise<string> {
  const http = new HttpClient({
    provider: PROVIDER,
    baseUrl: WIX_API,
    fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.random ? { random: deps.random } : {}),
    classifyError: ({ status }: { status: number }) => (status === 400 || status === 401 || status === 403 ? new ConnectorError('auth', WIX_SIGNED_OUT, { provider: PROVIDER, status, forUser: true }) : classifyWixError(status)),
  })
  const res = await http.request<unknown>({ method: 'POST', path: '/oauth2/token', json: { grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.clientSecret, instance_id: instanceId }, idempotent: true })
  const token = isRecord(res.data) ? res.data.access_token : undefined
  if (typeof token !== 'string' || !token) throw unreadable('a sign-in')
  return token
}

export class WixClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: WIX_API,
      fetch: ordersOnly(deps.fetch ?? ((input, init) => fetch(input, init))),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      // Wix's docs show the token bare, with no "Bearer".
      headers: { authorization: accessToken },
      // No published limit for this endpoint.
      rateLimit: { perSecond: 4, burst: 8 },
      classifyError: ({ status }: { status: number }) => classifyWixError(status),
    })
  }

  /** One page, oldest first. The window and the cursor are never sent together. `archived` is both ways: the docs don't say whether a search includes archived orders. */
  async orders(window: { after: string; before: string } | null, cursor: string | null, limit = PAGE_SIZE): Promise<OrdersPage> {
    const search = cursor
      ? { cursorPaging: { limit, cursor } }
      : { filter: { archived: { $in: [true, false] }, ...(window ? { createdDate: { $gte: window.after, $lte: window.before } } : {}) }, sort: [{ fieldName: 'createdDate', order: 'ASC' }], cursorPaging: { limit } }
    const res = await this.http.request<unknown>({ method: 'POST', path: '/ecom/v1/orders/search', json: { search }, idempotent: true })
    const d = res.data
    if (!isRecord(d) || !Array.isArray(d.orders) || !d.orders.every(isRecord) || !isRecord(d.metadata)) throw unreadable('an order list')
    const m = d.metadata
    if (m.hasNext !== true && m.hasNext !== false) throw unreadable('an order list')
    const next = isRecord(m.cursors) ? m.cursors.next : undefined
    if (m.hasNext && (typeof next !== 'string' || !next || next === cursor)) throw unreadable('an order list')
    return { orders: d.orders.map(pick), nextCursor: m.hasNext ? (next as string) : null }
  }
}

/** Only these fields leave this file, so buyerInfo can't reach anything by accident. */
const pick = (o: Record<string, unknown>): WixOrder => ({ id: o.id, currency: o.currency, createdDate: o.createdDate, purchasedDate: o.purchasedDate, paymentStatus: o.paymentStatus, balanceSummary: o.balanceSummary })
