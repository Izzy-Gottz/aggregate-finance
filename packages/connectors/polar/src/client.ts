// Polar HTTP client (api.polar.sh/v1, or sandbox-api.polar.sh): a Bearer token, either an organization access token
// (polar_oat_…) pasted by a self-hoster or an OAuth access token from Aggregate's Polar app. Read-only: GET only.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export type PolarEnv = 'production' | 'sandbox'

export const POLAR_API: Record<PolarEnv, string> = {
  production: 'https://api.polar.sh/v1',
  sandbox: 'https://sandbox-api.polar.sh/v1',
}

/** Where people approve Aggregate's Polar app (polar.sh/oauth2/authorize); codes become tokens at the API. */
export const POLAR_AUTHORIZE: Record<PolarEnv, string> = {
  production: 'https://polar.sh/oauth2/authorize',
  sandbox: 'https://sandbox.polar.sh/oauth2/authorize',
}

/** Read scopes only. organizations:read names the connection and lists the organizations a sign-in covers. */
export const POLAR_SCOPES = ['organizations:read', 'orders:read', 'refunds:read', 'disputes:read', 'subscriptions:read', 'discounts:read']

/** Errors: FastAPI-style { error, detail } (detail a string or a list of field errors). */
export function classifyPolarError(status: number, body: unknown): ConnectorError {
  const b = isRecord(body) ? body : {}
  const code = typeof b.error === 'string' ? b.error : undefined
  const detail = typeof b.detail === 'string' ? b.detail : `Polar HTTP ${status}`
  let kind: ConnectorErrorKind
  let message = detail
  let forUser = false
  if (status === 401) {
    kind = 'auth'
    message = 'Polar rejected the access token (it was revoked, expired or deleted). Connect Polar again.'
    forUser = true
  } else if (status === 403) {
    kind = 'auth'
    message = `The Polar access token is missing a read scope. Give it ${POLAR_SCOPES.join(', ')}, then connect again.`
    forUser = true
  } else if (status === 429) kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'polar', status, ...(code ? { code } : {}), ...(forUser ? { forUser } : {}) })
}

export class PolarClient {
  private readonly http: HttpClient

  constructor(token: string, env: PolarEnv, deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'polar',
      baseUrl: POLAR_API[env],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${token}` },
      // Polar rate-limits per organization (429 with Retry-After); a steady trickle stays clear of it.
      rateLimit: { perSecond: 2, burst: 5 },
      classifyError: ({ status, body }) => classifyPolarError(status, body),
    })
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
