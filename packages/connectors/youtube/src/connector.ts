// YouTube connector: a channel's monthly estimated revenue, as report.snapshot. What YouTube estimates, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. YouTube pays through
// AdSense into the bank, so posting these would double revenue. report.snapshot never reaches the ledger, and core's
// provider_report check skips this connector (checks.ts). With AdSense connected too, the same money shows in both drawers,
// each "not counted as revenue".
//
// Auth: Google sign-in with Aggregate's OAuth app, the only way in. A grant that isn't exactly the two read-only scopes is
// refused. Google's consent picks one channel, and each channel is its own connection: YouTube's policies forbid combining
// data across content owners. Access tokens last about an hour and renew on sync; the new one is saved before any read.
//
// Stored: one estimate per month, channel level. No video, country or audience data is ever asked for. Every sync renews the
// sign-in, which is the policies' 30-day authorization check. A refused refresh token means the person revoked Aggregate, and
// raises code 'revoked' so the server erases (ERASE_ON_DISCONNECT). See README.md for the rest of the rules.
//
// No revenue is not zero. A month YouTube has no row for gets no snapshot, and a channel with nothing in 12 months gets a
// plain message and no $0 lines, because that usually means it isn't monetized.
//
// Built from Google's API reference. It has not been run against a real account, and the fixtures are hand-built. See
// README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { CHANNEL_ID, unreadable, YOUTUBE_AUTHORIZE_URL, YOUTUBE_NO_REVENUE, YOUTUBE_REVOKE_URL, YOUTUBE_SCOPES, YOUTUBE_TOKEN_URL, YouTubeClient } from './client.ts'
import { addMonths, lastDay, monthRows, REPORT_CURRENCY, revenueMinor } from './month.ts'

const PROVIDER = 'youtube'
export const LOOKBACK_MONTHS = 12
/** Google's tokens last an hour. */
const RENEW_EARLY_MS = 300_000
/** Revenue months run on Pacific time. */
const REPORT_ZONE = 'America/Los_Angeles'

export type YouTubeSecret = { tokens: OAuthTokens }

export interface YouTubeConnectorOptions {
  /** Aggregate's Google OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const YOUTUBE_WRONG_ACCESS = 'Google’s sign-in didn’t come back with read-only YouTube access and nothing else, so this connection was stopped. Nothing was read. Connect YouTube again and tick both YouTube boxes.'
export const YOUTUBE_NO_RENEWAL = 'Google didn’t give Aggregate a way to keep this connection up to date. Remove Aggregate in your Google Account, then connect YouTube again.'
export const NOT_REVOKED = 'Google didn’t confirm the sign-in ended. In your Google Account, open Security → Third-party apps and remove Aggregate.'

const isSecret = (v: unknown): v is YouTubeSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'
const isRefused = (e: unknown) => e instanceof ConnectorError && e.kind === 'auth' && e.code === 'invalid_grant'
const revoked = () => new ConnectorError('auth', 'Access to YouTube was removed in your Google Account, so your YouTube data was deleted from Aggregate. Connect YouTube again to bring it back.', { provider: PROVIDER, code: 'revoked', forUser: true })

const channelOf = (conn: ConnectionRef): string => {
  const id = str(conn.config.channel)
  if (!id || !CHANNEL_ID.test(id)) throw new ConnectorError('permanent', 'This connection has no YouTube channel. Connect YouTube again.', { provider: PROVIDER, forUser: true })
  return id
}

const dayInReportZone = (nowMs: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: REPORT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs)

/** The months to ask for, and the rows checked. Anything outside them or twice stops; nothing but zero counts as no revenue. */
async function readRevenue(client: YouTubeClient, channel: string, today: string): Promise<{ first: string; until: string; byMonth: Map<string, number> }> {
  const until = today.slice(0, 7)
  const first = addMonths(until, 1 - LOOKBACK_MONTHS)
  const byMonth = new Map<string, number>()
  for (const r of await client.revenue(channel, first, until)) {
    if (r.month < first || r.month > until) throw unreadable('revenue outside the dates asked for')
    if (byMonth.has(r.month)) throw unreadable('a month twice')
    byMonth.set(r.month, revenueMinor(r.amount))
  }
  if (![...byMonth.values()].some((v) => v !== 0)) throw new ConnectorError('permanent', YOUTUBE_NO_REVENUE, { provider: PROVIDER, forUser: true })
  return { first, until, byMonth }
}

export interface YouTubeConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createYouTubeConnector(opts: YouTubeConnectorOptions, deps: ConnectorDeps): YouTubeConnector {
  const clock = deps.clock ?? systemClock
  const tokenFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: YOUTUBE_AUTHORIZE_URL,
    tokenUrl: YOUTUBE_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'body',
    scopes: YOUTUBE_SCOPES,
    scopeSeparator: ' ',
    fetch: tokenFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'YouTube',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates daily',
    auth: 'oauth',
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: YouTubeSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS).catch((e: unknown) => {
      throw isRefused(e) ? revoked() : e
    })
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: YouTubeSecret = { tokens }
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  return {
    describe: () => description,

    async begin(ctx) {
      // offline and consent: without them Google sends no refresh token on a second sign-in, and syncs stop in an hour.
      return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state, extraParams: { access_type: 'offline', prompt: 'consent' } }) }
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'YouTube connects with Google sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code)
      const granted = (tokens.scope?.split(/\s+/).filter(Boolean) ?? []).sort()
      if (granted.join(' ') !== [...YOUTUBE_SCOPES].sort().join(' ')) throw new ConnectorError('permanent', YOUTUBE_WRONG_ACCESS, { provider: PROVIDER, forUser: true })
      if (!tokens.refreshToken) throw new ConnectorError('permanent', YOUTUBE_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      const client = new YouTubeClient(tokens.accessToken, deps)
      const channel = await client.channel()
      await readRevenue(client, channel.id, dayInReportZone(clock.now()))
      return { secret: { tokens } satisfies YouTubeSecret, config: { channel: channel.id, displayName: `YouTube · ${channel.title.slice(0, 80)}` } }
    },

    async sync(conn): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const today = dayInReportZone(clock.now())
      const { first, until, byMonth } = await readRevenue(new YouTubeClient(token, deps), channelOf(conn), today)
      const events: ReportSnapshot[] = []
      for (let month = first; month <= until; month = addMonths(month, 1)) {
        const minor = byMonth.get(month)
        if (minor === undefined) continue
        const end = lastDay(month)
        const externalId = `youtube:${month}:${REPORT_CURRENCY}`
        const rawRef = await deps.raw.put(conn.id, 'youtube.month', externalId, { month, currency: REPORT_CURRENCY, earned: minor })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < today ? end : today, basis: 'accrual', currency: REPORT_CURRENCY, rows: monthRows(minor) })
      }
      return { events, cursor: null, hasMore: false, ...(renewed ? { updatedSecret: renewed } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here; it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await new YouTubeClient(token, deps).channel()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      const token = secret.tokens.refreshToken ?? secret.tokens.accessToken
      try {
        const res = await tokenFetch(YOUTUBE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
        if (!res.ok) return { notRevoked: NOT_REVOKED }
      } catch {
        return { notRevoked: NOT_REVOKED }
      }
      return
    },
  }
}
