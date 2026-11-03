// Google AdSense connector: monthly estimated earnings and payments per currency, as report.snapshot. What AdSense reports,
// not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. AdSense's money arrives
// in the bank, so posting these would double revenue. report.snapshot never reaches the ledger, and core's provider_report
// check skips this connector (checks.ts).
//
// Auth: Google sign-in with Aggregate's OAuth app, the only way in. adsense.readonly is the one scope asked for, and a grant
// that lacks it or holds anything else is refused, so the wider adsense scope can't get through. No pasted keys: AdSense has
// none. Each account is its own connection. Access tokens last about an hour and renew on sync; the new one is saved before
// any read.
//
// Stored: monthly totals only. No site, ad unit, page or country is ever asked for. See README.md: Google's API terms limit
// permanent copies, so these snapshots need checking against them before the flag is turned on.
//
// A sync is one report and one payment list, and always recomputes all 12 months, because earnings get adjusted. Shapes are
// checked: an unknown payment name, a date that doesn't match its name, or a total that doesn't match its rows stops the sync.
// The unpaid balance is checked and thrown away, so it can never count as paid.
//
// Built from Google's API reference. It has not been run against a real account, and the fixtures are hand-built. See
// README.md for what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type OAuthTokens } from '@agfn/connector-sdk'
import { createHash } from 'node:crypto'
import { ACCOUNT_NAME, ADSENSE_AUTHORIZE_URL, ADSENSE_REVOKE_URL, ADSENSE_SCOPE, ADSENSE_TOKEN_URL, AdSenseClient, unreadable } from './client.ts'
import { addMonths, cellMinor, emptyTotals, exact, lastDay, monthRows, paymentMoney, type MonthTotals } from './month.ts'
import type { AdSensePayment } from './types.ts'

const PROVIDER = 'adsense'
export const LOOKBACK_MONTHS = 12
/** Google's tokens last an hour. */
const RENEW_EARLY_MS = 300_000

export type AdSenseSecret = { tokens: OAuthTokens }

export interface AdSenseConnectorOptions {
  /** Aggregate's Google OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const ADSENSE_WRONG_ACCESS = 'Google’s sign-in didn’t come back with read-only AdSense access and nothing else, so this connection was stopped. Nothing was read. Connect AdSense again and tick only the AdSense box.'
export const ADSENSE_NO_RENEWAL = 'Google didn’t give Aggregate a way to keep this connection up to date. Remove Aggregate in your Google Account, then connect AdSense again.'
export const NOT_REVOKED = 'Google didn’t confirm the sign-in ended. In your Google Account, open Security → Third-party apps and remove Aggregate.'

interface AdSenseCursor {
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
}

const isCursor = (v: unknown): v is AdSenseCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string')
const isSecret = (v: unknown): v is AdSenseSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

const accountOf = (conn: ConnectionRef): string => {
  const name = str(conn.config.account)
  if (!name || !ACCOUNT_NAME.test(name)) throw new ConnectorError('permanent', 'This connection has no AdSense account. Connect AdSense again.', { provider: PROVIDER, forUser: true })
  return name
}

/** A day on the account's clock. AdSense reports in that zone, and a zone it sends that isn't known falls back to UTC. */
function dayIn(zone: unknown, nowMs: number): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: typeof zone === 'string' ? zone : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs)
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10)
  }
}

/** The month a paid payment lands in, or null for the unpaid balance, which is never paid money. */
function paidMonth(p: AdSensePayment): string | null {
  if (typeof p.name !== 'string') throw unreadable('a payment')
  const m = /^accounts\/pub-\d+\/payments\/(?:(?:youtube-)?(unpaid)|(?:youtube-)?(\d{4}-\d{2}-\d{2}))$/.exec(p.name)
  if (!m) throw unreadable('a payment')
  const hasDate = isRecord(p.date) && Object.keys(p.date).length > 0
  if (m[1]) {
    if (hasDate) throw unreadable('an unpaid balance with a date')
    return null
  }
  if (!hasDate) throw unreadable('a payment with no date')
  const { year, month, day } = p.date as Record<string, unknown>
  const shown = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (shown !== m[2]) throw unreadable('a payment whose date doesn’t match')
  return shown.slice(0, 7)
}

export interface AdSenseConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createAdSenseConnector(opts: AdSenseConnectorOptions, deps: ConnectorDeps): AdSenseConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<AdSenseCursor>(PROVIDER, 1, isCursor)
  const tokenFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: ADSENSE_AUTHORIZE_URL,
    tokenUrl: ADSENSE_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'body',
    scopes: [ADSENSE_SCOPE],
    scopeSeparator: ' ',
    fetch: tokenFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Google AdSense',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  /** An access token for this connection, renewing it first (when asked) if it's close to running out. */
  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: AdSenseSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: AdSenseSecret = { tokens }
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
      if (!code) throw new ConnectorError('invalid_input', 'AdSense connects with Google sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code)
      const granted = tokens.scope?.split(/\s+/).filter(Boolean) ?? []
      if (granted.length !== 1 || granted[0] !== ADSENSE_SCOPE) throw new ConnectorError('permanent', ADSENSE_WRONG_ACCESS, { provider: PROVIDER, forUser: true })
      if (!tokens.refreshToken) throw new ConnectorError('permanent', ADSENSE_NO_RENEWAL, { provider: PROVIDER, forUser: true })
      const client = new AdSenseClient(tokens.accessToken, deps)
      const accounts = (await client.accounts()).sort((a, b) => a.name.localeCompare(b.name))
      if (!accounts.length) throw new ConnectorError('invalid_input', 'This Google sign-in doesn’t reach an AdSense account.', { provider: PROVIDER, forUser: true })
      for (const a of accounts) await client.payments(a.name)
      const secret: AdSenseSecret = { tokens }
      const sharedSecretKey = `adsense:${createHash('sha256').update(tokens.refreshToken).digest('hex').slice(0, 16)}`
      const [first, ...rest] = accounts.map((a) => ({
        secret,
        config: { account: a.name, timeZone: a.timeZone, displayName: `AdSense · ${a.displayName.slice(0, 80)}`, ...(accounts.length > 1 ? { sharedSecretKey } : {}) },
      }))
      return { ...first!, ...(rest.length ? { additional: rest } : {}) }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const client = new AdSenseClient(token, deps)
      const account = accountOf(conn)
      const today = dayIn(conn.config.timeZone, clock.now())
      const until = today.slice(0, 7)
      const first = addMonths(until, 1 - LOOKBACK_MONTHS)

      const report = await client.report(account, `${first}-01`, today)
      const totals = new Map<string, MonthTotals>()
      const of = (month: string, currency: string) => {
        const key = `${month}:${currency}`
        if (!totals.has(key)) totals.set(key, emptyTotals())
        return totals.get(key) as MonthTotals
      }
      const months = new Set<string>()
      let sum = 0
      for (const r of report.rows) {
        if (r.month < first || r.month > until) throw unreadable('earnings outside the dates asked for')
        if (months.has(r.month)) throw unreadable('a month twice')
        months.add(r.month)
        const amount = cellMinor(r.amount, report.currency)
        of(r.month, report.currency).earned = amount
        sum = exact(sum + amount)
      }
      if (report.total !== null && cellMinor(report.total, report.currency) !== sum) throw unreadable('a total that doesn’t match its months')

      for (const p of await client.payments(account)) {
        const month = paidMonth(p)
        const money = paymentMoney(p.amount, report.currency)
        if (month === null || month < first || month > until) continue
        const t = of(month, money.currency)
        t.paid = exact(t.paid + money.minor)
      }

      const seen = new Set([...(codec.decode(cursor)?.currencies ?? []), report.currency])
      for (const key of totals.keys()) seen.add(key.slice(8))
      const currencies = [...seen].sort()

      const events: ReportSnapshot[] = []
      for (let month = first; month <= until; month = addMonths(month, 1)) {
        const end = lastDay(month)
        for (const currency of currencies) {
          const t = totals.get(`${month}:${currency}`) ?? emptyTotals()
          const externalId = `adsense:${month}:${currency}`
          const rawRef = await deps.raw.put(conn.id, 'adsense.month', externalId, { month, currency, totals: t })
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
            rows: monthRows(t, currency),
          })
        }
      }
      return { events, cursor: codec.encode({ currencies }), hasMore: false, ...(renewed ? { updatedSecret: renewed } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here; it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        const { token } = await tokenFor(conn, false)
        await new AdSenseClient(token, deps).payments(accountOf(conn))
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    async disconnect(conn) {
      const secret = requireSecret(PROVIDER, conn.secret, isSecret)
      // Another account from this sign-in still uses the token. Revoking would end that one too.
      if (conn.config.sharedSecretKey && conn.config.lastOfGrant === false) return
      const token = secret.tokens.refreshToken ?? secret.tokens.accessToken
      try {
        const res = await tokenFetch(ADSENSE_REVOKE_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() })
        if (!res.ok) return { notRevoked: NOT_REVOKED }
      } catch {
        return { notRevoked: NOT_REVOKED }
      }
      return
    },
  }
}
