// Brex connector: Brex Cash accounts and the Brex card (balances and settled transactions). Read-only.
//
// A sync cycle: one "accounts" page (card accounts + cash accounts with balances), then each cash account's
// transactions (cursor pages), then primary card transactions (cursor pages). The final cursor remembers the day
// the cycle started; the next cycle passes posted_at_start = that day minus an overlap (Brex recommends overlapping
// and de-duplicating by id; our externalIds make re-emission idempotent).

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoTimestamp,
  OAuthClient,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { BrexClient } from './client.ts'
import { cur, mapCardAccount, mapCardBalance, mapCardTxn, mapCashAccount, mapCashBalance, mapCashTxn } from './map.ts'
import type { BrexCardAccount, BrexCardTransaction, BrexCashAccount, BrexCashTransaction, BrexPage } from './types.ts'
import { brexWebhook } from './webhook.ts'

export interface BrexSecret {
  token: string
  /** Partner sign-in (OAuth): the token is a one-hour access token, refreshed with `refreshToken`. */
  kind?: 'oauth'
  /** Brex expires refresh tokens after 90 days; each refresh returns a new one, which is saved. */
  refreshToken?: string
  /** Epoch ms when `token` expires. */
  expiresAt?: number
}

export interface BrexConfig {
  /** False when the token has no Brex Cash access (card-only customers). */
  cash: boolean
  cardAccountId?: string
  companyId?: string
  warnings?: string[]
}

export interface BrexConnectorOptions {
  /** Webhook signing secrets (GET /v1/webhooks/secrets; two during rotation). Omit to disable webhooks. */
  webhookSecrets?: string[]
  /** Days re-read on each incremental cycle. Default 3. */
  overlapDays?: number
  /** Page size (Brex max 1000). Default 100. */
  pageSize?: number
  baseUrl?: string
  /**
   * Brex partner OAuth (one-click sign-in): the client id and secret Brex issues to approved partners. Without both,
   * people paste a user token.
   */
  oauthClientId?: string
  oauthClientSecret?: string
  /** OAuth server base. Default production; staging is https://accounts-api.staging.brexapps.com/oauth2/default. */
  oauthBase?: string
}

export const BREX_OAUTH_BASE = 'https://accounts-api.brex.com/oauth2/default'
/** Read-only scopes; offline_access for a refresh token. */
export const BREX_OAUTH_SCOPES = [
  'openid',
  'offline_access',
  'accounts.card.readonly',
  'accounts.cash.readonly',
  'transactions.card.readonly',
  'transactions.cash.readonly',
]
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 5 * 60_000

interface BrexCursor {
  stage: 'accounts' | 'cash' | 'card'
  /** Cash accounts: [id, currency]. */
  cash: Array<[string, string]>
  card: string | null
  idx: number
  page: string | null
  /** posted_at_start for this cycle (YYYY-MM-DD) or null for full history. */
  since: string | null
  /** Day this cycle started; becomes `last` when it completes. */
  cycle: string
  /** Day the previous complete cycle started. */
  last: string | null
}

const isCursor = (v: unknown): v is BrexCursor =>
  isRecord(v) && (v.stage === 'accounts' || v.stage === 'cash' || v.stage === 'card') && Array.isArray(v.cash) && typeof v.idx === 'number'

const isSecret = (v: unknown): v is BrexSecret => isRecord(v) && typeof v.token === 'string' && v.token.trim() !== ''

/** What disconnect managed: `failures` names each token Brex refused ("refresh_token HTTP 401") or never answered. */
export interface BrexRevokeResult {
  revoked: boolean
  failures: string[]
}

export interface BrexConnector extends Connector {
  begin(ctx?: ConnectBeginContext): Promise<ConnectBegin>
  /** What disconnect does, with the outcome (disconnect itself returns nothing). */
  revoke(conn: ConnectionRef): Promise<BrexRevokeResult>
  readonly webhook?: ConnectorWebhook
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

/** Per-sync warning for a card-only token. */
export const BREX_NO_CASH_WARNING = "This Brex token can't read Brex Cash accounts, so only the Brex card was synced."

/**
 * Any 403 from the cash endpoints means a card-only company (or a token without cash scopes). The token itself already
 * worked on the card endpoints, and Brex's wording ("Must be cash admin, bookkeeper or user") isn't a contract.
 */
const noCashAccess = (e: unknown) => isConnectorError(e) && e.status === 403

export function createBrexConnector(opts: BrexConnectorOptions, deps: ConnectorDeps): BrexConnector {
  const clock: Clock = deps.clock ?? systemClock
  // ConnectorDeps has no logger today; use one if the caller's deps carry it.
  const log = (deps as { log?: (msg: string, fields?: Record<string, unknown>) => void }).log
  const codec = cursorCodec<BrexCursor>('brex', 1, isCursor)
  const limit = Math.min(1000, Math.max(1, opts.pageSize ?? 100))
  const overlap = Math.max(0, opts.overlapDays ?? 3)
  const client = (token: string) => new BrexClient(token, deps, opts.baseUrl)
  const clientOf = (conn: ConnectionRef) => client(requireSecret('brex', conn.secret, isSecret).token)
  const oauthBase = (opts.oauthBase ?? BREX_OAUTH_BASE).replace(/\/+$/, '')
  const oauthReady = !!(opts.oauthClientId && opts.oauthClientSecret)
  const oauth = (redirectUri: string) =>
    new OAuthClient({
      provider: 'brex',
      authorizeUrl: `${oauthBase}/v1/authorize`,
      tokenUrl: `${oauthBase}/v1/token`,
      clientId: opts.oauthClientId ?? '',
      ...(opts.oauthClientSecret ? { clientSecret: opts.oauthClientSecret } : {}),
      redirectUri,
      scopes: BREX_OAUTH_SCOPES,
      clientAuth: 'body',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })

  /** A sign-in token close to expiry is refreshed first; the caller saves the new secret (rotated refresh token). */
  async function fresh(conn: ConnectionRef): Promise<{ conn: ConnectionRef; renewed?: BrexSecret }> {
    const sec = requireSecret('brex', conn.secret, isSecret)
    if (sec.kind !== 'oauth' || !sec.refreshToken || sec.expiresAt === undefined) return { conn }
    if (sec.expiresAt - clock.now() > REFRESH_EARLY_MS) return { conn }
    if (!oauthReady) throw new ConnectorError('auth', 'Brex sign-in is not configured on this server; reconnect with a user token', { provider: 'brex', forUser: true })
    // The redirect URI isn't part of a refresh request.
    const t = await oauth('').refresh({ accessToken: sec.token, refreshToken: sec.refreshToken })
    const renewed: BrexSecret = { token: t.accessToken, kind: 'oauth', refreshToken: t.refreshToken ?? sec.refreshToken, expiresAt: t.expiresAt ?? clock.now() + 3_600_000 }
    return { conn: { ...conn, secret: renewed }, renewed }
  }
  const webhook = opts.webhookSecrets?.length ? brexWebhook(opts.webhookSecrets, clock) : undefined

  const description: ConnectorDescription = {
    key: 'brex',
    name: 'Brex',
    group: 'spend',
    provides: ['balances', 'transactions'],
    freshness: 'updates every few hours; card transactions appear once settled',
    auth: opts.oauthClientId && opts.oauthClientSecret ? 'oauth' : 'api_key',
  }

  async function cashAccounts(c: BrexClient): Promise<BrexCashAccount[]> {
    const out: BrexCashAccount[] = []
    let cursor: string | undefined
    for (let i = 0; i < 100; i++) {
      const p = await c.get<BrexPage<BrexCashAccount>>('/v2/accounts/cash', cursor ? { cursor } : undefined)
      out.push(...p.items)
      if (!p.next_cursor) break
      cursor = p.next_cursor
    }
    return out
  }

  async function accountsPage(conn: ConnectionRef, state: BrexCursor | null): Promise<SyncResult> {
    const c = clientOf(conn)
    const at = isoTimestamp(clock.now())
    const today = at.slice(0, 10)
    const events: NormalizedEvent[] = []

    const cards = await c.get<BrexCardAccount[]>('/v2/accounts/card')
    const cardList = Array.isArray(cards) ? cards : []
    for (const [i, a] of cardList.entries()) {
      const rawRef = await deps.raw.put(conn.id, 'brex.card_account', a.id, a)
      events.push(mapCardAccount(a, conn.id, rawRef, i))
      const bal = mapCardBalance(a, conn.id, rawRef, at)
      if (bal) events.push(bal)
    }

    let cash: BrexCashAccount[] = []
    let cashDenied = conn.config.cash === false
    if (!cashDenied) {
      try {
        cash = await cashAccounts(c)
      } catch (e) {
        if (!noCashAccess(e)) throw e
        cashDenied = true
      }
    }
    for (const a of cash) {
      const rawRef = await deps.raw.put(conn.id, 'brex.cash_account', a.id, a)
      events.push(mapCashAccount(a, conn.id, rawRef), mapCashBalance(a, conn.id, rawRef, at))
    }

    // Card transactions are for the primary card account; Brex customers have one card account in practice.
    const card = str(conn.config.cardAccountId) ?? cardList[0]?.id ?? null
    const last = state?.last ?? null
    const next: BrexCursor = {
      stage: cash.length ? 'cash' : 'card',
      cash: cash.map((a) => [a.id, cur(a.current_balance)]),
      card,
      idx: 0,
      page: null,
      since: last ? addDays(last, -overlap) : null,
      cycle: today,
      last,
    }
    return { events, cursor: codec.encode(next), hasMore: true, ...(cashDenied ? { warnings: [BREX_NO_CASH_WARNING] } : {}) }
  }

  const since = (s: BrexCursor) => (s.since ? `${s.since}T00:00:00Z` : undefined)

  async function cashPage(conn: ConnectionRef, s: BrexCursor): Promise<SyncResult> {
    const acct = s.cash[s.idx]
    if (!acct) return { events: [], cursor: codec.encode({ ...s, stage: 'card', idx: 0, page: null }), hasMore: true }
    const [id, currency] = acct
    let p: BrexPage<BrexCashTransaction>
    try {
      p = await clientOf(conn).get<BrexPage<BrexCashTransaction>>(`/v2/transactions/cash/${encodeURIComponent(id)}`, {
        limit,
        cursor: s.page ?? undefined,
        posted_at_start: since(s),
      })
    } catch (e) {
      // Cash accounts listed but their transactions refused: same card-only case, so go on to the card.
      if (!noCashAccess(e)) throw e
      return { events: [], cursor: codec.encode({ ...s, stage: 'card', idx: 0, page: null }), hasMore: true, warnings: [BREX_NO_CASH_WARNING] }
    }
    const events: NormalizedEvent[] = []
    for (const t of p.items) {
      const rawRef = await deps.raw.put(conn.id, 'brex.cash_transaction', t.id, t)
      events.push(mapCashTxn(t, id, currency, conn.id, rawRef))
    }
    const next: BrexCursor = p.next_cursor
      ? { ...s, page: p.next_cursor }
      : s.idx + 1 < s.cash.length
        ? { ...s, idx: s.idx + 1, page: null }
        : { ...s, stage: 'card', idx: 0, page: null }
    return { events, cursor: codec.encode(next), hasMore: true }
  }

  async function cardPage(conn: ConnectionRef, s: BrexCursor): Promise<SyncResult> {
    const done = (events: NormalizedEvent[]): SyncResult => ({
      events,
      cursor: codec.encode({ stage: 'accounts', cash: s.cash, card: s.card, idx: 0, page: null, since: null, cycle: s.cycle, last: s.cycle }),
      hasMore: false,
    })
    if (!s.card) return done([])
    const p = await clientOf(conn).get<BrexPage<BrexCardTransaction>>('/v2/transactions/card/primary', {
      limit,
      cursor: s.page ?? undefined,
      posted_at_start: since(s),
      'expand[]': 'expense_id',
    })
    const events: NormalizedEvent[] = []
    for (const t of p.items) {
      const rawRef = await deps.raw.put(conn.id, 'brex.card_transaction', t.id, t)
      events.push(mapCardTxn(t, s.card, conn.id, rawRef))
    }
    if (p.next_cursor) return { events, cursor: codec.encode({ ...s, page: p.next_cursor }), hasMore: true }
    return done(events)
  }

  /**
   * Partner sign-in only: revoke the refresh token so Brex shows the app as disconnected. Pasted user tokens are
   * revoked by the person in Brex (Developer page). Best effort, and it never throws: the secret is wiped either way
   * and Brex expires unused refresh tokens after 90 days. A refused revoke isn't success: it's returned, logged when
   * the caller passed a logger, and disconnect tells the person.
   */
  async function revoke(conn: ConnectionRef): Promise<BrexRevokeResult> {
    const sec = requireSecret('brex', conn.secret, isSecret)
    if (sec.kind !== 'oauth' || !oauthReady) return { revoked: false, failures: [] }
    const f = deps.fetch ?? fetch
    const failed: string[] = []
    const tokens: Array<[string | undefined, 'refresh_token' | 'access_token']> = [[sec.refreshToken, 'refresh_token'], [sec.token, 'access_token']]
    for (const [token, hint] of tokens) {
      if (!token) continue
      try {
        // RFC 7009: form-encoded, client credentials in the body like our token requests.
        const res = await f(`${oauthBase}/v1/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, token_type_hint: hint, client_id: opts.oauthClientId ?? '', client_secret: opts.oauthClientSecret ?? '' }).toString(),
        })
        if (!res.ok) failed.push(`${hint} HTTP ${res.status}`)
      } catch {
        failed.push(`${hint} network error`)
      }
    }
    if (failed.length) log?.('brex revoke failed', { connectionId: conn.id, failures: failed })
    return { revoked: failed.length === 0, failures: failed }
  }

  return {
    describe: () => description,
    ...(webhook ? { webhook } : {}),

    async begin(ctx) {
      if (oauthReady && ctx) return { kind: 'oauth', url: oauth(ctx.redirectUri).authorizationUrl({ state: ctx.state }) }
      return {
        kind: 'api_key',
        label: 'Brex user token',
        steps: [
          'Sign in to Brex as an account or card admin and open Developer → Settings, then Create Token.',
          'Name it “Aggregate” and choose read-only access to card and cash accounts and transactions only.',
          'Copy the token (it starts with bxt_) and paste it here.',
        ],
        permissions: [
          'Read only: card and cash accounts and their transactions.',
          'Brex expires tokens that go 90 days unused; Aggregate’s regular syncs keep it in use.',
        ],
        helpUrl: 'https://developer.brex.com/guides/authentication',
        placeholder: 'bxt_...',
      }
    },

    async connect(input) {
      const code = str(input.code)
      let secret: BrexSecret
      if (code) {
        if (!oauthReady) throw new ConnectorError('invalid_input', 'Brex sign-in is not configured on this server', { provider: 'brex' })
        const redirectUri = str(input.redirectUri)
        if (!redirectUri) throw new ConnectorError('invalid_input', 'redirectUri is required to finish Brex sign-in', { provider: 'brex' })
        const t = await oauth(redirectUri).exchangeCode(code)
        if (!t.refreshToken) throw new ConnectorError('permanent', 'Brex did not return a refresh token (offline_access missing)', { provider: 'brex' })
        secret = { token: t.accessToken, kind: 'oauth', refreshToken: t.refreshToken, expiresAt: t.expiresAt ?? clock.now() + 3_600_000 }
      } else {
        const token = (str(input.apiKey) ?? str(input.token))?.trim()
        if (!token) throw new ConnectorError('invalid_input', 'a Brex user token is required', { provider: 'brex' })
        if (/\s/.test(token)) throw new ConnectorError('invalid_input', 'the Brex token must not contain spaces', { provider: 'brex' })
        secret = { token }
      }
      const c = client(secret.token)
      const cards = await c.get<BrexCardAccount[]>('/v2/accounts/card')
      let cash = true
      const warnings: string[] = []
      try {
        await c.get<BrexPage<BrexCashAccount>>('/v2/accounts/cash')
      } catch (e) {
        if (!noCashAccess(e)) throw e
        cash = false
        warnings.push('This token cannot read Brex Cash accounts; only the Brex card will sync.')
      }
      const companyId = str(input.companyId)
      const cardAccountId = Array.isArray(cards) ? cards[0]?.id : undefined
      const config: BrexConfig = {
        cash,
        ...(cardAccountId ? { cardAccountId } : {}),
        ...(companyId ? { companyId } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
      return { secret, config: { ...config } }
    },

    async sync(conn0, cursor) {
      const { conn, renewed } = await fresh(conn0)
      // Refresh tokens rotate: keep the new one before fetching anything, so a failed page can't strand it.
      if (renewed) await deps.saveSecret?.(conn0.id, renewed)
      const s = codec.decode(cursor)
      const page = !s || s.stage === 'accounts' ? await accountsPage(conn, s) : s.stage === 'cash' ? await cashPage(conn, s) : await cardPage(conn, s)
      return renewed ? { ...page, updatedSecret: renewed } : page
    },

    async disconnect(conn) {
      const sec = requireSecret('brex', conn.secret, isSecret)
      if (sec.kind !== 'oauth') return { notRevoked: 'In Brex, go to the Developer page → Delete the token.' }
      if (!(await revoke(conn)).revoked) return { notRevoked: 'In Brex, go to the Developer page → Remove Aggregate.' }
    },
    revoke,

    async health(conn0): Promise<ConnectorHealth> {
      try {
        // Never refreshes: a refresh rotates the refresh token, and health has nowhere to keep the new one. An expired
        // access token renews on the next sync; only a refusal of a current one means reconnect.
        const sec = requireSecret('brex', conn0.secret, isSecret)
        if (sec.kind === 'oauth' && sec.refreshToken && sec.expiresAt !== undefined && sec.expiresAt <= clock.now()) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        await clientOf(conn0).get('/v2/accounts/card')
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
