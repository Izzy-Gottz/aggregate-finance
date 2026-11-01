// App Store Connect API client: a cached ES256 bearer token (re-minted a minute before expiry) and the one endpoint we
// use, GET /v1/financeReports, which returns a gzip-compressed tab-separated report.

import { gunzipSync } from 'node:zlib'
import type { KeyObject } from 'node:crypto'
import { ConnectorError, HttpClient, isConnectorError, isRecord, systemClock, type Clock, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'
import { appStoreJwt, loadP8, type AppStoreKey } from './jwt.ts'

export const APPSTORE_BASE = 'https://api.appstoreconnect.apple.com'

/** Errors: { errors: [{ status, code, title, detail }] }. */
export function classifyAppStoreError(status: number, body: unknown): ConnectorError {
  const first = isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : {}
  const code = typeof first.code === 'string' ? first.code : undefined
  const detail = (typeof first.detail === 'string' && first.detail) || (typeof first.title === 'string' && first.title) || `App Store Connect HTTP ${status}`
  let kind: ConnectorErrorKind
  let message = detail
  if (status === 401) kind = 'auth'
  else if (status === 403) {
    kind = 'auth'
    message = `App Store Connect key lacks Finance access (${detail}). Use a team key with the Finance or Admin role.`
  } else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 409 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'appstore', status, ...(code ? { code } : {}) })
}

export function decodeReport(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes)
  const plain = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf
  return plain.toString('utf8')
}

export class AppStoreClient {
  private readonly http: HttpClient
  private readonly clock: Clock
  private readonly creds: AppStoreKey
  private readonly key: KeyObject
  private token: { value: string; until: number } | undefined

  constructor(creds: AppStoreKey, deps: Omit<ConnectorDeps, 'raw'>) {
    this.creds = creds
    this.key = loadP8(creds.privateKey)
    this.clock = deps.clock ?? systemClock
    this.http = new HttpClient({
      provider: 'appstore',
      baseUrl: APPSTORE_BASE,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: () => ({ authorization: `Bearer ${this.bearer()}` }),
      // Apple allows ~3600 requests/hour per key.
      rateLimit: { perSecond: 1, burst: 3 },
      timeoutMs: 120_000,
      classifyError: ({ status, body }) => classifyAppStoreError(status, body),
    })
  }

  bearer(): string {
    const now = this.clock.now()
    if (!this.token || this.token.until <= now) {
      const ttl = 15 * 60
      this.token = { value: appStoreJwt(this.creds, now, ttl, this.key), until: now + (ttl - 60) * 1000 }
    }
    return this.token.value
  }

  /** The FINANCIAL report (region ZZ, all currencies) for an Apple fiscal month, or null when Apple has none (404). */
  async financeReport(vendorNumber: string, month: string): Promise<string | null> {
    try {
      const res = await this.http.request<Uint8Array>({
        path: '/v1/financeReports',
        query: {
          'filter[regionCode]': 'ZZ',
          'filter[reportType]': 'FINANCIAL',
          'filter[reportDate]': month,
          'filter[vendorNumber]': vendorNumber,
        },
        headers: { accept: 'application/a-gzip' },
        responseType: 'bytes',
      })
      return decodeReport(res.data)
    } catch (e) {
      if (isConnectorError(e) && e.status === 404) return null
      throw e
    }
  }
}
