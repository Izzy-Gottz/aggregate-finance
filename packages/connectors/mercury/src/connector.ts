// Mercury connector: checking/savings (depository), Mercury Treasury (investment, balance only) and Mercury credit
// card accounts, with balances and transactions. Read-only (GET only, Read Only token).
//
// A sync cycle: one "accounts" page (GET /accounts, /credit, /treasury), then GET /account/{id}/transactions per
// account with offset/limit pages over a [start, end] date window (order=asc), paging on while a page comes back
// full (Mercury's `total` isn't documented, so it isn't trusted). The final cursor remembers the
// day the cycle ran; the next cycle starts `overlapDays` earlier, and never later than the oldest still-pending
// row, so a pending row that settles later is re-read and upserted (same id, new status).

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import {
  ConnectorError,
  cursorCodec,
  healthFromError,
  isConnectorError,
  isRecord,
  isoDate,
  isoTimestamp,
  OAuthClient,
  requireSecret,
  str,
  systemClock,
  type Clock,
  type ConnectorDeps,
  type ConnectorWebhook,
} from '@agfn/connector-sdk'
import { MercuryClient } from './client.ts'
import { mapAccount, mapBalance, mapCreditAccount, mapTreasuryAccount, mapTxn } from './map.ts'
import type { MercuryAccount, MercuryAccountsResponse, MercuryCreditAccount, MercuryTransactionsResponse, MercuryTreasuryAccount } from './types.ts'
import { mercuryWebhook } from './webhook.ts'

export interface MercurySecret {
  token: string
  /** One-click sign-in (OAuth): `token` is a one-hour access token. */
  kind?: 'oauth'
  /** Single-use: every refresh returns a new one (valid 720 hours), which is saved. */
  refreshToken?: string
  /** Epoch ms when `token` expires. */
  expiresAt?: number
}

export interface MercuryConfig {
  /** Mercury account ids (depository + credit); webhooks match on membership. */
  accountIds: string[]
  legalBusinessName?: string
  warnings?: string[]
}

export interface MercuryConnectorOptions {
  /** Signing secret of the Mercury webhook endpoint (returned once when the endpoint is created). */
  webhookSecret?: string
  /** History pulled on the first sync. Default 730 days. */
  backfillDays?: number
  /** Days re-read on each incremental cycle. Default 3. */
  overlapDays?: number
  /** Page size (Mercury max 1000). Default 500. */
  pageSize?: number
  baseUrl?: string
  /** Aggregate's Mercury OAuth client (Mercury issues it after approving the integration). Without both, people paste a token. */
  oauthClientId?: string
  oauthClientSecret?: string
  oauthBase?: string
}

export const MERCURY_OAUTH_BASE = 'https://oauth2.mercury.com'
/** `read`: accounts and transactions. `offline_access`: a refresh token. */
export const MERCURY_OAUTH_SCOPES = ['read', 'offline_access']
const REFRESH_EARLY_MS = 5 * 60_000

interface MercuryCursor {
  stage: 'accounts' | 'txns'
  /** Accounts whose transactions are read this cycle. */
  accts: string[]
  idx: number
  offset: number
  start: string
  end: string
  /** End date of the previous complete cycle. */
  last: string | null
  /** Oldest createdAt date of a pending row seen this cycle (re-read next cycle). */
  pend: string | null
  /** Same, from the previous cycle. */
  prevPend: string | null
  /** Optional products (credit, treasury) this connection has returned accounts for before. */
  had?: Array<'credit' | 'treasury'>
  /** Which of `accts` are credit card accounts (a 404 on their transactions gets a warning). */
  credit?: string[]
}

const isCursor = (v: unknown): v is MercuryCursor =>
  isRecord(v) && (v.stage === 'accounts' || v.stage === 'txns') && Array.isArray(v.accts) && typeof v.idx === 'number' && typeof v.offset === 'number'

/** Per-sync warning when credit or treasury accounts seen before are no longer visible to the token. */
export const mercuryHiddenWarning = (product: 'credit' | 'treasury'): string =>
  product === 'credit'
    ? "Mercury credit card accounts synced before are no longer visible to this token, so they weren't updated."
    : "Mercury Treasury accounts synced before are no longer visible to this token, so they weren't updated."

export const MERCURY_CREDIT_TXNS_WARNING = "Mercury didn't return transactions for the credit card account; card activity may be missing"

const isSecret = (v: unknown): v is MercurySecret => isRecord(v) && typeof v.token === 'string' && v.token.trim() !== ''

export interface MercuryConnector extends Connector {
  begin(ctx?: ConnectBeginContext): Promise<ConnectBegin>
  readonly webhook?: ConnectorWebhook
}

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
}

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b)

export function createMercuryConnector(opts: MercuryConnectorOptions, deps: ConnectorDeps): MercuryConnector {
  const clock: Clock = deps.clock ?? systemClock
  const codec = cursorCodec<MercuryCursor>('mercury', 1, isCursor)
  const limit = Math.min(1000, Math.max(1, opts.pageSize ?? 500))
  const overlap = Math.max(0, opts.overlapDays ?? 3)
  const backfill = Math.max(1, opts.backfillDays ?? 730)
  const client = (sec: MercurySecret) => new MercuryClient(sec.token, deps, opts.baseUrl, { oauth: sec.kind === 'oauth' })
  const clientOf = (conn: ConnectionRef) => client(requireSecret('mercury', conn.secret, isSecret))
  const oauthReady = !!(opts.oauthClientId && opts.oauthClientSecret)
  const oauthBase = (opts.oauthBase ?? MERCURY_OAUTH_BASE).replace(/\/+$/, '')
  const oauth = (redirectUri: string) =>
    new OAuthClient({
      provider: 'mercury',
      authorizeUrl: `${oauthBase}/oauth2/auth`,
      tokenUrl: `${oauthBase}/oauth2/token`,
      clientId: opts.oauthClientId ?? '',
      ...(opts.oauthClientSecret ? { clientSecret: opts.oauthClientSecret } : {}),
      redirectUri,
      scopes: MERCURY_OAUTH_SCOPES,
      clientAuth: 'basic',
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      clock,
    })

  /** A sign-in token close to expiry is refreshed first; the rotated refresh token must be saved (single-use). */
  async function fresh(conn: ConnectionRef): Promise<{ conn: ConnectionRef; renewed?: MercurySecret }> {
    const sec = requireSecret('mercury', conn.secret, isSecret)
    if (sec.kind !== 'oauth' || !sec.refreshToken || sec.expiresAt === undefined) return { conn }
    if (sec.expiresAt - clock.now() > REFRESH_EARLY_MS) return { conn }
    if (!oauthReady) throw new ConnectorError('auth', 'Mercury sign-in is not configured on this server; reconnect with an API token', { provider: 'mercury', forUser: true })
    const t = await oauth('').refresh({ accessToken: sec.token, refreshToken: sec.refreshToken }, { scope: MERCURY_OAUTH_SCOPES.join(' ') })
    const renewed: MercurySecret = { token: t.accessToken, kind: 'oauth', refreshToken: t.refreshToken ?? sec.refreshToken, expiresAt: t.expiresAt ?? clock.now() + 3_600_000 }
    return { conn: { ...conn, secret: renewed }, renewed }
  }
  const webhook = opts.webhookSecret ? mercuryWebhook(opts.webhookSecret, clock) : undefined

  const description: ConnectorDescription = {
    key: 'mercury',
    name: 'Mercury',
    group: 'banks',
    provides: ['balances', 'transactions'],
    freshness: webhook ? 'updates within minutes via webhooks' : 'updates every few hours',
    auth: opts.oauthClientId && opts.oauthClientSecret ? 'oauth' : 'api_key',
    // 1: transactions carry a real `at` instant so the ledger dates them by the workspace's business day. Existing
    // connections re-import once to re-date rows booked before the fix.
    dataVersion: 1,
  }

  async function listAccounts(c: MercuryClient): Promise<MercuryAccount[]> {
    const out: MercuryAccount[] = []
    let after: string | undefined
    for (let i = 0; i < 100; i++) {
      const r = await c.get<MercuryAccountsResponse>('/accounts', { limit: 1000, ...(after ? { start_after: after } : {}) })
      out.push(...r.accounts)
      if (!r.page?.nextPage) return out.filter((a) => a.type === 'mercury' && a.status !== 'deleted')
      after = r.page.nextPage
    }
    // The provider still has pages after the cap: stop visibly rather than record a partial account list as complete.
    throw new ConnectorError('permanent', 'Mercury returned more accounts than Aggregate can page through, so this sync stopped. No totals were changed.', { provider: 'mercury', forUser: true })
  }

  /** Credit and Treasury are optional products: a 403/404 means "not on this org / not in this token's scope". */
  async function optional<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (e) {
      if (isConnectorError(e) && (e.status === 403 || e.status === 404)) return undefined
      throw e
    }
  }

  async function accountsPage(conn: ConnectionRef, state: MercuryCursor | null): Promise<SyncResult> {
    const c = clientOf(conn)
    const at = isoTimestamp(clock.now())
    const today = at.slice(0, 10)
    const events: NormalizedEvent[] = []
    const accts: string[] = []
    const creditIds: string[] = []

    for (const a of await listAccounts(c)) {
      const rawRef = await deps.raw.put(conn.id, 'mercury.account', a.id, a)
      events.push(mapAccount(a, conn.id, rawRef), mapBalance(a, conn.id, rawRef, at, 'depository'))
      accts.push(a.id)
    }
    const credit = await optional(() => c.get<{ accounts: MercuryCreditAccount[] }>('/credit'))
    const had = new Set(state?.had ?? [])
    const warnings: string[] = []
    // 403/404 is normal for orgs without the product; only warn when this connection has seen such accounts before.
    const track = (product: 'credit' | 'treasury', res: { accounts: unknown[] } | undefined) => {
      if (res === undefined) {
        if (had.has(product)) warnings.push(mercuryHiddenWarning(product))
      } else if (res.accounts.length) had.add(product)
    }
    track('credit', credit)
    for (const a of credit?.accounts ?? []) {
      const rawRef = await deps.raw.put(conn.id, 'mercury.credit_account', a.id, a)
      events.push(mapCreditAccount(a, conn.id, rawRef), mapBalance(a, conn.id, rawRef, at, 'credit'))
      // Card rows come through the regular transactions endpoint on the credit account.
      accts.push(a.id)
      creditIds.push(a.id)
    }
    const treasury = await optional(() => c.get<{ accounts: MercuryTreasuryAccount[] }>('/treasury'))
    track('treasury', treasury)
    for (const a of treasury?.accounts ?? []) {
      const rawRef = await deps.raw.put(conn.id, 'mercury.treasury_account', a.id, a)
      events.push(mapTreasuryAccount(a, conn.id, rawRef), mapBalance(a, conn.id, rawRef, at, 'treasury'))
    }

    const last = state?.last ?? null
    const prevPend = state?.pend ?? null
    const start = last ? (minDate(addDays(last, -overlap), prevPend) as string) : addDays(today, -backfill)
    const next: MercuryCursor = { stage: 'txns', accts, idx: 0, offset: 0, start, end: today, last, pend: null, prevPend, ...(had.size ? { had: [...had].sort() } : {}), ...(creditIds.length ? { credit: creditIds } : {}) }
    return { events, cursor: codec.encode(next), hasMore: true, ...(warnings.length ? { warnings } : {}) }
  }

  async function txnsPage(conn: ConnectionRef, s: MercuryCursor): Promise<SyncResult> {
    const id = s.accts[s.idx]
    if (id === undefined) {
      const done: MercuryCursor = { stage: 'accounts', accts: [], idx: 0, offset: 0, start: s.start, end: s.end, last: s.end, pend: s.pend, prevPend: null, ...(s.had ? { had: s.had } : {}) }
      return { events: [], cursor: codec.encode(done), hasMore: false }
    }
    let r: MercuryTransactionsResponse
    const warnings: string[] = []
    try {
      r = await clientOf(conn).get<MercuryTransactionsResponse>(`/account/${encodeURIComponent(id)}/transactions`, {
        limit,
        offset: s.offset,
        start: s.start,
        end: s.end,
        order: 'asc',
      })
    } catch (e) {
      // An account the per-account endpoint doesn't serve: skip it, don't fail the cycle. For the credit card that
      // means card activity is missing, so say so instead of passing it off as an empty account.
      if (isConnectorError(e) && e.status === 404) {
        r = { total: 0, transactions: [] }
        if (s.credit?.includes(id)) warnings.push(MERCURY_CREDIT_TXNS_WARNING)
      } else throw e
    }
    const events: NormalizedEvent[] = []
    let pend = s.pend
    for (const t of r.transactions) {
      const rawRef = await deps.raw.put(conn.id, 'mercury.transaction', t.id, t)
      events.push(mapTxn(t, t.accountId ?? id, conn.id, rawRef))
      if (t.status === 'pending') pend = minDate(pend, isoDate(t.createdAt))
    }
    // A full page may have more behind it; a short or empty one is the end, so this always stops.
    const more = r.transactions.length > 0 && r.transactions.length >= limit
    const next = more ? { ...s, offset: s.offset + r.transactions.length, pend } : { ...s, idx: s.idx + 1, offset: 0, pend }
    if (!more && next.idx >= s.accts.length) {
      const done: MercuryCursor = { stage: 'accounts', accts: [], idx: 0, offset: 0, start: s.start, end: s.end, last: s.end, pend, prevPend: null, ...(s.had ? { had: s.had } : {}) }
      return { events, cursor: codec.encode(done), hasMore: false, ...(warnings.length ? { warnings } : {}) }
    }
    return { events, cursor: codec.encode(next), hasMore: true, ...(warnings.length ? { warnings } : {}) }
  }

  return {
    describe: () => description,
    ...(webhook ? { webhook } : {}),

    async begin(ctx) {
      if (oauthReady && ctx) return { kind: 'oauth', url: oauth(ctx.redirectUri).authorizationUrl({ state: ctx.state }) }
      return {
        kind: 'api_key',
        label: 'Mercury API token',
        steps: [
          'Sign in to Mercury, open Settings and choose Tokens in the menu on the left.',
          'Choose Create an API Token, name it “Aggregate” and pick Read Only (no IP allow-list needed).',
          'Copy the token and paste it here.',
        ],
        permissions: [
          'Read only: accounts, balances and transactions. Aggregate can’t move money.',
        ],
        helpUrl: 'https://app.mercury.com/settings/tokens',
        placeholder: 'secret-token:mercury_production_...',
      }
    },

    async connect(input) {
      const code = str(input.code)
      let secret: MercurySecret
      if (code) {
        if (!oauthReady) throw new ConnectorError('invalid_input', 'Mercury sign-in is not configured on this server', { provider: 'mercury' })
        const redirectUri = str(input.redirectUri)
        if (!redirectUri) throw new ConnectorError('invalid_input', 'redirectUri is required to finish Mercury sign-in', { provider: 'mercury' })
        const t = await oauth(redirectUri).exchangeCode(code)
        if (!t.refreshToken) throw new ConnectorError('permanent', 'Mercury did not return a refresh token (offline_access missing)', { provider: 'mercury' })
        secret = { token: t.accessToken, kind: 'oauth', refreshToken: t.refreshToken, expiresAt: t.expiresAt ?? clock.now() + 3_600_000 }
      } else {
        const token = (str(input.apiKey) ?? str(input.token))?.trim()
        if (!token) throw new ConnectorError('invalid_input', 'a Mercury API token is required', { provider: 'mercury' })
        if (/\s/.test(token)) throw new ConnectorError('invalid_input', 'the Mercury token must not contain spaces', { provider: 'mercury' })
        secret = { token }
      }
      const token = secret.token
      const c = client(secret)
      const accounts = await listAccounts(c)
      const credit = await optional(() => c.get<{ accounts: MercuryCreditAccount[] }>('/credit'))
      const legalBusinessName = accounts.find((a) => a.legalBusinessName)?.legalBusinessName ?? undefined
      const warnings: string[] = []
      if (secret.kind !== 'oauth' && !/^secret-token:mercury_(production|sandbox)_/.test(token)) {
        warnings.push('This does not look like a Mercury API token; if syncs fail, create a new Read Only token.')
      }
      const config: MercuryConfig = {
        accountIds: [...accounts.map((a) => a.id), ...(credit?.accounts ?? []).map((a) => a.id)],
        ...(legalBusinessName ? { legalBusinessName: legalBusinessName.slice(0, 120) } : {}),
        ...(warnings.length ? { warnings } : {}),
      }
      return { secret, config: { ...config } }
    },

    async sync(conn0, cursor) {
      const { conn, renewed } = await fresh(conn0)
      // Refresh tokens rotate: keep the new one before fetching anything, so a failed page can't strand it.
      if (renewed) await deps.saveSecret?.(conn0.id, renewed)
      const s = codec.decode(cursor)
      const page = !s || s.stage === 'accounts' ? await accountsPage(conn, s) : await txnsPage(conn, s)
      return renewed ? { ...page, updatedSecret: renewed } : page
    },

    /**
     * RFC 7009 at the revocation_endpoint in Mercury's discovery doc: revoking the refresh token ends the whole grant.
     * An invalid_token answer means it's already gone. A pasted token can only be deleted in Mercury.
     */
    async disconnect(conn) {
      const sec = requireSecret('mercury', conn.secret, isSecret)
      if (sec.kind !== 'oauth') return { notRevoked: 'In Mercury, go to Settings → Tokens → Delete the token.' }
      if (!sec.refreshToken) return
      const refused = { notRevoked: 'In Mercury, go to Settings → Remove Aggregate.' }
      try {
        const res = await (deps.fetch ?? fetch)(`${oauthBase}/oauth2/revoke`, {
          method: 'POST',
          headers: { authorization: 'Basic ' + Buffer.from(`${encodeURIComponent(opts.oauthClientId ?? '')}:${encodeURIComponent(opts.oauthClientSecret ?? '')}`).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: sec.refreshToken, token_type_hint: 'refresh_token' }).toString(),
        })
        if (res.ok) return
        const body: unknown = res.status === 400 ? await res.json().catch(() => null) : null
        if (!isRecord(body) || body.error !== 'invalid_token') return refused
      } catch {
        return refused
      }
    },

    async health(conn0): Promise<ConnectorHealth> {
      try {
        // Never refreshes: a refresh rotates the refresh token, and health has nowhere to keep the new one. An expired
        // access token renews on the next sync; only a refusal of a current one means reconnect.
        const sec = requireSecret('mercury', conn0.secret, isSecret)
        if (sec.kind === 'oauth' && sec.refreshToken && sec.expiresAt !== undefined && sec.expiresAt <= clock.now()) {
          return { status: 'ok', message: 'The access token renews on the next sync.' }
        }
        await clientOf(conn0).get('/accounts', { limit: 1 })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },
  }
}
