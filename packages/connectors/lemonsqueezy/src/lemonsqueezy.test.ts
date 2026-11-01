import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { LS_FEE_SYNC_WARNING, LS_FULL_ACCESS_WARNING, createLemonSqueezyConnector, interpretLemonSqueezyWebhook, refundExTax, type LemonSqueezyConnectorOptions } from './index.ts'
import type { LsOrder } from './types.ts'

type Pages = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/lemonsqueezy.json', import.meta.url), 'utf8')) as {
  stores: unknown
  orders: Pages
  subscriptions: Pages
  prices: Pages
  errors: { unauthorized: unknown; rate_limited: unknown }
}

const SECRET = 'ls_webhook_signing_secret'
const conn: ConnectionRef = {
  id: 'conn_ls',
  workspaceId: 'ws1',
  connectorKey: 'lemonsqueezy',
  secret: { apiKey: 'ls_test_key_redacted_0001' },
  config: { storeId: '1', storeIds: ['1', '2'] },
}

const notFound = { status: 404, json: { errors: [{ status: '404', title: 'Not Found', detail: 'not found' }] } }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  const byPage = (pages: Pages, u: URL) => {
    const p = pages[u.searchParams.get('page[number]') ?? '1']
    return p ? { json: p } : notFound
  }
  return [
    ...extra,
    { match: (u) => u.pathname === '/v1/stores', respond: { json: fx.stores } },
    { match: (u) => u.pathname === '/v1/orders', respond: (u) => byPage(fx.orders, u) },
    { match: (u) => u.pathname === '/v1/subscriptions', respond: (u) => byPage(fx.subscriptions, u) },
    {
      match: (u) => u.pathname.startsWith('/v1/prices/'),
      respond: (u) => {
        const p = fx.prices[u.pathname.slice('/v1/prices/'.length)]
        return p ? { json: p } : notFound
      },
    },
  ]
}

function make(extra: FixtureRoute[] = [], opts: LemonSqueezyConnectorOptions = {}) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createLemonSqueezyConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const find = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

describe('lemonsqueezy contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { '101': '+', '102': '+', '102:refund': '-', '103:refund': '-', '106': '+' },
      minEvents: 14,
    })
    expect(r.pages).toBe(5)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('lemonsqueezy mapping', () => {
  it('books orders from USD fields, excluding tax, with fee 0', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('101')).toMatchObject({
      kind: 'charge', accountExternalId: 'lemonsqueezy:1:USD', gross: { minor: 1000, currency: 'USD' }, fee: { minor: 0 }, net: { minor: 1000 },
      customer: '1101', at: '2026-09-02T10:00:00.000Z',
    })
    expect(t('102')).toMatchObject({ gross: { minor: 2000 }, net: { minor: 2000 } })
    expect(t('102:refund')).toMatchObject({ kind: 'refund', gross: { minor: -2000 }, fee: { minor: 0 }, net: { minor: -2000 }, sourceExternalId: '102', at: '2026-09-06T08:00:00.000Z' })
    // Partial refund of 5.50 on an 11.00 order with 1.00 tax: tax share removed pro rata → 5.00.
    expect(t('103:refund')?.net.minor).toBe(-500)
    // EUR checkout on a second store, booked in USD from total_usd − tax_usd.
    expect(t('106')).toMatchObject({ accountExternalId: 'lemonsqueezy:2:USD', gross: { minor: 900, currency: 'USD' } })
    expect(t('104')).toBeUndefined()
    expect(t('105')).toBeUndefined()
    expect(find<AccountUpsert>(events, 'account.upsert', 'lemonsqueezy:2:USD')).toMatchObject({ name: 'Second Store balance (Lemon Squeezy)', accountType: 'processor_balance', currency: 'USD' })
    expect(calls[0]?.headers).toMatchObject({ accept: 'application/vnd.api+json', authorization: 'Bearer ls_test_key_redacted_0001' })
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('warns about unknown fees once, on the final page of the cycle', async () => {
    const { connector } = make()
    const pages: Array<{ hasMore: boolean; warnings?: string[] }> = []
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      pages.push(r)
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(pages.slice(0, -1).every((p) => p.warnings === undefined)).toBe(true)
    expect(pages.at(-1)?.warnings).toEqual([LS_FEE_SYNC_WARNING, LS_FULL_ACCESS_WARNING])
  })

  it('refund tax share rounds half away from zero', () => {
    const o = { status: 'partial_refund', total_usd: 300, tax_usd: 100, refunded_amount_usd: 3 } as LsOrder
    // 3 × 200 / 300 = 2 exactly; 1 × 200/300 = 0.667 → 1; 3 × 150/300 with tax 150 → 1.5 → 2
    expect(refundExTax(o)).toBe(2)
    expect(refundExTax({ ...o, refunded_amount_usd: 1 })).toBe(1)
    expect(refundExTax({ ...o, tax_usd: 150 })).toBe(2)
    expect(refundExTax({ ...o, refunded_amount_usd: 0 })).toBe(0)
  })

  it('maps subscriptions with golden MRR', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const s = (id: string) => find<SubscriptionUpsert>(events, 'subscription.upsert', id)
    expect(s('1')).toMatchObject({ status: 'active', mrr: { minor: 3000, currency: 'USD' }, interval: 'month', intervalCount: 1, customer: '2001', items: [{ priceExternalId: '11', quantity: 2, amount: { minor: 1500 } }] })
    // cancelled = still running until ends_at: active, cancel at period end, 99.99/yr → 8.33.
    expect(s('2')).toMatchObject({ status: 'active', cancelAtPeriodEnd: true, mrr: { minor: 833 }, interval: 'year', currentPeriodEnd: '2026-12-01T00:00:00.000Z' })
    expect(s('3')).toMatchObject({ status: 'canceled', mrr: { minor: 0 }, endedAt: '2026-08-01T00:00:00.000Z' })
    expect(s('4')).toMatchObject({ status: 'trialing', mrr: { minor: 0 } })
    // Package pricing: 25 units in packs of 10 → 3 packs × 10.00 per 3 months → 10.00/mo.
    expect(s('5')).toMatchObject({ status: 'past_due', mrr: { minor: 1000 }, intervalCount: 3 })
    // Usage-based is excluded from MRR.
    expect(s('6')?.mrr.minor).toBe(0)
  })

  it('incremental cycle stops paging orders once past the refund window', async () => {
    const { connector, calls } = make([], { refundWindowDays: 1 })
    const first = await runSync(connector, conn, null)
    const n = calls.length
    await runSync(connector, conn, first.cursor)
    const orderPages = calls.slice(n).filter((c) => new URL(c.url).pathname === '/v1/orders').map((c) => new URL(c.url).searchParams.get('page[number]'))
    // since = 2026-09-10; page 1's oldest order (09-02) is older than since − 1 day → stop after page 1.
    expect(orderPages).toEqual(['1'])
  })

  it('filters by store when the connection has one store', async () => {
    const { connector, calls } = make()
    const one = { ...conn, config: { storeId: '1', storeIds: ['1'] } }
    const { events } = await runSync(connector, one, null)
    expect(new URL(calls.find((c) => c.url.includes('/v1/orders'))!.url).searchParams.get('filter[store_id]')).toBe('1')
    expect(find<AccountUpsert>(events, 'account.upsert', 'lemonsqueezy:2:USD')).toBeUndefined()
    expect(find<ProcessorBalanceTxn>(events, 'processor.balance_txn', '106')).toBeUndefined()
  })
})

describe('lemonsqueezy errors and connect', () => {
  it('401 is auth; health needs_reauth', async () => {
    const { connector } = make([{ match: '/v1/stores', respond: { status: 401, json: fx.errors.unauthorized } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', message: 'Unauthenticated.' })
    expect(await connector.health(conn)).toEqual({ status: 'needs_reauth', message: 'Unauthenticated.' })
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('429 with Retry-After is retried', async () => {
    let n = 0
    const { connector, clock } = make([
      { match: (u) => u.pathname === '/v1/stores' && n++ === 0, respond: { status: 429, json: fx.errors.rate_limited, headers: { 'retry-after': '3' } } },
    ])
    const page = await connector.sync(conn, null)
    expect(page.events).toHaveLength(2)
    expect(clock.sleeps).toContain(3000)
  })

  it('malformed stored secret is auth', async () => {
    await expect(make().connector.sync({ ...conn, secret: 'x' }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('connect validates, picks stores, and always warns that the key can write', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'ls_test_key_redacted_0001', storeId: '99' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const all = await connector.connect({ apiKey: 'ls_test_key_redacted_0001' })
    expect(all.config).toMatchObject({ storeId: '1', storeIds: ['1', '2'], storeName: 'Synthetic Store' })
    expect((all.config.warnings as string[])[0]).toMatch(/no read-only scope/)
    const one = await connector.connect({ apiKey: 'ls_test_key_redacted_0001', storeId: 2 })
    expect(one.config).toMatchObject({ storeId: '2', storeIds: ['2'] })
    expect(one.secret).toEqual({ apiKey: 'ls_test_key_redacted_0001' })
  })

  it('begin asks for an API key', async () => {
    expect(await make().connector.begin()).toMatchObject({ kind: 'api_key', helpUrl: 'https://app.lemonsqueezy.com/settings/api' })
  })
})

describe('lemonsqueezy webhooks', () => {
  const body = JSON.stringify({ meta: { event_name: 'order_refunded', test_mode: true, webhook_id: 'wh-1' }, data: { type: 'orders', id: '102', attributes: { store_id: 1 } } })
  const sig = (b: string, s = SECRET) => createHmac('sha256', s).update(b).digest('hex')

  it('verifies X-Signature and rejects tampered, missing and wrong-secret', async () => {
    const wh = make([], { webhookSecret: SECRET }).connector.webhook!
    await expect(wh.verify({ headers: { 'x-signature': sig(body) }, body })).resolves.toBeUndefined()
    await expect(wh.verify({ headers: { 'x-signature': sig(body) }, body: body.replace('102', '103') })).rejects.toMatchObject({ kind: 'auth' })
    await expect(wh.verify({ headers: { 'x-signature': sig(body, 'other') }, body })).rejects.toThrow(/bad signature/)
    await expect(wh.verify({ headers: { 'x-signature': 'zz' }, body })).rejects.toThrow(/malformed/)
    await expect(wh.verify({ headers: {}, body })).rejects.toThrow(/missing/)
    expect(make().connector.webhook).toBeUndefined()
  })

  it('interprets order and subscription events', () => {
    const w = (event_name: string) => interpretLemonSqueezyWebhook({ headers: {}, body: JSON.stringify({ meta: { event_name }, data: { id: '1', attributes: { store_id: 1 } } }) })
    expect(w('order_created')).toMatchObject({ action: 'sync', match: { field: 'storeId', value: '1' }, reason: 'order_created' })
    expect(w('order_refunded').action).toBe('sync')
    expect(w('subscription_updated').action).toBe('sync')
    expect(w('subscription_payment_success').action).toBe('sync')
    expect(w('license_key_created').action).toBe('ignore')
    expect(interpretLemonSqueezyWebhook({ headers: {}, body: '{' }).action).toBe('ignore')
    expect(w('order_created').dedupeKey).toBe(w('order_created').dedupeKey)
  })
})
