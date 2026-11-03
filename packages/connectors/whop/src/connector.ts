// Whop connector (creator payments and storefronts): Whop's own monthly income statement per currency, as report.snapshot.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. Whop payouts reach the
// bank, which may be connected already, so posting these would double revenue. report.snapshot never reaches the ledger,
// and core's provider_report check skips this connector (checks.ts).
//
// Auth: "Sign in with Whop" (OAuth 2.1 with PKCE) on Aggregate's app, asking for `company:balance:read` only. That scope
// reads the balance ledger and its reports; it can't see buyers, and it can't move money. A token response naming any other
// scope is refused. The PKCE verifier is HMAC(client secret, state), so nothing extra is kept between begin and connect.
// Access tokens last an hour and refresh tokens rotate, so each new pair is saved before any read. Disconnect revokes the
// refresh token; the access token runs out within the hour.
//
// One business per connection. A sign-in that reaches more than one business is refused with a message, for now.
//
// Currency: the report lists every currency the business has had money in. Each is read on its own, with no conversion.
// A currency that isn’t an ISO code (crypto, even three-letter btc) stops the sync: dropping it would understate the business.
// So does a currency reported before that Whop no longer lists: zeroing its months would erase real totals.
//
// A run reads one currency per step, totals in the cursor, and only then sends the months: a half-read run must never show.
//
// Stored: monthly totals per Whop family only. Account names are read for the connection's label; nothing else is kept.
//
// Built from Whop's OAuth guide and OpenAPI reference. It has not been run against a real business, and the fixtures are
// hand-built. See README.md for what's unverified.

import { createHash, createHmac } from 'node:crypto'
import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { unreadable, WHOP_AUTHORIZE_URL, WHOP_REVOKE_URL, WHOP_SCOPE, WHOP_TOKEN_URL, WhopClient } from './client.ts'
import { addMonths, isoCurrency, lastDay, monthRows, readReport, type MonthTotals } from './report.ts'

const PROVIDER = 'whop'
export const REPORT_MONTHS = 12
const RENEW_EARLY_MS = 5 * 60_000

export type WhopSecret = { tokens: OAuthTokens; accountId: string }

export interface WhopConnectorOptions {
  /** Aggregate's Whop OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const WHOP_WRONG_SCOPE = 'Whop gave Aggregate more than read-only access to the balance, so the connection wasn’t saved.'
export const WHOP_NO_BUSINESS = 'This Whop sign-in doesn’t reach a business, so there’s nothing to connect.'
export const WHOP_MANY_BUSINESSES = 'This Whop sign-in reaches more than one business. Aggregate connects one business per sign-in for now, so the connection wasn’t saved.'
export const whopCurrencyGone = (currency: string) => `Whop no longer lists ${currency}, which Aggregate reported before. Showing those months as zero would be wrong, so this sync stopped. No totals were changed. To start fresh, disconnect Whop and connect it again.`
export const NOT_REVOKED = 'Aggregate couldn’t end its access at Whop. In Whop, open Settings, then Authorized apps, and remove Aggregate.'

interface Run {
  first: string
  until: string
  today: string
  /** Currencies still to read, as Whop writes them. */
  queue: string[]
  /** ISO code → month → family → minor units. */
  totals: Record<string, Record<string, MonthTotals>>
}

interface WhopCursor {
  /** Between runs, null. */
  run: Run | null
  /** Every currency reported, so one that has left stops the sync instead of keeping stale months. */
  currencies: string[]
}

const isTotals = (v: unknown): v is MonthTotals => isRecord(v) && Object.values(v).every((n) => Number.isSafeInteger(n))
const isRun = (v: unknown): v is Run =>
  isRecord(v) &&
  ['first', 'until', 'today'].every((k) => typeof v[k] === 'string') &&
  Array.isArray(v.queue) &&
  v.queue.every((c) => typeof c === 'string') &&
  isRecord(v.totals) &&
  Object.values(v.totals).every((byMonth) => isRecord(byMonth) && Object.values(byMonth).every(isTotals))
const isCursor = (v: unknown): v is WhopCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || isRun(v.run))
const isSecret = (v: unknown): v is WhopSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string' && typeof v.accountId === 'string'

/** The PKCE verifier for one connect attempt: HMAC(client secret, state), 43 base64url characters. */
export function verifierFor(clientSecret: string, state: string): string {
  return createHmac('sha256', clientSecret).update(`whop-pkce:${state}`).digest('base64url')
}

/** An id token or other extras from the token response aren't kept. */
function kept(tokens: OAuthTokens): OAuthTokens {
  const { extra: _extra, ...rest } = tokens
  return rest
}

const monthStart = (month: string) => `${month}-01T00:00:00.000Z`

export interface WhopConnector extends Connector {
  authorizationUrl(state: string): string
}

export function createWhopConnector(opts: WhopConnectorOptions, deps: ConnectorDeps): WhopConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<WhopCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: WHOP_AUTHORIZE_URL,
    tokenUrl: WHOP_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'body',
    tokenBody: 'json',
    scopes: [WHOP_SCOPE],
    fetch: baseFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Whop',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  const api = (token: string) => new WhopClient(token, { ...deps, fetch: baseFetch })

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; accountId: string; renewed?: WhopSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken, accountId: secret.accountId }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken, accountId: secret.accountId }
    const renewed: WhopSecret = { tokens: kept(tokens), accountId: secret.accountId }
    // Refresh tokens rotate: keep the new pair before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, accountId: secret.accountId, renewed }
  }

  async function snapshots(conn: ConnectionRef, run: Run, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (const currency of currencies) {
      const byMonth = run.totals[currency] ?? {}
      const families = [...new Set(Object.values(byMonth).flatMap((t) => Object.keys(t)))]
      for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
        const t = byMonth[month] ?? {}
        const end = lastDay(month)
        const externalId = `whop:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'whop.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'cash', currency, rows: monthRows(t, families, currency) })
      }
    }
    return events
  }

  /** Reads one currency into the run. */
  async function readCurrency(client: WhopClient, accountId: string, run: Run, whopCurrency: string): Promise<string[]> {
    const report = await client.incomeStatement(accountId, whopCurrency, monthStart(run.first), monthStart(addMonths(run.until, 1)))
    const iso = isoCurrency(whopCurrency)
    run.totals[iso] = readReport(report.rows, report.total, iso, run.first, run.until)
    return report.currencies
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
      if (!code || !state) throw new ConnectorError('invalid_input', 'Whop connects with Whop sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code, { codeVerifier: verifierFor(opts.oauth.clientSecret, state) })
      if (tokens.scope !== undefined && tokens.scope.split(/\s+/).filter(Boolean).join(' ') !== WHOP_SCOPE) throw new ConnectorError('permanent', WHOP_WRONG_SCOPE, { provider: PROVIDER, forUser: true })
      const client = api(tokens.accessToken)
      const accounts = await client.accounts()
      if (accounts.length === 0) throw new ConnectorError('permanent', WHOP_NO_BUSINESS, { provider: PROVIDER, forUser: true })
      if (accounts.length > 1) throw new ConnectorError('permanent', WHOP_MANY_BUSINESSES, { provider: PROVIDER, forUser: true })
      const account = accounts[0]!
      // One read, so a token that can't see the balance fails here rather than on the first sync.
      const month = new Date(clock.now()).toISOString().slice(0, 7)
      await client.incomeStatement(account.id, 'usd', monthStart(month), monthStart(addMonths(month, 1)))
      const secret: WhopSecret = { tokens: kept(tokens), accountId: account.id }
      return { secret, config: { accountId: account.id, displayName: `Whop · ${account.name}` } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, accountId, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = api(token)
      const decoded = codec.decode(cursor)
      const reported = decoded?.currencies ?? []

      let run = decoded?.run ?? null
      if (!run) {
        const now = clock.now()
        const until = new Date(now).toISOString().slice(0, 7)
        run = { first: addMonths(until, 1 - REPORT_MONTHS), until, today: new Date(now).toISOString().slice(0, 10), queue: [], totals: {} }
        // The first read is USD, which also lists every currency the business has had money in.
        const all = await readCurrency(client, accountId, run, 'usd')
        for (const c of all) isoCurrency(c)
        if (!all.some((c) => c.toLowerCase() === 'usd')) {
          // USD rows from a business that lists no USD: the list can't be trusted to name the rest.
          if (Object.keys(run.totals.USD ?? {}).length) throw unreadable('a currency list')
          delete run.totals.USD
        }
        const listed = new Set(Object.keys(run.totals).concat(all.map(isoCurrency)))
        const gone = reported.find((c) => !listed.has(c))
        if (gone) throw new ConnectorError('permanent', whopCurrencyGone(gone), { provider: PROVIDER, forUser: true })
        run.queue = [...new Set(all.filter((c) => c.toLowerCase() !== 'usd'))].sort()
        if (run.queue.length) return { events: [], cursor: codec.encode({ run, currencies: reported }), hasMore: true, ...extra }
      } else {
        const [next, ...rest] = run.queue
        if (next) {
          await readCurrency(client, accountId, run, next)
          run.queue = rest
          if (rest.length) return { events: [], cursor: codec.encode({ run, currencies: reported }), hasMore: true, ...extra }
        }
      }

      const currencies = [...new Set([...reported, ...Object.keys(run.totals)])].sort()
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a rotated refresh token would have nowhere to go); it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await api(secret.tokens.accessToken).accounts()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /** Ends the grant at Whop by revoking the refresh token. The call carries the app's credentials, no business data. */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      if (!tokens.refreshToken) return { notRevoked: NOT_REVOKED }
      try {
        const res = await baseFetch(WHOP_REVOKE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: tokens.refreshToken, client_id: opts.oauth.clientId, client_secret: opts.oauth.clientSecret }),
        })
        if (!res.ok) return { notRevoked: NOT_REVOKED }
      } catch {
        return { notRevoked: NOT_REVOKED }
      }
      return undefined
    },
  }
}
