// Ramp HTTP client with OAuth 2.0 client credentials. The customer creates their own Ramp developer app and gives
// Aggregate its client id + secret; we exchange them at POST /developer/v1/token (HTTP Basic, form body) for an access
// token (client-credentials tokens normally last 10 days, no refresh token), cache it in memory until shortly
// before expires_in, and fetch a new one on expiry or on a 401. Only GET endpoints with *:read scopes are used.

import {
  ConnectorError,
  HttpClient,
  parseTokenResponse,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type HttpErrorInfo,
  type HttpRequest,
} from '@agfn/connector-sdk'

export const RAMP_HOSTS = { production: 'https://api.ramp.com', sandbox: 'https://demo-api.ramp.com' } as const
export type RampEnv = keyof typeof RAMP_HOSTS

// No cards:read: card_id comes on each transaction and we never call the cards endpoints.
export const RAMP_SCOPES = ['transactions:read', 'business:read', 'bills:read', 'reimbursements:read']

export interface RampCredentials {
  clientId: string
  clientSecret: string
  /**
   * One-click sign-in (Aggregate's partner app): clientId/clientSecret are the APP's, and this refresh token (from the
   * authorization-code grant) is exchanged for access tokens. Ramp doesn't rotate it on refresh.
   */
  refreshToken?: string
}

export const RAMP_AUTHORIZE = { production: 'https://app.ramp.com/v1/authorize', sandbox: 'https://demo.ramp.com/v1/authorize' } as const

export function classifyRampError({ status, body }: HttpErrorInfo): ConnectorError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const e2 = (b.error_v2 && typeof b.error_v2 === 'object' ? b.error_v2 : {}) as Record<string, unknown>
  const oauthCode = typeof b.error === 'string' ? b.error : undefined
  const code = (typeof e2.error_code === 'string' ? e2.error_code : undefined) ?? oauthCode
  const msg =
    (typeof e2.message === 'string' && e2.message) ||
    (typeof b.error_description === 'string' && b.error_description) ||
    (typeof b.message === 'string' && b.message) ||
    undefined
  const opts = { provider: 'ramp', status, ...(code ? { code } : {}) }
  const text = (msg ?? '').slice(0, 300)
  if (oauthCode === 'invalid_client' || oauthCode === 'unauthorized_client' || oauthCode === 'invalid_grant') {
    return new ConnectorError('auth', `Ramp rejected the app's client id/secret${text ? ` (${text})` : ''}; check the developer app in Ramp`, opts)
  }
  if (oauthCode === 'invalid_scope') {
    return new ConnectorError('auth', `Ramp app is missing a scope${text ? ` (${text})` : ''}; grant ${RAMP_SCOPES.join(', ')}`, opts)
  }
  if (status === 401) return new ConnectorError('auth', `Ramp rejected the access token${text ? ` (${text})` : ''}`, opts)
  if (status === 403) {
    return new ConnectorError('auth', `Ramp refused access${text ? ` (${text})` : ''}; the app needs the scopes ${RAMP_SCOPES.join(', ')}`, opts)
  }
  if (status === 429) return new ConnectorError('rate_limited', text || 'Ramp rate limit (200 requests per 10 seconds)', opts)
  if (status >= 500 || status === 408) return new ConnectorError('transient', text || `Ramp HTTP ${status}`, opts)
  if (status === 400 || status === 422) return new ConnectorError('invalid_input', text || 'Ramp rejected the request', opts)
  return new ConnectorError('permanent', text || `Ramp HTTP ${status}`, opts)
}

const basicAuth = (c: { clientId: string; clientSecret: string }) => Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')

/** Authorization-code exchange for Aggregate's partner app. Not retried: codes are single-use. */
export async function exchangeRampCode(
  app: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
  deps: Omit<ConnectorDeps, 'raw'>,
  opts: { env?: RampEnv; baseUrl?: string } = {},
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number; refreshExpiresAt?: number }> {
  const http = new HttpClient({
    provider: 'ramp',
    baseUrl: opts.baseUrl ?? RAMP_HOSTS[opts.env ?? 'production'],
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    classifyError: classifyRampError,
  })
  const res = await http.request<unknown>({
    method: 'POST',
    path: '/developer/v1/token',
    headers: { authorization: `Basic ${basicAuth(app)}` },
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    idempotent: false,
  })
  const now = (deps.clock ?? systemClock).now()
  const t = parseTokenResponse(res.data, 'ramp', now)
  // Sent only when the Ramp app has a refresh-token lifetime set. Refreshing never extends it, so this is final.
  const life = Number(t.extra?.refresh_token_expires_in)
  return { ...t, ...(Number.isFinite(life) && life > 0 ? { refreshExpiresAt: now + life * 1000 } : {}) }
}

/** Revoke a token issued to Aggregate's partner app (best effort is the caller's choice). */
export async function revokeRampToken(
  app: { clientId: string; clientSecret: string },
  token: string,
  deps: Omit<ConnectorDeps, 'raw'>,
  opts: { env?: RampEnv; baseUrl?: string } = {},
): Promise<void> {
  const http = new HttpClient({
    provider: 'ramp',
    baseUrl: opts.baseUrl ?? RAMP_HOSTS[opts.env ?? 'production'],
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    classifyError: classifyRampError,
  })
  await http.request<unknown>({ method: 'POST', path: '/developer/v1/token/revoke', headers: { authorization: `Basic ${basicAuth(app)}` }, form: { token }, idempotent: true, responseType: 'text' })
}

export class RampClient {
  readonly baseUrl: string
  private readonly http: HttpClient
  private readonly tokenHttp: HttpClient
  private readonly creds: RampCredentials
  private readonly scopes: string[]
  private readonly clock: Clock
  private token: { value: string; expiresAt: number } | undefined
  /** Number of token requests made (for tests and diagnostics). */
  tokenRequests = 0

  constructor(creds: RampCredentials, deps: Omit<ConnectorDeps, 'raw'>, opts: { env?: RampEnv; baseUrl?: string; scopes?: string[] } = {}) {
    this.creds = creds
    this.scopes = opts.scopes ?? RAMP_SCOPES
    this.clock = deps.clock ?? systemClock
    this.baseUrl = opts.baseUrl ?? RAMP_HOSTS[opts.env ?? 'production']
    const common = {
      provider: 'ramp',
      baseUrl: this.baseUrl,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      classifyError: classifyRampError,
    }
    this.tokenHttp = new HttpClient({ ...common, retry: { maxAttempts: 3 } })
    this.http = new HttpClient({
      ...common,
      // Ramp: 200 requests per rolling 10 s per IP.
      rateLimit: { perSecond: 10, burst: 20 },
      headers: async () => ({ authorization: `Bearer ${await this.accessToken()}` }),
    })
  }

  /** Cached client-credentials token; refreshed 5 minutes before expiry. */
  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - 5 * 60_000 > this.clock.now()) return this.token.value
    this.tokenRequests++
    const refresh = this.creds.refreshToken
    let res
    try {
      res = await this.tokenHttp.request<unknown>({
        method: 'POST',
        path: '/developer/v1/token',
        headers: { authorization: `Basic ${basicAuth(this.creds)}` },
        form: refresh ? { grant_type: 'refresh_token', refresh_token: refresh } : { grant_type: 'client_credentials', scope: this.scopes.join(' ') },
        // Neither grant uses a single-use code (Ramp doesn't rotate refresh tokens), so retrying is safe.
        idempotent: true,
      })
    } catch (e) {
      if (refresh && e instanceof ConnectorError && e.code === 'invalid_grant') {
        throw new ConnectorError('auth', 'Ramp sign-in expired or was removed in Ramp; reconnect Ramp', { provider: 'ramp', status: e.status ?? 400, code: 'invalid_grant' })
      }
      throw e
    }
    const t = parseTokenResponse(res.data, 'ramp', this.clock.now())
    // Ramp documents ~10 days for client credentials; assume 1 hour if expires_in is missing.
    this.token = { value: t.accessToken, expiresAt: t.expiresAt ?? this.clock.now() + 3_600_000 }
    return t.accessToken
  }

  invalidate(): void {
    this.token = undefined
  }

  /** GET a path or a `page.next` URL. A 401 drops the cached token and retries once with a fresh one. */
  async get<T>(pathOrUrl: string, query?: HttpRequest['query']): Promise<T> {
    if (/^https?:\/\//.test(pathOrUrl) && new URL(pathOrUrl).origin !== new URL(this.baseUrl).origin) {
      throw new ConnectorError('permanent', 'Ramp pagination link points at another host', { provider: 'ramp' })
    }
    for (let attempt = 0; ; attempt++) {
      const before = this.tokenRequests
      try {
        const res = await this.http.request<T>({ path: pathOrUrl, ...(query ? { query } : {}) })
        return res.data
      } catch (e) {
        // Retry only when a cached token was rejected (revoked/rotated early), not when a fresh one just failed.
        if (attempt === 0 && e instanceof ConnectorError && e.status === 401 && this.tokenRequests === before) {
          this.invalidate()
          continue
        }
        throw e
      }
    }
  }
}
