// Patreon API v2 client. Bearer token (from Aggregate's Patreon client, or a Creator's Access Token); this client only
// ever issues GETs. Patreon's docs: without a User-Agent, "your calls may be dropped with a 403 response".
//
// v2 returns no attributes unless they're asked for, so the lists below are the whole of what Aggregate can see. No
// name, email, address, note or user: `customer` is the opaque member id, and map.ts stores only these fields.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export const PATREON_API = 'https://www.patreon.com'
export const PATREON_V2 = '/api/oauth2/v2'
export const PATREON_AUTHORIZE_URL = 'https://www.patreon.com/oauth2/authorize'
export const PATREON_TOKEN_URL = 'https://www.patreon.com/api/oauth2/token'
export const PATREON_USER_AGENT = 'Aggregate - Sync App'
/** Never identity[email], campaigns.members[email] or campaigns.members.address. */
export const PATREON_SCOPES = ['identity', 'campaigns', 'campaigns.members']
export const PATREON_CAMPAIGN_FIELDS = ['currency', 'is_monthly', 'pay_per_name'] as const
export const PATREON_MEMBER_FIELDS = [
  'patron_status',
  'currently_entitled_amount_cents',
  'will_pay_amount_cents',
  'pledge_cadence',
  'is_free_trial',
  'is_gifted',
  'last_charge_status',
  'last_charge_date',
  'next_charge_date',
  'pledge_relationship_start',
  'campaign_lifetime_support_cents',
] as const

export function classifyPatreonError(status: number, body: unknown): ConnectorError {
  const first = isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : undefined
  const message = (typeof first?.detail === 'string' && first.detail) || `Patreon HTTP ${status}`
  const code = typeof first?.code_name === 'string' ? first.code_name : undefined
  let kind: ConnectorErrorKind
  if (status === 401) kind = 'auth'
  else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  // 403 is "hidden for administrators" or a dropped call, not a dead login: reconnecting wouldn't help.
  else kind = 'permanent'
  // The docs: "Treat all attributes in the response as optional."
  const after = typeof first?.retry_after_seconds === 'number' ? first.retry_after_seconds : undefined
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'patreon', status, ...(code ? { code } : {}), ...(after !== undefined ? { retryAfterMs: after * 1000 } : {}) })
}

export class PatreonClient {
  private readonly http: HttpClient

  constructor(accessToken: string, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'patreon',
      baseUrl: PATREON_API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': PATREON_USER_AGENT },
      // 100 requests a minute per token.
      rateLimit: { perSecond: 1.5, burst: 5 },
      classifyError: ({ status, body }) => classifyPatreonError(status, body),
    })
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ path: `${PATREON_V2}${path}`, ...(query ? { query } : {}) })
    return res.data
  }
}
