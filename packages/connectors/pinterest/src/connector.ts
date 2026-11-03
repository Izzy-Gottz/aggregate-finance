// Pinterest Ads connector: monthly ad spend per ad account, as report.snapshot. What Pinterest reports, not a booked expense.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert, nothing that posts. Ad spend also shows up as card or
// bank spend, so posting these would double it. report.snapshot never reaches the ledger, and core's provider_report check
// skips this connector (checks.ts).
//
// Auth: Pinterest sign-in with Aggregate's OAuth app, the only way in. ads:read is the one scope asked for, and a grant that
// names anything else is refused. Each ad account is its own connection. Refresh tokens run 60 days and renew; a new access
// token is saved before any read.
//
// Stored: monthly account totals only. No campaign, ad group, ad, pin or audience is ever asked for.
//
// The window: Pinterest's GET report reaches 90 days back, so a sync reads every whole month inside that, plus this month so
// far. A month it can only partly see is never sent, because that would understate it. Older months stay from earlier syncs.
// A first connect shows two or three months, not twelve. The report that goes further needs a POST and a file (client.ts).
//
// No answer is not $0: any error ends the sync with no snapshots, a day with no spend figure stops it, and a month with no
// days at all sends nothing.
//
// Built from Pinterest's published OpenAPI description. It has not been run against a real account, and the fixtures are
// hand-built. See README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { createHash } from 'node:crypto'
import { AD_ACCOUNT_ID, AD_CURRENCY, PINTEREST_AUTHORIZE_URL, PINTEREST_SCOPE, PINTEREST_TOKEN_URL, PinterestClient, unreadable } from './client.ts'
import { exact, lastDay, microsToMinor, monthRows, nextMonthStart } from './month.ts'

const PROVIDER = 'pinterest'
/** A day short of the 90 Pinterest allows, so a request near midnight UTC isn't refused. */
export const WINDOW_DAYS = 89
const DAY_MS = 86_400_000
/** Access tokens last about 30 days. */
const RENEW_EARLY_MS = 86_400_000

export type PinterestSecret = { tokens: OAuthTokens }

export interface PinterestConnectorOptions {
  /** Aggregate's Pinterest app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const PINTEREST_WRONG_ACCESS = 'Pinterest’s sign-in came back with more than read-only ads access, so this connection was stopped. Nothing was read.'
export const PINTEREST_NO_RENEWAL = 'Pinterest didn’t give Aggregate a way to keep this connection up to date. Connect Pinterest again.'
export const NOT_REVOKED = 'Pinterest has no way for Aggregate to end the sign-in from here. In your Pinterest settings, remove Aggregate from your connected apps.'

const isSecret = (v: unknown): v is PinterestSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

const accountOf = (conn: ConnectionRef): { id: string; currency: string } => {
  const id = str(conn.config.adAccountId)
  const currency = str(conn.config.currency)
  if (!id || !AD_ACCOUNT_ID.test(id) || !currency || !AD_CURRENCY.test(currency)) throw new ConnectorError('permanent', 'This connection has no Pinterest ad account. Connect Pinterest again.', { provider: PROVIDER, forUser: true })
  return { id, currency }
}

export interface PinterestConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createPinterestConnector(opts: PinterestConnectorOptions, deps: ConnectorDeps): PinterestConnector {
  const clock = deps.clock ?? systemClock

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: PINTEREST_AUTHORIZE_URL,
    tokenUrl: PINTEREST_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'basic',
    scopes: [PINTEREST_SCOPE],
    scopeSeparator: ',',
    fetch: deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Pinterest Ads',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: PinterestSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: PinterestSecret = { tokens }
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  return {
    describe: () => description,

    async begin(ctx) {
      return { kind: 'oauth', url: oauth.authorizationUrl({ state: ctx.state }) }
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Pinterest connects with Pinterest sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code)
      // The docs make `scope` optional. When it's missing the app still only asked for ads:read, and the client only reads.
      const granted = tokens.scope?.split(/[\s,]+/).filter(Boolean)
      if (granted && (granted.length !== 1 || granted[0] !== PINTEREST_SCOPE)) throw new ConnectorError('permanent', PINTEREST_WRONG_ACCESS, { provider: PROVIDER, forUser: true })
      if (!tokens.refreshToken) throw new ConnectorError('permanent', PINTEREST_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      const accounts = (await new PinterestClient(tokens.accessToken, deps).adAccounts()).sort((a, b) => a.id.localeCompare(b.id))
      if (!accounts.length) throw new ConnectorError('invalid_input', 'This Pinterest sign-in doesn’t reach an ad account.', { provider: PROVIDER, forUser: true })
      const secret: PinterestSecret = { tokens }
      const sharedSecretKey = `pinterest:${createHash('sha256').update(tokens.refreshToken).digest('hex').slice(0, 16)}`
      const [first, ...rest] = accounts.map((a) => ({
        secret,
        config: { adAccountId: a.id, currency: a.currency, displayName: `Pinterest Ads · ${a.name.slice(0, 80)}`, ...(accounts.length > 1 ? { sharedSecretKey } : {}) },
      }))
      return { ...first!, ...(rest.length ? { additional: rest } : {}) }
    },

    async sync(conn): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const { id, currency } = accountOf(conn)
      const client = new PinterestClient(token, deps)
      const today = new Date(clock.now()).toISOString().slice(0, 10)
      const earliest = new Date(clock.now() - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)
      // Only a month whose first day is in reach: a part of one would read as a smaller month.
      const start = earliest.endsWith('-01') ? earliest : nextMonthStart(earliest)

      const months = new Map<string, number>()
      const days = new Set<string>()
      for (const d of await client.dailySpend(id, start, today)) {
        if (d.date < start || d.date > today) throw unreadable('spend outside the dates asked for')
        if (days.has(d.date)) throw unreadable('a day twice')
        days.add(d.date)
        const month = d.date.slice(0, 7)
        months.set(month, exact((months.get(month) ?? 0) + d.micros))
      }

      const events: ReportSnapshot[] = []
      for (const month of [...months.keys()].sort()) {
        const minor = microsToMinor(months.get(month) as number, currency)
        const end = lastDay(month)
        const externalId = `pinterest:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'pinterest.month', externalId, { month, currency, minor })
        events.push({
          type: 'report.snapshot',
          externalId,
          connectionId: conn.id,
          rawRef,
          kind: 'profit_and_loss',
          from: `${month}-01`,
          to: end < today ? end : today,
          basis: 'accrual',
          currency,
          rows: monthRows(minor, currency),
        })
      }
      return { events, cursor: null, hasMore: false, ...(renewed ? { updatedSecret: renewed } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here; it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await new PinterestClient(token, deps).adAccounts()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    async disconnect(conn) {
      requireSecret(PROVIDER, conn.secret, isSecret)
      // Another ad account from this sign-in still uses the token.
      if (conn.config.sharedSecretKey && conn.config.lastOfGrant === false) return
      // The API description has no revoke call, so the person ends it on Pinterest's side.
      return { notRevoked: NOT_REVOKED }
    },
  }
}
