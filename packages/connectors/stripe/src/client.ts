// Stripe HTTP client. Read-only: only GET endpoints are ever called. Auth is `Authorization: Bearer <key>`;
// platforms reading a connected account add `Stripe-Account: acct_...`. The API version is pinned so object
// shapes don't drift with the account's default version.

import {
  ConnectorError,
  HttpClient,
  isRecord,
  type ConnectorDeps,
  type ConnectorErrorKind,
  type ConnectorErrorOptions,
  type HttpRequest,
} from '@agfn/connector-sdk'

/** Confirmed on docs.stripe.com/changelog (released 2026-08-26). */
export const STRIPE_API_VERSION = '2026-08-26.dahlia'
export const STRIPE_API_BASE = 'https://api.stripe.com'

/** A Stripe error with the extras we parse out of permission errors on restricted keys. */
export class StripeError extends ConnectorError {
  /** Restricted-key permission Stripe says is missing, e.g. "rak_balance_read". */
  readonly permission?: string
  /** Account id mentioned in a permission error ("... on account 'acct_...'"). */
  readonly accountHint?: string

  constructor(
    kind: ConnectorErrorKind,
    message: string,
    opts: ConnectorErrorOptions & { permission?: string; accountHint?: string },
  ) {
    super(kind, message, opts)
    this.name = 'StripeError'
    if (opts.permission !== undefined) this.permission = opts.permission
    if (opts.accountHint !== undefined) this.accountHint = opts.accountHint
  }
}

/** Never echo key material back, even the partly masked forms Stripe puts in messages. */
export function scrubKeys(s: string): string {
  return s.replace(/\b(sk|rk|pk|whsec)_(test_|live_)?[A-Za-z0-9*_]+/g, '$1_***')
}

const PERMISSION_RE = /'(rak_[a-z0-9_]+)'/
const ACCOUNT_RE = /\b(acct_[A-Za-z0-9_]+)/

/**
 * Stripe error bodies are {error: {type, code, message}}. 401 → auth; 403 or a "required permissions" message → auth
 * (restricted key missing a permission, with a message naming it); 429/rate_limit_error/lock_timeout → rate_limited;
 * api_error/5xx → transient; invalid_request_error and the rest → permanent.
 */
export function classifyStripeError(status: number, body: unknown): StripeError {
  const e = isRecord(body) && isRecord(body.error) ? body.error : {}
  const type = typeof e.type === 'string' ? e.type : undefined
  const code = typeof e.code === 'string' ? e.code : undefined
  const raw = typeof e.message === 'string' ? e.message : ''
  const base = { provider: 'stripe', status, ...(code ?? type ? { code: code ?? type } : {}) }
  const msg = scrubKeys(raw).slice(0, 300) || `Stripe HTTP ${status}`

  const permissionMissing = status === 403 || /required permissions?/i.test(raw)
  if (permissionMissing) {
    const permission = PERMISSION_RE.exec(raw)?.[1]
    const accountHint = ACCOUNT_RE.exec(raw)?.[1]
    const message = permission
      ? `Stripe says Aggregate is missing the '${permission}' permission. If you pasted a restricted key, give it Read access to that in the Stripe Dashboard; if you installed the Aggregate app, reconnect it to accept the app's current permissions.`
      : `Stripe says Aggregate isn't allowed to read this. If you pasted a restricted key, give it Read access in the Stripe Dashboard; if you installed the Aggregate app, reconnect it. (${msg})`
    return new StripeError('auth', message, {
      ...base,
      code: 'permission_missing',
      ...(permission ? { permission } : {}),
      ...(accountHint ? { accountHint } : {}),
    })
  }
  let kind: ConnectorErrorKind
  if (status === 401 || type === 'authentication_error') kind = 'auth'
  else if (status === 429 || type === 'rate_limit_error' || code === 'rate_limit' || code === 'lock_timeout') kind = 'rate_limited'
  // 424 is Stripe's "external dependency failed": worth another try, like a 5xx.
  else if (type === 'api_error' || status >= 500 || status === 408 || status === 424) kind = 'transient'
  else kind = 'permanent'
  return new StripeError(kind, kind === 'auth' ? `Stripe rejected the API key: ${msg}` : msg, base)
}

export interface StripeCredentials {
  apiKey: string
  /** Connected account to read via the Stripe-Account header (platform keys only). */
  stripeAccount?: string
}

export class StripeClient {
  private readonly http: HttpClient

  constructor(deps: Omit<ConnectorDeps, 'raw'>) {
    this.http = new HttpClient({
      provider: 'stripe',
      baseUrl: STRIPE_API_BASE,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { 'stripe-version': STRIPE_API_VERSION },
      // Stripe allows ~100 req/s live and ~25 req/s in test mode per account; stay under the test-mode limit.
      rateLimit: { perSecond: 20, burst: 20 },
      timeoutMs: 60_000,
      classifyError: ({ status, body }) => classifyStripeError(status, body),
    })
  }

  /**
   * Can this key write here? An empty POST to a money-moving endpoint (/v1/refunds, /v1/payouts) can never create
   * anything: Stripe needs a charge or an amount. A key without write access is refused first (permission error →
   * 'blocked'); one with it gets "missing parameter" (→ 'allowed'). Anything else is 'unknown'.
   */
  async probeWrite(creds: StripeCredentials, path: '/v1/refunds' | '/v1/payouts'): Promise<'blocked' | 'allowed' | 'unknown'> {
    try {
      await this.http.request({
        method: 'POST',
        path,
        body: '',
        headers: {
          authorization: `Bearer ${creds.apiKey}`,
          'content-type': 'application/x-www-form-urlencoded',
          ...(creds.stripeAccount ? { 'stripe-account': creds.stripeAccount } : {}),
        },
      })
      return 'unknown'
    } catch (e) {
      if (e instanceof StripeError && e.code === 'permission_missing') return 'blocked'
      if (e instanceof StripeError && e.status === 400 && (e.code === 'parameter_missing' || e.code === 'invalid_request_error')) return 'allowed'
      return 'unknown'
    }
  }

  async get<T>(creds: StripeCredentials, path: string, query?: HttpRequest['query']): Promise<T> {
    const res = await this.http.request<T>({
      method: 'GET',
      path,
      ...(query ? { query } : {}),
      headers: {
        authorization: `Bearer ${creds.apiKey}`,
        ...(creds.stripeAccount ? { 'stripe-account': creds.stripeAccount } : {}),
      },
    })
    return res.data
  }
}
