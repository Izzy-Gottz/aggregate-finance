// WooCommerce HTTP client: https://{store}/wp-json/wc/v3, HTTP Basic with the consumer key and secret. Never query-string
// credentials. Every request goes through safe-url.ts. Errors are written here from the status alone: nothing a store
// sends is repeated, because a hosted user controls that server.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps } from '@agfn/connector-sdk'
import { guardedFetch, httpsFetch, parseStoreUrl, systemResolver, type Resolver } from './safe-url.ts'

const PROVIDER = 'woocommerce'
const AUTH_ERROR = 'woocommerce_rest_authentication_error'
const PROBE_PATH = '/aggregate-read-only-check'

export const PER_PAGE_MAX = 100

export function classifyWooError(status: number, body: unknown): ConnectorError {
  const code = isRecord(body) && body.code === AUTH_ERROR ? AUTH_ERROR : undefined
  return new ConnectorError(kindForStatus(status), `WooCommerce HTTP ${status}`, { provider: PROVIDER, status, ...(code ? { code } : {}) })
}

export interface WooPage<T> {
  rows: T[]
  /** X-WP-TotalPages; null when something between us and the store dropped it. */
  totalPages: number | null
}

type Query = Record<string, string | number>

/** A 200 that isn't what we asked for (a maintenance page, a cache). Treating it as empty would report a month of zero sales. */
const unreadable = () => new ConnectorError('transient', 'WooCommerce sent something other than a list', { provider: PROVIDER })

export class WooClient {
  private readonly http: HttpClient

  constructor(storeUrl: string, consumerKey: string, consumerSecret: string, deps: Omit<ConnectorDeps, 'raw'>, resolve: Resolver = systemResolver) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: `${parseStoreUrl(storeUrl)}/wp-json/wc/v3`,
      fetch: guardedFetch({ resolve, fetch: deps.fetch ?? httpsFetch(resolve) }),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`, 'user-agent': 'Aggregate' },
      // Stores run on anything from shared hosting up.
      rateLimit: { perSecond: 2, burst: 4 },
      timeoutMs: 20_000,
      classifyError: ({ status, body }) => classifyWooError(status, body),
    })
  }

  async list<T>(path: string, query: Query): Promise<WooPage<T>> {
    const res = await this.http.request<unknown>({ path, query })
    if (!Array.isArray(res.data)) throw unreadable()
    const pages = Number(res.headers.get('x-wp-totalpages'))
    return { rows: res.data.filter(isRecord) as T[], totalPages: res.headers.has('x-wp-totalpages') && Number.isFinite(pages) ? pages : null }
  }

  async storeCurrency(): Promise<string | null> {
    const res = await this.http.request<unknown>({ path: '/settings/general/woocommerce_currency', query: { _fields: 'value' } })
    if (!isRecord(res.data)) throw unreadable()
    return typeof res.data.value === 'string' ? res.data.value : null
  }

  async orderTotals(): Promise<Array<{ slug: string; total: number }>> {
    const res = await this.http.request<unknown>({ path: '/reports/orders/totals' })
    if (!Array.isArray(res.data)) return []
    return res.data.filter(isRecord).map((r) => ({ slug: String(r.slug), total: Number(r.total) || 0 }))
  }

  /**
   * Whether the key can write. WooCommerce doesn't report a key's permissions over the API, but it checks them before
   * it looks for a route (check_user_permissions on rest_pre_dispatch), so an empty POST to a route that doesn't exist
   * tells them apart and can't change anything: a Read key gets 401 woocommerce_rest_authentication_error; a key that
   * can write gets past that to 404. Anything else (a firewall, a 500) proves nothing.
   */
  async keyAccess(): Promise<'read' | 'write' | 'unknown'> {
    try {
      await this.http.request({ method: 'POST', path: PROBE_PATH })
      return 'unknown'
    } catch (e) {
      if (!(e instanceof ConnectorError)) throw e
      if (e.forUser) throw e
      if (e.status === 401 && e.code === AUTH_ERROR) return 'read'
      return e.status === 404 ? 'write' : 'unknown'
    }
  }
}
