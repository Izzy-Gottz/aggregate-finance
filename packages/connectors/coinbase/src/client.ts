// Coinbase App API client (api.coinbase.com, v2 Track APIs). Two ways in: an OAuth access token ("Sign in with
// Coinbase", read scopes only) as a bearer, or a CDP API key, which signs a fresh JWT for every request (jwt.ts).
// Errors come as { errors: [{ id, message }] } (expired_token, revoked_token, invalid_token, invalid_scope,
// rate_limit_exceeded, ...); the OAuth token endpoint answers { error, error_description }.

import { ConnectorError, HttpClient, isRecord, str, type ConnectorDeps, type HttpErrorInfo, type HttpRequest } from '@agfn/connector-sdk'
import { coinbaseJwt, loadCoinbaseKey, type CoinbaseApiKey } from './jwt.ts'

export const PROVIDER = 'coinbase'
export const API_HOST = 'api.coinbase.com'
export const API_BASE = `https://${API_HOST}`
export const OAUTH_BASE = 'https://login.coinbase.com/oauth2'
/** Read only: wallets with balances, and their transactions. offline_access returns a refresh token. */
export const COINBASE_SCOPES = ['wallet:accounts:read', 'wallet:transactions:read', 'offline_access']

export type CoinbaseAuth = { kind: 'oauth'; accessToken: string } | { kind: 'key'; key: CoinbaseApiKey }

export function classifyCoinbaseError({ status, headers, body }: Pick<HttpErrorInfo, 'status' | 'headers' | 'body'>): ConnectorError {
  const first = isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : undefined
  const code = str(first?.id) ?? (isRecord(body) ? str(body.error) : undefined)
  const message = (str(first?.message) ?? (isRecord(body) ? str(body.error_description) ?? str(body.message) : undefined) ?? `Coinbase HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status, ...(code ? { code } : {}) }
  if (code === 'invalid_scope') {
    return new ConnectorError('auth', 'Coinbase access is missing a permission Aggregate needs (view wallets and transactions). Reconnect Coinbase and allow it.', { ...opts, forUser: true })
  }
  if (status === 401 || code === 'expired_token' || code === 'revoked_token' || code === 'invalid_token' || code === 'invalid_grant' || code === 'authentication_error') {
    return new ConnectorError('auth', message, opts)
  }
  if (status === 429 || code === 'rate_limit_exceeded') {
    const ra = Number(headers?.get('retry-after') ?? '')
    return new ConnectorError('rate_limited', 'Coinbase rate limit', { ...opts, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 })
  }
  // A 403 is a read this access isn't allowed (a key without View, a wallet outside the granted portfolio).
  if (status === 403) return new ConnectorError('auth', message, opts)
  if (status >= 500) return new ConnectorError('transient', message, opts)
  if (status === 400 || status === 422) return new ConnectorError('invalid_input', message, opts)
  return new ConnectorError('permanent', message, opts)
}

export class CoinbaseClient {
  private readonly http: HttpClient
  private readonly now: () => number
  private readonly auth: CoinbaseAuth
  private readonly loaded: ReturnType<typeof loadCoinbaseKey> | undefined

  constructor(auth: CoinbaseAuth, deps: Omit<ConnectorDeps, 'raw'>, baseUrl = API_BASE) {
    this.auth = auth
    this.now = () => (deps.clock ?? { now: () => Date.now() }).now()
    this.loaded = auth.kind === 'key' ? loadCoinbaseKey(auth.key.privateKey) : undefined
    this.http = new HttpClient({
      provider: PROVIDER,
      baseUrl,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      // 10,000 requests an hour per user or key; a sync needs a handful.
      rateLimit: { perSecond: 2, burst: 5 },
      headers: { accept: 'application/json' },
      classifyError: (info) => classifyCoinbaseError(info),
    })
  }

  /** GET a path ("/v2/accounts") or a pagination next_uri ("/v2/accounts?starting_after=..."). */
  async get<T>(pathOrUri: string, query?: HttpRequest['query']): Promise<T> {
    const u = new URL(pathOrUri, API_BASE)
    const q: Record<string, string> = Object.fromEntries(u.searchParams.entries())
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && !(k in q)) q[k] = String(v)
    const authorization =
      this.auth.kind === 'oauth' ? `Bearer ${this.auth.accessToken}` : `Bearer ${coinbaseJwt(this.auth.key, 'GET', API_HOST, u.pathname, this.now(), this.loaded)}`
    const res = await this.http.request<T>({ path: u.pathname, ...(Object.keys(q).length ? { query: q } : {}), headers: { authorization } })
    return res.data
  }
}
