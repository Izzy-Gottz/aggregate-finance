// Coinbase connector: a person's or company's Coinbase wallets, read-only. Cash wallets (USD...) come in as accounts
// with their rows; crypto wallets as not-money accounts whose snapshot holds the quantity and its dollar value (map.ts).
//
// Two ways in:
// - "Sign in with Coinbase" (OAuth, scopes wallet:accounts:read, wallet:transactions:read, offline_access). Access
//   tokens last an hour; each refresh returns a new refresh token, saved before anything else is read.
// - A CDP secret API key with View permission only, for self-hosters (Coinbase gives OAuth apps to approved partners
//   for now). The key's permissions are read from Coinbase at connect: one that can trade or transfer is refused.
//   Hosted servers never take keys (Aggregate holds no credentials that can move money).
//
// A sync cycle: "accounts" (GET /v2/accounts pages and the public dollar rates; one account and snapshot per wallet
// that holds something or did before; empty wallets for every listed asset are skipped), then "txns": each cash
// wallet's GET /v2/accounts/{id}/transactions, newest first, until a page reaches rows older than the last cycle
// minus a week (and the oldest row still pending then), so late changes are re-read and upserted under the same id.

import type { Connector, ConnectBegin, ConnectBeginContext, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  HttpClient,
  isConnectorError,
  isRecord,
  isoTimestamp,
  OAuthClient,
  type OAuthTokens,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
} from '@agfn/connector-sdk'
import { classifyCoinbaseError, CoinbaseClient, COINBASE_SCOPES, OAUTH_BASE, PROVIDER, type CoinbaseAuth } from './client.ts'
import { loadCoinbaseKey } from './jwt.ts'
import { isCashWallet, isZero, mapAccount, mapBalance, mapTxn } from './map.ts'
import type { CoinbaseAccount, CoinbaseExchangeRates, CoinbaseKeyPermissions, CoinbaseList, CoinbaseTransaction } from './types.ts'

export type CoinbaseSecret = { kind: 'oauth'; tokens: OAuthTokens } | { kind: 'key'; name: string; privateKey: string }

export interface CoinbaseOptions {
  deps: ConnectorDeps
  /** Aggregate's Coinbase OAuth client. Without it, only CDP API keys (self-hosted). */
  oauth?: { clientId: string; clientSecret: string; redirectUri: string }
  /** Hosted service: sign-in only, never a pasted key. */
  hosted?: boolean
  /** API base override (tests). */
  apiBase?: string
  /** Page size (Coinbase max 100). */
  pageSize?: number
}

interface CoinbaseCursor {
  stage: 'accounts' | 'txns'
  /** Cash wallets whose rows are read this cycle, with their currency. */
  wallets: Array<{ id: string; cur: string }>
  idx: number
  /** next_uri of the current wallet's rows, or null for its first page. */
  next: string | null
  /** Rows created before this instant are not read this cycle (null: everything). */
  since: string | null
  /** When this cycle began; the next cycle reads back from here. */
  started: string
  /** Oldest pending row seen this cycle. */
  pend: string | null
  /** Wallets this connection has sent before (an emptied wallet still gets its zero balance). */
  seen: string[]
}

const isCursor = (v: unknown): v is CoinbaseCursor =>
  isRecord(v) && (v.stage === 'accounts' || v.stage === 'txns') && Array.isArray(v.wallets) && v.wallets.every((w) => isRecord(w) && typeof w.id === 'string' && typeof w.cur === 'string') && typeof v.idx === 'number' && Array.isArray(v.seen) && typeof v.started === 'string'

const isSecret = (v: unknown): v is CoinbaseSecret =>
  isRecord(v) &&
  ((v.kind === 'oauth' && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string') || (v.kind === 'key' && typeof v.name === 'string' && typeof v.privateKey === 'string'))

/** Mapping version: bump when the mapping changes, so existing connections re-read everything once. */
export const MAPPING_VERSION = 2
const codec = cursorCodec<CoinbaseCursor>(PROVIDER, MAPPING_VERSION, isCursor)
const DAY = 86_400_000
const OVERLAP_MS = 7 * DAY
/** Safety stop for a list that never ends. */
const MAX_PAGES = 200

export const COINBASE_KEY_REFUSED_HOSTED = 'Aggregate connects to Coinbase with Coinbase sign-in only. An API key isn’t accepted here.'
export const COINBASE_KEY_TOO_STRONG =
  'This Coinbase API key can trade or move money. Aggregate only reads: create a key with only the View permission and paste that one.'
export const COINBASE_KEY_NO_VIEW = 'This Coinbase API key doesn’t have the View permission. Create a key with View (and nothing else) and paste that one.'
export const COINBASE_NO_RATES_WARNING = 'Coinbase didn’t send dollar prices this time, so crypto amounts are shown without a dollar value.'

export interface CoinbaseConnector extends Connector {
  begin(ctx: ConnectBeginContext): Promise<ConnectBegin>
  authorizationUrl(state: string): string
}

export function createCoinbaseConnector(opts: CoinbaseOptions): CoinbaseConnector {
  const { deps } = opts
  const clock: Clock = deps.clock ?? systemClock
  const limit = Math.min(100, Math.max(1, opts.pageSize ?? 100))
  const oauth = opts.oauth
    ? new OAuthClient({
        provider: PROVIDER,
        authorizeUrl: `${OAUTH_BASE}/auth`,
        tokenUrl: `${OAUTH_BASE}/token`,
        clientId: opts.oauth.clientId,
        clientSecret: opts.oauth.clientSecret,
        redirectUri: opts.oauth.redirectUri,
        scopes: COINBASE_SCOPES,
        scopeSeparator: ',',
        clientAuth: 'body',
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        clock,
      })
    : undefined

  const authOf = (s: CoinbaseSecret): CoinbaseAuth => (s.kind === 'oauth' ? { kind: 'oauth', accessToken: s.tokens.accessToken } : { kind: 'key', key: { name: s.name, privateKey: s.privateKey } })
  const client = (s: CoinbaseSecret) => new CoinbaseClient(authOf(s), deps, opts.apiBase)

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Coinbase',
    group: 'other',
    provides: ['balances', 'transactions'],
    freshness: 'updates every few hours',
    auth: oauth ? 'oauth' : 'api_key',
    dataVersion: MAPPING_VERSION,
  }

  async function listAccounts(c: CoinbaseClient): Promise<CoinbaseAccount[]> {
    const out: CoinbaseAccount[] = []
    let uri: string | null = '/v2/accounts'
    for (let i = 0; uri && i < MAX_PAGES; i++) {
      const page: CoinbaseList<CoinbaseAccount> = await c.get<CoinbaseList<CoinbaseAccount>>(uri, i === 0 ? { limit } : undefined)
      out.push(...(page.data ?? []))
      uri = page.pagination?.next_uri || null
    }
    return out
  }

  /** Coinbase's public dollar rates (units of each asset per 1 USD). Not worth failing a sync over. */
  async function usdRates(c: CoinbaseClient): Promise<Record<string, string> | undefined> {
    try {
      return (await c.get<CoinbaseExchangeRates>('/v2/exchange-rates', { currency: 'USD' })).data?.rates
    } catch (e) {
      if (isConnectorError(e) && (e.kind === 'transient' || e.kind === 'rate_limited' || e.kind === 'permanent')) return undefined
      throw e
    }
  }

  async function accountsPage(conn: ConnectionRef, sec: CoinbaseSecret, prev: CoinbaseCursor | null): Promise<SyncResult> {
    const c = client(sec)
    const at = isoTimestamp(clock.now())
    const seen = new Set(prev?.seen ?? [])
    const accounts = await listAccounts(c)
    const rates = await usdRates(c)
    const warnings: string[] = []
    const events: NormalizedEvent[] = []
    const wallets: CoinbaseCursor['wallets'] = []
    let crypto = false
    for (const a of accounts) {
      const cash = isCashWallet(a)
      if (!cash && isZero(a.balance.amount) && !seen.has(a.id)) continue
      const rawRef = await deps.raw.put(conn.id, 'coinbase.account', a.id, a)
      events.push(mapAccount(a, conn.id, rawRef), mapBalance(a, conn.id, rawRef, at, rates ?? {}))
      seen.add(a.id)
      if (cash) wallets.push({ id: a.id, cur: a.currency.code })
      else crypto = true
    }
    if (crypto && !rates) warnings.push(COINBASE_NO_RATES_WARNING)
    // Read back a week before the last cycle began, and to the oldest row that was still pending then.
    const lastStart = prev?.started ? Date.parse(prev.started) : NaN
    let since = Number.isFinite(lastStart) ? new Date(lastStart - OVERLAP_MS).toISOString() : null
    if (since && prev?.pend && prev.pend < since) since = prev.pend
    const next: CoinbaseCursor = { stage: 'txns', wallets, idx: 0, next: null, since, started: at, pend: null, seen: [...seen].sort() }
    return { events, cursor: codec.encode(next), hasMore: true, ...(warnings.length ? { warnings } : {}) }
  }

  async function txnsPage(conn: ConnectionRef, sec: CoinbaseSecret, s: CoinbaseCursor): Promise<SyncResult> {
    const w = s.wallets[s.idx]
    const done = (events: NormalizedEvent[], pend: string | null): SyncResult => ({
      events,
      cursor: codec.encode({ stage: 'accounts', wallets: [], idx: 0, next: null, since: null, started: s.started, pend, seen: s.seen }),
      hasMore: false,
    })
    if (w === undefined) return done([], s.pend)
    const page = await client(sec).get<CoinbaseList<CoinbaseTransaction>>(s.next ?? `/v2/accounts/${encodeURIComponent(w.id)}/transactions`, s.next ? undefined : { limit, order: 'desc' })
    const events: NormalizedEvent[] = []
    let pend = s.pend
    let older = false
    for (const t of page.data ?? []) {
      if (s.since && t.created_at < s.since) {
        older = true
        continue
      }
      const rawRef = await deps.raw.put(conn.id, 'coinbase.transaction', t.id, t)
      const ev = mapTxn(t, w.id, w.cur, conn.id, rawRef)
      if (!ev) continue
      events.push(ev)
      if (ev.status === 'pending' && (pend === null || t.created_at < pend)) pend = t.created_at
    }
    const nextUri = page.pagination?.next_uri || null
    const more = !older && nextUri !== null && (page.data?.length ?? 0) > 0
    if (more) return { events, cursor: codec.encode({ ...s, next: nextUri, pend }), hasMore: true }
    if (s.idx + 1 >= s.wallets.length) return done(events, pend)
    return { events, cursor: codec.encode({ ...s, idx: s.idx + 1, next: null, pend }), hasMore: true }
  }

  /** A sign-in token close to expiry is refreshed first; the new refresh token is saved before any read. */
  async function fresh(conn: ConnectionRef): Promise<{ sec: CoinbaseSecret; renewed?: CoinbaseSecret }> {
    const sec = requireSecret(PROVIDER, conn.secret, isSecret)
    if (sec.kind !== 'oauth') return { sec }
    if (!oauth) {
      if (sec.tokens.expiresAt !== undefined && sec.tokens.expiresAt <= clock.now()) {
        throw new ConnectorError('auth', 'Coinbase sign-in isn’t set up on this server any more. Reconnect Coinbase with an API key.', { provider: PROVIDER, forUser: true })
      }
      return { sec }
    }
    const { tokens, refreshed } = await oauth.ensureFresh(sec.tokens, 5 * 60_000)
    if (!refreshed) return { sec }
    const renewed: CoinbaseSecret = { kind: 'oauth', tokens }
    return { sec: renewed, renewed }
  }

  async function checkKey(sec: Extract<CoinbaseSecret, { kind: 'key' }>): Promise<void> {
    const perms = await client(sec).get<CoinbaseKeyPermissions>('/api/v3/brokerage/key_permissions')
    if (perms.can_trade || perms.can_transfer) throw new ConnectorError('invalid_input', COINBASE_KEY_TOO_STRONG, { provider: PROVIDER, forUser: true })
    if (perms.can_view === false) throw new ConnectorError('invalid_input', COINBASE_KEY_NO_VIEW, { provider: PROVIDER, forUser: true })
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      if (!oauth) throw new ConnectorError('invalid_input', 'Coinbase sign-in is not configured on this server', { provider: PROVIDER })
      return oauth.authorizationUrl({ state })
    },

    async begin(ctx) {
      if (oauth) return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
      if (opts.hosted) throw new ConnectorError('invalid_input', COINBASE_KEY_REFUSED_HOSTED, { provider: PROVIDER, forUser: true })
      return {
        kind: 'api_key',
        label: 'Coinbase API key (View only)',
        helpUrl: 'https://portal.cdp.coinbase.com/projects/api-keys',
        placeholder: '',
        steps: [
          'Sign in to the Coinbase Developer Platform with your Coinbase account and open API Keys.',
          'Create a Secret API key named “Aggregate”, with only the View permission.',
          'Copy the key name (or ID) and the private key it shows once, and paste both here.',
        ],
        permissions: ['View only: wallets, balances and transactions. Aggregate can’t trade or move money.'],
        fields: [
          { name: 'keyName', label: 'API key name or ID' },
          { name: 'privateKey', label: 'Private key', secret: true, multiline: true },
        ],
      }
    },

    async connect(input) {
      const code = str(input.code)
      let secret: CoinbaseSecret
      if (code) {
        if (!oauth) throw new ConnectorError('invalid_input', 'Coinbase sign-in is not configured on this server', { provider: PROVIDER })
        const tokens = await oauth.exchangeCode(code)
        const granted = tokens.scope?.split(/[\s,+]+/).filter(Boolean)
        if (granted && !COINBASE_SCOPES.filter((x) => x !== 'offline_access').every((x) => granted.includes(x))) {
          throw new ConnectorError('invalid_input', 'Coinbase access was granted without viewing wallets and transactions. Connect again and allow both.', { provider: PROVIDER, forUser: true })
        }
        if (!tokens.refreshToken) throw new ConnectorError('permanent', 'Coinbase did not return a refresh token (offline_access missing)', { provider: PROVIDER })
        secret = { kind: 'oauth', tokens }
      } else {
        if (opts.hosted) throw new ConnectorError('invalid_input', COINBASE_KEY_REFUSED_HOSTED, { provider: PROVIDER, forUser: true })
        const name = (str(input.keyName) ?? str(input.apiKeyName))?.trim()
        const privateKey = str(input.privateKey)?.trim()
        if (!name || !privateKey) throw new ConnectorError('invalid_input', 'Paste the Coinbase API key name and its private key.', { provider: PROVIDER, forUser: true })
        loadCoinbaseKey(privateKey)
        secret = { kind: 'key', name, privateKey }
        await checkKey(secret)
      }
      // One read, so access that can't see the wallets fails here rather than on the first sync.
      await client(secret).get('/v2/accounts', { limit: 1 })
      return { secret, config: { displayName: 'Coinbase', auth: secret.kind } }
    },

    async sync(conn, cursor) {
      const { sec, renewed } = await fresh(conn)
      // Refresh tokens are single-use: keep the new pair before any read can fail and strand it.
      if (renewed) await deps.saveSecret?.(conn.id, renewed)
      const s = codec.decode(cursor)
      const page = !s || s.stage === 'accounts' ? await accountsPage(conn, sec, s) : await txnsPage(conn, sec, s)
      return renewed ? { ...page, updatedSecret: renewed } : page
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const sec = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never refreshes here: the new refresh token would have nowhere to go. It renews on the next sync.
        if (sec.kind === 'oauth' && sec.tokens.refreshToken && sec.tokens.expiresAt !== undefined && sec.tokens.expiresAt <= clock.now()) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        await client(sec).get('/v2/accounts', { limit: 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /** Sign-in: revoke the token at Coinbase. A key is the person's: they delete it in the Developer Platform. */
    async disconnect(conn) {
      const sec = requireSecret(PROVIDER, conn.secret, isSecret)
      if (sec.kind !== 'oauth' || !opts.oauth) {
        throw new ConnectorError('permanent', 'Aggregate stopped syncing Coinbase. To remove its access too, delete the API key in the Coinbase Developer Platform.', { provider: PROVIDER, forUser: true })
      }
      const http = new HttpClient({ provider: PROVIDER, baseUrl: OAUTH_BASE, ...(deps.fetch ? { fetch: deps.fetch } : {}), clock, classifyError: (i) => classifyCoinbaseError(i) })
      await http.request({
        method: 'POST',
        path: `${OAUTH_BASE}/revoke`,
        form: { token: sec.tokens.refreshToken ?? sec.tokens.accessToken, client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret },
        idempotent: true,
      })
    },
  }
}
