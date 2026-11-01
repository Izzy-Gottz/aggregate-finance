// Chargebee HTTP client: https://{site}.chargebee.com/api/v2, Basic auth with the API key as the user name. Aggregate
// asks for a read-only key and only ever issues GETs.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

/** A Chargebee site name: the "acme" in acme.chargebee.com (test sites end in "-test"). */
export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

export const siteBase = (site: string) => `https://${site}.chargebee.com/api/v2`

/** Errors: { message, api_error_code, error_code, http_status_code }. */
export function classifyChargebeeError(status: number, body: unknown): ConnectorError {
  const b = isRecord(body) ? body : {}
  const message = (typeof b.message === 'string' && b.message) || `Chargebee HTTP ${status}`
  const code = typeof b.api_error_code === 'string' ? b.api_error_code : undefined
  let kind: ConnectorErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'chargebee', status, ...(code ? { code } : {}) })
}

export class ChargebeeClient {
  private readonly http: HttpClient

  constructor(site: string, apiKey: string, deps: Omit<ConnectorDeps, 'raw'>) {
    if (!SITE_RE.test(site)) throw new ConnectorError('invalid_input', 'That isn’t a Chargebee site name (the part before .chargebee.com).', { provider: 'chargebee' })
    this.http = new HttpClient({
      provider: 'chargebee',
      baseUrl: siteBase(site),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`, accept: 'application/json' },
      rateLimit: { perSecond: 2, burst: 4 },
      classifyError: ({ status, body }) => classifyChargebeeError(status, body),
    })
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
