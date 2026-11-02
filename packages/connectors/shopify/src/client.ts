// Shopify GraphQL Admin API client. One HttpClient per shop (Shopify's limits are per shop + app).
// GraphQL problems arrive with HTTP 200 and an `errors` array, so they're classified here, not by status:
// THROTTLED → wait for the leaky bucket to refill (from extensions.cost.throttleStatus) and retry;
// ACCESS_DENIED → 'auth' naming the missing scope. Every query is a read, so POSTs are marked idempotent.

import { ConnectorError, HttpClient, systemClock, type Clock, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'
import type { GraphQLError, GraphQLResponse } from './types.ts'

/** Latest stable quarterly version per shopify.dev (docs front matter api_version 2026-10), confirmed 2026-10-09. */
export const SHOPIFY_API_VERSION = '2026-10'

/**
 * Least privilege: payouts, balance transactions and the payments account. No read_orders: order data needs Shopify's
 * separate protected-customer-data review, and nothing here reads orders.
 */
export const SHOPIFY_SCOPES = ['read_shopify_payments_payouts', 'read_shopify_payments_accounts']

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/

/** "https://Example.myshopify.com/" → "example.myshopify.com"; undefined when it isn't a myshopify domain. */
export function normalizeShop(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return SHOP_RE.test(s) ? s : undefined
}

export function classifyShopifyHttpError(status: number, body: unknown): ConnectorError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const raw = typeof b.errors === 'string' ? b.errors : typeof b.error_description === 'string' ? b.error_description : typeof b.error === 'string' ? b.error : undefined
  let kind: ConnectorErrorKind
  let message = raw ?? `Shopify HTTP ${status}`
  const raw0 = message
  if (status === 401) {
    kind = 'auth'
    message = 'Shopify rejected the access token (revoked, or the app was uninstalled). Reconnect the store.'
  } else if (status === 403) {
    // GraphQL 403 is "the shop is forbidden" (flagged as fraudulent): reconnecting can't fix it.
    kind = 'permanent'
    message = 'Shopify has blocked API access to this store. Contact Shopify support.'
  }
  else if (status === 429) kind = 'rate_limited'
  else if (status >= 500) kind = 'transient'
  else if (status === 402) {
    kind = 'permanent'
    message = 'The Shopify store is frozen (unpaid Shopify bill).'
  } else if (status === 404) {
    kind = 'permanent'
    message = 'Shopify store not found.'
  } else if (status === 423) {
    kind = 'permanent'
    message = 'The Shopify store is locked.'
  } else kind = 'permanent'
  // Our own sentences (blocked, frozen, locked…) are shown as is; Shopify's text stays in the log.
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'shopify', status, ...(message !== raw0 ? { forUser: true } : {}) })
}

export function accessDeniedError(e: GraphQLError): ConnectorError {
  const field = e.path?.filter((p) => typeof p === 'string').join('.') || 'a field'
  const scope = e.extensions?.requiredAccess ?? /Required access: (.+)$/.exec(e.message)?.[1] ?? 'a missing access scope'
  return new ConnectorError('auth', `Shopify denied access to ${field}: requires ${scope.replace(/`/g, '')}. Grant it to the app and reconnect.`.slice(0, 300), {
    provider: 'shopify',
    code: 'ACCESS_DENIED',
  })
}

export class ShopifyClient {
  private readonly deps: Omit<ConnectorDeps, 'raw'>
  private readonly clock: Clock
  private readonly clients = new Map<string, HttpClient>()

  constructor(deps: Omit<ConnectorDeps, 'raw'>) {
    this.deps = deps
    this.clock = deps.clock ?? systemClock
  }

  private http(shop: string): HttpClient {
    let c = this.clients.get(shop)
    if (!c) {
      c = new HttpClient({
        provider: 'shopify',
        baseUrl: `https://${shop}/admin/api/${SHOPIFY_API_VERSION}`,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        clock: this.clock,
        ...(this.deps.random ? { random: this.deps.random } : {}),
        // GraphQL is cost-limited (bucket refills ~100 points/s on standard plans); requests themselves are cheap.
        rateLimit: { perSecond: 2, burst: 4 },
        classifyError: ({ status, body }) => classifyShopifyHttpError(status, body),
      })
      this.clients.set(shop, c)
    }
    return c
  }

  /** Removes Aggregate from the store: the only way to end its access. Irreversible, and it ends every token. */
  async uninstall(shop: string, accessToken: string): Promise<void> {
    await this.http(shop).request({ method: 'DELETE', path: `https://${shop}/admin/api_permissions/current.json`, headers: { 'x-shopify-access-token': accessToken }, idempotent: true })
  }

  async graphql<T>(shop: string, accessToken: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const maxAttempts = 5
    for (let attempt = 1; ; attempt++) {
      const res = await this.http(shop).request<GraphQLResponse<T>>({
        method: 'POST',
        path: '/graphql.json',
        json: { query, variables },
        headers: { 'x-shopify-access-token': accessToken },
        idempotent: true,
      })
      const body = res.data
      const errors = body?.errors
      if (typeof errors === 'string') throw new ConnectorError('permanent', errors.slice(0, 300), { provider: 'shopify' })
      if (errors?.length) {
        const throttled = errors.find((e) => e.extensions?.code === 'THROTTLED')
        if (throttled) {
          const wait = throttleWaitMs(body)
          if (attempt >= maxAttempts) throw new ConnectorError('rate_limited', 'Shopify GraphQL throttled', { provider: 'shopify', code: 'THROTTLED', retryAfterMs: wait })
          await this.clock.sleep(wait)
          continue
        }
        const denied = errors.find((e) => e.extensions?.code === 'ACCESS_DENIED')
        if (denied) throw accessDeniedError(denied)
        const first = errors[0]!
        const code = first.extensions?.code
        const kind: ConnectorErrorKind = code === 'INTERNAL_SERVER_ERROR' ? 'transient' : code === 'BAD_USER_INPUT' ? 'invalid_input' : 'permanent'
        const text = code === 'SHOP_INACTIVE' ? 'The Shopify store is inactive (closed or paused), so Shopify won\'t share its data.' : code === 'MAX_COST_EXCEEDED' ? `Shopify said the query was too large: ${first.message}` : first.message
        throw new ConnectorError(kind, text.slice(0, 300), { provider: 'shopify', ...(code ? { code } : {}) })
      }
      if (!body?.data) throw new ConnectorError('transient', 'Shopify GraphQL returned no data', { provider: 'shopify' })
      return body.data
    }
  }
}

/** Time until the bucket holds enough points for the query again. */
export function throttleWaitMs(body: GraphQLResponse<unknown> | undefined): number {
  const cost = body?.extensions?.cost
  const t = cost?.throttleStatus
  if (!t || !(t.restoreRate > 0)) return 1000
  const need = Math.max(0, (cost?.requestedQueryCost ?? 100) - t.currentlyAvailable)
  return Math.min(60_000, Math.max(250, Math.ceil((need / t.restoreRate) * 1000)))
}
