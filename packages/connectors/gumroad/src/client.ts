// Gumroad API v2 client. Bearer token (an OAuth token from Aggregate's Gumroad app, or a token the seller generated on
// their own Gumroad application); this client only ever issues GETs. Errors: { success: false, message }.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export const GUMROAD_API = 'https://api.gumroad.com'
export const GUMROAD_AUTHORIZE_URL = 'https://gumroad.com/oauth/authorize'
export const GUMROAD_TOKEN_URL = 'https://api.gumroad.com/oauth/token'
/** Read-only: sales and payouts. Never edit_sales / edit_products. */
export const GUMROAD_SCOPES = ['view_sales', 'view_payouts']

export function classifyGumroadError(status: number, body: unknown): ConnectorError {
  const msg = (isRecord(body) && typeof body.message === 'string' && body.message) || `Gumroad HTTP ${status}`
  let kind: ConnectorErrorKind
  if (status === 401 || status === 403) kind = 'auth'
  else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 402 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, msg.slice(0, 300), { provider: 'gumroad', status })
}

export class GumroadClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'gumroad',
      baseUrl: GUMROAD_API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      rateLimit: { perSecond: 2, burst: 4 },
      classifyError: ({ status, body }) => classifyGumroadError(status, body),
    })
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
