// Square HTTP client: bearer token per connection, Square-Version pinned, Square's {errors:[{category,code}]} bodies
// classified. Also the OAuth token calls: Square's /oauth2/token takes JSON (not a form) and answers with an ISO
// `expires_at` instead of `expires_in`, so it doesn't go through the SDK's form-based token exchange.

import { ConnectorError, HttpClient, type ConnectorDeps, type ConnectorErrorKind, type HttpRequest } from '@agfn/connector-sdk'
import type { SquareError, SquareTokenResponse } from './types.ts'

export type SquareEnv = 'production' | 'sandbox'

export const SQUARE_HOSTS: Record<SquareEnv, string> = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
}

/** Confirmed against the Square API reference (Payouts API examples) on 2026-10-09. */
export const SQUARE_VERSION = '2026-09-16'

/** Least privilege: payouts and their entries (PAYOUTS_READ), locations and merchant (MERCHANT_PROFILE_READ), invoices. */
export const SQUARE_SCOPES = ['PAYOUTS_READ', 'PAYMENTS_READ', 'MERCHANT_PROFILE_READ', 'INVOICES_READ']

export function classifySquareError(status: number, body: unknown): ConnectorError {
  const b = (body && typeof body === 'object' ? body : {}) as { errors?: SquareError[]; error?: string; error_description?: string; message?: string }
  const first = Array.isArray(b.errors) ? b.errors[0] : undefined
  const code = first?.code ?? (typeof b.error === 'string' ? b.error : undefined)
  const category = first?.category
  let message = first?.detail ?? b.error_description ?? b.message ?? `Square HTTP ${status}`
  let kind: ConnectorErrorKind
  if (code === 'INSUFFICIENT_SCOPES') {
    kind = 'auth'
    message = `Square token is missing a permission (${message}). Reconnect and grant ${SQUARE_SCOPES.join(', ')}.`
  } else if (category === 'AUTHENTICATION_ERROR' || status === 401 || code === 'invalid_grant' || code === 'invalid_client') kind = 'auth'
  // INVALID_REQUEST_ERROR can come back as 403 too: that is the request, not the token, so reconnecting won't help.
  else if (status === 403 && category === 'INVALID_REQUEST_ERROR') kind = 'invalid_input'
  else if (status === 403) kind = 'auth'
  else if (category === 'RATE_LIMIT_ERROR' || status === 429) kind = 'rate_limited'
  else if (category === 'API_ERROR' || status >= 500) kind = 'transient'
  else if (category === 'INVALID_REQUEST_ERROR' || status === 400) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 400), { provider: 'square', status, ...(code ? { code } : {}) })
}

export class SquareClient {
  private readonly http: Record<SquareEnv, HttpClient>

  constructor(deps: Omit<ConnectorDeps, 'raw'>) {
    const make = (env: SquareEnv) =>
      new HttpClient({
        provider: 'square',
        baseUrl: SQUARE_HOSTS[env],
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.clock ? { clock: deps.clock } : {}),
        ...(deps.random ? { random: deps.random } : {}),
        headers: { 'square-version': SQUARE_VERSION },
        // Square doesn't publish fixed limits; it returns 429 RATE_LIMITED when pushed. Stay modest.
        rateLimit: { perSecond: 8, burst: 10 },
        classifyError: ({ status, body }) => classifySquareError(status, body),
      })
    this.http = { production: make('production'), sandbox: make('sandbox') }
  }

  async get<T>(env: SquareEnv, accessToken: string, path: string, query?: HttpRequest['query']): Promise<T> {
    const res = await this.http[env].request<T>({ path, ...(query ? { query } : {}), headers: { authorization: `Bearer ${accessToken}` } })
    return res.data
  }

  /** POST /oauth2/revoke: ends every token this seller granted the app. Authorized with the app secret. */
  async revoke(env: SquareEnv, clientId: string, clientSecret: string, accessToken: string): Promise<void> {
    await this.http[env].request({ method: 'POST', path: '/oauth2/revoke', json: { client_id: clientId, access_token: accessToken }, headers: { authorization: `Client ${clientSecret}` }, idempotent: true })
  }

  /** POST /oauth2/token (authorization_code or refresh_token). Not retried: codes are single-use. */
  async token(env: SquareEnv, body: Record<string, string>): Promise<SquareTokenResponse> {
    const res = await this.http[env].request<SquareTokenResponse>({ method: 'POST', path: '/oauth2/token', json: body, idempotent: false })
    if (!res.data?.access_token) throw new ConnectorError('permanent', 'Square token response has no access_token', { provider: 'square' })
    return res.data
  }
}
