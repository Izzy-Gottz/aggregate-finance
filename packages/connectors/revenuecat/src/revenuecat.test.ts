import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, SubscriptionUpsert } from '@agfn/contracts'
import { isConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { computeMrr, createRevenueCatConnector, mapStatus, microsToMinor, opaqueCustomer, parseDuration, RC_DIRECT_WARNING, RC_LIST_PRICE_WARNING, RC_OTHER_STORE_WARNING, RC_UNPRICED_WARNING, type RcSubscriptionStatus } from './index.ts'

type Page = { items: unknown[]; next_page: string | null }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/revenuecat.json', import.meta.url), 'utf8')) as {
  products: unknown
  customerPages: Record<string, unknown>
  subscriptions: Record<string, unknown[]>
  transactions: Record<string, unknown[]>
  errors: { unauthorized: unknown; forbidden: unknown; rateLimited: unknown }
}

const conn: ConnectionRef = { id: 'conn_rc', workspaceId: 'ws1', connectorKey: 'revenuecat', secret: { projectId: 'proj_demo', apiKey: 'sk_test_redacted_0001' }, config: {} }
const BASE = '/v2/projects/proj_demo'
const list = (items: unknown[]): Page => ({ items, next_page: null })

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: (u) => u.pathname === `${BASE}/products`, respond: { json: fx.products } },
    { match: (u) => u.pathname === `${BASE}/customers`, respond: (u) => ({ json: fx.customerPages[u.searchParams.get('starting_after') ?? ''] ?? list([]) }) },
    { match: (u) => /^\/v2\/projects\/proj_demo\/customers\/[^/]+\/subscriptions$/.test(u.pathname), respond: (u) => ({ json: list(fx.subscriptions[decodeURIComponent(u.pathname.split('/')[5]!)] ?? []) }) },
    { match: (u) => /\/subscriptions\/[^/]+\/transactions$/.test(u.pathname), respond: (u) => ({ json: list(fx.transactions[u.pathname.split('/')[5]!] ?? []) }) },
  ]
}

function make(extra: FixtureRoute[] = []) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  return { connector: createRevenueCatConnector({}, { raw, fetch: f.fetch, clock }), conn, calls: f.calls, clock, raw }
}

const subs = (events: NormalizedEvent[]) => new Map(events.filter((e): e is SubscriptionUpsert => e.type === 'subscription.upsert').map((e) => [e.externalId, e]))
const full = async (extra: FixtureRoute[] = []) => {
  const m = make(extra)
  const r = await runSync(m.connector, m.conn, null)
  return { ...m, r, s: subs(r.events) }
}
const warnings = async (extra: FixtureRoute[] = []) => {
  const m = make(extra)
  let cursor: string | null = null
  const out: string[] = []
  for (let i = 0; i < 20; i++) {
    const page = await m.connector.sync(m.conn, cursor)
    out.push(...(page.warnings ?? []))
    cursor = page.cursor
    if (!page.hasMore) break
  }
  return out
}
const error = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x)
  if (!isConnectorError(e)) throw new Error('expected a ConnectorError')
  return e
}

describe('revenuecat contract', () => {
  it('passes the connector contract, paging customers', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 15 })
    expect(r.pages).toBe(2)
  })
  it('fixture is redacted', () => assertRedacted(fx, [/^17\d{11}$/])) // ms timestamps
  it('describes a read-only key connection', async () => {
    const c = make().connector
    expect(c.describe()).toMatchObject({ key: 'revenuecat', name: 'RevenueCat', auth: 'api_key' })
    const b = await c.begin()
    const text = JSON.stringify(b)
    for (const p of ['customer_information:customers:read', 'customer_information:subscriptions:read', 'project_configuration:products:read']) expect(text).toContain(p)
    expect(text).not.toContain('read_write')
  })
})

describe('revenuecat status map', () => {
  const cases: Array<[RcSubscriptionStatus, SubscriptionUpsert['status']]> = [
    ['trialing', 'trialing'], ['active', 'active'], ['expired', 'canceled'], ['in_grace_period', 'past_due'], ['in_billing_retry', 'past_due'], ['paused', 'paused'], ['unknown', 'incomplete'], ['incomplete', 'incomplete'],
  ]
  it.each(cases)('%s → %s', (from, to) => expect(mapStatus(from)).toBe(to))
  it('a status RevenueCat adds later counts for nothing', () => expect(mapStatus('brand_new')).toBe('incomplete'))
  it('only active and past_due carry MRR', async () => {
    const { s } = await full()
    for (const id of ['sub_trial', 'sub_paused', 'sub_unknown', 'sub_incomplete', 'sub_expired', 'sub_trial_lapsed']) expect(s.get(id)?.mrr.minor, id).toBe(0)
    expect(s.get('sub_paused')?.status).toBe('paused')
    expect(s.get('sub_roku_q')?.status).toBe('past_due')
    expect(s.get('sub_galaxy_retry')?.status).toBe('past_due')
  })
})

describe('revenuecat stores', () => {
  it.each(['sub_stripe', 'sub_paddle', 'sub_promo', 'sub_test', 'sub_external', 'sub_newstore', 'sub_sandbox', 'sub_family'])('leaves out %s', async (id) => {
    expect((await full()).s.has(id)).toBe(false)
  })
  it.each(['sub_app_month', 'sub_play_year', 'sub_amz_year', 'sub_rc_week', 'sub_roku_q', 'sub_galaxy_retry', 'sub_nodur'])('keeps %s', async (id) => {
    expect((await full()).s.has(id)).toBe(true)
  })
  it('asks for transactions only for the stores the endpoint covers, and only when a price is needed', async () => {
    const { calls } = await full()
    const asked = calls.filter((c) => c.url.includes('/transactions')).map((c) => new URL(c.url).pathname.split('/')[5])
    expect(asked.sort()).toEqual(['sub_app_month', 'sub_expired', 'sub_play_week', 'sub_play_year'])
  })
  it('never emits anything but subscription.upsert', async () => {
    const { r } = await full()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['subscription.upsert']))
  })
})

describe('revenuecat MRR accuracy (independent answers, to the cent)', () => {
  // Worked by hand, rounded half away from zero once per subscription.
  const expected: Record<string, [number, string]> = {
    sub_app_month: [949, 'USD'], // transaction: 9.99 less 0.50 tax
    sub_play_year: [420, 'EUR'], // transaction: (59.99 − 9.58) = 50.41 a year ÷ 12 = 4.2008…
    sub_play_week: [2_167, 'JPY'], // transaction: ¥500 a week × 52 ÷ 12 = 2,166.67, no minor units
    sub_amz_year: [500, 'USD'], // list: 59.99 a year ÷ 12 = 4.9992
    sub_rc_week: [1_296, 'USD'], // list: 2.99 a week × 52 ÷ 12 = 12.9567
    sub_roku_q: [833, 'USD'], // list: 24.99 a quarter ÷ 3, past due still counts
    sub_galaxy_retry: [999, 'USD'], // list: 9.99 a month, past due still counts
    sub_nodur: [499, 'USD'], // list: no duration on the product, 31-day billing period means monthly
    sub_noprice: [0, 'USD'], // no list price: counted as 0 with a warning
  }
  it.each(Object.entries(expected))('%s', async (id, [minor, currency]) => {
    expect((await full()).s.get(id)?.mrr).toEqual({ minor, currency })
  })
  it('the live subscriptions add up per currency', async () => {
    const { s } = await full()
    const total = (c: string) => [...s.values()].filter((e) => e.mrr.currency === c).reduce((a, e) => a + e.mrr.minor, 0)
    expect(total('USD')).toBe(5_076) // 949 + 500 + 1,296 + 833 + 999 + 499
    expect(total('EUR')).toBe(420)
    expect(total('JPY')).toBe(2_167)
  })
  it('normalizes exactly', () => {
    expect(computeMrr([{ unitAmount: 5_999, quantity: 1, interval: 'year', intervalCount: 1 }])).toBe(500)
    expect(computeMrr([{ unitAmount: 299, quantity: 1, interval: 'week', intervalCount: 1 }])).toBe(1_296)
    expect(computeMrr([{ unitAmount: 2_499, quantity: 1, interval: 'month', intervalCount: 3 }])).toBe(833)
  })
  it('turns micros into minor units with no floats', () => {
    expect(microsToMinor(9_990_000, 'USD')).toBe(999)
    expect(microsToMinor(1_200_000_000, 'JPY')).toBe(1_200)
    expect(microsToMinor(1_234_500, 'KWD')).toBe(1_235)
    expect(microsToMinor(1_005_000, 'USD')).toBe(101)
  })
  it('reads ISO durations and refuses what it cannot', () => {
    expect(parseDuration('P1W')).toEqual({ interval: 'week', intervalCount: 1 })
    expect(parseDuration('P3M')).toEqual({ interval: 'month', intervalCount: 3 })
    expect(parseDuration('P1Y')).toEqual({ interval: 'year', intervalCount: 1 })
    expect(parseDuration('P3D')).toEqual({ interval: 'day', intervalCount: 3 })
    expect(parseDuration('P1Y2M')).toBeUndefined()
    expect(parseDuration(null)).toBeUndefined()
  })
  it('a subscription with no paid transaction falls back to the list price', async () => {
    const empty: FixtureRoute = { match: (u) => u.pathname.endsWith('/sub_app_month/transactions'), respond: { json: list([]) } }
    expect((await full([empty])).s.get('sub_app_month')?.mrr).toEqual({ minor: 999, currency: 'USD' })
  })
  it('a 404 from transactions falls back too, an auth failure does not', async () => {
    const r404: FixtureRoute = { match: (u) => u.pathname.endsWith('/sub_play_week/transactions'), respond: { status: 404, json: { type: 'resource_missing', message: 'nope', retryable: false } } }
    expect((await full([r404])).s.get('sub_play_week')?.mrr).toEqual({ minor: 1_296, currency: 'USD' })
    const r403: FixtureRoute = { match: (u) => u.pathname.endsWith('/sub_play_week/transactions'), respond: { status: 403, json: fx.errors.forbidden } }
    const m = make([r403])
    expect((await error(runSync(m.connector, m.conn, null))).kind).toBe('auth')
  })
})

describe('revenuecat history', () => {
  it('trial then paid: MRR starts at the first paid transaction, not the trial', async () => {
    const e = (await full()).s.get('sub_app_month')!
    expect(e.startedAt).toBe('2026-01-08T00:00:00.000Z')
    expect(e.changes).toEqual([{ at: '2026-01-15T00:00:00.000Z', mrr: { minor: 949, currency: 'USD' } }])
  })
  it('trial → active → expired: churns the amount it paid, on the day it ended', async () => {
    const e = (await full()).s.get('sub_expired')!
    expect(e).toMatchObject({ status: 'canceled', endedAt: '2026-04-08T00:00:00.000Z', canceledAt: '2026-04-08T00:00:00.000Z', mrr: { minor: 0, currency: 'USD' } })
    expect(e.changes).toEqual([{ at: '2026-02-08T00:00:00.000Z', mrr: { minor: 949, currency: 'USD' } }])
  })
  it('a trial that lapsed never counted', async () => {
    const e = (await full()).s.get('sub_trial_lapsed')!
    expect(e.status).toBe('canceled')
    expect(e.changes).toBeUndefined()
  })
  it('a price change shows as a change', async () => {
    const t = (id: string, at: number, gross: number) => ({ id, purchased_at: at, expiration_date: at + 31 * 86_400_000, revenue_in_local_currency: { currency: 'USD', gross, tax: 0, proceeds: gross } })
    const rows = [t('t2', Date.parse('2026-06-01'), 14.99), t('t1', Date.parse('2026-05-01'), 9.99)]
    const up: FixtureRoute = { match: (u) => u.pathname.endsWith('/sub_app_month/transactions'), respond: { json: list(rows) } }
    const e = (await full([up])).s.get('sub_app_month')!
    expect(e.mrr.minor).toBe(1_499)
    expect(e.changes?.map((c) => c.mrr.minor)).toEqual([999, 1_499])
  })
  it('reports will_not_renew and the period end', async () => {
    const { s } = await full()
    expect(s.get('sub_cancelling')?.cancelAtPeriodEnd).toBe(true)
    expect(s.get('sub_amz_year')).toMatchObject({ cancelAtPeriodEnd: false, currentPeriodEnd: '2026-11-01T00:00:00.000Z', interval: 'year', intervalCount: 1 })
    expect(s.get('sub_paused')?.currentPeriodEnd).toBeUndefined()
  })
})

describe('revenuecat privacy', () => {
  it('sends an opaque customer id, stable per project, and never the app user id', async () => {
    const { s, raw } = await full()
    const e = s.get('sub_app_month')!
    expect(e.customer).toBe(opaqueCustomer('proj_demo', 'alice@example.com'))
    expect(e.customer).toMatch(/^rc_[a-f0-9]{24}$/)
    expect(opaqueCustomer('other', 'alice@example.com')).not.toBe(e.customer)
    expect(JSON.stringify([...s.values()])).not.toContain('alice')
    const stored = JSON.stringify([...raw.records.values()])
    expect(raw.records.size).toBeGreaterThan(10)
    expect(stored).not.toContain('alice')
    expect(stored).not.toContain('store-sub_')
  })
})

describe('revenuecat paging and resume', () => {
  it('stops after one customer page and resumes there', async () => {
    const m = make()
    const one = await runSync(m.connector, m.conn, null, { maxPages: 1 })
    expect(one.complete).toBe(false)
    expect(subs(one.events).has('sub_app_month')).toBe(true)
    expect(subs(one.events).has('sub_noprice')).toBe(false)
    const before = m.calls.length
    const rest = await runSync(m.connector, m.conn, one.cursor)
    expect(rest.complete).toBe(true)
    expect(subs(rest.events).has('sub_noprice')).toBe(true)
    expect(m.calls.slice(before).some((c) => c.url.includes('starting_after=cust_f'))).toBe(true)
    expect(m.calls.slice(before).some((c) => c.url.includes('/customers/cust_b/'))).toBe(false)
  })
  it('walks every page of one customer’s subscriptions', async () => {
    const a = fx.subscriptions.cust_b![0]
    const b = { ...(a as object), id: 'sub_second_page' }
    const pages: FixtureRoute = { match: (u) => u.pathname === `${BASE}/customers/cust_b/subscriptions`, respond: (u) => ({ json: u.searchParams.get('starting_after') === 'sub_play_year' ? list([b]) : { items: [a], next_page: `${BASE}/customers/cust_b/subscriptions?starting_after=sub_play_year` } }) }
    expect((await full([pages])).s.has('sub_second_page')).toBe(true)
  })
  it('starts over once a pass has finished: there is no updated-since filter', async () => {
    const m = make()
    const done = await runSync(m.connector, m.conn, null)
    const again = await runSync(m.connector, m.conn, done.cursor)
    expect(again.events.length).toBe(done.events.length)
  })
  it('a cursor from another connector is refused or restarts, never crashes on shape', async () => {
    const m = make()
    await expect(runSync(m.connector, m.conn, 'not-a-cursor')).resolves.toMatchObject({ complete: true })
  })
  it('only ever reads', async () => {
    const { calls } = await full()
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
    expect(calls[0]?.headers.authorization).toBe('Bearer sk_test_redacted_0001')
  })
})

describe('revenuecat warnings', () => {
  it('says MRR is partly list price, in one warning per kind, once a pass', async () => {
    const w = await warnings()
    // Live on a list price: amazon, rc_billing, roku, galaxy, paypal. sub_noprice has none.
    expect(w).toContain(RC_LIST_PRICE_WARNING(5))
    expect(w).toContain(RC_UNPRICED_WARNING(1))
    expect(w).toContain(RC_DIRECT_WARNING(2))
    expect(w).toContain(RC_OTHER_STORE_WARNING(2))
    expect(w).toHaveLength(4)
  })
  it('no warnings when everything is priced from transactions', async () => {
    const one: FixtureRoute = { match: (u) => u.pathname === `${BASE}/customers`, respond: { json: list([{ id: 'cust_b' }]) } }
    expect(await warnings([one])).toEqual([])
  })
})

describe('revenuecat errors and connect', () => {
  const customers = (r: FixtureResponse | FixtureResponse[]): FixtureRoute => ({ match: (u) => u.pathname === `${BASE}/customers`, respond: r })
  it('401 is an auth failure', async () => {
    const m = make([customers({ status: 401, json: fx.errors.unauthorized })])
    expect((await error(runSync(m.connector, m.conn, null))).kind).toBe('auth')
    expect((await m.connector.health(m.conn)).status).not.toBe('ok')
  })
  it('403 is an auth failure', async () => {
    const m = make([customers({ status: 403, json: fx.errors.forbidden })])
    expect((await error(runSync(m.connector, m.conn, null))).kind).toBe('auth')
  })
  it('429 waits for Retry-After, then carries on', async () => {
    const m = make([customers([{ status: 429, json: fx.errors.rateLimited, headers: { 'retry-after': '3' } }, { json: fx.customerPages.cust_f }])])
    await runSync(m.connector, m.conn, null, { maxPages: 1 })
    expect(m.clock.sleeps).toContain(3_000)
  })
  it('429 without the header uses backoff_ms from the body', async () => {
    const m = make([customers([{ status: 429, json: fx.errors.rateLimited }, { json: fx.customerPages.cust_f }])])
    await runSync(m.connector, m.conn, null, { maxPages: 1 })
    expect(m.clock.sleeps).toContain(1_000)
  })
  it('connect refuses anything but a secret key, without calling RevenueCat', async () => {
    for (const apiKey of ['appl_abcdefghij', 'goog_abcdefghij', 'atk_abcdefghij', 'pk_abcdefghij', 'sk_', 'sk_has space here']) {
      const m = make()
      expect((await error(m.connector.connect({ projectId: 'proj_demo', apiKey }))).kind).toBe('invalid_input')
      expect(m.calls).toHaveLength(0)
    }
  })
  it('connect refuses a bad project id', async () => {
    const m = make()
    expect((await error(m.connector.connect({ projectId: '../x', apiKey: 'sk_test_redacted_0001' }))).kind).toBe('invalid_input')
  })
  it('connect checks all three read permissions and keeps only the secret', async () => {
    const m = make()
    const r = await m.connector.connect({ projectId: ' proj_demo ', apiKey: ' sk_test_redacted_0001 ' })
    expect(r.secret).toEqual({ projectId: 'proj_demo', apiKey: 'sk_test_redacted_0001' })
    expect(JSON.stringify(r.config)).not.toContain('sk_')
    const paths = m.calls.map((c) => new URL(c.url).pathname)
    expect(paths).toEqual(expect.arrayContaining([`${BASE}/customers`, `${BASE}/products`]))
    expect(paths.some((p) => p.endsWith('/subscriptions'))).toBe(true)
  })
  it('connect explains a key missing a permission', async () => {
    const m = make([{ match: (u) => u.pathname === `${BASE}/products`, respond: { status: 403, json: fx.errors.forbidden } }])
    const e = await error(m.connector.connect({ projectId: 'proj_demo', apiKey: 'sk_test_redacted_0001' }))
    expect(e.kind).toBe('auth')
    expect(e.message).toContain('project_configuration:products:read')
    expect(e.forUser).toBe(true)
  })
})
