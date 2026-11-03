// Squarespace Commerce connector: monthly store sales per currency, as report.snapshot. What the store reports, not booked
// revenue.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. Squarespace's money arrives
// through Stripe, PayPal or Square, so posting these would double revenue. report.snapshot never reaches the ledger, and core's
// provider_report check skips this connector (checks.ts).
//
// Auth: sign-in with Aggregate's OAuth app, the only way here. website.transactions.read is the one permission asked for;
// Squarespace's token response doesn't name what was granted, so that can't be checked on the way back. Site API keys aren't
// taken: they'd need Commerce Advanced, and nothing shows what a key can write. One token, one site. Access tokens last 30
// minutes and refresh tokens seven days, one use each: the new pair is saved before any read, so a connection that goes a week
// without a sync must sign in again.
//
// Stored: monthly totals only. customerEmail is on every Document and is never read.
//
// A run reads every Document modified in the 12 months, one page per step, with the totals in the cursor, and only then sends
// the months: a refund can change any of them, and a half-read month must never show. A Squarespace cursor that's gone stale
// starts the run again.
//
// Built from Squarespace's API reference and published schema. It has not been run against a real site, and the fixtures are
// hand-built. See README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { SQUARESPACE_AUTHORIZE_URL, SQUARESPACE_SCOPE, SQUARESPACE_TOKEN_URL, SquarespaceClient, USER_AGENT } from './client.ts'
import { addMonths, documentLines, emptyTotals, exact, isMonthTotals, lastDay, monthIn, monthRows, type MonthTotals } from './month.ts'

const PROVIDER = 'squarespace'
export const LOOKBACK_MONTHS = 12
const RENEW_EARLY_MS = 300_000
const ACCESS_MS = 1_800_000

export type SquarespaceSecret = { tokens: OAuthTokens }

export interface SquarespaceConnectorOptions {
  /** Aggregate's Squarespace OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const SQUARESPACE_NO_RENEWAL = 'Squarespace didn’t give Aggregate a way to keep this connection up to date. Connect Squarespace again.'
export const NOT_REVOKED = 'Squarespace has no way for Aggregate to end this access. In your site’s settings, open Extensions and disconnect Aggregate.'

interface SquarespaceCursor {
  /** Between runs, null. */
  run: { first: string; until: string; today: string; after: string; before: string; page: string | null; prev: string[]; totals: Record<string, MonthTotals>; timeZone: string; currency: string } | null
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
}

const isCursor = (v: unknown): v is SquarespaceCursor =>
  isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || (isRecord(v.run) && isRecord(v.run.totals) && Object.values(v.run.totals).every(isMonthTotals)))
const isSecret = (v: unknown): v is SquarespaceSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

/** Squarespace's token response has its own expiry field and repeats the access token as `token`, so neither stays in `extra`. */
function normalized(tokens: OAuthTokens, now: number): OAuthTokens {
  const { extra, ...rest } = tokens
  const stated = Number(extra?.access_token_expires_at)
  return { ...rest, expiresAt: Number.isFinite(stated) && stated > 0 ? stated * 1000 : now + ACCESS_MS }
}

export interface SquarespaceConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createSquarespaceConnector(opts: SquarespaceConnectorOptions, deps: ConnectorDeps): SquarespaceConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<SquarespaceCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const tokenFetch: FetchLike = (input, init) => baseFetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'user-agent': USER_AGENT } })

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: SQUARESPACE_AUTHORIZE_URL,
    tokenUrl: SQUARESPACE_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'basic',
    basicEncoding: 'raw',
    scopes: [SQUARESPACE_SCOPE],
    scopeSeparator: ',',
    fetch: tokenFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Squarespace',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: SquarespaceSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew || !oauth.isExpired(secret.tokens, RENEW_EARLY_MS)) return { token: secret.tokens.accessToken }
    const tokens = normalized(await oauth.refresh(secret.tokens), clock.now())
    const renewed: SquarespaceSecret = { tokens }
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  async function snapshots(conn: ConnectionRef, run: NonNullable<SquarespaceCursor['run']>, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const t = run.totals[`${month}:${currency}`] ?? emptyTotals()
        const externalId = `squarespace:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'squarespace.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'accrual', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  return {
    describe: () => description,

    async begin(ctx) {
      // offline: without it there's no refresh token, and syncs stop in 30 minutes.
      return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state, extraParams: { access_type: 'offline' } }) }
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Squarespace connects with Squarespace sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = normalized(await oauth.exchangeCode(code), clock.now())
      if (!tokens.refreshToken) throw new ConnectorError('permanent', SQUARESPACE_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      const client = new SquarespaceClient(tokens.accessToken, { ...deps, fetch: baseFetch })
      const site = await client.site()
      await client.transactions({ after: new Date(clock.now() - 86_400_000).toISOString(), before: new Date(clock.now()).toISOString() }, null)
      const secret: SquarespaceSecret = { tokens }
      return { secret, config: { websiteId: site.id, timeZone: site.timeZone, displayName: `Squarespace · ${site.title.slice(0, 80)}` } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = new SquarespaceClient(token, { ...deps, fetch: baseFetch })
      const decoded = codec.decode(cursor)
      const seen = new Set(decoded?.currencies ?? [])

      let run = decoded?.run ?? null
      if (!run) {
        const site = await client.site()
        const now = clock.now()
        const until = monthIn(site.timeZone, now)
        const first = addMonths(until, 1 - LOOKBACK_MONTHS)
        // Two days early: every payment in the first month was modified on or after it, wherever the site's clock sits.
        const after = new Date(Date.parse(`${first}-01T00:00:00Z`) - 86_400_000 * 2).toISOString()
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
        run = { first, until, today, after, before: new Date(now).toISOString(), page: null, prev: [], totals: {}, timeZone: site.timeZone, currency: site.currency }
      }

      let page
      try {
        page = await client.transactions(run.page ? null : { after: run.after, before: run.before }, run.page)
      } catch (e) {
        // A cursor Squarespace no longer knows: the run starts over, nothing has been sent from it.
        if (run.page && e instanceof ConnectorError && e.status === 400) return { events: [], cursor: codec.encode({ run: null, currencies: [...seen].sort() }), hasMore: true, ...extra }
        throw e
      }

      const repeated = new Set(run.prev)
      const ids: string[] = []
      for (const doc of page.documents) {
        const lines = documentLines(doc, run.timeZone)
        ids.push(doc.id as string)
        if (repeated.has(doc.id as string)) continue
        for (const l of lines) {
          if (l.month < run.first || l.month > run.until) continue
          const key = `${l.month}:${l.currency}`
          const t = run.totals[key] ?? emptyTotals()
          run.totals[key] = { sales: exact(t.sales + l.sales), refunds: exact(t.refunds + l.refunds) }
        }
      }
      const next = { ...run, page: page.nextPageCursor, prev: ids }
      if (page.nextPageCursor) return { events: [], cursor: codec.encode({ run: next, currencies: [...seen].sort() }), hasMore: true, ...extra }

      seen.add(run.currency)
      for (const key of Object.keys(run.totals)) seen.add(key.slice(8))
      const currencies = [...seen].sort()
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here: a refresh token works once, so it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await new SquarespaceClient(token, { ...deps, fetch: baseFetch }).site()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Squarespace documents no revoke call. The saved tokens are deleted here; the person removes the app at Squarespace.
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
