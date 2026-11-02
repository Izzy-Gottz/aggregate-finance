// WooCommerce connector (read-only key): monthly sales reported by the store, as report.snapshot. Sales reported by the
// store, not booked revenue.
//
// Not emitted, on purpose: no invoice.upsert, no processor.balance_txn, no account.upsert with money, nothing that posts.
// Most Woo orders are paid through Stripe or PayPal, which Aggregate already books, and invoices aren't linked across
// connections, so posting these would double revenue. Decided by the ledger owner; see docs/partners/connector-factory.md.
// report.snapshot never reaches the ledger, and core's provider_report check skips this connector (checks.ts), because
// this is a sales report and not a company's books.
//
// Built from the WooCommerce REST API docs and plugin source. It has not been run against a real store, and the fixtures
// are hand-built, not recorded.
//
// A sync walks months oldest first: every page of orders, then every page of refunds, then that month's snapshots. The
// cursor holds the month, the phase, the page and the running totals, so a stop anywhere resumes on the next page. The
// first sync reads 24 months. Later ones recompute the last RECOMPUTE_MONTHS, because an order cancelled now changes the
// month it was placed in. Why orders and not reports/sales or wc-analytics: the first has no refund or tax split by
// currency, the second is a lookup table filled by a background job and can lag. See month.ts for what counts.

import type { ConnectBegin, Connector, ConnectionRef, ConnectorDescription, ConnectorHealth, NormalizedEvent, ReportSnapshot, SyncResult } from '@agfn/contracts'
import { ConnectorError, cursorCodec, healthFromError, isConnectorError, isRecord, normalizeCurrency, requireSecret, str, systemClock, type ConnectorDeps } from '@agfn/connector-sdk'
import { PER_PAGE_MAX, WooClient, type WooPage } from './client.ts'
import { addMonths, addOrder, addRefund, COUNTED_STATUSES, emptyTotals, isMonthTotals, KNOWN_STATUSES, lastDay, monthRows, type MonthTotals } from './month.ts'
import { parseStoreUrl, systemResolver, type Resolver } from './safe-url.ts'
import type { WooOrder, WooOrderRef, WooRefund } from './types.ts'

export const BACKFILL_MONTHS = 24
export const RECOMPUTE_MONTHS = 6
/** Enough places for any currency; amounts round once, to the currency's own minor unit. */
const DP = 4

const ORDER_FIELDS = 'id,status,currency,date_created,total,total_tax,shipping_total'
const REFUND_FIELDS = 'id,parent_id,date_created,amount,line_items.total,line_items.total_tax,shipping_lines.total,shipping_lines.total_tax,fee_lines.total,fee_lines.total_tax'

export const NOT_REVOKED = 'In WooCommerce, go to Settings → Advanced → REST API → Revoke the key.'

export interface WooSecret {
  storeUrl: string
  consumerKey: string
  consumerSecret: string
}

export interface WooConnectorOptions {
  /** Hosted: a key that can't be shown to be Read-only is refused. */
  hosted?: boolean
  perPage?: number
  /** Injectable DNS, for tests. */
  resolve?: Resolver
}

interface WooCursor {
  /** Month being read; null between syncs. */
  month: string | null
  /** Last month of this run. */
  until: string | null
  phase: 'orders' | 'refunds'
  page: number
  /** Highest id counted in this phase: a row shifted onto the next page doesn't count twice. */
  lastId: number
  /** Running totals for `month`, by currency. */
  totals: Record<string, MonthTotals>
  storeCurrency: string | null
  /** Every currency seen, so a recompute can zero one that has left a month. */
  currencies: string[]
  /** Refunds this run that had only an amount. */
  amountOnly: number
  backfilled: boolean
}

const isCursor = (v: unknown): v is WooCursor =>
  isRecord(v) &&
  (v.month === null || typeof v.month === 'string') &&
  (v.until === null || typeof v.until === 'string') &&
  (v.phase === 'orders' || v.phase === 'refunds') &&
  typeof v.page === 'number' &&
  typeof v.lastId === 'number' &&
  isRecord(v.totals) &&
  Object.values(v.totals).every(isMonthTotals) &&
  (v.storeCurrency === null || typeof v.storeCurrency === 'string') &&
  Array.isArray(v.currencies) &&
  typeof v.amountOnly === 'number' &&
  typeof v.backfilled === 'boolean'

const isSecret = (v: unknown): v is WooSecret => isRecord(v) && typeof v.storeUrl === 'string' && typeof v.consumerKey === 'string' && typeof v.consumerSecret === 'string'

const KEY_RE = /^ck_[A-Za-z0-9]{20,}$/
const SECRET_RE = /^cs_[A-Za-z0-9]{20,}$/

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function pageIsLast(p: WooPage<unknown>, page: number, size: number): boolean {
  return p.totalPages !== null ? page >= p.totalPages : p.rows.length < size
}

/** Date window for a month, by the store's clock. WordPress's after and before are both exclusive. */
function monthWindow(month: string) {
  return { after: `${addMonths(month, -1)}-${lastDay(addMonths(month, -1)).slice(8)}T23:59:59`, before: `${addMonths(month, 1)}-01T00:00:00` }
}

export function createWooCommerceConnector(opts: WooConnectorOptions, deps: ConnectorDeps): Connector & { begin(): Promise<ConnectBegin> } {
  const codec = cursorCodec<WooCursor>('woocommerce', 1, isCursor)
  const perPage = Math.min(PER_PAGE_MAX, Math.max(1, opts.perPage ?? PER_PAGE_MAX))
  const clock = deps.clock ?? systemClock
  const resolve = opts.resolve ?? systemResolver

  const description: ConnectorDescription = {
    key: 'woocommerce',
    name: 'WooCommerce',
    group: 'payments',
    provides: ['reports'],
    freshness: 'updates every few hours',
    auth: 'api_key',
  }

  const clientFor = (conn: ConnectionRef) => {
    const s = requireSecret('woocommerce', conn.secret, isSecret)
    return new WooClient(s.storeUrl, s.consumerKey, s.consumerSecret, deps, resolve)
  }

  /** Snapshots for a finished month: every currency seen, the store's own always, so a recompute can zero what left. */
  async function monthSnapshots(conn: ConnectionRef, s: WooCursor, month: string): Promise<ReportSnapshot[]> {
    const today = new Date(clock.now()).toISOString().slice(0, 10)
    const end = lastDay(month)
    const out: ReportSnapshot[] = []
    for (const currency of [...new Set([s.storeCurrency as string, ...s.currencies, ...Object.keys(s.totals)])].sort()) {
      const totals = s.totals[currency] ?? emptyTotals()
      const externalId = `woocommerce:${month}:${currency}`
      const rawRef = await deps.raw.put(conn.id, 'woocommerce.month', externalId, { month, currency, totals })
      out.push({
        type: 'report.snapshot',
        externalId,
        connectionId: conn.id,
        rawRef,
        kind: 'profit_and_loss',
        from: `${month}-01`,
        to: end < today ? end : today,
        basis: 'accrual',
        currency,
        rows: monthRows(totals, currency),
      })
    }
    return out
  }

  async function runWarnings(client: WooClient, s: WooCursor): Promise<string[]> {
    const out: string[] = []
    if (s.amountOnly > 0) out.push(`${plural(s.amountOnly, 'refund', 'refunds')} had only an amount, with no lines, so all of it shows as a refund of sales. Its tax and shipping share isn’t known.`)
    // A courtesy: a store that won't say keeps its numbers.
    const statuses = await client.orderTotals().catch(() => [])
    const other = statuses.filter((x) => !KNOWN_STATUSES.has(x.slug)).reduce((a, x) => a + x.total, 0)
    if (other > 0) out.push(`${plural(other, 'order has a status', 'orders have a status')} added by a plugin. These aren’t counted in sales reported by the store.`)
    return out
  }

  const totalsFor = (s: WooCursor, currency: string): MonthTotals => (s.totals[currency] ??= emptyTotals())

  return {
    describe: () => description,

    async begin() {
      return {
        kind: 'api_key',
        label: 'WooCommerce read-only REST API key',
        steps: [
          'In WordPress, open WooCommerce → Settings → Advanced → REST API.',
          'Choose Add key, name it “Aggregate”, and set Permissions to Read.',
          'Choose Generate API key, then copy the consumer key and consumer secret.',
          'Type your store’s address, the one customers see, starting with https://.',
        ],
        permissions: ['Read permission only. Aggregate reads order and refund totals, with no customer names, emails or addresses, and keeps monthly sales reported by the store, not booked revenue.'],
        helpUrl: 'https://woocommerce.com/document/woocommerce-rest-api/',
        placeholder: '',
        fields: [
          { name: 'storeUrl', label: 'Store address', placeholder: 'https://shop.example.com' },
          { name: 'consumerKey', label: 'Consumer key', placeholder: 'ck_…', secret: true },
          { name: 'consumerSecret', label: 'Consumer secret', placeholder: 'cs_…', secret: true },
        ],
      }
    },

    async connect(input) {
      const storeUrl = parseStoreUrl(str(input.storeUrl) ?? '')
      const consumerKey = str(input.consumerKey)?.trim() ?? ''
      const consumerSecret = str(input.consumerSecret)?.trim() ?? ''
      if (!KEY_RE.test(consumerKey)) throw new ConnectorError('invalid_input', 'Paste the consumer key from WooCommerce. It starts with ck_.', { provider: 'woocommerce' })
      if (!SECRET_RE.test(consumerSecret)) throw new ConnectorError('invalid_input', 'Paste the consumer secret from WooCommerce. It starts with cs_.', { provider: 'woocommerce' })
      const client = new WooClient(storeUrl, consumerKey, consumerSecret, deps, resolve)
      const notFound = (message: string) => (e: unknown) => {
        if (isConnectorError(e) && e.status === 404) throw new ConnectorError('permanent', message, { provider: 'woocommerce', status: 404, forUser: true })
        throw e
      }
      await client.list('/orders', { per_page: 1, _fields: 'id' }).catch(notFound('Aggregate couldn’t find WooCommerce at that address. Check the address, and that WordPress permalinks aren’t set to Plain.'))
      await client.list('/refunds', { per_page: 1, _fields: 'id' }).catch(notFound('This store needs WooCommerce 9.0 or later, which is when the refunds list was added.'))
      const currency = normalizeCurrency(await client.storeCurrency())
      const access = await client.keyAccess()
      if (opts.hosted && access !== 'read') {
        throw new ConnectorError(
          'permanent',
          access === 'write'
            ? 'That key can change your store. Make a new key with Permissions set to Read.'
            : 'Aggregate couldn’t confirm that key is Read only, so it won’t connect it. Check the key’s Permissions are Read, and that a firewall isn’t blocking Aggregate.',
          { provider: 'woocommerce', forUser: true },
        )
      }
      const secret: WooSecret = { storeUrl, consumerKey, consumerSecret }
      return {
        secret,
        config: {
          host: new URL(storeUrl).hostname,
          currency,
          ...(access !== 'read' ? { warnings: ['This key may be able to change your store. Aggregate only reads, but a key with Permissions set to Read is safer.'] } : {}),
        },
      }
    },

    async sync(conn, cursor): Promise<SyncResult> {
      const client = clientFor(conn)
      const decoded = codec.decode(cursor)
      const thisMonth = new Date(clock.now()).toISOString().slice(0, 7)
      let s: WooCursor
      if (decoded?.month) s = decoded
      else {
        s = {
          month: addMonths(thisMonth, 1 - (decoded?.backfilled ? RECOMPUTE_MONTHS : BACKFILL_MONTHS)),
          until: thisMonth,
          phase: 'orders',
          page: 1,
          lastId: 0,
          totals: {},
          storeCurrency: normalizeCurrency(await client.storeCurrency()),
          currencies: decoded?.currencies ?? [],
          amountOnly: 0,
          backfilled: decoded?.backfilled ?? false,
        }
      }
      const month = s.month as string
      const store = s.storeCurrency as string
      const window = monthWindow(month)
      const paging = { ...window, orderby: 'id', order: 'asc', per_page: perPage, page: s.page, dp: DP }

      if (s.phase === 'orders') {
        const res = await client.list<WooOrder>('/orders', { ...paging, status: COUNTED_STATUSES.join(','), _fields: ORDER_FIELDS })
        let lastId = s.lastId
        for (const o of res.rows) {
          if (o.id <= lastId || !COUNTED_STATUSES.includes(o.status) || !o.date_created?.startsWith(month)) continue
          lastId = o.id
          addOrder(totalsFor(s, normalizeCurrency(o.currency, store)), o, normalizeCurrency(o.currency, store))
        }
        const next: WooCursor = pageIsLast(res, s.page, perPage) ? { ...s, phase: 'refunds', page: 1, lastId: 0 } : { ...s, page: s.page + 1, lastId }
        return { events: [], cursor: codec.encode(next), hasMore: true }
      }

      const res = await client.list<WooRefund>('/refunds', { ...paging, _fields: REFUND_FIELDS })
      const rows = res.rows.filter((r) => r.id > s.lastId && r.date_created?.startsWith(month))
      // A refund has no currency or status of its own: both come from its order, which may be from any earlier month.
      const parents = new Map<number, WooOrderRef>()
      const ids = [...new Set(rows.map((r) => r.parent_id))]
      for (let i = 0; i < ids.length; i += PER_PAGE_MAX) {
        const batch = ids.slice(i, i + PER_PAGE_MAX)
        const found = await client.list<WooOrderRef>('/orders', { include: batch.join(','), status: 'any', per_page: PER_PAGE_MAX, _fields: 'id,status,currency' })
        for (const p of found.rows) parents.set(p.id, p)
      }
      let lastId = s.lastId
      let amountOnly = s.amountOnly
      for (const r of rows) {
        lastId = Math.max(lastId, r.id)
        const parent = parents.get(r.parent_id)
        if (!parent || !COUNTED_STATUSES.includes(parent.status)) continue
        const currency = normalizeCurrency(parent.currency, store)
        if (addRefund(totalsFor(s, currency), r, currency)) amountOnly++
      }
      if (!pageIsLast(res, s.page, perPage)) return { events: [], cursor: codec.encode({ ...s, page: s.page + 1, lastId, amountOnly }), hasMore: true }

      const done = { ...s, amountOnly }
      const events: NormalizedEvent[] = await monthSnapshots(conn, done, month)
      const currencies = [...new Set([...s.currencies, ...Object.keys(s.totals)])].sort()
      if (month !== s.until) {
        const next: WooCursor = { ...done, month: addMonths(month, 1), phase: 'orders', page: 1, lastId: 0, totals: {}, currencies }
        return { events, cursor: codec.encode(next), hasMore: true }
      }
      const warnings = await runWarnings(client, done)
      const idle: WooCursor = { month: null, until: null, phase: 'orders', page: 1, lastId: 0, totals: {}, storeCurrency: null, currencies, amountOnly: 0, backfilled: true }
      return { events, cursor: codec.encode(idle), hasMore: false, ...(warnings.length ? { warnings } : {}) }
    },

    async health(conn): Promise<ConnectorHealth> {
      try {
        await clientFor(conn).list('/orders', { per_page: 1, _fields: 'id' })
        return { status: 'ok' }
      } catch (e) {
        return healthFromError(e)
      }
    },

    // A pasted key can't be revoked from here.
    async disconnect() {
      return { notRevoked: NOT_REVOKED }
    },
  }
}
