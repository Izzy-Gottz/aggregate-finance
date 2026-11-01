// PayPal REST client. The company brings its own REST app (client_id + client_secret); we mint an OAuth2
// client_credentials token from /v1/oauth2/token, cache it until shortly before expiry, and refresh it once on a 401.
// Read-only: only reporting, invoicing list and webhook-verification endpoints are ever called.

import { ConnectorError, HttpClient, type ConnectorDeps, type ConnectorErrorKind, type HttpRequest, systemClock, type Clock } from '@agfn/connector-sdk'
import type { PayPalTokenResponse } from './types.ts'

export type PayPalEnv = 'sandbox' | 'live'

export const PAYPAL_HOSTS: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}

export interface PayPalCredentials {
  clientId: string
  clientSecret: string
  env: PayPalEnv
  /**
   * Partner mode: Aggregate's own REST app (clientId/secret) acting for a seller who granted it access during partner
   * onboarding. Every seller-data call carries PayPal-Auth-Assertion naming that seller. Partner-level calls (creating
   * a referral, reading a seller's onboarding status) leave this unset: they're made as ourselves, token only.
   */
  payerId?: string
  /** Partner attribution id (BN code), sent as PayPal-Partner-Attribution-Id when set. */
  bnCode?: string
}

/** The unsigned JWT PayPal expects in PayPal-Auth-Assertion: {"alg":"none"}.{"iss":client_id,"payer_id":…}. */
export function authAssertion(clientId: string, payerId: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
  return `${b64({ alg: 'none' })}.${b64({ iss: clientId, payer_id: payerId })}.`
}

/** Message shown when Transaction Search isn't enabled on the REST app (PayPal answers 403 NOT_AUTHORIZED). */
export const TXN_SEARCH_HINT =
  'PayPal refused the request. In the PayPal developer dashboard, open this REST app and enable "Transaction search" (and "Invoicing" for invoices), then reconnect.'

/** The same 403 for a seller connected through partner sign-in: they have no REST app of their own to fix. */
export const PARTNER_ACCESS_HINT =
  'PayPal refused the request: this PayPal account hasn’t given Aggregate that access. Reconnect PayPal from Aggregate and approve the access PayPal asks for.'

/** Transaction Search's answer when a date range holds more rows than it will return (about 10,000). */
export const RESULTSET_TOO_LARGE = 'RESULTSET_TOO_LARGE'

export function classifyPayPalError(status: number, body: unknown): ConnectorError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  // OAuth endpoint shape: {error, error_description}. REST shape: {name, message, debug_id, details}.
  const oauthCode = typeof b.error === 'string' ? b.error : undefined
  // RESULTSET_TOO_LARGE can come as the top-level name or as an issue under details.
  const issues = Array.isArray(b.details) ? b.details.map((d) => (d && typeof d === 'object' ? (d as Record<string, unknown>).issue : undefined)) : []
  const name = issues.includes(RESULTSET_TOO_LARGE) ? RESULTSET_TOO_LARGE : typeof b.name === 'string' ? b.name : oauthCode
  const message =
    (typeof b.message === 'string' && b.message) ||
    (typeof b.error_description === 'string' && b.error_description) ||
    `PayPal HTTP ${status}`
  let kind: ConnectorErrorKind
  let msg = message
  if (oauthCode === 'invalid_client' || oauthCode === 'invalid_token' || name === 'AUTHENTICATION_FAILURE' || status === 401) {
    kind = 'auth'
  } else if (name === 'NOT_AUTHORIZED' || name === 'PERMISSION_DENIED' || status === 403) {
    kind = 'auth'
    msg = TXN_SEARCH_HINT
  } else if (name === 'RATE_LIMIT_REACHED' || status === 429) kind = 'rate_limited'
  else if (status >= 500 || name === 'INTERNAL_SERVICE_ERROR' || name === 'SERVICE_UNAVAILABLE') kind = 'transient'
  else if (name === 'INVALID_REQUEST' || status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, msg.slice(0, 400), { provider: 'paypal', status, ...(name ? { code: name } : {}), ...(msg === TXN_SEARCH_HINT ? { forUser: true } : {}) })
}

interface CachedToken {
  token: string
  expiresAt: number
}

export class PayPalClient {
  private readonly http: Record<PayPalEnv, HttpClient>
  private readonly clock: Clock
  private readonly tokens = new Map<string, CachedToken>()

  constructor(deps: Omit<ConnectorDeps, 'raw'>) {
    this.clock = deps.clock ?? systemClock
    const make = (env: PayPalEnv) =>
      new HttpClient({
        provider: 'paypal',
        baseUrl: PAYPAL_HOSTS[env],
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock: this.clock,
        ...(deps.random ? { random: deps.random } : {}),
        // PayPal doesn't publish fixed limits; Transaction Search is the slow one. Stay gentle.
        rateLimit: { perSecond: 4, burst: 8 },
        timeoutMs: 60_000,
        headers: { 'paypal-enforce-iso8601-format': 'true' },
        classifyError: ({ status, body }) => classifyPayPalError(status, body),
      })
    this.http = { sandbox: make('sandbox'), live: make('live') }
  }

  private key(c: PayPalCredentials): string {
    return `${c.env}\0${c.clientId}`
  }

  /** client_credentials token, cached until 5 minutes before expiry. */
  async token(c: PayPalCredentials, force = false): Promise<string> {
    const cached = this.tokens.get(this.key(c))
    if (!force && cached && cached.expiresAt - 5 * 60_000 > this.clock.now()) return cached.token
    const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')
    // Minting a token has no side effects, so it's safe to retry.
    const res = await this.http[c.env].request<PayPalTokenResponse>({
      method: 'POST',
      path: '/v1/oauth2/token',
      form: { grant_type: 'client_credentials' },
      headers: { authorization: `Basic ${basic}` },
      idempotent: true,
    })
    if (!res.data || typeof res.data.access_token !== 'string') {
      throw new ConnectorError('permanent', 'PayPal token response has no access_token', { provider: 'paypal' })
    }
    const expiresIn = typeof res.data.expires_in === 'number' ? res.data.expires_in : 3600
    this.tokens.set(this.key(c), { token: res.data.access_token, expiresAt: this.clock.now() + expiresIn * 1000 })
    return res.data.access_token
  }

  /** Authenticated request. A 401 with a cached token re-mints the token once (it may have been revoked early). */
  async request<T>(c: PayPalCredentials, req: HttpRequest): Promise<T> {
    const run = async (force: boolean) => {
      const token = await this.token(c, force)
      const partner = {
        ...(c.payerId ? { 'paypal-auth-assertion': authAssertion(c.clientId, c.payerId) } : {}),
        ...(c.bnCode ? { 'paypal-partner-attribution-id': c.bnCode } : {}),
      }
      return (await this.http[c.env].request<T>({ ...req, headers: { ...req.headers, ...partner, authorization: `Bearer ${token}` } })).data
    }
    try {
      return await run(false)
    } catch (e) {
      if (e instanceof ConnectorError && e.status === 401 && this.tokens.has(this.key(c))) {
        this.tokens.delete(this.key(c))
        return run(true).catch((e2: unknown) => {
          throw this.forSeller(c, e2)
        })
      }
      throw this.forSeller(c, e)
    }
  }

  /** A 403 while acting for a partner-mode seller: swap the REST-app hint for one that seller can act on. */
  private forSeller(c: PayPalCredentials, e: unknown): unknown {
    if (!c.payerId || !(e instanceof ConnectorError) || e.status !== 403 || !e.message.includes(TXN_SEARCH_HINT)) return e
    return new ConnectorError(e.kind, PARTNER_ACCESS_HINT, {
      provider: e.provider,
      forUser: true,
      status: 403,
      ...(e.code ? { code: e.code } : {}),
      ...(e.requestId ? { requestId: e.requestId } : {}),
      cause: e,
    })
  }

  get<T>(c: PayPalCredentials, path: string, query?: HttpRequest['query']): Promise<T> {
    return this.request<T>(c, { path, ...(query ? { query } : {}) })
  }
}
