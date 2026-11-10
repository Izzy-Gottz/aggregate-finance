// BigCommerce connector (the merchant's own store-level API account, read-only scopes): monthly orders, refunds and their
// net per currency, as report.snapshot. Sales reported by the store, not booked revenue.
//
// Not emitted, on purpose: no transaction.upsert, no invoice.upsert, no account.upsert with money, nothing that posts. The
// money from these orders reaches the bank through the store's payment provider (Stripe, PayPal, BigCommerce Payments...),
// which may be connected already, so posting would double revenue. report.snapshot never reaches the ledger, and core's
// provider_report check skips this connector (checks.ts).
//
// No fees and no payouts: BigCommerce has no payout or fee scope. Order transactions (/v3/orders/{id}/transactions) carry
// amounts and gateways but no fee, so they aren't read either. What a payment provider kept is only in that provider.
//
// Auth, two ways. A pasted store hash and access token from Settings > Store-level API accounts, with Orders and
// Information & Settings read-only: BigCommerce doesn't report a pasted token's scopes, so one that can write can't be
// told apart and refused; the client sends GET only instead (client.ts), and connect says so. Or the single-click app
// (app.ts, BIGCOMMERCE_CLIENT_ID/SECRET): installed from BigCommerce, its token comes with its scopes, which are checked
// read-only before it's kept; the server links it to a workspace after sign-in (apps/server/src/bigcommerce-app.ts).
//
// Months are the store's own (/v2/store timezone). A missing or unknown time zone stops the sync and the connect; it is
// never guessed as UTC. Currencies are never added together: each one an order was paid in gets its own snapshot. A
// currency reported before that the store no longer lists stops the sync rather than zero or move its months.
//
// A run reads every refund created since just before the first reported month, then every order placed since then, then the
// orders behind refunds placed earlier, one page per step with the totals in the cursor, and only then sends the months: a
// half-read month must never show. Stored: monthly totals only. No buyer name, email or address, in events or raw.
//
// Built from BigCommerce's public API reference. It has not been run against a real store, and the fixtures are hand-built.
// See README.md for what's unverified.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, requireSecret, str, systemClock, type ConnectorDeps } from '@agfn/connector-sdk'
import { exchangeInstallCode, verifySignedPayload, type BigCommerceApp, type BigCommerceInstall, type BigCommercePayload } from './app.ts'
import { BigCommerceClient, PER_PAGE, unreadable } from './client.ts'
import { addMonths, amount, dayIn, emptyTotals, exact, isMonthTotals, lastDay, monthIn, monthRows, orderLine, positiveId, stop, when, type MonthTotals, type OrderLine } from './month.ts'

const PROVIDER = 'bigcommerce'
export const REPORT_MONTHS = 12
/** Orders looked up per step for refunds whose order was placed before the run. */
const PARENTS_PER_STEP = 20

export const NOT_REVOKED = 'In BigCommerce, go to Settings → Store-level API accounts → Delete the Aggregate API account.'
export const NOT_REVOKED_APP = 'In BigCommerce, open Apps → My Apps and uninstall Aggregate.'
export const BIGCOMMERCE_SCOPES_UNCHECKED = 'BigCommerce doesn’t tell Aggregate what this token may do. Aggregate only reads, but check the API account’s scopes are all read-only or none.'
export const bigCommerceCurrencyGone = (currency: string) => `BigCommerce no longer lists ${currency} for this store, which Aggregate reported before. Showing those months as zero, or moving them to another currency, would be wrong, so this sync stopped. No totals were changed. To start fresh, disconnect BigCommerce and connect it again.`
export const bigCommerceRefundMismatch = (n: number) => `${plural(n, 'order is', 'orders are')} marked refunded in BigCommerce with no matching refund record; ${n === 1 ? 'its refund isn’t' : 'their refunds aren’t'} taken off.`
export const BIGCOMMERCE_NOT_FOUND = 'Aggregate couldn’t find that BigCommerce store. Check the store hash: it’s the part after /stores/ in the API path.'

export interface BigCommerceSecret {
  storeHash: string
  accessToken: string
}

type Phase = 'refunds' | 'orders' | 'parents'

/** A refund read, waiting on its order for a currency and status. Its amount stays as sent until the currency is known. */
interface Pending {
  order: number
  month: string
  amount: string
}

interface Run {
  first: string
  until: string
  today: string
  /** Lower bound for both lists: two days before the first month, so every time zone's first day is in. */
  since: string
  zone: string
  storeCurrency: string
  /** Every currency the store has set up. */
  listed: string[]
  phase: Phase
  page: number
  /** Highest id counted in this phase: a row shifted onto the next page doesn't count twice. */
  lastId: number
  pending: Pending[]
  /** month → currency → totals. */
  totals: Record<string, Record<string, MonthTotals>>
  unknownStatus: number
  /** Refunded orders whose refunded_amount isn't the sum of their refund records. */
  refundMismatch: number
}

interface BigCommerceCursor {
  /** Between runs, null. */
  run: Run | null
  /** Every currency reported, so one that has left is never silently dropped. */
  currencies: string[]
}

const isPending = (v: unknown): v is Pending => isRecord(v) && typeof v.order === 'number' && typeof v.month === 'string' && typeof v.amount === 'string'
const isRun = (v: unknown): v is Run =>
  isRecord(v) &&
  ['first', 'until', 'today', 'since', 'zone', 'storeCurrency'].every((k) => typeof v[k] === 'string') &&
  Array.isArray(v.listed) &&
  v.listed.every((c) => typeof c === 'string') &&
  (v.phase === 'refunds' || v.phase === 'orders' || v.phase === 'parents') &&
  typeof v.page === 'number' &&
  typeof v.lastId === 'number' &&
  Array.isArray(v.pending) &&
  v.pending.every(isPending) &&
  isRecord(v.totals) &&
  Object.values(v.totals).every((byCurrency) => isRecord(byCurrency) && Object.values(byCurrency).every(isMonthTotals)) &&
  typeof v.unknownStatus === 'number' &&
  typeof v.refundMismatch === 'number'
const isCursor = (v: unknown): v is BigCommerceCursor => isRecord(v) && Array.isArray(v.currencies) && v.currencies.every((c) => typeof c === 'string') && (v.run === null || isRun(v.run))
const isSecret = (v: unknown): v is BigCommerceSecret => isRecord(v) && typeof v.storeHash === 'string' && typeof v.accessToken === 'string'

const HASH_RE = /^[a-z0-9]{4,32}$/i
const TOKEN_RE = /^[A-Za-z0-9]{20,64}$/

/** The store hash, typed alone or as the API path BigCommerce shows (https://api.bigcommerce.com/stores/{hash}/v3/). */
export function parseStoreHash(input: string): string | null {
  const s = input.trim()
  const fromPath = /^https:\/\/api\.bigcommerce\.com\/stores\/([^/?#]+)(\/v[23])?\/?$/i.exec(s)?.[1]
  const hash = fromPath ?? s
  return HASH_RE.test(hash) ? hash.toLowerCase() : null
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export interface BigCommerceConnector extends Connector {
  begin(): Promise<ConnectBegin>
  /** Set when the single-click app is configured: the install and signed-payload checks the server's callbacks use. */
  app?: {
    clientId: string
    exchange(query: Record<string, string | undefined>): Promise<BigCommerceInstall>
    verify(signedPayloadJwt: string): BigCommercePayload
  }
}

export function createBigCommerceConnector(deps: ConnectorDeps, opts: { app?: BigCommerceApp } = {}): BigCommerceConnector {
  const clock = deps.clock ?? systemClock
  const codec = cursorCodec<BigCommerceCursor>(PROVIDER, 1, isCursor)

  const description: ConnectorDescription = {
    key: PROVIDER,
    name: 'BigCommerce',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'api_key',
  }

  const clientFor = (conn: ConnectionRef) => {
    const s = requireSecret(PROVIDER, conn.secret, isSecret)
    return new BigCommerceClient(s.storeHash, s.accessToken, deps)
  }

  const totalsFor = (run: Run, month: string, currency: string): MonthTotals => ((run.totals[month] ??= {})[currency] ??= emptyTotals())
  const inRun = (run: Run, month: string) => month >= run.first && month <= run.until

  /** A refund's order is known: it counts when the order does, in the order's currency, in the refund's own month. */
  function settle(run: Run, p: Pending, order: { counted: boolean; currency: string }): void {
    if (!order.counted) return
    const t = totalsFor(run, p.month, order.currency)
    t.refunds = exact(t.refunds + amount(p.amount, order.currency))
  }

  async function snapshots(conn: ConnectionRef, run: Run, currencies: string[]): Promise<ReportSnapshot[]> {
    const events: ReportSnapshot[] = []
    for (let month = run.first; month <= run.until; month = addMonths(month, 1)) {
      const end = lastDay(month)
      for (const currency of currencies) {
        const t = run.totals[month]?.[currency] ?? emptyTotals()
        const externalId = `bigcommerce:${month}:${currency}`
        const rawRef = await deps.raw.put(conn.id, 'bigcommerce.month', externalId, { month, currency, totals: t })
        events.push({ type: 'report.snapshot', externalId, connectionId: conn.id, rawRef, kind: 'profit_and_loss', from: `${month}-01`, to: end < run.today ? end : run.today, basis: 'accrual', currency, rows: monthRows(t, currency) })
      }
    }
    return events
  }

  /** The next page's rows above lastId. A page that sends only rows already counted would loop, so it stops the sync. */
  function fresh(rows: Array<Record<string, unknown>>, lastId: number, what: string): Array<Record<string, unknown>> {
    const out = rows.filter((r) => positiveId(r.id, what) > lastId)
    if (rows.length && !out.length) throw unreadable('a page it had already sent')
    return out
  }

  /** One read of each thing a sync needs, so a token that can't read them fails at connect, not at the first sync. */
  async function check(client: BigCommerceClient) {
    const store = await client.store().catch((e: unknown) => {
      if (isConnectorError(e) && e.status === 404) throw new ConnectorError('permanent', BIGCOMMERCE_NOT_FOUND, { provider: PROVIDER, status: 404, forUser: true })
      throw e
    })
    await client.currencies()
    await client.v2List('/v2/orders', { limit: 1 })
    await client.v3List('/v3/orders/payment_actions/refunds', { limit: 1 })
    return store
  }

  const app = opts.app
  return {
    describe: () => description,
    ...(app
      ? {
          app: {
            clientId: app.clientId,
            exchange: (q: Record<string, string | undefined>) => exchangeInstallCode(app, q, deps.fetch ?? fetch),
            verify: (jwt: string) => verifySignedPayload(app, jwt, clock.now()),
          },
        }
      : {}),

    async begin() {
      return {
        kind: 'api_key',
        label: 'BigCommerce store-level API account, read-only',
        steps: [
          'In BigCommerce, open Settings → Store-level API accounts and choose Create API account.',
          'Name it “Aggregate”. Set Orders to read-only and Information & Settings to read-only. Leave every other scope at None.',
          'Choose Save, then copy the access token and the API path BigCommerce shows once.',
          'Paste the API path (or just the store hash, the part after /stores/) and the access token here.',
        ],
        permissions: ['Read-only scopes only: Orders and Information & Settings. Aggregate reads order and refund totals and the store’s time zone, with no customer names, emails or addresses, and keeps monthly sales reported by the store, not booked revenue.'],
        helpUrl: 'https://support.bigcommerce.com/s/article/Store-API-Accounts',
        placeholder: '',
        fields: [
          { name: 'storeHash', label: 'API path or store hash', placeholder: 'https://api.bigcommerce.com/stores/abc123/v3/' },
          { name: 'accessToken', label: 'Access token', placeholder: '', secret: true },
        ],
      }
    },

    async connect(input) {
      // From the app install (server-side, scopes already checked read-only): the same checks as a pasted token.
      if (isSecret(input.adopt)) {
        const { storeHash, accessToken } = input.adopt
        const store = await check(new BigCommerceClient(storeHash, accessToken, deps))
        const secret: BigCommerceSecret = { storeHash, accessToken }
        return { secret, config: { storeHash, currency: store.currency, via: 'app' } }
      }
      const storeHash = parseStoreHash(str(input.storeHash) ?? '')
      const accessToken = str(input.accessToken)?.trim() ?? ''
      if (!storeHash) throw new ConnectorError('invalid_input', 'Paste the API path from BigCommerce, or the store hash: the part after /stores/.', { provider: PROVIDER })
      if (!TOKEN_RE.test(accessToken)) throw new ConnectorError('invalid_input', 'Paste the access token from the BigCommerce API account.', { provider: PROVIDER })
      const store = await check(new BigCommerceClient(storeHash, accessToken, deps))
      const secret: BigCommerceSecret = { storeHash, accessToken }
      // BigCommerce can't say whether the token can write (see the note at the top), so the person is told instead.
      return { secret, config: { storeHash, currency: store.currency, warnings: [BIGCOMMERCE_SCOPES_UNCHECKED] } }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const client = clientFor(conn)
      const decoded = codec.decode(cursor)
      const reported = decoded?.currencies ?? []

      let run = decoded?.run ?? null
      if (!run) {
        const now = clock.now()
        const store = await client.store()
        const listed = [...new Set([store.currency, ...(await client.currencies())])].sort()
        const gone = reported.find((c) => !listed.includes(c))
        if (gone) throw new ConnectorError('permanent', bigCommerceCurrencyGone(gone), { provider: PROVIDER, forUser: true })
        const until = monthIn(store.zone, now)
        const first = addMonths(until, 1 - REPORT_MONTHS)
        const since = new Date(Date.parse(`${first}-01T00:00:00Z`) - 2 * 86_400_000).toISOString()
        // On the store's clock too, or a month that has begun there but not in UTC would end before it starts.
        run = { first, until, today: dayIn(store.zone, now), since, zone: store.zone, storeCurrency: store.currency, listed, phase: 'refunds', page: 1, lastId: 0, pending: [], totals: {}, unknownStatus: 0, refundMismatch: 0 }
      }
      const listed = new Set(run.listed)
      const step = (next: Run): SyncResult => ({ events: [], cursor: codec.encode({ run: next, currencies: reported }), hasMore: true })

      if (run.phase === 'refunds') {
        const rows = fresh(await client.v3List('/v3/orders/payment_actions/refunds', { 'created:min': run.since, page: run.page, limit: PER_PAGE }), run.lastId, 'a refund')
        if (!rows.length) return step({ ...run, phase: 'orders', page: 1, lastId: 0 })
        let lastId = run.lastId
        const pending = [...run.pending]
        for (const r of rows) {
          const id = positiveId(r.id, 'a refund')
          lastId = Math.max(lastId, id)
          const order = positiveId(r.order_id, 'a refund')
          const month = monthIn(run.zone, when(r.created))
          const value = typeof r.total_amount === 'number' ? String(r.total_amount) : r.total_amount
          if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) throw stop('a refund amount')
          if (inRun(run, month)) pending.push({ order, month, amount: value })
        }
        return step({ ...run, page: run.page + 1, lastId, pending })
      }

      if (run.phase === 'orders') {
        const rows = fresh(await client.v2List('/v2/orders', { min_date_created: run.since, sort: 'id:asc', page: run.page, limit: PER_PAGE }), run.lastId, 'an order')
        if (!rows.length) return step({ ...run, phase: 'parents', page: 1, lastId: 0 })
        let lastId = run.lastId
        let unknownStatus = run.unknownStatus
        let refundMismatch = run.refundMismatch
        const next: Run = { ...run, totals: structuredClone(run.totals) }
        const byOrder = new Map<number, OrderLine>()
        for (const o of rows) {
          const line = orderLine(o, run.zone, listed)
          lastId = Math.max(lastId, line.id)
          byOrder.set(line.id, line)
          if (line.unknownStatus) unknownStatus++
          if (!line.counted || !inRun(run, line.month)) continue
          const t = totalsFor(next, line.month, line.currency)
          t.sales = exact(t.sales + line.sales)
          // Placed in the run, so every refund on it was read in the refunds phase and waits in pending.
          if (line.refunded !== undefined) {
            const recorded = run.pending.filter((p) => p.order === line.id).reduce((sum, p) => exact(sum + amount(p.amount, line.currency)), 0)
            if (recorded !== line.refunded) refundMismatch++
          }
        }
        const pending: Pending[] = []
        for (const p of run.pending) {
          const line = byOrder.get(p.order)
          if (line) settle(next, p, line)
          else pending.push(p)
        }
        return step({ ...next, page: run.page + 1, lastId, pending, unknownStatus, refundMismatch })
      }

      // Refunds whose order was placed before the run: one call per order, a few per step.
      if (run.pending.length) {
        const ids = [...new Set(run.pending.map((p) => p.order))].slice(0, PARENTS_PER_STEP)
        const next: Run = { ...run, totals: structuredClone(run.totals) }
        for (const id of ids) {
          const o = await client.order(id)
          // An order BigCommerce no longer has: its sale isn't counted anywhere, so neither are its refunds.
          const line = o ? orderLine(o, run.zone, listed) : null
          for (const p of run.pending) if (p.order === id && line) settle(next, p, line)
        }
        return step({ ...next, pending: run.pending.filter((p) => !ids.includes(p.order)) })
      }

      const currencies = [...new Set([...reported, run.storeCurrency, ...Object.values(run.totals).flatMap((byCurrency) => Object.keys(byCurrency))])].sort()
      const warnings = [
        ...(run.unknownStatus ? [`${plural(run.unknownStatus, 'order has a status', 'orders have a status')} BigCommerce’s docs don’t list. These aren’t counted in sales reported by the store.`] : []),
        ...(run.refundMismatch ? [bigCommerceRefundMismatch(run.refundMismatch)] : []),
      ]
      return { events: await snapshots(conn, run, currencies), cursor: codec.encode({ run: null, currencies }), hasMore: false, ...(warnings.length ? { warnings } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).store()
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // Neither a pasted token nor an app install can be ended from here: BigCommerce has no call for it.
    async disconnect(conn) {
      return { notRevoked: conn.config.via === 'app' ? NOT_REVOKED_APP : NOT_REVOKED }
    },
  }
}
