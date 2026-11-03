// Mollie connector (payments, Europe): Mollie's own monthly balance report per currency, as report.snapshot.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. Mollie pays out to the
// bank, which may be connected already, so posting these would double revenue. report.snapshot never reaches the ledger,
// and core's provider_report check skips this connector (checks.ts).
//
// Auth: "Connect with Mollie" (OAuth) on Aggregate's app, asking for `balances.read` and `balance-reports.read` only. They
// read balances and their reports; they can't see customers or move money. A token response naming any other scope is
// refused. Access tokens last an hour and renew on sync; the new token is saved before any read. Disconnect revokes the
// refresh token at Mollie.
//
// Months are on Amsterdam's clock, the only one Mollie's reports use. Each balance is one currency; balances that share a
// currency are added together. Every month is checked: opening balance plus its movements must equal its closing balance.
// A currency reported before with no balance now stops the sync: zeroing its months would erase real totals.
//
// A run reads one balance-month per step, totals in the cursor, and only then sends the months: a half-read run must never
// show.
//
// Stored: monthly totals per kind and the closing balance only. Payment methods and counts in the report are read past.
//
// Built from Mollie's OAuth guide and OpenAPI reference. It has not been run against a real account, and the fixtures are
// hand-built. See README.md for what's unverified.

import type { Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, OAuthClient, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike, type OAuthTokens } from '@agfn/connector-sdk'
import { MOLLIE_AUTHORIZE_URL, MOLLIE_SCOPES, MOLLIE_TOKEN_URL, MollieClient, type MollieBalance } from './client.ts'
import { add, addMonths, amsterdamDay, emptyTotals, lastDay, monthRows, nextDay, readTotals, type MonthTotals } from './report.ts'

const PROVIDER = 'mollie'
export const REPORT_MONTHS = 12
const RENEW_EARLY_MS = 5 * 60_000

export type MollieSecret = { tokens: OAuthTokens }

export interface MollieConnectorOptions {
  /** Aggregate's Mollie OAuth app. Required: there's no other way in. */
  oauth: { clientId: string; clientSecret: string; redirectUri: string }
}

export const MOLLIE_WRONG_SCOPE = 'Mollie gave Aggregate access beyond reading balances, so the connection wasn’t saved.'
export const MOLLIE_NO_BALANCE = 'This Mollie account has no balances yet, so there’s nothing to connect.'
export const mollieCurrencyGone = (currency: string) => `Mollie no longer shows a ${currency} balance, which Aggregate reported before. Showing those months as zero would be wrong, so this sync stopped. No totals were changed. To start fresh, disconnect Mollie and connect it again.`
export const NOT_REVOKED = 'Aggregate couldn’t end its access at Mollie. In Mollie, open Settings, then Connected apps, and remove Aggregate.'

interface Run {
  first: string
  until: string
  /** Amsterdam's today when the run began. */
  today: string
  balances: MollieBalance[]
  /** Next balance-month to read: balance = floor(step / months), month = first + step % months. */
  step: number
  /** Currency → month → totals. */
  totals: Record<string, Record<string, MonthTotals>>
}

interface MollieCursor {
  run: Run | null
  /** Every currency reported, so one that has left stops the sync instead of keeping stale months. */
  currencies: string[]
}

const isTotals = (v: unknown): v is MonthTotals => isRecord(v) && Number.isSafeInteger(v.close) && isRecord(v.kinds) && Object.values(v.kinds).every((n) => Number.isSafeInteger(n))
const isRun = (v: unknown): v is Run =>
  isRecord(v) &&
  ['first', 'until', 'today'].every((k) => typeof v[k] === 'string') &&
  Number.isSafeInteger(v.step) &&
  Array.isArray(v.balances) &&
  v.balances.every((b) => isRecord(b) && typeof b.id === 'string' && typeof b.currency === 'string') &&
  isRecord(v.totals) &&
  Object.values(v.totals).every((byMonth) => isRecord(byMonth) && Object.values(byMonth).every(isTotals))
const isCursor = (v: unknown): v is MollieCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || isRun(v.run))
const isSecret = (v: unknown): v is MollieSecret => isRecord(v) && isRecord(v.tokens) && typeof v.tokens.accessToken === 'string'

const kept = (tokens: OAuthTokens): OAuthTokens => {
  const { extra: _extra, ...rest } = tokens
  return rest
}

const sameScopes = (granted: string) => {
  const g = granted.split(/\s+/).filter(Boolean).sort()
  return g.length === MOLLIE_SCOPES.length && [...MOLLIE_SCOPES].sort().every((s, i) => g[i] === s)
}

export interface MollieConnector extends Connector {
  authorizationUrl(state: string): string
}

export function createMollieConnector(opts: MollieConnectorOptions, deps: ConnectorDeps): MollieConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<MollieCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))

  const oauth = new OAuthClient({
    provider: PROVIDER,
    authorizeUrl: MOLLIE_AUTHORIZE_URL,
    tokenUrl: MOLLIE_TOKEN_URL,
    clientId: opts.oauth.clientId,
    clientSecret: opts.oauth.clientSecret,
    redirectUri: opts.oauth.redirectUri,
    clientAuth: 'basic',
    tokenBody: 'json',
    scopes: [...MOLLIE_SCOPES],
    fetch: baseFetch,
    clock,
  })

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Mollie',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  const api = (token: string) => new MollieClient(token, { ...deps, fetch: baseFetch })

  async function tokenFor(conn: ConnectionRef, renew: boolean): Promise<{ token: string; renewed?: MollieSecret }> {
    const secret = requireSecret(PROVIDER, conn.secret, isSecret)
    if (!renew) return { token: secret.tokens.accessToken }
    const { tokens, refreshed } = await oauth.ensureFresh(secret.tokens, RENEW_EARLY_MS)
    if (!refreshed) return { token: tokens.accessToken }
    const renewed: MollieSecret = { tokens: kept(tokens) }
    // Keep the new token before any read can fail and strand it.
    await deps.saveSecret?.(conn.id, renewed)
    return { token: tokens.accessToken, renewed }
  }

  /** The report window for one month: Amsterdam dates, `until` exclusive and never past tomorrow. */
  function window(run: Run, month: string): { from: string; until: string } {
    const end = `${addMonths(month, 1)}-01`
    const tomorrow = nextDay(run.today)
    return { from: `${month}-01`, until: end < tomorrow ? end : tomorrow }
  }

  async function snapshots(conn: ConnectionRef, run: Run, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (const currency of currencies) {
      for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
        const t = run.totals[currency]?.[month] ?? emptyTotals()
        const end = lastDay(month)
        const externalId = `mollie:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'mollie.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'cash', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  return {
    describe: () => description,

    authorizationUrl(state) {
      return oauth.authorizationUrl({ state })
    },

    async connect(input) {
      const code = str(input.code)
      if (!code) throw new ConnectorError('invalid_input', 'Mollie connects with Mollie sign-in only.', { provider: PROVIDER, forUser: true })
      const tokens = await oauth.exchangeCode(code)
      if (tokens.scope !== undefined && !sameScopes(tokens.scope)) throw new ConnectorError('permanent', MOLLIE_WRONG_SCOPE, { provider: PROVIDER, forUser: true })
      const client = api(tokens.accessToken)
      const balances = await client.balances()
      if (!balances.length) throw new ConnectorError('permanent', MOLLIE_NO_BALANCE, { provider: PROVIDER, forUser: true })
      // One read, so a token that can't see reports fails here rather than on the first sync.
      const today = amsterdamDay(clock.now())
      await client.report(balances[0]!.id, `${today.slice(0, 7)}-01`, nextDay(today))
      return { secret: { tokens: kept(tokens) } satisfies MollieSecret, config: { displayName: 'Mollie' } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { token, renewed } = await tokenFor(conn, true)
      const extra = renewed ? { updatedSecret: renewed } : {}
      const client = api(token)
      const decoded = codec.decode(cursor)
      const reported = decoded?.currencies ?? []

      let run = decoded?.run ?? null
      if (!run) {
        const today = amsterdamDay(clock.now())
        const until = today.slice(0, 7)
        run = { first: addMonths(until, 1 - REPORT_MONTHS), until, today, balances: await client.balances(), step: 0, totals: {} }
        const gone = reported.find((c) => !run!.balances.some((b) => b.currency === c))
        if (gone) throw new ConnectorError('permanent', mollieCurrencyGone(gone), { provider: PROVIDER, forUser: true })
      }

      const steps = run.balances.length * REPORT_MONTHS
      if (run.step < steps) {
        const balance = run.balances[Math.floor(run.step / REPORT_MONTHS)]!
        const month = addMonths(run.first, run.step % REPORT_MONTHS)
        const { from, until } = window(run, month)
        const t = readTotals(await client.report(balance.id, from, until), balance.currency)
        const byMonth = (run.totals[balance.currency] ??= {})
        byMonth[month] = add(byMonth[month] ?? emptyTotals(), t)
        run.step += 1
        if (run.step < steps) return { events: [], cursor: codec.encode({ run, currencies: reported }), hasMore: true, ...extra }
      }

      const currencies = [...new Set([...reported, ...run.balances.map((b) => b.currency)])].sort()
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false, ...extra }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const secret = requireSecret(PROVIDER, conn.secret, isSecret)
        // Never renews here; it renews on the next sync.
        if (secret.tokens.expiresAt !== undefined && secret.tokens.expiresAt <= clock.now() && secret.tokens.refreshToken) return { status: 'ok', message: 'The access token renews on the next sync.' }
        await api(secret.tokens.accessToken).balances()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    /** Ends the grant at Mollie by revoking the refresh token, with the app's own credentials. */
    async disconnect(conn) {
      const { tokens } = requireSecret(PROVIDER, conn.secret, isSecret)
      if (!tokens.refreshToken) return { notRevoked: NOT_REVOKED }
      const basic = 'Basic ' + Buffer.from(`${opts.oauth.clientId}:${opts.oauth.clientSecret}`).toString('base64')
      try {
        const res = await baseFetch(MOLLIE_TOKEN_URL, { method: 'DELETE', headers: { authorization: basic, 'content-type': 'application/json' }, body: JSON.stringify({ token_type_hint: 'refresh_token', token: tokens.refreshToken }) })
        if (!res.ok) return { notRevoked: NOT_REVOKED }
      } catch {
        return { notRevoked: NOT_REVOKED }
      }
      return undefined
    },
  }
}
