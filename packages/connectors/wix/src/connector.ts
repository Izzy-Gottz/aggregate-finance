// Wix connector: monthly store sales per currency, as report.snapshot. What the store reports, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no account.upsert with money, nothing that posts. A Wix store's money arrives
// through Wix Payments, Stripe, PayPal or Square, so posting these would double revenue. report.snapshot never reaches the
// ledger, and core's provider_report check skips this connector (checks.ts).
//
// Auth: the site owner installs Aggregate's Wix app, the only way here. Custom auth is deprecated for new apps, and API keys
// aren't open to third-party apps. The install redirect brings instanceId and signedInstance back; the signature is checked
// before instanceId is believed (instance.ts). Wix treats instanceId as a permanent credential, so it's the secret stored. Tokens
// last four hours with no refresh token, and are minted again from instanceId and the app's secret.
//
// Stored: monthly totals only. buyerInfo is on every order and is never read (client.ts drops it from the page).
//
// A run reads every order created in the 12 months, one page per step, with the totals in the cursor, and only then sends the
// months: a refund can change any of them, and a half-read month must never show. A Wix cursor that's gone stale starts the run
// again.
//
// Built from Wix's API reference. It has not been run against a real site, and the fixtures are hand-built. See README.md for
// what's unverified.

import type { ConnectBegin, ConnectBeginContext, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isRecord, requireSecret, str, systemClock, type ConnectorDeps, type FetchLike } from '@agfn/connector-sdk'
import { mintToken, WIX_INSTALL_URL, WixClient } from './client.ts'
import { verifySignedInstance } from './instance.ts'
import { addMonths, emptyTotals, exact, isMonthTotals, lastDay, monthRows, orderLine, type MonthTotals } from './month.ts'

const PROVIDER = 'wix'
export const LOOKBACK_MONTHS = 12
const TOKEN_MS = 4 * 3_600_000
const RENEW_EARLY_MS = 300_000

export type WixSecret = { instanceId: string }

export interface WixConnectorOptions {
  /** Aggregate's Wix app. Required: there's no other way in. */
  app: {
    clientId: string
    clientSecret: string
    redirectUri: string
    /** For an unlisted app: Wix's Share URL id. Testing only, 80 installs at most. */
    shareUrlId?: string
  }
}

export const NOT_REVOKED = 'Wix has no way for Aggregate to end this access. In your site’s dashboard, open Apps and remove Aggregate.'
export const WIX_NOT_INSTALLED = 'The Wix install didn’t finish. Connect Wix again.'

interface WixCursor {
  /** Between runs, null. */
  run: { first: string; until: string; today: string; after: string; before: string; page: string | null; prev: string[]; totals: Record<string, MonthTotals> } | null
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
}

const isCursor = (v: unknown): v is WixCursor =>
  isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || (isRecord(v.run) && isRecord(v.run.totals) && Object.values(v.run.totals).every(isMonthTotals)))
const isSecret = (v: unknown): v is WixSecret => isRecord(v) && typeof v.instanceId === 'string' && v.instanceId !== ''

export interface WixConnector extends Connector {
  begin(ctx: Pick<ConnectBeginContext, 'state'>): Promise<ConnectBegin>
}

export function createWixConnector(opts: WixConnectorOptions, deps: ConnectorDeps): WixConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<WixCursor>(PROVIDER, 1, isCursor)
  const baseFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init))
  const http = { ...deps, fetch: baseFetch }
  const tokens = new Map<string, { token: string; until: number }>()

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'Wix',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'oauth',
  }

  async function clientFor(instanceId: string): Promise<WixClient> {
    const now = clock.now()
    let held = tokens.get(instanceId)
    if (!held || held.until <= now) {
      held = { token: await mintToken(opts.app, instanceId, http), until: now + TOKEN_MS - RENEW_EARLY_MS }
      tokens.set(instanceId, held)
    }
    return new WixClient(held.token, http)
  }

  async function snapshots(conn: ConnectionRef, run: NonNullable<WixCursor['run']>, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const t = run.totals[`${month}:${currency}`] ?? emptyTotals()
        const externalId = `wix:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'wix.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'accrual', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  return {
    describe: () => description,

    async begin(ctx) {
      // Wix adds appId, instanceId and signedInstance to this URL and keeps what's already on it, so `state` comes back.
      const back = new URL(opts.app.redirectUri)
      back.searchParams.set('state', ctx.state)
      const url = new URL(WIX_INSTALL_URL)
      url.searchParams.set('appId', opts.app.clientId)
      url.searchParams.set('postInstallationUrl', back.href)
      if (opts.app.shareUrlId) url.searchParams.set('shareUrlId', opts.app.shareUrlId)
      return { kind: 'oauth', url: url.href }
    },

    async connect(input) {
      const instanceId = str(input.instanceId)
      const signed = str(input.signedInstance)
      if (!instanceId || !signed) throw new ConnectorError('invalid_input', WIX_NOT_INSTALLED, { provider: PROVIDER, forUser: true })
      const appId = str(input.appId)
      if (appId && appId !== opts.app.clientId) throw new ConnectorError('auth', 'Wix install is for another app', { provider: PROVIDER })
      const site = verifySignedInstance(signed, instanceId, opts.app.clientSecret, clock.now())
      const client = await clientFor(site)
      await client.orders(null, null, 1)
      const secret: WixSecret = { instanceId: site }
      return { secret, config: { displayName: 'Wix store' } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const { instanceId } = requireSecret(PROVIDER, conn.secret, isSecret)
      const client = await clientFor(instanceId)
      const decoded = codec.decode(cursor)
      const seen = new Set(decoded?.currencies ?? [])

      let run = decoded?.run ?? null
      if (!run) {
        const now = clock.now()
        const until = new Date(now).toISOString().slice(0, 7)
        const first = addMonths(until, 1 - LOOKBACK_MONTHS)
        // Two days early, as a margin: nothing relies on an order just before the first month.
        const after = new Date(Date.parse(`${first}-01T00:00:00Z`) - 86_400_000 * 2).toISOString()
        run = { first, until, today: new Date(now).toISOString().slice(0, 10), after, before: new Date(now).toISOString(), page: null, prev: [], totals: {} }
      }

      let page
      try {
        page = await client.orders(run.page ? null : { after: run.after, before: run.before }, run.page)
      } catch (e) {
        // A cursor Wix no longer knows: the run starts over, nothing has been sent from it.
        if (run.page && e instanceof ConnectorError && e.status === 400) return { events: [], cursor: codec.encode({ run: null, currencies: [...seen].sort() }), hasMore: true }
        // The token this process held may be from before a reinstall: the next try mints one.
        if (e instanceof ConnectorError && e.kind === 'auth') tokens.delete(instanceId)
        throw e
      }

      const repeated = new Set(run.prev)
      const ids: string[] = []
      for (const order of page.orders) {
        const l = orderLine(order)
        ids.push(order.id as string)
        if (repeated.has(order.id as string)) continue
        if (l.month < run.first || l.month > run.until) continue
        const key = `${l.month}:${l.currency}`
        const t = run.totals[key] ?? emptyTotals()
        run.totals[key] = { sales: exact(t.sales + l.sales), refunds: exact(t.refunds + l.refunds) }
      }
      const next = { ...run, page: page.nextCursor, prev: ids }
      if (page.nextCursor) return { events: [], cursor: codec.encode({ run: next, currencies: [...seen].sort() }), hasMore: true }

      for (const key of Object.keys(run.totals)) seen.add(key.slice(8))
      const currencies = [...seen].sort()
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        const { instanceId } = requireSecret(PROVIDER, conn.secret, isSecret)
        await (await clientFor(instanceId)).orders(null, null, 1)
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Wix documents no revoke call. The saved instance is deleted here; the owner removes the app at Wix.
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
