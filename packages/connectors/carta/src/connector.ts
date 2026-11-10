// Carta connector: a person's private company stakes from Carta's Portfolio API (read-only OAuth).
//
// Each sync reads every portfolio the person shared and, per company (issuer): share certificates, restricted stock
// awards, convertible notes and SAFEs, the latest 409A, and security transactions (sales). It emits investment.event
// only (map.ts): no accounts, balances or cash rows, so a stake never doubles as an account balance and the bank's
// own rows stay the only cash.
//
// OAuth: authorization code; access tokens last an hour, refresh tokens 14 days and rotate on every refresh, so the
// new pair is saved before anything else. The playground (CARTA_ENV=playground) has its own login and API hosts.
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, InvestmentEvent, NormalizedEvent } from '@agfn/contracts'
import {
  type ConnectorDeps,
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  isRecord,
  OAuthClient,
  type OAuthTokens,
  requireSecret,
  str,
  type SyncResultWithSecret,
  systemClock,
} from '@agfn/connector-sdk'
import { mapIssuer, PROVIDER, scopeOf, type IssuerData, type IssuerRef } from './map.ts'

export { PROVIDER }
const HOSTS = {
  production: { login: 'https://login.app.carta.com', api: 'https://api.carta.com' },
  playground: { login: 'https://login.playground.carta.team', api: 'https://api.playground.carta.team' },
} as const
/** Exactly what the sync reads: portfolios and issuers, their securities, 409As, and transactions. */
export const DEFAULT_SCOPES = ['read_portfolio_info', 'read_portfolio_securities', 'read_portfolio_issuervaluations', 'read_portfolio_transactions']
/** Safety stop for a list whose next page token never ends (Carta's mock repeats it). */
const MAX_PAGES = 50
/** Portfolios one sign-in can add (Carta's consent allows up to 50). */
const MAX_PORTFOLIOS = 50

export interface CartaSecret {
  tokens: OAuthTokens
}

export interface CartaOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string; scopes?: string[] }
  env?: 'production' | 'playground'
  /** API host override (tests, or Carta's mock at https://mock-api.carta.com). */
  apiBase?: string
}

interface CursorState {
  /** The portfolio's companies, found by the listing page; one company per later page. */
  issuers: IssuerRef[]
  i: number
  /** When this full pass began (listing.complete voids what it didn't see since). */
  startedAt: string
}
const isIssuer = (v: unknown): v is IssuerRef => isRecord(v) && typeof v.portfolioId === 'string' && typeof v.issuerId === 'string' && typeof v.name === 'string'
const isState = (v: unknown): v is CursorState => isRecord(v) && Array.isArray(v.issuers) && v.issuers.every(isIssuer) && typeof v.i === 'number' && typeof v.startedAt === 'string'
/** Mapping version: bump when the mapping changes, so existing connections re-read everything once. */
export const MAPPING_VERSION = 1
const codec = cursorCodec<CursorState>(PROVIDER, MAPPING_VERSION, isState)
const isSecret = (s: unknown): s is CartaSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

export function classifyCartaError({ status, headers, body }: { status: number; headers: Headers; body: unknown }): ConnectorError | undefined {
  const b = isRecord(body) ? body : {}
  const detail = (str(b.message) ?? str(b.detail) ?? str(b.title) ?? str(b.error_description) ?? `HTTP ${status}`).slice(0, 300)
  const opts = { provider: PROVIDER, status }
  if (status === 401) return new ConnectorError('auth', detail, opts)
  // 403 is a scope the person didn't grant (or Carta hasn't approved for the app): not a broken login.
  if (status === 403) return new ConnectorError('permanent', `Carta didn't allow this read: ${detail}`, { ...opts, code: 'scope' })
  if (status === 429) {
    const ra = Number(headers.get('retry-after') ?? '')
    return new ConnectorError('rate_limited', 'Carta rate limit', { ...opts, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000 })
  }
  if (status >= 500) return new ConnectorError('transient', detail, opts)
  return new ConnectorError('permanent', detail, opts)
}

export function createCartaConnector(opts: CartaOptions): Connector & { authorizationUrl(state: string): string } {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const hosts = HOSTS[opts.env ?? 'production']
  const apiBase = `${opts.apiBase ?? hosts.api}/v1alpha1`
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: `${hosts.login}/o/authorize/`,
    tokenUrl: `${hosts.login}/o/access_token/`,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    scopes: opts.oauth.scopes ?? DEFAULT_SCOPES,
    clientAuth: 'basic',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  function client(tokens: OAuthTokens): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: apiBase,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      rateLimit: { perSecond: 4, burst: 4 },
      headers: { authorization: `Bearer ${tokens.accessToken}` },
      classifyError: classifyCartaError,
    })
  }

  /** Every item of a paged Carta list (`pageToken` in, `nextPageToken` out). */
  async function all(http: HttpClient, path: string, key: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const ids = new Set<string>()
    let token: string | undefined
    for (let n = 0; n < MAX_PAGES; n++) {
      const res = await http.request<Record<string, unknown>>({ path, query: token ? { pageToken: token } : {} })
      // A present object with the key omitted/empty is a real empty page; a null/non-object body (an empty body, or the
      // sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop, never read as zero.
      if (!isRecord(res.data)) throw new ConnectorError('transient', 'Carta sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
      const items = res.data[key]
      // A page that repeats items (Carta's mock serves the same page for every token) adds nothing twice.
      for (const it of Array.isArray(items) ? items.filter(isRecord) : []) {
        const id = str(it.id) ?? str(it.portfolioId) ?? JSON.stringify(it)
        if (!ids.has(id)) out.push(it), ids.add(id)
      }
      token = str(res.data.nextPageToken)
      if (!token || seen.has(token) || !Array.isArray(items) || !items.length) return out
      seen.add(token)
    }
    // Still a fresh next-page token after the cap: stop visibly. A partial list here would feed listing.complete and
    // wrongly void the holdings on the pages never fetched.
    throw new ConnectorError('permanent', 'Carta returned more list pages than Aggregate can page through, so this sync stopped. No totals were changed.', { provider: PROVIDER, forUser: true })
  }

  /** The companies one portfolio holds. */
  async function listIssuers(http: HttpClient, portfolioId: string): Promise<IssuerRef[]> {
    const out: IssuerRef[] = []
    for (const i of await all(http, `/portfolios/${encodeURIComponent(portfolioId)}/issuers`, 'issuers')) {
      const issuerId = str(i.id) ?? str(i.issuerId)
      if (issuerId) out.push({ portfolioId, issuerId, name: (str(i.doingBusinessAsName) ?? str(i.legalName) ?? 'Company').slice(0, 120) })
    }
    return out
  }

  async function issuerEvents(http: HttpClient, conn: ConnectionRef, issuer: IssuerRef): Promise<InvestmentEvent[]> {
    const at = `/portfolios/${encodeURIComponent(issuer.portfolioId)}/issuers/${encodeURIComponent(issuer.issuerId)}`
    const data: IssuerData = {
      certificates: await all(http, `${at}/certificates`, 'certificates'),
      restrictedStockAwards: await all(http, `${at}/restrictedStockAwards`, 'restrictedStockAwards'),
      convertibleNotes: await all(http, `${at}/convertibleNotes`, 'convertibleNotes'),
      securityTransactions: await all(http, `${at}/securityTransactions`, 'securitytransactions'),
    }
    // A 409A Carta withholds (no valuation scope, or none on file) leaves the shares at cost.
    const fmv = await http.request<Record<string, unknown>>({ path: `${at}/fairMarketValue` }).catch((e: unknown) => {
      if (e instanceof ConnectorError && (e.status === 404 || e.code === 'scope')) return undefined
      throw e
    })
    if (fmv && isRecord(fmv.data.fairMarketValue)) data.fairMarketValue = fmv.data.fairMarketValue
    const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.issuer`, `${issuer.portfolioId}:${issuer.issuerId}`, data)
    return mapIssuer(data, issuer, conn.id, rawRef)
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Carta',
    group: 'equity',
    provides: ['equity'],
    freshness: 'syncs daily',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      return oauth.authorizationUrl({ state })
    },

    /** One connection per portfolio the person shared (a person's own, or each fund, GP and SPV a firm runs). */
    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Carta sign-in did not return a code', { provider: PROVIDER })
      const tokens = await oauth.exchangeCode(code)
      const portfolios = (await all(client(tokens), '/portfolios', 'portfolios')).filter((p) => str(p.portfolioId) ?? str(p.id))
      if (!portfolios.length) throw new ConnectorError('invalid_input', 'no Carta portfolio was shared with Aggregate', { provider: PROVIDER })
      const secret: CartaSecret = { tokens }
      // They share one token pair, which rotates on refresh, so they share a key.
      const shared = portfolios.length > 1 ? { sharedSecretKey: `carta:${str(portfolios[0]!.portfolioId) ?? str(portfolios[0]!.id)}:${clock.now()}` } : {}
      const results = portfolios.slice(0, MAX_PORTFOLIOS).map((p) => {
        const portfolioId = (str(p.portfolioId) ?? str(p.id))!
        const name = str(p.legalName)
        return { secret, config: { portfolioId, ...(name ? { displayName: `Carta · ${name}`.slice(0, 120) } : {}), ...shared } }
      })
      const [first, ...rest] = results
      return { ...first!, ...(rest.length ? { additional: rest } : {}) }
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens)
      // Carta refresh tokens rotate: keep the new pair before any read can fail and strand it.
      if (refreshed) await deps.saveSecret?.(conn.id, { tokens } satisfies CartaSecret)
      const http = client(tokens)
      const portfolioId = str(conn.config.portfolioId)
      if (!portfolioId) throw new ConnectorError('invalid_input', 'connection has no Carta portfolio (portfolioId)', { provider: PROVIDER })
      const state = codec.decode(cursor)
      let events: NormalizedEvent[] = []
      let next: CursorState | null
      if (!state || state.i >= state.issuers.length) {
        const startedAt = new Date(clock.now()).toISOString()
        const issuers = await listIssuers(http, portfolioId)
        next = { issuers, i: 0, startedAt }
        if (!issuers.length) {
          events = [{ type: 'listing.complete', externalId: `listing:${startedAt}`, connectionId: conn.id, kinds: ['investment'], startedAt, scope: scopeOf(portfolioId) }]
          next = null
        }
      } else {
        events = await issuerEvents(http, conn, state.issuers[state.i]!)
        next = state.i + 1 < state.issuers.length ? { ...state, i: state.i + 1 } : null
        // A full pass finished: anything of this portfolio it didn't see (a note that converted) is gone at Carta.
        if (!next) events.push({ type: 'listing.complete', externalId: `listing:${state.startedAt}`, connectionId: conn.id, kinds: ['investment'], startedAt: state.startedAt, scope: scopeOf(portfolioId) })
      }
      // Each full pass re-reads everything (stable externalIds make it idempotent); the saved cursor starts the next one.
      const result: SyncResultWithSecret = { events, cursor: next ? codec.encode(next) : null, hasMore: next !== null }
      if (refreshed) result.updatedSecret = { tokens } satisfies CartaSecret
      return result
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const t = requireSecret(PROVIDER, conn.secret, isSecret).tokens
        // Never refreshes here: the rotated refresh token would have nowhere to go. An expired access token renews on
        // the next sync.
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await client(t).request({ path: '/portfolios' })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
