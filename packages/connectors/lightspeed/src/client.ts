// Lightspeed Retail X-Series HTTP client: https://{domain_prefix}.retail.lightspeed.app/api/2026-10, a Bearer token. Only
// ever GETs, with the read scopes below. Errors are written here from the status alone.
//
// Date versions last at least 12 months from release, so 2026-10 is good to at least 2027-10; after that Lightspeed serves
// the oldest version still supported, which may behave differently.

import { ConnectorError, HttpClient, isRecord, kindForStatus, type ConnectorDeps } from '@agfn/connector-sdk'
import type { LightspeedRetailer, LightspeedSearchPage } from './types.ts'

const PROVIDER = 'lightspeed'
export const LIGHTSPEED_API_VERSION = '2026-10'
export const LIGHTSPEED_AUTHORIZE_URL = 'https://secure.retail.lightspeed.app/connect'
/** Read only. retailer:read gives the currency and time zone; the /retailer page lists payment_types:read too, without saying if both are needed. */
export const LIGHTSPEED_SCOPES = ['sales:read', 'retailer:read', 'payment_types:read']
export const LIGHTSPEED_REQUIRED_SCOPES = ['sales:read', 'retailer:read']

const PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** The prefix comes off the callback's query string and picks the host a client secret is sent to: one DNS label only. */
export function parseDomainPrefix(value: unknown): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!PREFIX_RE.test(v)) throw new ConnectorError('invalid_input', 'That isn’t a Lightspeed store address. Use the first part of yourstore.retail.lightspeed.app.', { provider: PROVIDER, forUser: true })
  return v
}

export const storeHost = (domainPrefix: string) => `https://${parseDomainPrefix(domainPrefix)}.retail.lightspeed.app`
export const tokenUrl = (domainPrefix: string) => `${storeHost(domainPrefix)}/api/1.0/token`

export function classifyLightspeedError(status: number): ConnectorError {
  if (status === 401) return new ConnectorError('auth', 'Lightspeed no longer accepts this sign-in. Connect Lightspeed again.', { provider: PROVIDER, status, forUser: true })
  if (status === 403) return new ConnectorError('auth', `Lightspeed refused this read. Connect again and allow ${LIGHTSPEED_REQUIRED_SCOPES.join(', ')}.`, { provider: PROVIDER, status, forUser: true })
  return new ConnectorError(kindForStatus(status), `Lightspeed HTTP ${status}`, { provider: PROVIDER, status })
}

/** A 200 that isn't what we asked for. Treating it as empty would report a month of no sales. */
const unreadable = () => new ConnectorError('transient', 'Lightspeed sent something other than a list', { provider: PROVIDER })

export class LightspeedClient {
  private readonly http: HttpClient

  constructor(domainPrefix: string, accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl: `${storeHost(domainPrefix)}/api/${LIGHTSPEED_API_VERSION}`,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}` },
      // 300 requests per register per 5 minutes, plus 50. One a second fits a single register.
      rateLimit: { perSecond: 1, burst: 5 },
      classifyError: ({ status }) => classifyLightspeedError(status),
    })
  }

  async retailer(): Promise<LightspeedRetailer> {
    const res = await this.http.request<{ data?: unknown }>({ path: '/retailer' })
    if (!isRecord(res.data) || !isRecord(res.data.data)) throw unreadable()
    return res.data.data as LightspeedRetailer
  }

  async searchSales(query: Record<string, string | number>): Promise<LightspeedSearchPage> {
    const res = await this.http.request<unknown>({ path: '/search', query: { type: 'sales', ...query } })
    if (!isRecord(res.data) || !Array.isArray(res.data.data)) throw unreadable()
    return res.data as unknown as LightspeedSearchPage
  }
}
