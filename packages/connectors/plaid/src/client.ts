// Plaid HTTP client. Ported from moshe-site/money.mjs `plaid()`: every call is a POST with client_id + secret in
// the body. Read-only: no product that moves money (Transfer, Payment Initiation, Auth) is ever requested.

import { ConnectorError, HttpClient, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export type PlaidEnv = 'sandbox' | 'production'

export const PLAID_HOSTS: Record<PlaidEnv, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
}

export interface PlaidAppCredentials {
  clientId: string
  secret: string
  env: PlaidEnv
}

/** Plaid error codes that mean "the user must go through Link update mode" (relink). */
export const RELINK_CODES = new Set([
  'ITEM_LOGIN_REQUIRED',
  'PENDING_EXPIRATION',
  'PENDING_DISCONNECT',
  'ACCESS_NOT_GRANTED',
  'INVALID_UPDATED_USERNAME',
  'INSUFFICIENT_CREDENTIALS',
  'USER_SETUP_REQUIRED',
  'MFA_NOT_SUPPORTED',
  'NO_ACCOUNTS',
  'ITEM_LOCKED',
  'ITEM_NOT_SUPPORTED',
  'USER_INPUT_TIMEOUT',
  'ITEM_CONCURRENTLY_DELETED',
])

const TRANSIENT_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'PLANNED_MAINTENANCE',
  'INSTITUTION_DOWN',
  'INSTITUTION_NOT_RESPONDING',
  'INSTITUTION_NOT_AVAILABLE',
  'PRODUCT_NOT_READY',
])

/** Errors that mean "this optional product isn't available for this Item" (skip it, don't fail the sync). */
export const PRODUCT_UNAVAILABLE_CODES = new Set([
  'PRODUCTS_NOT_SUPPORTED',
  'PRODUCT_NOT_ENABLED',
  'NO_LIABILITY_ACCOUNTS',
  'NO_INVESTMENT_ACCOUNTS',
  'NO_INVESTMENT_AUTH_ACCOUNTS',
  'ADDITIONAL_CONSENT_REQUIRED',
  'INVALID_PRODUCT',
])

export function classifyPlaidError(status: number, body: unknown): ConnectorError {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const code = typeof b.error_code === 'string' ? b.error_code : undefined
  const type = typeof b.error_type === 'string' ? b.error_type : undefined
  const message =
    (typeof b.display_message === 'string' && b.display_message) ||
    (typeof b.error_message === 'string' && b.error_message) ||
    `Plaid HTTP ${status}`
  let kind: ConnectorErrorKind
  // The Item was removed or revoked: nothing to retry. Shown as "reconnect"; reconnecting finds it gone and asks for a
  // fresh connection (the stale token is then wiped).
  if (code === 'ITEM_NOT_FOUND') {
    return new ConnectorError('auth', 'This bank connection no longer exists at Plaid. Remove it and connect the bank again.', {
      provider: 'plaid',
      forUser: true,
      status,
      code,
      ...(typeof b.request_id === 'string' ? { requestId: b.request_id } : {}),
    })
  }
  if (code && RELINK_CODES.has(code)) kind = 'auth'
  else if (type === 'RATE_LIMIT_EXCEEDED' || status === 429) kind = 'rate_limited'
  else if ((code && TRANSIENT_CODES.has(code)) || type === 'API_ERROR' || type === 'INSTITUTION_ERROR' || status >= 500) {
    kind = 'transient'
  } else if (code === 'INVALID_ACCESS_TOKEN' || code === 'INVALID_API_KEYS' || type === 'INVALID_API_KEYS') kind = 'auth'
  else if (type === 'INVALID_INPUT' || type === 'INVALID_REQUEST') kind = 'invalid_input'
  else kind = 'permanent'
  const requestId = typeof b.request_id === 'string' ? b.request_id : undefined
  // Plaid's display_message is written for end users; error_message is for developers and stays in the log.
  return new ConnectorError(kind, message.slice(0, 300), {
    provider: 'plaid',
    ...(typeof b.display_message === 'string' && b.display_message ? { forUser: true } : {}),
    status,
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
  })
}

export class PlaidClient {
  private readonly http: HttpClient
  private readonly creds: PlaidAppCredentials

  constructor(creds: PlaidAppCredentials, deps: Omit<ConnectorDeps, 'raw'>) {
    this.creds = creds
    this.http = new HttpClient({
      provider: 'plaid',
      baseUrl: PLAID_HOSTS[creds.env],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { 'plaid-version': '2020-09-14' },
      // Plaid's limits are per Item per endpoint (e.g. /transactions/sync ~50/min/Item); stay well under per worker.
      rateLimit: { perSecond: 5, burst: 10 },
      timeoutMs: 60_000,
      classifyError: ({ status, body }) => classifyPlaidError(status, body),
    })
  }

  get env(): PlaidEnv {
    return this.creds.env
  }

  /** All Plaid read endpoints are POST but safe to retry. Mutating calls pass idempotent: false. */
  async call<T>(path: string, body: Record<string, unknown>, idempotent = true): Promise<T> {
    const res = await this.http.request<T>({
      method: 'POST',
      path,
      json: { client_id: this.creds.clientId, secret: this.creds.secret, ...body },
      idempotent,
    })
    return res.data
  }
}
