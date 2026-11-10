// Wefunder connector: an investor's Wefunder portfolio (read:investments, read-only OAuth with PKCE).
//
// Each sync reads GET /portfolio/positions page by page and emits investment.event only (map.ts), then
// listing.complete so a position gone from Wefunder stops counting. No accounts or cash rows: the money left the
// investor's bank, which shows it.
//
// OAuth: authorization code with PKCE (S256), client secret in the form body. Test clients (pk_test_) authorize at the
// sandbox host; both use one token endpoint, which routes by the credential's prefix. Access tokens last two hours;
// every refresh rotates the refresh token, so the new pair is saved before anything else is read.
// The PKCE verifier is derived from the connect state with the client secret (HMAC), so nothing extra has to be kept
// between the redirect and the callback; the state itself is single-use and server-checked.
//
// Wefunder's rules (docs.wefunder.com/resources/acceptable-use): what a person authorized is theirs, shown only to
// them, and deleted when they revoke. The server removes a Wefunder connection's data on disconnect (ERASE_ON_DISCONNECT),
// and when the person revokes Aggregate on wefunder.com: a read refused with 401 gets one refresh, and a refresh token
// Wefunder refuses (invalid_grant) is a revoke, raised as an auth error with code 'revoked' so the server erases.
import { createHash, createHmac } from 'node:crypto'
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent } from '@agfn/contracts'
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
import { mapPosition, PROVIDER, SCOPE } from './map.ts'

export { PROVIDER }
export const API = 'https://api.wefunder.com'
export const AUTHORIZE = { live: 'https://wefunder.com/oauth/authorize', test: 'https://oauth.wefunder-sandbox.com/oauth/authorize' } as const
export const SCOPES = ['read:investments']
const PAGE = 100
/** Safety stop for a cursor that never ends. */
const MAX_PAGES = 200

export interface WefunderSecret {
  tokens: OAuthTokens
}

export interface WefunderOptions {
  deps: ConnectorDeps
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
  /** API host override (tests). */
  apiBase?: string
}

interface CursorState {
  /** Wefunder's next_cursor for the page to read (null = first page). */
  cursor: number | string | null
  pages: number
  startedAt: string
}
const isState = (v: unknown): v is CursorState =>
  isRecord(v) && (v.cursor === null || typeof v.cursor === 'number' || typeof v.cursor === 'string') && typeof v.pages === 'number' && typeof v.startedAt === 'string'
/** Mapping version: bump when the mapping changes, so existing connections re-read everything once. */
export const MAPPING_VERSION = 1
const codec = cursorCodec<CursorState>(PROVIDER, MAPPING_VERSION, isState)
const isSecret = (s: unknown): s is WefunderSecret => isRecord(s) && isRecord(s.tokens) && typeof s.tokens.accessToken === 'string'

/** Errors: { error: { type, message, request_id } }. */
export function classifyWefunderError({ status, headers, body }: { status: number; headers: Headers; body: unknown }): ConnectorError | undefined {
  const e = isRecord(body) && isRecord(body.error) ? body.error : isRecord(body) ? body : {}
  const type = str(e.type) ?? str(e.error)
  const requestId = str(e.request_id)
  const message = `${(str(e.message) ?? str(e.error_description) ?? `HTTP ${status}`).slice(0, 240)}${requestId ? ` (request ${requestId})` : ''}`
  const opts = { provider: PROVIDER, status, ...(type ? { code: type } : {}) }
  if (status === 401 || type === 'invalid_grant') return new ConnectorError('auth', message, opts)
  if (status === 403) return new ConnectorError('permanent', `Wefunder didn't allow this read: ${message}`, opts)
  if (status === 429) {
    const ra = Number(headers.get('retry-after') ?? '')
    return new ConnectorError('rate_limited', 'Wefunder rate limit', { ...opts, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000 })
  }
  if (status >= 500) return new ConnectorError('transient', message, opts)
  return new ConnectorError('permanent', message, opts)
}

/** The PKCE verifier for one connect attempt: HMAC(client secret, state), 43 base64url characters. */
/** Wefunder refused the refresh token itself: the person revoked Aggregate (or the grant ended). */
const isRefused = (e: unknown) => e instanceof ConnectorError && e.kind === 'auth' && e.code === 'invalid_grant'
const revoked = () =>
  new ConnectorError('auth', 'Access to Wefunder was removed on wefunder.com, so your Wefunder data was deleted from Aggregate. Connect Wefunder again to bring it back.', { provider: PROVIDER, code: 'revoked', forUser: true })

export function verifierFor(clientSecret: string, state: string): string {
  return createHmac('sha256', clientSecret).update(`wefunder-pkce:${state}`).digest('base64url')
}

export function createWefunderConnector(opts: WefunderOptions): Connector & { authorizationUrl(state: string): string } {
  const { deps } = opts
  const clock = deps.clock ?? systemClock
  const test = opts.oauth.clientId.startsWith('pk_test_')
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: test ? AUTHORIZE.test : AUTHORIZE.live,
    tokenUrl: `${API}/oauth/token`,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    scopes: SCOPES,
    clientAuth: 'body',
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    clock,
  })

  function client(tokens: OAuthTokens): HttpClient {
    return new HttpClient({
      provider: PROVIDER,
      baseUrl: opts.apiBase ?? API,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
      ...(deps.random ? { random: deps.random } : {}),
      // The documented limits are per minute; stay well under them.
      rateLimit: { perSecond: 1, burst: 3 },
      headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
      classifyError: classifyWefunderError,
    })
  }

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Wefunder',
    group: 'equity',
    provides: ['equity'],
    freshness: 'syncs daily',
    auth: 'oauth',
    dataVersion: MAPPING_VERSION,
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      const verifier = verifierFor(opts.oauth.clientSecret, state)
      return oauth.authorizationUrl({ state, pkce: { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256' } })
    },

    async connect(input) {
      const code = str(input.code)
      // The server passes the connect attempt's state as connectState (it keeps the provider's `state` param itself).
      const state = str(input.connectState) ?? str(input.state)
      if (!code || !state) throw new ConnectorError('invalid_input', 'Wefunder sign-in did not return a code', { provider: PROVIDER })
      const tokens = await oauth.exchangeCode(code, { codeVerifier: verifierFor(opts.oauth.clientSecret, state) })
      if (tokens.scope && !tokens.scope.split(/\s+/).includes('read:investments')) {
        throw new ConnectorError('invalid_input', 'Wefunder access was granted without “View your investments”. Connect again and allow it.', { provider: PROVIDER, forUser: true })
      }
      // One read, so a token that can't see the portfolio fails here rather than on the first sync.
      await client(tokens).request({ path: '/portfolio/positions', query: { per_page: 1 } })
      const secret: WefunderSecret = { tokens }
      return { secret, config: { displayName: 'Wefunder', ...(test ? { sandbox: true, warnings: ['This is Wefunder’s sandbox: test data, not real investments.'] } : {}) } }
    },

    async sync(conn, cursor): Promise<SyncResultWithSecret> {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      let tokens = secret.tokens
      let refreshed = false
      // Refresh tokens rotate: keep the new pair before any read can fail and strand it.
      const renew = async (force: boolean) => {
        try {
          const r = force ? { tokens: await oauth.refresh(tokens), refreshed: true } : await oauth.ensureFresh(tokens)
          if (!r.refreshed) return
          tokens = r.tokens
          refreshed = true
          await deps.saveSecret?.(conn.id, { tokens } satisfies WefunderSecret)
        } catch (e) {
          throw isRefused(e) ? revoked() : e
        }
      }
      await renew(false)
      const state = codec.decode(cursor) ?? { cursor: null, pages: 0, startedAt: new Date(clock.now()).toISOString() }
      const read = () => client(tokens).request<{ data?: unknown; meta?: unknown }>({ path: '/portfolio/positions', query: { per_page: PAGE, ...(state.cursor !== null ? { cursor: String(state.cursor) } : {}) } })
      let res: Awaited<ReturnType<typeof read>>
      try {
        res = await read()
      } catch (e) {
        // A 401 on a token that should still work: revoked on wefunder.com, or just ended early. One refresh tells which
        // (a refused refresh token is a revoke); if it works, read again with the new token.
        if (!(e instanceof ConnectorError && e.kind === 'auth' && e.status === 401 && tokens.refreshToken && !refreshed)) throw e
        await renew(true)
        res = await read()
      }
      // A present JSON:API envelope with an empty `data` array is a real empty page; a null/non-object body (an empty
      // body, or a sign-in/error page the shared client rejects as non-JSON) is unreadable and must stop the sync.
      if (!isRecord(res.data)) throw new ConnectorError('transient', 'Wefunder sent a response Aggregate couldn’t read, so this sync stopped. No totals were changed.', { provider: PROVIDER })
      const rows = Array.isArray(res.data.data) ? res.data.data.filter(isRecord) : []
      const events: NormalizedEvent[] = []
      for (const p of rows) {
        const id = str(p.id) ?? (isRecord(p.attributes) ? str(p.attributes.offering_id) : undefined)
        if (!id) continue
        const rawRef = await deps.raw.put(conn.id, `${PROVIDER}.position`, id, p)
        events.push(...mapPosition(p, conn.id, rawRef))
      }
      const meta = isRecord(res.data.meta) ? res.data.meta : {}
      const nextCursor = typeof meta.next_cursor === 'number' || typeof meta.next_cursor === 'string' ? meta.next_cursor : null
      const providerMore = meta.has_more === true && nextCursor !== null && nextCursor !== state.cursor && rows.length > 0
      // The cap must not masquerade as the end of the listing: a truncated pass here would emit listing.complete and
      // void the positions on the pages never fetched. Stop visibly instead.
      if (providerMore && state.pages + 1 >= MAX_PAGES)
        throw new ConnectorError('permanent', 'Wefunder returned more positions than Aggregate can page through, so this sync stopped. No positions were voided and no totals were changed.', { provider: PROVIDER, forUser: true })
      const more = providerMore
      if (!more) {
        // A full pass: any Wefunder position this connection had that wasn't seen since it began is gone at Wefunder.
        events.push({ type: 'listing.complete', externalId: `listing:${state.startedAt}`, connectionId: conn.id, kinds: ['investment'], startedAt: state.startedAt, scope: SCOPE })
      }
      const result: SyncResultWithSecret = { events, cursor: more ? codec.encode({ cursor: nextCursor, pages: state.pages + 1, startedAt: state.startedAt }) : null, hasMore: more }
      if (refreshed) result.updatedSecret = { tokens } satisfies WefunderSecret
      return result
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const t = requireSecret(PROVIDER, conn.secret, isSecret).tokens
        // Never refreshes here: the rotated refresh token would have nowhere to go. It renews on the next sync.
        if (t.expiresAt !== undefined && t.expiresAt <= clock.now() && t.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await client(t).request({ path: '/portfolio/positions', query: { per_page: 1 } })
        return { status: 'ok', lastSuccessAt: new Date(clock.now()).toISOString() }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /**
     * Revoking a connected app needs write:profile, which Aggregate doesn't ask for (read-only). So the person removes
     * Aggregate on wefunder.com; the server deletes the data here either way.
     */
    async disconnect() {
      throw new ConnectorError('permanent', 'Your Wefunder data was deleted from Aggregate. To remove its access too, remove Aggregate from your connected apps on wefunder.com.', { provider: PROVIDER, forUser: true })
    },
  }
}
