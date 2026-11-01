// Mercury HTTP client. Auth is a Mercury API token ("secret-token:mercury_production_...") sent as a Bearer token.
// Aggregate asks for a Read Only token (no IP allow-list needed) and only calls GET endpoints.

import { ConnectorError, HttpClient, providerMessage, type ConnectorDeps, type HttpErrorInfo, type HttpRequest } from '@agfn/connector-sdk'

export const MERCURY_BASE_URL = 'https://api.mercury.com/api/v1'
export const MERCURY_SANDBOX_URL = 'https://api-sandbox.mercury.com/api/v1'

/**
 * Mercury documents no error body or rate-limit headers; classify by status and pass any message through. `oauth`
 * picks the fix to suggest: a sign-in is reconnected, a pasted token is replaced.
 */
export function classifyMercuryError({ status, body }: HttpErrorInfo, auth: { oauth?: boolean } = {}): ConnectorError {
  const { message, code } = providerMessage(body)
  const opts = { provider: 'mercury', status, ...(code ? { code } : {}) }
  if (status === 401) {
    return new ConnectorError(
      'auth',
      auth.oauth
        ? 'Mercury rejected the sign-in (it was revoked in Mercury or expired); reconnect Mercury'
        : 'Mercury rejected the API token. Tokens unused for 45 days are deleted by Mercury; create a new Read Only token and reconnect',
      { ...opts, forUser: true },
    )
  }
  if (status === 403 && auth.oauth) {
    return new ConnectorError('auth', 'Mercury refused access; reconnect Mercury and approve read access', { ...opts, forUser: true })
  }
  if (status === 403) {
    return new ConnectorError('auth', 'Mercury refused access; use a Read Only token, or check the token’s IP allow-list', { ...opts, forUser: true })
  }
  if (status === 429) return new ConnectorError('rate_limited', message ?? 'Mercury rate limit', opts)
  if (status >= 500 || status === 408) return new ConnectorError('transient', message ?? `Mercury HTTP ${status}`, opts)
  if (status === 400) return new ConnectorError('invalid_input', message ?? 'Mercury rejected the request', opts)
  return new ConnectorError('permanent', message ?? `Mercury HTTP ${status}`, opts)
}

export class MercuryClient {
  private readonly http: HttpClient

  constructor(token: string, deps: Omit<ConnectorDeps, 'raw'>, baseUrl: string = MERCURY_BASE_URL, auth: { oauth?: boolean } = {}) {
    this.http = new HttpClient({
      provider: 'mercury',
      baseUrl,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${token}` },
      // Undocumented limits; stay conservative.
      rateLimit: { perSecond: 5, burst: 10 },
      classifyError: (info) => classifyMercuryError(info, auth),
    })
  }

  async get<T>(path: string, query?: HttpRequest['query']): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
