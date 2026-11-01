// Paddle Billing HTTP client: Bearer API key, sandbox or live host. Read-only: only GET list/get endpoints are used.

import { ConnectorError, HttpClient, isRecord, type ConnectorDeps, type ConnectorErrorKind } from '@agfn/connector-sdk'

export type PaddleEnv = 'sandbox' | 'live'

export const PADDLE_HOSTS: Record<PaddleEnv, string> = {
  sandbox: 'https://sandbox-api.paddle.com',
  live: 'https://api.paddle.com',
}

/** Paddle keys carry their environment: pdl_live_apikey_… / pdl_sdbx_apikey_… (older keys have no prefix). */
export function envFromKey(key: string): PaddleEnv | undefined {
  if (key.startsWith('pdl_live_')) return 'live'
  if (key.startsWith('pdl_sdbx_')) return 'sandbox'
  return undefined
}

/** Error body: { error: { type, code, detail, documentation_url, errors? }, meta: { request_id } }. */
export function classifyPaddleError(status: number, body: unknown): ConnectorError {
  const err = isRecord(body) && isRecord(body.error) ? body.error : {}
  const code = typeof err.code === 'string' ? err.code : undefined
  const detail = typeof err.detail === 'string' ? err.detail : `Paddle HTTP ${status}`
  let kind: ConnectorErrorKind
  let message = detail
  let forUser = false
  if (status === 401 || code === 'authentication_missing' || code === 'authentication_malformed' || code === 'invalid_token') {
    kind = 'auth'
    message = 'Paddle rejected the API key. Paddle keys expire (after 90 days unless a later date was set) or can be revoked; create a new key with read access and reconnect.'
    forUser = true
  } else if (status === 403 || code === 'forbidden') {
    kind = 'auth'
    message = 'The Paddle API key is missing a read permission. Give it Read for transactions, adjustments, subscriptions and discounts, then reconnect.'
    forUser = true
  } else if (status === 429 || code === 'too_many_requests') kind = 'rate_limited'
  else if (status >= 500 || status === 408) kind = 'transient'
  else if (status === 400 || status === 422) kind = 'invalid_input'
  else kind = 'permanent'
  return new ConnectorError(kind, message.slice(0, 300), { provider: 'paddle', status, ...(code ? { code } : {}), ...(forUser ? { forUser } : {}) })
}

export class PaddleClient {
  readonly env: PaddleEnv
  private readonly http: HttpClient

  constructor(apiKey: string, env: PaddleEnv, deps: Omit<ConnectorDeps, 'raw'>) {
    this.env = env
    this.http = new HttpClient({
      provider: 'paddle',
      baseUrl: PADDLE_HOSTS[env],
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${apiKey}`, 'paddle-version': '1' },
      // Paddle allows 240 requests/minute per IP; stay well under.
      rateLimit: { perSecond: 2, burst: 5 },
      classifyError: ({ status, body }) => classifyPaddleError(status, body),
    })
  }

  /** GET a path (or an absolute `meta.pagination.next` URL). */
  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    if (/^https?:\/\//.test(path) && !path.startsWith(PADDLE_HOSTS[this.env])) {
      throw new ConnectorError('permanent', 'refusing to follow a pagination link to another host', { provider: 'paddle' })
    }
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}), headers: { 'skip-count': 'true' } })
    return res.data
  }
}
