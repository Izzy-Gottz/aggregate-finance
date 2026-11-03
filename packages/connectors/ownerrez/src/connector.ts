// OwnerRez connector (vacation rental software): monthly payments collected, refunds, chargebacks and fees per currency, as
// report.snapshot. What OwnerRez recorded, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no payment.applied, no account.upsert with money, nothing that posts. Rental
// money arrives in the bank through Airbnb, Vrbo, Stripe or another processor, so posting these would double revenue.
// report.snapshot never reaches the ledger, and core's provider_report check skips this connector (checks.ts).
//
// Auth: sign-in with Aggregate's OAuth app, the only way here. The `read` scope is asked for, and OwnerRez limits it to GET
// requests; the token response names the scope it granted, and anything but `read` is refused. Personal Access Tokens aren't
// taken: they reach everything the account can do. Access tokens last 30 days and renew a day early on sync, and the new pair
// is saved before any read. Disconnect revokes both the access and the refresh token at OwnerRez.
//
// Currency: OwnerRez payments carry no currency. The only currency it writes down is each property's, on the calendar. If
// every property uses one currency, that's the payments' currency; if they use more than one, the payments can't be split, so
// the sync stops and says so rather than add different currencies together. A currency reported before that the properties
// no longer use stops the sync too: zeroing its months would erase real totals, and moving them would relabel them.
//
// Stored: monthly totals only. Descriptions, booking ids, deposit details and the account's name and email are never kept.
//
// A run reads every payment and then every refund created or changed since LOOKBACK_MONTHS before the first reported month,
// one page per step, with the totals in the cursor, and only then sends the months: a half-read month must never show.
//
// Built from OwnerRez's API reference and OpenAPI spec. It has not been run against a real account, and the fixtures are
// hand-built. See README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { OWNERREZ_AUTHORIZE_URL, OWNERREZ_REVOKE_URL, OWNERREZ_SCOPE, OWNERREZ_TOKEN_URL, OwnerRezClient, userAgent } from './client.ts'
import { add, addMonths, dayIn, emptyTotals, isMonthTotals, lastDay, monthIn, monthRows, paymentLine, refundLine, type Line, type MonthTotals } from './month.ts'
import type { OwnerRezPayment, OwnerRezRefund } from './types.ts'

const PROVIDER = 'ownerrez'
export const REPORT_MONTHS = 12
/** A payment recorded late, or edited, still shows up: the list filters by created-or-changed, not by collected. */
export const LOOKBACK_MONTHS = 12
const PER_PAGE = 100
const RENEW_EARLY_MS = 86_400_000

export type OwnerRezSecret = { tokens: OAuthTokens }

export interface OwnerRezConnectorOptions {
  /** Aggregate's OwnerRez OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const OWNERREZ_WRONG_SCOPE = 'OwnerRez gave Aggregate more than read-only access, so the connection wasn’t saved. Aggregate’s OwnerRez app must be set to Read.'
export const OWNERREZ_MIXED_CURRENCY = 'This OwnerRez account has properties in more than one currency, and OwnerRez payments don’t say which currency they’re in. Aggregate can’t add them up without mixing currencies, so nothing was reported.'
export const OWNERREZ_NO_CURRENCY = 'OwnerRez shows no properties for this account, so Aggregate can’t tell which currency its payments are in. Nothing was reported.'
export const ownerRezCurrencyGone = (currency: string) => `OwnerRez’s properties no longer use ${currency}, which Aggregate reported before. Showing those months as zero, or moving them to another currency, would be wrong, so this sync stopped. No totals were changed. To start fresh, disconnect OwnerRez and connect it again.`
export const NOT_REVOKED = 'Aggregate couldn’t end its access at OwnerRez. In OwnerRez, remove Aggregate from the apps connected to your account.'

type Phase = 'payments' | 'refunds'

interface OwnerRezCursor {
  /** Between runs, null. */
  run: { first: string; until: string; today: string; since: string; zone: string; currency: string; phase: Phase; next: Record<string, string> | null; totals: Record<string, MonthTotals> } | null
  /** Every currency reported, so one that has left still gets its months zeroed. */
  currencies: string[]
}

const isRun = (v: unknown): v is NonNullable<OwnerRezCursor['run']> =>
  isRecord(v) &&
  ['first', 'until', 'today', 'since', 'zone', 'currency'].every((k) => typeof v[k] === 'string') &&
  (v.phase === 'payments' || v.phase === 'refunds') &&
  (v.next === null || isRecord(v.next)) &&
  isRecord(v.totals) &&
  Object.values(v.totals).every(isMonthTotals)
const isCursor = (v: unknown): v is OwnerRezCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || isRun(v.run))
const isSecret = (v: unknown): v is OwnerRezSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

/** The token response names the account; only its display name and id are kept, and nothing else from `extra`. */
function kept(tokens: OAuthTokens): OAuthTokens {
  const { extra: _extra, ...rest } = tokens
  return rest
}

export interface OwnerRezConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createOwnerRezConnector(opts: OwnerRezConnectorOptions, deps: ConnectorDeps): OwnerRezConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<OwnerRezCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const ua = userAgent(opts.oauth.clientId)
  const withUa: FetchLike = (input, init) => baseFetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'user-agent': ua } })

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: OWNERREZ_AUTHORIZE_URL,
    tokenUrl: OWNERREZ_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'basic',
    scopes: [OWNERREZ_SCOPE],
    fetch: withUa,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'OwnerRez',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  const api = (token: string) => new OwnerRezClient(token, opts.oauth.clientId, { ...deps, fetch: baseFetch })

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: OwnerRezSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: OwnerRezSecret = { tokens: kept(tokens) }
    // Keep the new pair before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  async function snapshots(conn: ConnectionRef, run: NonNullable<OwnerRezCursor['run']>, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const t = currency === run.currency ? (run.totals[month] ?? emptyTotals()) : emptyTotals()
        const externalId = `ownerrez:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'ownerrez.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'cash', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  return {
    describe: () => description,

    async begin(ctx) {
      return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'OwnerRez connects with OwnerRez sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code)
      if (tokens.scope !== OWNERREZ_SCOPE) throw new ConnectorError('permanent', OWNERREZ_WRONG_SCOPE, { provider: PROVIDER, forUser: true })
      const client = api(tokens.accessToken)
      await client.timeZone()
      await client.page('/v2/payments', { limit: 1 })
      const name = typeof tokens.extra?.user_display_name === 'string' && tokens.extra.user_display_name ? tokens.extra.user_display_name.slice(0, 80) : 'OwnerRez account'
      const secret: OwnerRezSecret = { tokens: kept(tokens) }
      return { secret, config: { ...(tokens.extra?.user_id !== undefined ? { accountId: String(tokens.extra.user_id) } : {}), displayName: `OwnerRez · ${name}` } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = api(token)
      const decoded = codec.decode(cursor)
      const reported = decoded?.currencies ?? []

      let run = decoded?.run ?? null
      if (!run) {
        const now = clock.now()
        const zone = await client.timeZone()
        const until = monthIn(zone, now)
        const first = addMonths(until, 1 - REPORT_MONTHS)
        // On the account's clock too, or a month that has begun there but not in UTC would end before it starts.
        const today = dayIn(zone, now)
        const { currencies, properties } = await client.propertyCurrencies(today)
        if (currencies.length > 1) throw new ConnectorError('permanent', OWNERREZ_MIXED_CURRENCY, { provider: PROVIDER, forUser: true })
        if (!properties || !currencies[0]) throw new ConnectorError('permanent', OWNERREZ_NO_CURRENCY, { provider: PROVIDER, forUser: true })
        const gone = reported.find((c) => c !== currencies[0])
        if (gone) throw new ConnectorError('permanent', ownerRezCurrencyGone(gone), { provider: PROVIDER, forUser: true })
        // Two days early: a payment in the first month was created or changed on or after this, wherever the account's clock sits.
        const since = new Date(Date.parse(`${addMonths(first, -LOOKBACK_MONTHS)}-01T00:00:00Z`) - 2 * 86_400_000).toISOString()
        run = { first, until, today, since, zone, currency: currencies[0], phase: 'payments', next: null, totals: {} }
      }

      const path = run.phase === 'payments' ? '/v2/payments' : '/v2/refunds'
      const page = await client.page<OwnerRezPayment | OwnerRezRefund>(path, run.next ?? { since_utc: run.since, limit: PER_PAGE })
      for (const item of page.items) {
        const line: Line | null = run.phase === 'payments' ? paymentLine(item as OwnerRezPayment, run.zone, run.currency) : refundLine(item as OwnerRezRefund, run.zone, run.currency)
        if (!line || line.month < run.first || line.month > run.until) continue
        run.totals[line.month] = add(run.totals[line.month] ?? emptyTotals(), line.totals)
      }

      if (page.next) return { events: [], cursor: codec.encode({ run: { ...run, next: page.next }, currencies: reported }), hasMore: true, ...extra }
      if (run.phase === 'payments') return { events: [], cursor: codec.encode({ run: { ...run, phase: 'refunds', next: null }, currencies: reported }), hasMore: true, ...extra }

      const currencies = [...new Set([...reported, run.currency])].sort()
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here (a rotated refresh token would have nowhere to go); it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await api(token).timeZone()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /**
     * Ends the grant at OwnerRez: the access token, then the refresh token, so neither can be used again. OwnerRez documents
     * one revoke call per token and doesn't say whether revoking the access token ends its refresh token; a 404 on the
     * refresh token is read as already ended. The calls
     * authenticate the app itself, so they hold no rental data.
     */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      const basic = 'Basic ' + Buffer.from(`${encodeURIComponent(opts.oauth.clientId)}:${encodeURIComponent(opts.oauth.clientSecret)}`).toString('base64')
      for (const token of [tokens.accessToken, tokens.refreshToken]) {
        if (!token) continue
        try {
          const res = await withUa(`${OWNERREZ_REVOKE_URL}/${encodeURIComponent(token)}`, { method: 'DELETE', headers: { authorization: basic } })
          // A 404 on the refresh token: revoking the access token already ended it.
          if (!res.ok && !(token === tokens.refreshToken && res.status === 404)) return { notRevoked: NOT_REVOKED }
        } catch {
          return { notRevoked: NOT_REVOKED }
        }
      }
      return undefined
    },
  }
}
