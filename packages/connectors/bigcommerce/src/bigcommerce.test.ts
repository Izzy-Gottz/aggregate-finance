import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  amount,
  BIGCOMMERCE_NO_TIME_ZONE,
  BIGCOMMERCE_NOT_FOUND,
  BIGCOMMERCE_REFUSED,
  BIGCOMMERCE_SCOPES_UNCHECKED,
  BIGCOMMERCE_TOKEN_REJECTED,
  NOT_REVOKED_APP,
  BIGCOMMERCE_UNKNOWN_CURRENCY,
  bigCommerceCurrencyGone,
  bigCommerceRefundMismatch,
  BigCommerceClient,
  createBigCommerceConnector,
  getOnly,
  NOT_REVOKED,
  parseStoreHash,
  REPORT_ROW_NET_SALES,
} from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/bigcommerce.json', import.meta.url), 'utf8')) as { store: Row; currencies: Row[]; orders: Row[]; oldOrder: Row; refunds: Row[] }

const TOKEN = 't'.repeat(31)
const conn: ConnectionRef = { id: 'conn_bc', workspaceId: 'ws1', connectorKey: 'bigcommerce', secret: { storeHash: 'abc123', accessToken: TOKEN }, config: {} }
const API = '/stores/abc123'

interface Data {
  orders?: Row[]
  refunds?: Row[]
  store?: Row
  currencies?: Row[]
  /** Answers first, for any path; undefined falls through to the store below. */
  hook?: (u: URL) => FixtureResponse | undefined
}

/** A small BigCommerce: filters by date, sorts by id, pages by page and limit, and answers an empty page with []. */
function bigcommerce(data: Data = {}): FixtureRoute[] {
  const orders = data.orders ?? fx.orders
  const refunds = data.refunds ?? fx.refunds
  const page = <T>(rows: T[], u: URL): T[] => {
    const size = Number(u.searchParams.get('limit') ?? 50)
    const n = Number(u.searchParams.get('page') ?? 1)
    return rows.slice((n - 1) * size, n * size)
  }
  // A row whose date doesn't parse is kept: the store would still send it, and the connector must stop on it.
  const since = (rows: Row[], field: string, min: string | null) => rows.filter((r) => !min || !(Date.parse(String(r[field])) < Date.parse(min)))
  const byId = (rows: Row[]) => [...rows].sort((a, b) => Number(a.id) - Number(b.id))
  return [
    { method: 'GET', match: () => true, respond: (u) => data.hook?.(u) ?? route(u) },
  ]
  function route(u: URL): FixtureResponse {
    const p = u.pathname
    if (p === `${API}/v2/store`) return { json: data.store ?? fx.store }
    if (p === `${API}/v2/currencies`) return { json: page(data.currencies ?? fx.currencies, u) }
    if (p === `${API}/v2/orders`) return { json: page(byId(since(orders, 'date_created', u.searchParams.get('min_date_created'))), u) }
    const one = /\/v2\/orders\/(\d+)$/.exec(p)
    if (one) {
      const o = [...orders, fx.oldOrder].find((x) => x.id === Number(one[1]))
      return o ? { json: o } : { status: 404, json: [{ status: 404, message: 'The requested resource was not found.' }] }
    }
    if (p === `${API}/v3/orders/payment_actions/refunds`) return { json: { data: page(byId(since(refunds, 'created', u.searchParams.get('created:min'))), u), meta: {} } }
    return { status: 404, json: { status: 404 } }
  }
}

function make(routes: FixtureRoute[] = bigcommerce(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const connector = createBigCommerceConnector({ raw, fetch: f.fetch, clock, random: () => 0 })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const failure = async (routes: FixtureRoute[], cursor: string | null = null) => {
  const m = make(routes)
  const e = (await runSync(m.connector, m.conn, cursor).catch((x: unknown) => x)) as ConnectorError
  return { e, m }
}
const order = (o: Row = {}): Row => ({ id: 201, status_id: 10, date_created: 'Tue, 15 Sep 2026 12:00:00 +0000', total_inc_tax: '10.0000', default_currency_code: 'USD', is_deleted: false, ...o })
const refund = (r: Row = {}): Row => ({ id: 301, order_id: 201, created: '2026-09-20T10:00:00Z', total_amount: 1, ...r })

describe('bigcommerce connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThan(3)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to hand-computed numbers: orders by the store’s month, refunds in their own month, currencies apart', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    // 12 months × USD (the store's) and EUR (an order was paid in it). GBP is set up but never used: no snapshots.
    expect(s.size).toBe(24)
    // 04:30 UTC on Sep 1 is Aug 31 in Chicago.
    expect(rows(s.get('bigcommerce:2026-08:USD'))).toEqual({ 'Orders placed in BigCommerce': 50_00, Refunds: 0, [REPORT_ROW_NET_SALES]: 50_00 })
    // 108.25 + 21.65 (the refunded order still sold); refunds 21.65 + 30.00 (03:00 UTC Oct 1 is Sep 30 in Chicago). The
    // cancelled order, its refund, the awaiting-payment order are all out.
    expect(rows(s.get('bigcommerce:2026-09:USD'))).toEqual({ 'Orders placed in BigCommerce': 129_90, Refunds: -51_65, [REPORT_ROW_NET_SALES]: 78_25 })
    // 64.95 (00:30 on Oct 1 in Chicago); the archived order is out; the refund on a 2025 order counts in October.
    expect(rows(s.get('bigcommerce:2026-10:USD'))).toEqual({ 'Orders placed in BigCommerce': 64_95, Refunds: -12_00, [REPORT_ROW_NET_SALES]: 52_95 })
    expect(rows(s.get('bigcommerce:2026-10:EUR'))).toEqual({ 'Orders placed in BigCommerce': 119_00, Refunds: -19_00, [REPORT_ROW_NET_SALES]: 100_00 })
    expect(rows(s.get('bigcommerce:2026-09:EUR'))).toEqual({ 'Orders placed in BigCommerce': 0, Refunds: 0, [REPORT_ROW_NET_SALES]: 0 })
    expect(s.get('bigcommerce:2026-10:USD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09', basis: 'accrual', kind: 'profit_and_loss' })
    for (const snap of s.values()) expect(snap.totals).toBeUndefined()
    expect([...s.keys()].some((k) => k.includes('GBP'))).toBe(false)
  })

  it('a refund in a later month than its order comes off in its own month, not the order’s', async () => {
    const { r } = await sync(bigcommerce({ orders: [order({ total_inc_tax: '40.0000' })], refunds: [refund({ created: '2026-10-03T12:00:00Z', total_amount: 15.5 })] }))
    const s = snaps(r.events)
    expect(rows(s.get('bigcommerce:2026-09:USD'))).toEqual({ 'Orders placed in BigCommerce': 40_00, Refunds: 0, [REPORT_ROW_NET_SALES]: 40_00 })
    expect(rows(s.get('bigcommerce:2026-10:USD'))).toEqual({ 'Orders placed in BigCommerce': 0, Refunds: -15_50, [REPORT_ROW_NET_SALES]: -15_50 })
  })

  it('a month that has begun on the store’s clock but not in UTC starts before it ends', async () => {
    const m = make(bigcommerce({ store: { ...fx.store, timezone: { name: 'Pacific/Auckland' } } }))
    m.clock.t = Date.parse('2026-10-31T12:00:00Z') // 01:00 on Nov 1 in Auckland
    const s = snaps((await runSync(m.connector, m.conn, null)).events).get('bigcommerce:2026-11:USD')
    expect(s).toMatchObject({ from: '2026-11-01', to: '2026-11-01' })
  })

  it('posts nothing: report snapshots only', async () => {
    const { r } = await sync()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('stores no buyer or owner names, emails or addresses: not in an event, not in raw', async () => {
    const { r, raw } = await sync()
    for (const s of [JSON.stringify(r.events), JSON.stringify([...raw.records.values()])]) {
      expect(s).not.toContain('example.com')
      expect(s).not.toContain('Sample')
      expect(s).not.toContain('Street')
      expect(s).not.toContain('Wrong size')
    }
  })

  it('only GETs reach the API, with the token in X-Auth-Token, and anything else is refused before it leaves', async () => {
    const { calls } = await sync()
    expect(calls.length).toBeGreaterThan(4)
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe('https://api.bigcommerce.com')
      expect(c.method).toBe('GET')
      expect(c.headers['x-auth-token']).toBe(TOKEN)
      expect(c.url).not.toContain(TOKEN)
    }
    let sent = 0
    const inner: FetchLike = async () => (sent++, new Response('{}'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(getOnly(inner)('https://api.bigcommerce.com/stores/abc123/v2/orders/1', { method })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })

  it('pages to the end (an empty page), filters by date from just before the first month, and counts a shifted row once', async () => {
    const many = Array.from({ length: 600 }, (_, i) => order({ id: 1000 + i, total_inc_tax: '1.0000' }))
    const { calls, r } = await sync(bigcommerce({ orders: many, refunds: [] }))
    const urls = calls.map((c) => new URL(c.url)).filter((u) => u.pathname === `${API}/v2/orders`)
    expect(urls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3', '4'])
    expect(urls[0]!.searchParams.get('min_date_created')).toBe('2025-10-30T00:00:00.000Z')
    expect(urls[0]!.searchParams.get('sort')).toBe('id:asc')
    expect(urls[0]!.searchParams.get('limit')).toBe('250')
    expect(rows(snaps(r.events).get('bigcommerce:2026-09:USD'))['Orders placed in BigCommerce']).toBe(600_00)
    const refundUrl = calls.map((c) => new URL(c.url)).find((u) => u.pathname === `${API}/v3/orders/payment_actions/refunds`)!
    expect(refundUrl.searchParams.get('created:min')).toBe('2025-10-30T00:00:00.000Z')

    // An order archived after page 1 was read pulls every later row one place back: page 1's last row comes again on page
    // 2 and is counted once.
    const shifted = bigcommerce({
      orders: many,
      refunds: [],
      hook: (u) => {
        const n = Number(u.searchParams.get('page'))
        if (u.pathname !== `${API}/v2/orders` || n < 2) return undefined
        return { json: many.slice((n - 1) * 250 - 1, n * 250 - 1) }
      },
    })
    const again = await sync(shifted)
    expect(rows(snaps(again.r.events).get('bigcommerce:2026-09:USD'))['Orders placed in BigCommerce']).toBe(600_00)
  })

  it('a page that sends only rows already counted stops the sync instead of looping', async () => {
    const { e } = await failure(bigcommerce({ orders: [order()], refunds: [], hook: (u) => (u.pathname === `${API}/v2/orders` ? { json: [order()] } : undefined) }))
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.message).toMatch(/already sent/)
  })

  it('a 204 with no body is an empty page', async () => {
    const f = fixtureFetch(bigcommerce())
    const wrapped: FetchLike = (input, init) => {
      const u = new URL(input)
      if (u.pathname === `${API}/v2/orders` && u.searchParams.get('page') === '2') return Promise.resolve(new Response(null, { status: 204 }))
      return f.fetch(input, init)
    }
    const c = createBigCommerceConnector({ raw: new MemoryRawSink(), fetch: wrapped, clock: fakeClock() })
    const r = await runSync(c, conn, null)
    expect(rows(snaps(r.events).get('bigcommerce:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(78_25)
  })

  it('shows nothing until refunds and orders are both read', async () => {
    const m = make()
    let cursor: string | null = null
    for (let i = 0; i < 20; i++) {
      const step = await m.connector.sync(m.conn, cursor)
      if (!step.hasMore) {
        expect(step.events.length).toBe(24)
        return
      }
      expect(step.events).toEqual([])
      cursor = step.cursor
    }
    throw new Error('never finished')
  })

  it.each([
    ['a word for an amount', order({ total_inc_tax: 'lots' })],
    ['no amount', order({ total_inc_tax: undefined })],
    ['a negative amount', order({ total_inc_tax: '-5.0000' })],
    ['a sub-cent amount', order({ total_inc_tax: '10.2550' })],
    ['a bad date', order({ date_created: 'soon' })],
    ['no status', order({ status_id: undefined })],
    ['an order with no id', order({ id: undefined })],
    ['a cancelled order with an unreadable amount', order({ status_id: 5, total_inc_tax: 'x' })],
  ])('stops the sync on %s, and never counts it as zero', async (_n, o) => {
    const { e, m } = await failure(bigcommerce({ orders: [o], refunds: [] }))
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.forUser).toBe(true)
    expect(e.message).toMatch(/BigCommerce/)
    expect(m.raw.records.size).toBe(0)
  })

  it.each([
    ['a word', refund({ total_amount: 'lots' })],
    ['a negative', refund({ total_amount: -3 })],
    ['no date', refund({ created: undefined })],
    ['no order', refund({ order_id: undefined })],
  ])('stops the sync on a refund amount that is %s', async (_n, r) => {
    const { e, m } = await failure(bigcommerce({ orders: [order()], refunds: [r] }))
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.forUser).toBe(true)
    expect(m.raw.records.size).toBe(0)
  })

  it('stops on an order in a currency the store doesn’t list, or no currency at all, never adding it to another', async () => {
    for (const code of ['JPY', 'usd', undefined]) {
      const { e, m } = await failure(bigcommerce({ orders: [order({ default_currency_code: code })], refunds: [] }))
      expect(e.message).toBe(BIGCOMMERCE_UNKNOWN_CURRENCY)
      expect(m.raw.records.size).toBe(0)
    }
  })

  it('a currency reported before that the store no longer lists stops the sync: its months are never zeroed or moved', async () => {
    const seeded = await sync()
    const { e, m } = await failure(bigcommerce({ currencies: [fx.currencies[0]!] }), seeded.r.cursor)
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(bigCommerceCurrencyGone('EUR'))
    expect(e.message.endsWith('To start fresh, disconnect BigCommerce and connect it again.')).toBe(true)
    expect(m.calls.some((c) => new URL(c.url).pathname.includes('/orders'))).toBe(false)
    expect(m.raw.records.size).toBe(0)
    // Still listed, with no orders this year: zeros, as before.
    const quiet = make(bigcommerce({ orders: [], refunds: [] }))
    const eurs = [...snaps((await runSync(quiet.connector, quiet.conn, seeded.r.cursor)).events).values()].filter((s) => s.currency === 'EUR')
    expect(eurs.length).toBe(12)
  })

  it.each([
    ['missing', undefined],
    ['empty', { name: '' }],
    ['not a real zone', { name: 'Mars/Olympus' }],
  ])('a time zone that is %s stops the sync and the connect, never a guess at UTC', async (_n, timezone) => {
    const routes = bigcommerce({ store: { ...fx.store, timezone } })
    const { e, m } = await failure(routes)
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(BIGCOMMERCE_NO_TIME_ZONE)
    expect(m.raw.records.size).toBe(0)
    await expect(make(routes).connector.connect({ storeHash: 'abc123', accessToken: TOKEN })).rejects.toThrow(BIGCOMMERCE_NO_TIME_ZONE)
  })

  it('a 401, 403, 429 or 500 stops the sync with no totals, never $0', async () => {
    for (const status of [401, 403, 429, 500]) {
      const { e, m } = await failure(bigcommerce({ hook: (u) => (u.pathname === `${API}/v2/orders` ? { status, json: [{ status, message: 'ZZ_PROVIDER_TEXT' }], headers: { 'x-rate-limit-time-reset-ms': '1500' } } : undefined) }))
      expect(e).toBeInstanceOf(ConnectorError)
      expect(e.message).not.toContain('ZZ_PROVIDER_TEXT')
      expect(m.raw.records.size).toBe(0)
      if (status === 401) expect(e).toMatchObject({ kind: 'auth', message: BIGCOMMERCE_TOKEN_REJECTED })
      if (status === 403) expect(e).toMatchObject({ kind: 'permanent', message: BIGCOMMERCE_REFUSED })
      if (status === 429) expect(e).toMatchObject({ kind: 'rate_limited' })
      if (status === 500) expect(e).toMatchObject({ kind: 'transient' })
    }
  }, 60_000)

  it('waits as long as BigCommerce’s rate-limit header says', async () => {
    const client = new BigCommerceClient('abc123', TOKEN, { fetch: (async () => new Response('[]', { status: 429, headers: { 'x-rate-limit-time-reset-ms': '1500' } })) as FetchLike, clock: fakeClock(), random: () => 0 })
    await expect(client.v2List('/v2/orders', {})).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 1500 })
  }, 30_000)

  it('a 200 that isn’t a list stops the sync rather than read as no orders', async () => {
    for (const json of [{ html: 'maintenance' }, 'oops', [1, 2]]) {
      const { e } = await failure(bigcommerce({ hook: (u) => (u.pathname === `${API}/v2/orders` ? { json } : undefined) }))
      expect(e).toMatchObject({ kind: 'permanent', forUser: true })
    }
    const { e } = await failure(bigcommerce({ hook: (u) => (u.pathname === `${API}/v3/orders/payment_actions/refunds` ? { json: { items: [] } } : undefined) }))
    expect(e).toMatchObject({ kind: 'permanent', forUser: true })
  })

  it('warns of a status id the docs don’t list, and leaves it out', async () => {
    const m = make(bigcommerce({ orders: [order(), order({ id: 202, status_id: 42, total_inc_tax: '99.0000' })], refunds: [] }))
    let cursor: string | null = null
    for (;;) {
      const p = await m.connector.sync(m.conn, cursor)
      cursor = p.cursor
      if (p.hasMore) continue
      expect(rows(snaps(p.events).get('bigcommerce:2026-09:USD'))['Orders placed in BigCommerce']).toBe(10_00)
      expect(p.warnings).toEqual([expect.stringContaining('1 order has a status')])
      return
    }
  })

  it('warns of refunded orders whose refunded_amount isn’t their refund records, and takes off the records only', async () => {
    const finish = async (orders: Row[], refunds: Row[]) => {
      const m = make(bigcommerce({ orders, refunds }))
      let cursor: string | null = null
      for (;;) {
        const p = await m.connector.sync(m.conn, cursor)
        cursor = p.cursor
        if (!p.hasMore) return p
      }
    }
    // Refunded in full with no record; partially refunded for more than its records; one that matches.
    const p = await finish(
      [order({ id: 201, status_id: 4, refunded_amount: '10.0000' }), order({ id: 202, status_id: 14, total_inc_tax: '40.0000', refunded_amount: '15.0000' }), order({ id: 203, status_id: 14, refunded_amount: '2.5000' })],
      [refund({ id: 301, order_id: 202, total_amount: 5 }), refund({ id: 302, order_id: 203, total_amount: 2.5 })],
    )
    expect(rows(snaps(p.events).get('bigcommerce:2026-09:USD'))).toEqual({ 'Orders placed in BigCommerce': 60_00, Refunds: -7_50, [REPORT_ROW_NET_SALES]: 52_50 })
    expect(p.warnings).toEqual([bigCommerceRefundMismatch(2)])
    expect(bigCommerceRefundMismatch(2)).toBe('2 orders are marked refunded in BigCommerce with no matching refund record; their refunds aren’t taken off.')
    // Records that add up: no warning. A refunded order with no refunded_amount stops the sync.
    expect((await finish([order({ id: 203, status_id: 14, refunded_amount: '2.5000' })], [refund({ id: 302, order_id: 203, total_amount: 2.5 })])).warnings).toBeUndefined()
    const { e } = await failure(bigcommerce({ orders: [order({ status_id: 4 })], refunds: [] }))
    expect(e).toMatchObject({ kind: 'permanent', forUser: true })
  })

  it('zero decimals: JPY stays whole, and 4-place strings read exactly', () => {
    expect(amount('500.0000', 'JPY')).toBe(500)
    expect(() => amount('500.5000', 'JPY')).toThrow(ConnectorError)
    expect(amount('108.2500', 'USD')).toBe(108_25)
    expect(amount(21.65, 'USD')).toBe(21_65)
  })

  it('maps statuses', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'permanent'], [404, 'permanent'], [429, 'rate_limited'], [503, 'transient']] as const) {
      const client = new BigCommerceClient('abc123', TOKEN, { fetch: (async () => new Response('{}', { status })) as FetchLike, clock: fakeClock(), random: () => 0 })
      await expect(client.store()).rejects.toMatchObject({ kind })
    }
  }, 30_000)

  it('connects with GETs only, keeps the hash and token, and says the scopes couldn’t be checked', async () => {
    const m = make()
    const c = await m.connector.connect({ storeHash: 'https://api.bigcommerce.com/stores/ABC123/v3/', accessToken: ` ${TOKEN} ` })
    expect(c.secret).toEqual({ storeHash: 'abc123', accessToken: TOKEN })
    expect(c.config).toEqual({ storeHash: 'abc123', currency: 'USD', warnings: [BIGCOMMERCE_SCOPES_UNCHECKED] })
    expect(JSON.stringify(c.config)).not.toContain('example.com')
    expect(m.calls.every((x) => x.method === 'GET')).toBe(true)
    expect(m.calls.map((x) => new URL(x.url).pathname)).toEqual([`${API}/v2/store`, `${API}/v2/currencies`, `${API}/v2/currencies`, `${API}/v2/orders`, `${API}/v3/orders/payment_actions/refunds`])
  })

  it('a token that can write can’t be told apart over the API, so none is ever used to write', async () => {
    // BigCommerce has no call that reports a store-level token's scopes (README, Unverified 1). The only guard is the client.
    const m = make()
    await m.connector.connect({ storeHash: 'abc123', accessToken: TOKEN })
    await runSync(m.connector, m.conn, null)
    expect(m.calls.filter((x) => x.method !== 'GET')).toEqual([])
  })

  it('connect refuses a bad hash, a bad token, an unknown store and a token without the scopes', async () => {
    const m = make()
    await expect(m.connector.connect({ storeHash: 'not a hash!', accessToken: TOKEN })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(m.connector.connect({ storeHash: 'https://evil.example.com/stores/abc123/v3/', accessToken: TOKEN })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(m.connector.connect({ storeHash: 'abc123', accessToken: 'short' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(m.calls).toEqual([])
    const missing = make(bigcommerce({ hook: (u) => (u.pathname === `${API}/v2/store` ? { status: 404, json: {} } : undefined) }))
    await expect(missing.connector.connect({ storeHash: 'abc123', accessToken: TOKEN })).rejects.toThrow(BIGCOMMERCE_NOT_FOUND)
    const noScope = make(bigcommerce({ hook: (u) => (u.pathname === `${API}/v3/orders/payment_actions/refunds` ? { status: 403, json: {} } : undefined) }))
    await expect(noScope.connector.connect({ storeHash: 'abc123', accessToken: TOKEN })).rejects.toThrow(BIGCOMMERCE_REFUSED)
  })

  it('reads the store hash from the API path or alone', () => {
    expect(parseStoreHash('abc123')).toBe('abc123')
    expect(parseStoreHash('https://api.bigcommerce.com/stores/abc123/v3/')).toBe('abc123')
    expect(parseStoreHash('https://api.bigcommerce.com/stores/abc123')).toBe('abc123')
    expect(parseStoreHash('https://api.bigcommerce.com/stores/../v3/')).toBeNull()
    expect(parseStoreHash('')).toBeNull()
  })

  it('connects an app install’s token with the same reads, GET only, marked as the app and without the unchecked-scopes note', async () => {
    const m = make()
    const c = await m.connector.connect({ adopt: { storeHash: 'abc123', accessToken: TOKEN } })
    expect(c.secret).toEqual({ storeHash: 'abc123', accessToken: TOKEN })
    expect(c.config).toEqual({ storeHash: 'abc123', currency: 'USD', via: 'app' })
    expect(m.calls.every((x) => x.method === 'GET')).toBe(true)
    expect(m.calls.map((x) => new URL(x.url).pathname)).toEqual([`${API}/v2/store`, `${API}/v2/currencies`, `${API}/v2/currencies`, `${API}/v2/orders`, `${API}/v3/orders/payment_actions/refunds`])
    expect(await m.connector.disconnect!({ ...m.conn, config: { via: 'app' } })).toEqual({ notRevoked: NOT_REVOKED_APP })
  })

  it('offers the app checks only when the app is configured', () => {
    expect(make().connector.app).toBeUndefined()
    const withApp = createBigCommerceConnector({ raw: new MemoryRawSink(), clock: fakeClock(), random: () => 0 }, { app: { clientId: 'cid', clientSecret: 'sec', authCallback: 'https://x.test/api/connectors/bigcommerce/auth' } })
    expect(withApp.app?.clientId).toBe('cid')
  })

  it('health reads the store; disconnect says where to delete the API account', async () => {
    const m = make()
    expect(await m.connector.health(m.conn)).toEqual({ status: 'ok' })
    expect(await m.connector.disconnect!(m.conn)).toEqual({ notRevoked: NOT_REVOKED })
    const dead = make(bigcommerce({ hook: () => ({ status: 401, json: {} }) }))
    expect((await dead.connector.health(dead.conn)).status).toBe('needs_reauth')
  })
})
