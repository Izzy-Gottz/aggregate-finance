// OAuth 2.0 authorization-code helper (with optional PKCE) for connectors like QuickBooks, Xero, Square, Shopify.
// Providers that rotate refresh tokens (QuickBooks, Xero) return a new one on each refresh; callers must persist
// the returned tokens (SyncResult.updatedSecret) or the next refresh fails.

import { createHash, randomBytes } from 'node:crypto'
import { ConnectorError } from './errors.ts'
import { HttpClient, type Clock, type FetchLike, systemClock } from './http.ts'

export interface OAuthClientConfig {
  provider: string
  authorizeUrl: string
  tokenUrl: string
  clientId: string
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /** 'basic': client credentials in an Authorization header (QuickBooks, Xero). 'body': in the form. */
  clientAuth?: 'basic' | 'body'
  /** 'form' (default, RFC 6749 §2.3.1): id and secret URL-encoded inside the Basic header. 'raw': as they are, for
   *  providers that compare the decoded header literally (Deel, whose secrets end in '=='). */
  basicEncoding?: 'form' | 'raw'
  /** 'form' (default): URL-encoded token requests. 'json': a JSON body, for providers documented that way (FreshBooks). */
  tokenBody?: 'form' | 'json'
  scopeSeparator?: string
  /** Response header with the provider's request id, put on token-call errors (see HttpClientOptions). */
  requestIdHeader?: string
  fetch?: FetchLike
  clock?: Clock
}

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds. */
  expiresAt?: number
  scope?: string
  tokenType?: string
  /** Provider extras from the token response (realmId, tenant ids, merchant_id...). */
  extra?: Record<string, unknown>
}

export interface Pkce {
  verifier: string
  challenge: string
  method: 'S256'
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256' }
}

export function createState(): string {
  return randomBytes(24).toString('base64url')
}

export class OAuthClient {
  private readonly http: HttpClient
  private readonly clock: Clock
  private readonly cfg: OAuthClientConfig

  constructor(cfg: OAuthClientConfig) {
    this.cfg = cfg
    this.clock = cfg.clock ?? systemClock
    this.http = new HttpClient({
      provider: cfg.provider,
      baseUrl: cfg.tokenUrl,
      ...(cfg.fetch ? { fetch: cfg.fetch } : {}),
      clock: this.clock,
      retry: { maxAttempts: 3 },
      ...(cfg.requestIdHeader ? { requestIdHeader: cfg.requestIdHeader } : {}),
      classifyError: ({ status, body }) => {
        const b = (body ?? {}) as Record<string, unknown>
        const code = typeof b.error === 'string' ? b.error : undefined
        const desc = typeof b.error_description === 'string' ? b.error_description.slice(0, 300) : undefined
        if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
          return new ConnectorError('auth', desc ?? code, { provider: cfg.provider, status, code })
        }
        return undefined
      },
    })
  }

  authorizationUrl(opts: { state: string; pkce?: Pkce; extraParams?: Record<string, string> }): string {
    const u = new URL(this.cfg.authorizeUrl)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', this.cfg.clientId)
    u.searchParams.set('redirect_uri', this.cfg.redirectUri)
    u.searchParams.set('state', opts.state)
    if (this.cfg.scopes?.length) u.searchParams.set('scope', this.cfg.scopes.join(this.cfg.scopeSeparator ?? ' '))
    if (opts.pkce) {
      u.searchParams.set('code_challenge', opts.pkce.challenge)
      u.searchParams.set('code_challenge_method', opts.pkce.method)
    }
    for (const [k, v] of Object.entries(opts.extraParams ?? {})) u.searchParams.set(k, v)
    return u.toString()
  }

  /** `extraParams` go in the token request body (e.g. Shopify's expiring=1). */
  exchangeCode(code: string, opts: { codeVerifier?: string; extraParams?: Record<string, string> } = {}): Promise<OAuthTokens> {
    if (!code) throw new ConnectorError('invalid_input', 'missing authorization code', { provider: this.cfg.provider })
    return this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.redirectUri,
      ...(opts.codeVerifier ? { code_verifier: opts.codeVerifier } : {}),
      ...opts.extraParams,
    })
  }

  /** Client credentials grant: an app acting for itself (e.g. a store owner's own Shopify app). No refresh token. */
  clientCredentials(extraParams: Record<string, string> = {}): Promise<OAuthTokens> {
    return this.token({ grant_type: 'client_credentials', ...extraParams })
  }

  /** Refresh. If the provider doesn't rotate, the old refresh token is carried over. `extraParams` go in the body
   *  (Mercury requires `scope`). */
  async refresh(tokens: OAuthTokens, extraParams: Record<string, string> = {}): Promise<OAuthTokens> {
    if (!tokens.refreshToken) {
      throw new ConnectorError('auth', 'no refresh token; reconnect required', { provider: this.cfg.provider })
    }
    const next = await this.token({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, ...extraParams })
    return {
      ...next,
      refreshToken: next.refreshToken ?? tokens.refreshToken,
      ...(tokens.extra || next.extra ? { extra: { ...tokens.extra, ...next.extra } } : {}),
    }
  }

  /** Any other grant at the token URL (e.g. RFC 8693 token exchange), with this client's credentials. */
  grant(grantType: string, params: Record<string, string>): Promise<OAuthTokens> {
    return this.token({ grant_type: grantType, ...params })
  }

  isExpired(tokens: OAuthTokens, skewMs = 60_000): boolean {
    return tokens.expiresAt !== undefined && tokens.expiresAt - skewMs <= this.clock.now()
  }

  /** Returns usable tokens and whether they changed (so the caller persists them). */
  async ensureFresh(tokens: OAuthTokens, skewMs = 60_000): Promise<{ tokens: OAuthTokens; refreshed: boolean }> {
    if (!this.isExpired(tokens, skewMs)) return { tokens, refreshed: false }
    return { tokens: await this.refresh(tokens), refreshed: true }
  }

  private async token(params: Record<string, string>): Promise<OAuthTokens> {
    const form: Record<string, string> = { ...params }
    const headers: Record<string, string> = {}
    if ((this.cfg.clientAuth ?? 'basic') === 'basic' && this.cfg.clientSecret) {
      const enc = this.cfg.basicEncoding === 'raw' ? (v: string) => v : encodeURIComponent
      headers.authorization = 'Basic ' + Buffer.from(`${enc(this.cfg.clientId)}:${enc(this.cfg.clientSecret)}`).toString('base64')
    } else {
      form.client_id = this.cfg.clientId
      if (this.cfg.clientSecret) form.client_secret = this.cfg.clientSecret
    }
    // Token requests aren't idempotent for authorization_code (codes are single-use), but a refresh is safe to retry
    // only before the provider has rotated; we retry neither on non-network errors.
    const res = await this.http.request<Record<string, unknown>>({
      method: 'POST',
      path: this.cfg.tokenUrl,
      ...(this.cfg.tokenBody === 'json' ? { json: form } : { form }),
      headers,
      idempotent: false,
    })
    return parseTokenResponse(res.data, this.cfg.provider, this.clock.now())
  }
}

export function parseTokenResponse(data: unknown, provider: string, now: number): OAuthTokens {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.access_token !== 'string' || !d.access_token) {
    throw new ConnectorError('permanent', 'token response has no access_token', { provider })
  }
  const known = new Set(['access_token', 'refresh_token', 'expires_in', 'expires_at', 'scope', 'token_type'])
  const extra = Object.fromEntries(Object.entries(d).filter(([k]) => !known.has(k)))
  const expiresIn = typeof d.expires_in === 'number' ? d.expires_in : typeof d.expires_in === 'string' ? Number(d.expires_in) : NaN
  // Some providers (Justworks) send an absolute expires_at: epoch seconds, epoch ms, or an ISO string.
  let expiresAt = Number.isFinite(expiresIn) ? now + expiresIn * 1000 : NaN
  if (!Number.isFinite(expiresAt)) {
    const at = d.expires_at
    const n = typeof at === 'number' ? at : typeof at === 'string' && /^\d+(\.\d+)?$/.test(at) ? Number(at) : NaN
    if (Number.isFinite(n)) expiresAt = n < 1e12 ? n * 1000 : n
    else if (typeof at === 'string') expiresAt = Date.parse(at)
  }
  return {
    accessToken: d.access_token,
    ...(typeof d.refresh_token === 'string' && d.refresh_token ? { refreshToken: d.refresh_token } : {}),
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
    ...(typeof d.scope === 'string' ? { scope: d.scope } : {}),
    ...(typeof d.token_type === 'string' ? { tokenType: d.token_type } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}
