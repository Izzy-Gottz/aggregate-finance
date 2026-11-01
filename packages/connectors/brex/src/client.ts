// Brex HTTP client (https://api.brex.com). Auth is a Brex user token (bxt_...) as a Bearer token. Aggregate only calls
// read endpoints (accounts and transactions, *.readonly scopes); nothing here can move money.

import { ConnectorError, HttpClient, providerMessage, type ConnectorDeps, type HttpErrorInfo, type HttpRequest } from '@agfn/connector-sdk'

export const BREX_BASE_URL = 'https://api.brex.com'

export const BREX_EXPIRY_HINT =
  'Brex user tokens expire after 90 days without an API call, or when the user who created them is deactivated; create a new token in Brex (Developer > Settings) and reconnect'

export function classifyBrexError({ status, body }: HttpErrorInfo): ConnectorError {
  const { message, code } = providerMessage(body)
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const type = typeof b.type === 'string' ? b.type : undefined
  const opts = { provider: 'brex', status, ...(code ?? type ? { code: code ?? type } : {}) }
  if (status === 401 || (status === 403 && /expired|revoked|invalid/i.test(message ?? ''))) {
    return new ConnectorError('auth', `Brex rejected the token. ${BREX_EXPIRY_HINT}`, { ...opts, forUser: true })
  }
  if (status === 403) {
    return new ConnectorError(
      'auth',
      'Brex refused access; the token needs read-only access to accounts and transactions (accounts.card.readonly, accounts.cash.readonly, transactions.card.readonly, transactions.cash.readonly)',
      { ...opts, forUser: true },
    )
  }
  if (status === 429) return new ConnectorError('rate_limited', message ?? 'Brex rate limit (1,000 requests per minute)', opts)
  if (status >= 500 || status === 408) return new ConnectorError('transient', message ?? `Brex HTTP ${status}`, opts)
  if (status === 400) return new ConnectorError('invalid_input', message ?? 'Brex rejected the request', opts)
  return new ConnectorError('permanent', message ?? `Brex HTTP ${status}`, opts)
}

export class BrexClient {
  private readonly http: HttpClient

  constructor(token: string, deps: Omit<ConnectorDeps, 'raw'>, baseUrl: string = BREX_BASE_URL) {
    this.http = new HttpClient({
      provider: 'brex',
      baseUrl,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      headers: { authorization: `Bearer ${token}` },
      // Brex allows 1,000 requests per 60 s per client and account; stay well under.
      rateLimit: { perSecond: 8, burst: 16 },
      classifyError: classifyBrexError,
    })
  }

  async get<T>(path: string, query?: HttpRequest['query']): Promise<T> {
    const res = await this.http.request<T>({ path, ...(query ? { query } : {}) })
    return res.data
  }
}
