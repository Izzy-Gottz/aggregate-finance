import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createWooCommerceConnector, NOT_REVOKED, type WooConnectorOptions } from './index.ts'

interface Order { id: number; status: string; currency: string; date_created: string; total: string; total_tax: string; shipping_total: string }
interface Refund { id: number; parent_id: number; date_created: string; amount: string; line_items: Array<{ total: string; total_tax: string }>; shipping_lines: Array<{ total: string; total_tax: string }>; fee_lines: Array<{ total: string; total_tax: string }> }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/woocommerce.json', import.meta.url), 'utf8')) as {
  orders: Order[]
  refunds: Refund[]
  orderTotals: unknown[]
  unauthorized: unknown
}

const KEY = 'ck_' + 'a'.repeat(40)
const SECRET = 'cs_' + 'b'.repeat(40)
const BASE = 'https://shop.example.com'
const conn: ConnectionRef = { id: 'conn_woo', workspaceId: 'ws1', connectorKey: 'woocommerce', secret: { storeUrl: BASE, consumerKey: KEY, consumerSecret: SECRET }, config: {} }

/** A small WooCommerce: filters by date (exclusive at both ends, like WP's date_query), status and id, and pages. */
function store(data: { orders?: Order[]; refunds?: Refund[]; currency?: string; pageHook?: (path: string, page: number) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const orders = data.orders ?? fx.orders
  const refunds = data.refunds ?? fx.refunds
  const page = <T>(rows: T[], u: URL): FixtureResponse => {
    const size = Number(u.searchParams.get('per_page') ?? 10)
    const n = Number(u.searchParams.get('page') ?? 1)
    return { json: rows.slice((n - 1) * size, n * size), headers: { 'x-wp-total': String(rows.length), 'x-wp-totalpages': String(Math.max(1, Math.ceil(rows.length / size))) } }
  }
  const dated = <T extends { date_created: string }>(rows: T[], u: URL) => {
    const after = u.searchParams.get('after')
    const before = u.searchParams.get('before')
    return rows.filter((r) => (!after || r.date_created > after) && (!before || r.date_created < before))
  }
  return [
    { method: 'GET', match: (u) => u.pathname === '/wp-json/wc/v3/settings/general/woocommerce_currency', respond: { json: { id: 'woocommerce_currency', value: data.currency ?? 'USD' } } },
    { method: 'GET', match: (u) => u.pathname === '/wp-json/wc/v3/reports/orders/totals', respond: { json: fx.orderTotals } },
    { method: 'POST', match: (u) => u.pathname === '/wp-json/wc/v3/aggregate-read-only-check', respond: { status: 401, json: { code: 'woocommerce_rest_authentication_error', message: 'The API key provided does not have write permissions.' } } },
    {
      method: 'GET',
      match: (u) => u.pathname === '/wp-json/wc/v3/orders',
      respond: (u) => {
        const hook = data.pageHook?.('orders', Number(u.searchParams.get('page') ?? 1))
        if (hook) return hook
        const include = u.searchParams.get('include')?.split(',').map(Number)
        if (include) return page(orders.filter((o) => include.includes(o.id)), u)
        const statuses = u.searchParams.get('status')?.split(',') ?? []
        return page(dated(orders, u).filter((o) => !statuses.length || statuses.includes('any') || statuses.includes(o.status)), u)
      },
    },
    {
      method: 'GET',
      match: (u) => u.pathname === '/wp-json/wc/v3/refunds',
      respond: (u) => data.pageHook?.('refunds', Number(u.searchParams.get('page') ?? 1)) ?? page(dated(refunds, u), u),
    },
  ]
}

function make(routes: FixtureRoute[] = store(), opts: Partial<WooConnectorOptions> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const connector = createWooCommerceConnector({ resolve: async () => [{ address: '93.184.216.34', family: 4 }], ...opts }, { raw, fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock, raw }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const order = (o: Partial<Order> & { id: number }): Order => ({ status: 'completed', currency: 'USD', date_created: '2026-10-02T10:00:00', total: '0', total_tax: '0', shipping_total: '0', ...o })

describe('woocommerce contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThan(24)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('only ever a report snapshot', () => {
  it('emits report.snapshot and nothing that could post', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('carries no net income a check could read as books', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    for (const s of snaps(events).values()) {
      expect(s.totals).toBeUndefined()
      expect(s.rows.some((r) => /^net (income|profit|earnings)$/i.test(r.account.trim()))).toBe(false)
    }
  })
})

describe('month totals, worked by hand to the cent', () => {
  // September 2026, USD. Counted orders (total = sales + shipping + tax):
  //   1001 completed   108.25 = 90.00 + 10.00 + 8.25
  //   1002 processing   54.12 = 50.00 +  0.00 + 4.12
  //   1003 refunded     21.65 = 15.00 +  5.00 + 1.65   counted: it was sold; its refund is a separate row
  //   1008 completed    32.48 = 30.00 +  0.00 + 2.48   on the month's last second
  //   sum              216.50 = 185.00 + 15.00 + 16.50
  // Left out: 1004 cancelled, 1005 pending, 1006 failed, 1007 on-hold.
  // Refunds dated in September:
  //   2001 of 1003 (full)  21.65 = 15.00 + 5.00 + (1.24 + 0.41)
  //   2002 of 1001 (part)  32.48 = 30.00 + 0.00 + 2.48
  //   2003 of 1002 (amount only, no lines)  5.00 = 5.00 of sales
  //   2004 of 1004 left out: the order was cancelled, so it isn't in sales either
  //   sum                  59.13 = 50.00 + 5.00 + 4.13
  it('September: sales, shipping and tax apart, with refunds apart again', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const s = snaps(events).get('woocommerce:2026-09:USD')
    expect(rows(s)).toEqual({
      'Sales reported by the store': 185_00,
      'Refunds of sales': -50_00,
      'Net sales reported by the store': 135_00,
      'Shipping charged': 15_00,
      'Shipping refunded': -5_00,
      'Sales tax collected': 16_50,
      'Sales tax refunded': -4_13,
    })
    expect(s).toMatchObject({ kind: 'profit_and_loss', basis: 'accrual', currency: 'USD', from: '2026-09-01', to: '2026-09-30' })
    // What the rows add up to is what the store took and gave back: 216.50 − 59.13.
    expect(s!.rows.filter((r) => !r.account.startsWith('Net')).reduce((a, r) => a + r.amount.minor, 0)).toBe(157_37)
  })

  // October so far: order 1010, 64.95 = 60.00 + 4.95. Refunds dated in October, of orders from earlier months:
  //   2005 of 1001 (Sep) shipping only   10.00
  //   2006 of  900 (Aug) full            43.30 = 40.00 + 3.30
  //   2007 of  500 (2023, before the backfill) 12.00
  it('a refund lands in the month it was made, whichever month the sale was', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))).toEqual({
      'Sales reported by the store': 60_00,
      'Refunds of sales': -52_00,
      'Net sales reported by the store': 8_00,
      'Shipping charged': 0,
      'Shipping refunded': -10_00,
      'Sales tax collected': 4_95,
      'Sales tax refunded': -3_30,
    })
  })

  it("a fully refunded order keeps its sale in the month it was made (status 'refunded' still counts)", async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-08:USD'))).toMatchObject({ 'Sales reported by the store': 40_00, 'Refunds of sales': 0, 'Sales tax collected': 3_30 })
  })

  it('the month still running ends today', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(snaps(events).get('woocommerce:2026-10:USD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09' })
  })

  it('a quiet month is a snapshot of zeros, so a month that went quiet is corrected', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-03:USD'))['Sales reported by the store']).toBe(0)
  })

  it('backfills 24 months at most, and no further', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    expect([...snaps(events).keys()].filter((k) => k.endsWith('USD')).sort()[0]).toBe('woocommerce:2024-11:USD')
    expect(snaps(events).size).toBe(25) // 24 USD months + the one EUR month
    const afters = calls.filter((c) => c.url.includes('/orders?') && c.url.includes('after=')).map((c) => new URL(c.url).searchParams.get('after')!)
    expect(afters.sort()[0]).toBe('2024-10-31T23:59:59')
  })

  it('says when a refund has no lines, and when plugin statuses aren’t counted', async () => {
    const { connector } = make()
    const { warnings } = (await lastPage(connector)) as { warnings?: string[] }
    expect(warnings).toEqual([
      expect.stringContaining('1 refund had only an amount'),
      expect.stringContaining('3 orders have a status added by a plugin'),
    ])
  })
})

async function lastPage(connector: ReturnType<typeof make>['connector']) {
  let cursor: string | null = null
  for (;;) {
    const p = await connector.sync(conn, cursor)
    if (!p.hasMore) return p
    cursor = p.cursor
  }
}

describe('currencies', () => {
  it('one snapshot per month per currency, each in its own money', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:EUR'))).toMatchObject({ 'Sales reported by the store': 100_00, 'Sales tax collected': 19_00 })
    expect(snaps(events).get('woocommerce:2026-10:EUR')?.currency).toBe('EUR')
  })

  it('a refund takes the currency of its order', async () => {
    const orders = [order({ id: 1, currency: 'EUR', total: '50.00' })]
    const refunds = [{ id: 2, parent_id: 1, date_created: '2026-10-03T10:00:00', amount: '20.00', line_items: [{ total: '-20.00', total_tax: '0' }], shipping_lines: [], fee_lines: [] }]
    const { connector } = make(store({ orders, refunds }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:EUR'))).toMatchObject({ 'Refunds of sales': -20_00 })
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))).toMatchObject({ 'Refunds of sales': 0 })
  })

  it('a zero-decimal store: yen stay whole', async () => {
    const orders = [order({ id: 1, currency: 'JPY', total: '1650.0000', total_tax: '150.0000', shipping_total: '500.0000' })]
    const refunds = [{ id: 2, parent_id: 1, date_created: '2026-10-03T10:00:00', amount: '330.0000', line_items: [{ total: '-300.0000', total_tax: '-30.0000' }], shipping_lines: [], fee_lines: [] }]
    const { connector } = make(store({ orders, refunds, currency: 'JPY' }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:JPY'))).toMatchObject({ 'Sales reported by the store': 1000, 'Shipping charged': 500, 'Sales tax collected': 150, 'Refunds of sales': -300, 'Sales tax refunded': -30 })
  })

  it('a three-decimal currency keeps its third digit (dp asks for it)', async () => {
    const orders = [order({ id: 1, currency: 'KWD', total: '12.3450', total_tax: '1.1220', shipping_total: '1.0000' })]
    const { connector, calls } = make(store({ orders, refunds: [], currency: 'KWD' }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:KWD'))).toMatchObject({ 'Sales reported by the store': 10_223, 'Sales tax collected': 1_122, 'Shipping charged': 1_000 })
    expect(new URL(calls.find((c) => c.url.includes('/orders?') && c.url.includes('after='))!.url).searchParams.get('dp')).toBe('4')
  })
})

describe('paging and resume', () => {
  const many = Array.from({ length: 7 }, (_, i) => order({ id: i + 1, total: '10.00' }))

  it('reads every X-WP-TotalPages page, 100 at most, sorted by id', async () => {
    const { connector, calls } = make(store({ orders: many, refunds: [] }), { perPage: 3 })
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))['Sales reported by the store']).toBe(70_00)
    const oct = calls.filter((c) => c.url.includes('/orders?') && c.url.includes('after=2026-09-30'))
    expect(oct.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3'])
    expect(new URL(oct[0]!.url).searchParams.get('orderby')).toBe('id')
    expect(new URL(oct[0]!.url).searchParams.get('order')).toBe('asc')
    const capped = make(store({ orders: many, refunds: [] }), { perPage: 500 })
    await runSync(capped.connector, conn, null)
    expect(new URL(capped.calls.find((c) => c.url.includes('/orders?'))!.url).searchParams.get('per_page')).toBe('100')
  })

  it('stops on a short page when a proxy dropped the paging headers', async () => {
    const r = store({ orders: many, refunds: [] }).map((x) => (x.match instanceof Function && x.method === 'GET' ? x : x))
    const strip: FixtureRoute = { method: 'GET', match: (u) => u.pathname === '/wp-json/wc/v3/orders', respond: (u) => {
      const route = store({ orders: many, refunds: [] }).find((x) => typeof x.match === 'function' && x.match(u, undefined, undefined) && x.method === 'GET')!
      const res = (route.respond as (u: URL, b: unknown) => FixtureResponse)(u, undefined)
      return { json: res.json }
    } }
    const { connector } = make([strip, ...r], { perPage: 3 })
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))['Sales reported by the store']).toBe(70_00)
  })

  it('an order seen twice across pages (new rows shifting the list) counts once', async () => {
    let served = 0
    const shifted = store({
      orders: many,
      refunds: [],
      pageHook: (path, page) => {
        if (path !== 'orders' || served > 1 || page < 2) return undefined
        served++
        // One row moved onto the end of page 1: id 3 comes again on page 2, and everything after it slides along.
        return { json: page === 2 ? [many[2], many[3], many[4]] : [many[5], many[6]], headers: { 'x-wp-totalpages': '3', 'x-wp-total': '7' } }
      },
    })
    const { connector } = make(shifted, { perPage: 3 })
    // Only October has rows, so the hook's pages are October's.
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))['Sales reported by the store']).toBe(70_00)
  })

  it('resuming mid-month from the saved cursor gives the same month', async () => {
    const whole = make(store({ orders: many, refunds: fx.refunds.slice(0, 0) }), { perPage: 3 })
    const expected = snaps((await runSync(whole.connector, conn, null)).events).get('woocommerce:2026-10:USD')
    const parts = make(store({ orders: many, refunds: [] }), { perPage: 3 })
    let cursor: string | null = null
    const seen: NormalizedEvent[] = []
    for (let i = 0; i < 1000; i++) {
      const step = await runSync(parts.connector, conn, cursor, { maxPages: 1 })
      seen.push(...step.events)
      cursor = step.cursor
      if (step.complete) break
    }
    expect(snaps(seen).get('woocommerce:2026-10:USD')).toEqual(expected)
  })

  it('an unreadable cursor restarts from the beginning', async () => {
    const { connector } = make()
    await expect(connector.sync(conn, 'not-a-cursor')).rejects.toMatchObject({ kind: 'cursor_invalid' })
  })

  it('a later sync recomputes recent months only: a cancelled order leaves its month, and an old month stays put', async () => {
    const orders = [order({ id: 1, date_created: '2026-09-10T10:00:00', total: '10.00' }), order({ id: 2, date_created: '2025-01-10T10:00:00', total: '20.00' })]
    const first = make(store({ orders, refunds: [] }))
    const done = await runSync(first.connector, conn, null)
    orders[0]!.status = 'cancelled'
    const callsBefore = first.calls.length
    const second = await runSync(first.connector, conn, done.cursor)
    expect(rows(snaps(second.events).get('woocommerce:2026-09:USD'))['Sales reported by the store']).toBe(0)
    expect(snaps(second.events).has('woocommerce:2025-01:USD')).toBe(false)
    expect([...snaps(second.events).keys()].sort()[0]).toBe('woocommerce:2026-05:USD')
    expect(first.calls.length - callsBefore).toBeLessThan(20)
  })

  it('a recompute corrects a foreign currency that has gone from a month', async () => {
    const orders = [order({ id: 1, currency: 'EUR', total: '10.00' }), order({ id: 2, total: '10.00' })]
    const first = make(store({ orders, refunds: [] }))
    const done = await runSync(first.connector, conn, null)
    orders[0]!.status = 'cancelled'
    const second = await runSync(first.connector, conn, done.cursor)
    expect(rows(snaps(second.events).get('woocommerce:2026-10:EUR'))['Sales reported by the store']).toBe(0)
  })
})

describe('what is asked for and kept', () => {
  const PII = /billing|shipping_address|\bshipping\b(?!_)|customer|email|phone|first_name|last_name|address|ip_address|user_agent|note|meta_data|reason/i

  it('every order and refund request names its fields, and none is personal', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    const reads = calls.filter((c) => /\/wc\/v3\/(orders|refunds)\b/.test(c.url))
    expect(reads.length).toBeGreaterThan(40)
    for (const c of reads) {
      const f = new URL(c.url).searchParams.get('_fields')
      expect(f, c.url).toBeTruthy()
      for (const name of f!.split(',')) expect(name).not.toMatch(PII)
    }
  })

  it('order fields are exactly these', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    const f = new URL(calls.find((c) => c.url.includes('/orders?') && c.url.includes('after='))!.url).searchParams.get('_fields')
    expect(f).toBe('id,status,currency,date_created,total,total_tax,shipping_total')
  })

  it('a store that ignores _fields still leaves nothing personal behind', async () => {
    const leaky = { ...fx.orders[10]!, billing: { first_name: 'Ada', email: 'ada@example.com' }, customer_note: 'hello' }
    const { connector, raw } = make(store({ orders: [leaky], refunds: [] }))
    const { events } = await runSync(connector, conn, null)
    expect(JSON.stringify(events)).not.toMatch(/Ada|ada@|hello/)
    expect(JSON.stringify([...raw.records.values()])).not.toMatch(/Ada|ada@|hello/)
  })

  it('credentials go in the Basic header over https, never in the address', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    const basic = 'Basic ' + Buffer.from(`${KEY}:${SECRET}`).toString('base64')
    for (const c of calls) {
      expect(c.url.startsWith('https://')).toBe(true)
      expect(c.url).not.toMatch(/consumer_key|consumer_secret|ck_|cs_/)
      expect(c.headers.authorization).toBe(basic)
    }
  })

  it('reads only, during a sync', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('errors', () => {
  const failing = (res: FixtureResponse): FixtureRoute[] => [{ match: () => true, respond: res }]

  it('401: asks for a reconnect and echoes nothing', async () => {
    const { connector } = make(failing({ status: 401, json: fx.unauthorized }))
    const e = await connector.sync(conn, null).catch((x: Error) => x)
    expect(e).toMatchObject({ kind: 'auth', status: 401 })
    expect((e as Error).message).not.toContain('Sorry')
  })
  it('403 from a security plugin: auth, and the page it sent isn’t repeated', async () => {
    const { connector } = make(failing({ status: 403, text: '<html>blocked by ACME firewall ref 1234</html>' }))
    const e = await connector.sync(conn, null).catch((x: Error) => x)
    expect(e).toMatchObject({ kind: 'auth', status: 403 })
    expect((e as Error).message).not.toContain('ACME')
  })
  it('429 retries with Retry-After, then carries on', async () => {
    const rs = store()
    const { connector, clock } = make([{ match: (u) => u.pathname === '/wp-json/wc/v3/settings/general/woocommerce_currency', respond: [{ status: 429, headers: { 'retry-after': '7' } }, { json: { value: 'USD' } }] }, ...rs])
    await connector.sync(conn, null)
    expect(clock.sleeps).toContain(7000)
  })
  it('503 retries, then gives up as retryable', async () => {
    const { connector, clock } = make(failing({ status: 503, text: 'Service Unavailable' }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'transient', status: 503 })
    expect(clock.sleeps.length).toBeGreaterThan(0)
  })
  it('a 200 that isn’t a list (a maintenance page) stops the sync; it never reads as a month of zero sales', async () => {
    const routes: FixtureRoute[] = [{ match: (u) => u.pathname === '/wp-json/wc/v3/orders', respond: { text: '<html>We are upgrading</html>' } }, ...store()]
    const { connector } = make(routes)
    const first = await connector.sync(conn, null).catch((x: Error) => x)
    const e = first instanceof Error ? first : await connector.sync(conn, first.cursor).catch((x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).not.toContain('upgrading')
  })
  it('an amount that isn’t one stops the sync without echoing it', async () => {
    const { connector } = make(store({ orders: [order({ id: 1, total: 'lots-of-money' })], refunds: [] }))
    const e = await runSync(connector, conn, null).catch((x: Error) => x)
    expect(e).toBeInstanceOf(Error)
    expect((e as Error).message).not.toContain('lots-of-money')
  })
  it('a refund for an order the store no longer has is left out, as it isn’t in sales', async () => {
    const refunds = [{ id: 2, parent_id: 999, date_created: '2026-10-03T10:00:00', amount: '20.00', line_items: [], shipping_lines: [], fee_lines: [] }]
    const { connector } = make(store({ orders: [], refunds }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('woocommerce:2026-10:USD'))['Refunds of sales']).toBe(0)
  })
})

describe('connect', () => {
  const input = { storeUrl: 'https://shop.example.com/', consumerKey: KEY, consumerSecret: SECRET }

  it('gives steps that say Read, and calls this sales reported by the store', async () => {
    const b = await make().connector.begin!({} as never)
    expect(b.kind).toBe('api_key')
    if (b.kind !== 'api_key') return
    expect(b.fields?.map((f) => [f.name, f.secret ?? false])).toEqual([['storeUrl', false], ['consumerKey', true], ['consumerSecret', true]])
    expect(b.steps!.join(' ')).toContain('WooCommerce → Settings → Advanced → REST API')
    expect(b.steps!.join(' ')).toContain('Read')
    expect((b.permissions ?? []).join(' ')).toContain('sales reported by the store')
    expect(JSON.stringify(b)).not.toMatch(/booked revenue is|counts as revenue/i)
  })

  it('stores the normalized address and the store currency', async () => {
    const { connector } = make()
    const r = await connector.connect!(input)
    expect(r.secret).toEqual({ storeUrl: BASE, consumerKey: KEY, consumerSecret: SECRET })
    expect(r.config).toMatchObject({ host: 'shop.example.com', currency: 'USD' })
  })

  it.each([['ck_short', SECRET], [KEY, 'nope'], ['', SECRET]])('refuses a malformed key before asking the store (%s)', async (consumerKey, consumerSecret) => {
    const { connector, calls } = make()
    await expect(connector.connect!({ ...input, consumerKey, consumerSecret })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(calls).toEqual([])
  })

  it.each(['http://shop.example.com', 'https://localhost', 'https://169.254.169.254', 'https://[fdaa::1]', 'https://db.internal'])('refuses %s before any request', async (storeUrl) => {
    const { connector, calls } = make()
    await expect(connector.connect!({ ...input, storeUrl })).rejects.toBeTruthy()
    expect(calls).toEqual([])
  })

  it('refuses a public name that points at a private address', async () => {
    const { connector, calls } = make(store(), { resolve: async () => [{ address: '169.254.169.254', family: 4 }] })
    await expect(connector.connect!(input)).rejects.toMatchObject({ kind: 'permanent', forUser: true })
    expect(calls).toEqual([])
  })

  it('a stored connection is checked again on every sync (a store moved to a private address after connecting)', async () => {
    const { connector, calls } = make(store(), { resolve: async () => [{ address: '10.0.0.5', family: 4 }] })
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'permanent' })
    expect(calls).toEqual([])
  })

  it('a stored secret with a bad address is refused too', async () => {
    const { connector, calls } = make()
    await expect(connector.sync({ ...conn, secret: { storeUrl: 'http://169.254.169.254', consumerKey: KEY, consumerSecret: SECRET } }, null)).rejects.toBeTruthy()
    expect(calls).toEqual([])
  })

  it('a redirect at connect is refused, not followed, and says what to do', async () => {
    const { connector, calls } = make([{ match: () => true, respond: { status: 301, headers: { location: 'https://www.shop.example.com/' } } }])
    const e = await connector.connect!(input).catch((x: Error) => x)
    expect(e).toMatchObject({ kind: 'permanent', forUser: true })
    expect((e as Error).message).toMatch(/redirect/i)
    expect(calls).toHaveLength(1)
  })

  it('a store too old for the refunds list says so', async () => {
    const routes: FixtureRoute[] = [{ match: (u) => u.pathname === '/wp-json/wc/v3/refunds', respond: { status: 404, json: { code: 'rest_no_route' } } }, ...store()]
    await expect(make(routes).connector.connect!(input)).rejects.toMatchObject({ forUser: true, message: expect.stringContaining('9.0') })
  })

  describe('write keys', () => {
    const probe = (res: FixtureResponse): FixtureRoute => ({ method: 'POST', match: (u) => u.pathname === '/wp-json/wc/v3/aggregate-read-only-check', respond: res })
    const writeKey = probe({ status: 404, json: { code: 'rest_no_route', message: 'No route was found' } })

    it('hosted: a Read key connects', async () => {
      await expect(make(store(), { hosted: true }).connector.connect!(input)).resolves.toBeTruthy()
    })
    it('hosted: a key that can write is refused', async () => {
      const e = await make([writeKey, ...store()], { hosted: true }).connector.connect!(input).catch((x: Error) => x)
      expect(e).toMatchObject({ forUser: true })
      expect((e as Error).message).toMatch(/Read/)
    })
    it.each([[403, 'a firewall'], [500, 'an error'], [405, 'a method block']])('hosted: a %i (%s) proves nothing, so it is refused', async (status) => {
      await expect(make([probe({ status, text: 'x' }), ...store()], { hosted: true }).connector.connect!(input)).rejects.toMatchObject({ forUser: true })
    })
    it('hosted: a 401 without WooCommerce’s own code proves nothing either', async () => {
      await expect(make([probe({ status: 401, text: 'Authorization Required' }), ...store()], { hosted: true }).connector.connect!(input)).rejects.toMatchObject({ forUser: true })
    })
    it('self-hosted: a key that can write connects with a warning', async () => {
      const r = await make([writeKey, ...store()]).connector.connect!(input)
      expect((r.config.warnings as string[]).join(' ')).toMatch(/Read/)
    })
    it('the probe is one POST to a route that does not exist, with no body', async () => {
      const { connector, calls } = make(store(), { hosted: true })
      await connector.connect!(input)
      const posts = calls.filter((c) => c.method !== 'GET')
      expect(posts).toHaveLength(1)
      expect(posts[0]!.url).toBe(`${BASE}/wp-json/wc/v3/aggregate-read-only-check`)
      expect(posts[0]!.body).toBeUndefined()
    })
  })
})

describe('health and disconnect', () => {
  it('health is ok on a good key and asks for a reconnect on a dead one', async () => {
    expect((await make().connector.health!(conn)).status).toBe('ok')
    expect((await make([{ match: () => true, respond: { status: 401, json: fx.unauthorized } }]).connector.health!(conn)).status).toBe('needs_reauth')
  })
  it('disconnect says where the key is revoked, since it can’t be done from here', async () => {
    const { connector, calls } = make()
    expect(await connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
    expect(NOT_REVOKED).toBe('In WooCommerce, go to Settings → Advanced → REST API → Revoke the key.')
    expect(calls).toEqual([])
  })
})
