// Lemon Squeezy HTTP client (JSON:API). Account-wide Bearer key; Lemon Squeezy has no read-only key scope, so this
// client only ever issues GETs. Rate limit: 300 API calls per minute.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export const LS_BASE = 'https://api.lemonsqueezy.com'

/** JSON:API errors: { errors: [{ status, title, detail }] }. */
export function classifyLsError(status: number, body: unknown): ConnectorError {
  const first = isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : {}
  const detail = (typeof first.detail === 'string' && first.detail) || (typeof first.title === 'string' && first.title) || `Lemon Squeezy HTTP ${status}`
  let kind: ConnectorErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, detail.slice(0, 300), { provider: 'lemonsqueezy', status })
}

export class LemonSqueezyClient {
  private readonly http: HttpClient

  constructor(apiKey: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'lemonsqueezy',
      baseUrl: LS_BASE,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/vnd.api+json' },
      rateLimit: { perSecond: 3, burst: 5 },
      classifyError: ({ status, body }) => classifyLsError(status, body),
    })
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
