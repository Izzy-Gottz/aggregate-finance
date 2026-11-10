// Etsy connector (Open API v3, the shop's payment account ledger): every entry in the seller's Etsy Payments balance, as
// one processor row on an Etsy balance per currency. Sales, Etsy's fees, refunds, the sales tax Etsy collects and remits,
// and each deposit to the seller's bank (the payout row core matches to the bank deposit). How entries are read and
// checked is in ledger.ts.
//
// THE CHECK. Each entry's running balance must be the one before it plus its amount, in order, from the last entry
// already recorded. Entries are read a window of days at a time, and nothing from a window is sent until every page of it
// has been read and has chained. A window that doesn't chain stops the sync with a message, and nothing from it is
// recorded; windows already recorded stay as they were (each passed its own check). So does an entry of a kind this
// connector doesn't know. Better no number than a wrong one.
//
// Auth: "Sign in with Etsy" on Aggregate's app, OAuth 2.0 authorization code with PKCE (S256), asking for
// `transactions_r shops_r` only. The PKCE verifier is HMAC(shared secret, state), so nothing extra is kept between begin
// and connect. Access tokens last an hour, refresh tokens 90 days; each renewal is saved before any read. Etsy has no call
// to end a grant: only the seller can, in Etsy (disconnect says where).
//
// A run reads entries created since a day before the last run started (the last 365 days on the first run), in windows of
// at most 30 days, one page of 100 per step, the window's entries held in the cursor until it's complete. A window with
// more than 1,000 entries is halved first. Entries seen before are recognised by the chain and skipped.
//
// Stored in raw: per entry its id, ledger, order, amount, balance, currency, date, type and Etsy's reference type and
// ids. No description, no payment adjustments, nothing about buyers.
//
// Built from Etsy's docs and published OpenAPI spec. It has not been run against a real shop, and the fixtures are
// hand-built. See README.md for what's unverified.

import { createHash, createHmac } from 'node:crypto'
import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { ETSY_AUTHORIZE_URL, ETSY_SCOPES, ETSY_TOKEN_URL, EtsyClient, unreadable } from './client.ts'
import { accountId, chain, isChainEnd, isEntry, readEntry, row, snapshots, type ChainEnd, type Entry } from './ledger.ts'

const PROVIDER = 'etsy'
const DAY_S = 86_400
/** Etsy rejects a ledger window wider than 31 days (README, Unverified): 30 stays inside it. */
export const WINDOW_DAYS = 30
/** The first run. */
export const BACKFILL_DAYS = 365
/** Each run reads again from a day before the last one started, for entries Etsy shows late. */
export const OVERLAP_DAYS = 1
/** Most entries held in the cursor for one window; a busier window is halved, down to an hour. */
export const MAX_HELD = 1000
const MIN_SPAN_S = 3600
/** Etsy's earliest allowed min_created (spec). */
const EARLIEST = 946_684_800
const RENEW_EARLY_MS = 300_000

export const NOT_REVOKED = 'In Etsy, open Shop Manager → Apps (or Account settings → Apps), find Aggregate and choose Revoke.'
export const ETSY_SIGN_IN_ONLY = 'Etsy connects with Etsy sign-in only. Start from Connections → Add → Etsy.'
export const ETSY_NO_RENEWAL = 'Etsy didn’t give Aggregate a way to keep this connection up to date. Connect Etsy again.'
export const ETSY_WRONG_SCOPE = 'Etsy gave Aggregate different access than the read-only access it asks for, so the connection wasn’t saved.'
export const ETSY_NO_SHOP = 'This Etsy account doesn’t have a shop, so there’s nothing to connect.'

export interface EtsyConnectorOptions {
  /** Aggregate's Etsy app: its keystring (the OAuth client id) and shared secret. */
  app: { clientId: string; clientSecret: string; redirectUri: string }
}

export interface EtsySecret {
  tokens: OAuthTokens
}

interface Run {
  /** The run reads entries created up to here (epoch seconds, when it started). */
  until: number
  /** The current window starts here. */
  from: number
  span: number
  offset: number
  /** The current window's entries read so far. */
  held: Entry[]
}

interface EtsyCursor {
  /** Next run starts a day before this. Null: the first run. */
  hw: number | null
  run: Run | null
  /** The last entry recorded, per ledger. */
  ends: Record<string, ChainEnd>
  /** Entries recorded in the overlap, [entry id, created]: the next run reads them again and must know them. */
  recorded: Array<[string, number]>
  /** Account ids sent already. */
  accounts: string[]
}

const isRun = (v: unknown): v is Run =>
  isRecord(v) && ['until', 'from', 'span', 'offset'].every((k) => Number.isSafeInteger(v[k])) && Array.isArray(v.held) && v.held.every(isEntry)
const isCursor = (v: unknown): v is EtsyCursor =>
  isRecord(v) &&
  (v.hw === null || Number.isSafeInteger(v.hw)) &&
  (v.run === null || isRun(v.run)) &&
  isRecord(v.ends) &&
  Object.values(v.ends).every(isChainEnd) &&
  Array.isArray(v.recorded) &&
  v.recorded.every((r) => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && Number.isSafeInteger(r[1])) &&
  Array.isArray(v.accounts) &&
  v.accounts.every((a) => typeof a === 'string')
const isSecret = (v: unknown): v is EtsySecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

/** The PKCE verifier for one connect attempt: HMAC(shared secret, state), 43 base64url characters. */
export function verifierFor(clientSecret: string, state: string): string {
  return createHmac('sha256', clientSecret).update(`etsy-pkce:${state}`).digest('base64url')
}

export interface EtsyConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createEtsyConnector(opts: EtsyConnectorOptions, deps: ConnectorDeps): EtsyConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<EtsyCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const apiKey = `${opts.app.clientId}:${opts.app.clientSecret}`

  // The one POST: Etsy's token endpoint, form-encoded, client_id in the body. Etsy's docs send no client secret there
  // (the shared secret goes only in x-api-key), so none is given to the helper.
  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: ETSY_AUTHORIZE_URL,
    tokenUrl: ETSY_TOKEN_URL,
    clientId: opts.app.clientId,
    redirectUri: opts.app.redirectUri,
    scopes: [...ETSY_SCOPES],
    scopeSeparator: ' ',
    clientAuth: 'body',
    fetch: baseFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Etsy',
    group: 'payments',
    provides: ['transactions'],
    freshness: 'updates every few hours',
    auth: 'oauth',
    // Etsy's API Terms: content shown no more than 24 hours older than etsy.com (README, Freshness).
    staleAfterHours: 24,
  }

  const api = (token: string) => new EtsyClient(token, apiKey, { ...deps, fetch: baseFetch })

  const shopOf = (conn: ConnectionRef): number => {
    const s = conn.config.shopId
    if (typeof s !== 'number' || !Number.isSafeInteger(s) || s < 1) throw new ConnectorError('invalid_input', 'connection has no Etsy shop id', { provider: PROVIDER })
    return s
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: EtsySecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew || !oauth.isExpired(secret.tokens, RENEW_EARLY_MS)) return { token: secret.tokens.accessToken }
    const tokens = await oauth.refresh(secret.tokens)
    const renewed: EtsySecret = { tokens }
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  return {
    describe: () => description,

    async begin(ctx) {
      const verifier = verifierFor(opts.app.clientSecret, ctx.state)
      return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state, pkce: { verifier, challenge: createHash('sha256').update(verifier).digest('base64url'), method: 'S256' } }) }
    },

    async connect(input) {
      const code = str(input.code)
      // The server passes the connect attempt's state as connectState (it keeps the provider's `state` param itself).
      const state = str(input.connectState) ?? str(input.state)
      if (!code || !state) throw new ConnectorError('invalid_input', ETSY_SIGN_IN_ONLY, { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code, { codeVerifier: verifierFor(opts.app.clientSecret, state) })
      if (tokens.scope !== undefined && [...new Set(tokens.scope.split(/\s+/).filter(Boolean))].sort().join(' ') !== [...ETSY_SCOPES].sort().join(' ')) {
        throw new ConnectorError('permanent', ETSY_WRONG_SCOPE, { provider: PROVIDER, forUser: true })
      }
      if (!tokens.refreshToken) throw new ConnectorError('permanent', ETSY_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      const client = api(tokens.accessToken)
      const me = await client.me()
      // Etsy's access tokens start with the user id they belong to.
      const prefix = /^(\d+)\./.exec(tokens.accessToken)?.[1]
      if (prefix !== undefined && prefix !== String(me.userId)) throw unreadable('an account')
      if (me.shopId === null) throw new ConnectorError('permanent', ETSY_NO_SHOP, { provider: PROVIDER, forUser: true })
      const shop = await client.shop(me.shopId)
      // One harmless read: the grant reaches the shop's payment account.
      const now = Math.floor(clock.now() / 1000)
      await client.ledger(me.shopId, now - 7 * DAY_S, now, 0)
      const secret: EtsySecret = { tokens }
      return { secret, config: { shopId: me.shopId, userId: me.userId, currency: shop.currency, displayName: shop.name ? `Etsy · ${shop.name}` : 'Etsy' } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const shopId = shopOf(conn)
      const { token, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = api(token)
      const s: EtsyCursor = codec.decode(cursor) ?? { hw: null, run: null, ends: {}, recorded: [], accounts: [] }
      const step = (next: EtsyCursor, events: NormalizedEvent[] = [], hasMore = true): SyncResult => ({ events, cursor: codec.encode(next), hasMore, ...extra })

      const now = Math.floor(clock.now() / 1000)
      const run: Run = s.run ?? { until: now, from: Math.max(EARLIEST, s.hw === null ? now - BACKFILL_DAYS * DAY_S : s.hw - OVERLAP_DAYS * DAY_S), span: WINDOW_DAYS * DAY_S, offset: 0, held: [] }
      const to = Math.min(run.from + run.span, run.until)

      const page = await client.ledger(shopId, run.from, to, run.offset)
      // Too many to hold: the same start, half the days.
      if (run.offset === 0 && page.count > MAX_HELD && run.span > MIN_SPAN_S) return step({ ...s, run: { ...run, span: Math.max(MIN_SPAN_S, Math.floor(run.span / 2)) } })

      // Every entry is read (and its type checked) as it arrives; none is sent until the whole window has chained.
      const held = [...run.held, ...page.entries.map(readEntry)]
      const offset = run.offset + page.entries.length
      // More to read while Etsy counts more than read so far (an empty page ends it: a count that never fills).
      if (page.entries.length > 0 && offset < page.count) return step({ ...s, run: { ...run, offset, held } })

      const recorded = new Set(s.recorded.map(([id]) => id))
      const { fresh, ends } = chain(held, s.ends, recorded, { from: run.from, to })
      const events: NormalizedEvent[] = []
      let accounts = s.accounts
      if (fresh.length) {
        const rawRef = await deps.raw.put(conn.id, 'etsy.ledger', `${shopId}:${run.from}-${to}`, { shopId, from: run.from, to, entries: fresh })
        const ctx = { shopId, connectionId: conn.id, rawRef }
        for (const currency of [...new Set(fresh.map((e) => e.currency))].sort()) {
          const acct = accountId(shopId, currency)
          if (accounts.includes(acct)) continue
          accounts = [...accounts, acct].sort()
          events.push({ type: 'account.upsert', externalId: acct, connectionId: conn.id, rawRef, name: `Etsy (${currency})`, accountType: 'processor_balance', currency, institution: 'Etsy', businessHint: 'business' })
        }
        for (const e of fresh) {
          const r = row(e, ctx)
          if (r) events.push(r)
        }
        events.push(...snapshots(fresh, ends, ctx))
      }
      // Kept: what the next window reads again (its first second is this one's last) and what the next run reads again.
      const keepFrom = Math.min(to, run.until - OVERLAP_DAYS * DAY_S)
      const recordedNext = [...s.recorded, ...fresh.map((e): [string, number] => [e.id, e.created])].filter(([, at]) => at >= keepFrom)

      if (to < run.until) {
        // The next window, back up to full width after a busy one.
        return step({ ...s, ends, accounts, recorded: recordedNext, run: { until: run.until, from: to, span: Math.min(WINDOW_DAYS * DAY_S, run.span * 2), offset: 0, held: [] } }, events)
      }
      // Done. The next run reads again from a day before this one started; only entries it can see again are kept.
      return step({ hw: run.until, run: null, ends, accounts, recorded: recordedNext }, events, false)
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here: the renewed token would have nowhere to go. It renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await api(token).me()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Etsy has no call to end a grant: only the seller can, in Etsy.
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
