import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { computeMrr, createPaddleConnector, interpretPaddleWebhook, paddleWebhookRef, percentToBasisPoints, verifyPaddleSignature } from './index.ts'

type Pages = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/paddle.json', import.meta.url), 'utf8')) as {
  transactions: Pages
  adjustments: Pages
  subscriptions: Pages
  discounts: Pages
  errors: { unauthorized: unknown; forbidden: unknown; rate_limited: unknown }
}

const WH_SECRET = 'pdl_ntfset_test_secret_value'
const conn: ConnectionRef = {
  id: 'conn_paddle',
  workspaceId: 'ws1',
  connectorKey: 'paddle',
  secret: { apiKey: 'pdl_sdbx_apikey_redacted_1' },
  config: { env: 'sandbox', webhookRef: paddleWebhookRef(WH_SECRET) },
}

const notFound = { status: 404, json: { error: { type: 'request_error', code: 'not_found', detail: 'not found' } } }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  const byAfter = (pages: Pages, u: URL) => {
    const key = u.searchParams.has('updated_at[GTE]') ? 'incremental' : (u.searchParams.get('after') ?? '')
    const page = pages[key]
    return page ? { json: page } : notFound
  }
  return [
    ...extra,
    { match: (u) => u.pathname === '/transactions', respond: (u) => byAfter(fx.transactions, u) },
    { match: (u) => u.pathname === '/adjustments', respond: (u) => byAfter(fx.adjustments, u) },
    { match: (u) => u.pathname === '/subscriptions', respond: (u) => byAfter(fx.subscriptions, u) },
    {
      match: (u) => u.pathname.startsWith('/discounts/'),
      respond: (u) => {
        const d = fx.discounts[decodeURIComponent(u.pathname.slice('/discounts/'.length))]
        return d ? { json: d } : notFound
      },
    },
  ]
}

function make(extra: FixtureRoute[] = [], webhookSecret?: string) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createPaddleConnector(webhookSecret ? { webhookSecret } : {}, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const find = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

describe('paddle contract', () => {
  it('passes the connector contract', async () => {
    const report = await runConnectorContract({
      make: () => make(),
      signs: { txn_01aa1: '+', txn_01aa2: '+', txn_01aa4: '+', adj_01bb1: '-', adj_01bb2: '-' },
      minEvents: 11,
    })
    expect(report.pages).toBe(6)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('paddle mapping', () => {
  it('maps completed transactions: tax excluded from gross, gross − fee = net = earnings', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('txn_01aa1')).toMatchObject({
      kind: 'charge',
      accountExternalId: 'paddle:sandbox:USD',
      gross: { minor: 10000, currency: 'USD' },
      fee: { minor: 550, currency: 'USD' },
      net: { minor: 9450, currency: 'USD' },
      customer: 'ctm_01cust1',
      at: '2026-09-01T10:00:00.000Z',
    })
    // EUR checkout settles to the USD balance: payout_totals are used.
    expect(t('txn_01aa2')).toMatchObject({ gross: { minor: 4600, currency: 'USD' }, fee: { minor: 279 }, net: { minor: 4321 } })
    // Account credit applied: earnings are what reached the balance.
    expect(t('txn_01aa4')).toMatchObject({ gross: { minor: 4000 }, fee: { minor: 250 }, net: { minor: 3750 } })
    // Paid but not completed (no payout_totals yet) is not emitted.
    expect(t('txn_01aa3')).toBeUndefined()
    expect(find<AccountUpsert>(events, 'account.upsert', 'paddle:sandbox:USD')).toMatchObject({ accountType: 'processor_balance', currency: 'USD' })
    const first = new URL(calls[0]!.url)
    expect(first.host).toBe('sandbox-api.paddle.com')
    expect(first.searchParams.get('status')).toBe('paid,completed')
    expect(first.searchParams.get('order_by')).toBe('updated_at[ASC]')
    expect(calls[0]!.headers.authorization).toBe('Bearer pdl_sdbx_apikey_redacted_1')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('maps refunds and chargebacks; skips credits and pending adjustments', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('adj_01bb1')).toMatchObject({ kind: 'refund', gross: { minor: -10000 }, fee: { minor: -550 }, net: { minor: -9450 }, sourceExternalId: 'txn_01aa1' })
    // Chargeback: returned fee −279, chargeback fee +1500 → fee 1221; net −(4321 + 1500).
    expect(t('adj_01bb2')).toMatchObject({ kind: 'dispute', gross: { minor: -4600 }, fee: { minor: 1221 }, net: { minor: -5821 } })
    expect(t('adj_01bb3')).toBeUndefined()
    expect(t('adj_01bb4')).toBeUndefined()
  })

  it('maps subscriptions with golden MRR', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const s = (id: string) => find<SubscriptionUpsert>(events, 'subscription.upsert', id)
    // 2 seats × 10.00/mo + 120.00/yr add-on = 30.00; one-time setup excluded; 10% discount → 27.00.
    expect(s('sub_01one')).toMatchObject({ status: 'active', mrr: { minor: 2700, currency: 'USD' }, interval: 'month', intervalCount: 1, cancelAtPeriodEnd: false })
    expect(s('sub_01one')?.items).toHaveLength(2)
    // 99.99/yr → 8.3325 → 8.33; cancel scheduled at period end still counts.
    expect(s('sub_02yearly')).toMatchObject({ mrr: { minor: 833 }, cancelAtPeriodEnd: true, interval: 'year' })
    expect(s('sub_03gone')).toMatchObject({ status: 'canceled', mrr: { minor: 0 }, canceledAt: '2026-08-15T00:00:00.000Z', endedAt: '2026-08-15T00:00:00.000Z' })
    expect(s('sub_04trial')).toMatchObject({ status: 'trialing', mrr: { minor: 0 } })
    // 10.00 every 2 weeks = 21.6667/mo minus 1.00 flat per cycle (2.1667/mo) = 19.50 exactly.
    expect(s('sub_05weekly')).toMatchObject({ status: 'past_due', mrr: { minor: 1950 }, interval: 'week', intervalCount: 2 })
    // Expired discount is ignored: 30.00 per quarter → 10.00.
    expect(s('sub_06expired_disc')?.mrr.minor).toBe(1000)
  })

  it('second cycle is incremental: overlap on updated_at, resumes adjustments after the last settled id', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const second = await runSync(connector, conn, first.cursor)
    assertValidEvents(second.events, { connectionId: conn.id, knownAccounts: ['paddle:sandbox:USD'] })
    const later = calls.slice(n).map((c) => new URL(c.url))
    const tx = later.find((u) => u.pathname === '/transactions')!
    // High-water 2026-09-04T10:00Z minus 2 days.
    expect(tx.searchParams.get('updated_at[GTE]')).toBe('2026-09-02T10:00:00.000Z')
    expect(later.find((u) => u.pathname === '/adjustments')!.searchParams.get('after')).toBe('adj_01bb2')
    expect(find<ProcessorBalanceTxn>(second.events, 'processor.balance_txn', 'adj_01bb3')).toMatchObject({ kind: 'refund', net: { minor: -3750 }, fee: { minor: -250 } })
  })
})

describe('mrr math (golden)', () => {
  it('normalizes intervals and rounds once, half away from zero', () => {
    expect(computeMrr([{ unitAmount: 1000, quantity: 3, interval: 'month', intervalCount: 1 }])).toBe(3000)
    expect(computeMrr([{ unitAmount: 6, quantity: 1, interval: 'year', intervalCount: 1 }])).toBe(1) // 0.5 → 1
    expect(computeMrr([{ unitAmount: 5, quantity: 1, interval: 'year', intervalCount: 1 }])).toBe(0) // 0.4167 → 0
    expect(computeMrr([{ unitAmount: 100, quantity: 1, interval: 'day', intervalCount: 1 }])).toBe(3042) // 3041.67
    expect(computeMrr([{ unitAmount: 1000, quantity: 1, interval: 'week', intervalCount: 1 }])).toBe(4333) // 4333.33
    // Rounding happens once: two lines of 0.5 each sum to 1, not 2.
    expect(computeMrr([
      { unitAmount: 6, quantity: 1, interval: 'year', intervalCount: 1 },
      { unitAmount: 6, quantity: 1, interval: 'year', intervalCount: 1 },
    ])).toBe(1)
    expect(computeMrr([{ unitAmount: 1000, quantity: 1, interval: 'month', intervalCount: 1 }], [{ kind: 'percent', basisPoints: 1250 }])).toBe(875)
    expect(computeMrr([{ unitAmount: 1000, quantity: 1, interval: 'month', intervalCount: 1 }], [{ kind: 'amount', amount: 5000, interval: 'month', intervalCount: 1 }])).toBe(0)
    expect(percentToBasisPoints('12.5')).toBe(1250)
    expect(percentToBasisPoints('100')).toBe(10000)
    expect(percentToBasisPoints('0.015')).toBe(2)
  })
})

describe('paddle errors and connect', () => {
  it('401 is auth and health needs_reauth; 403 explains the missing permission', async () => {
    const { connector } = make([{ match: '/transactions', respond: { status: 401, json: fx.errors.unauthorized } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'authentication_malformed' })
    expect((await connector.health(conn)).status).toBe('needs_reauth')
    const forbidden = make([{ match: '/transactions', respond: { status: 403, json: fx.errors.forbidden } }])
    await expect(runSync(forbidden.connector, conn, null)).rejects.toThrow(/read permission/)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('429 with Retry-After is retried after the stated wait', async () => {
    let n = 0
    const { connector, clock } = make([
      { match: (u) => u.pathname === '/transactions' && n++ === 0, respond: { status: 429, json: fx.errors.rate_limited, headers: { 'retry-after': '7' } } },
    ])
    const page = await connector.sync(conn, null)
    expect(page.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(7000)
  })

  it('malformed stored secret is auth', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { key: 'x' } }, null)).rejects.toMatchObject({ kind: 'auth' })
    expect((await connector.health({ ...conn, secret: null })).status).toBe('needs_reauth')
  })

  it('connect validates input, infers env from the key, and verifies with one read', async () => {
    const { connector, calls } = make([], WH_SECRET)
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'pdl_sdbx_apikey_abcdefghij', env: 'live' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const out = await connector.connect({ apiKey: 'pdl_sdbx_apikey_abcdefghij' })
    expect(out.secret).toEqual({ apiKey: 'pdl_sdbx_apikey_abcdefghij' })
    expect(out.config).toMatchObject({ env: 'sandbox', webhookRef: paddleWebhookRef(WH_SECRET) })
    expect(calls.at(-1)?.url).toBe('https://sandbox-api.paddle.com/transactions?per_page=1')
  })

  it('begin asks for an API key', async () => {
    const begin = await make().connector.begin()
    expect(begin).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('paddle.com') })
  })
})

describe('paddle webhooks', () => {
  const body = JSON.stringify({ event_id: 'evt_01abc', event_type: 'transaction.completed', occurred_at: '2026-10-09T12:00:00Z', notification_id: 'ntf_01abc', data: { id: 'txn_01aa1' } })
  const sign = (b: string, ts: number, secret = WH_SECRET) => ({
    'paddle-signature': `ts=${ts};h1=${createHmac('sha256', secret).update(`${ts}:${b}`).digest('hex')}`,
  })

  it('accepts a valid signature within 5 s and rejects tampered, stale, wrong-secret and malformed ones', async () => {
    const { connector, clock } = make([], WH_SECRET)
    const wh = connector.webhook!
    const ts = Math.floor(clock.now() / 1000)
    await expect(wh.verify({ headers: sign(body, ts), body })).resolves.toBeUndefined()
    await expect(wh.verify({ headers: sign(body, ts - 3), body })).resolves.toBeUndefined()
    await expect(wh.verify({ headers: sign(body, ts), body: body.replace('txn_01aa1', 'txn_01zz9') })).rejects.toMatchObject({ kind: 'auth' })
    await expect(wh.verify({ headers: sign(body, ts - 6), body })).rejects.toThrow(/tolerance/)
    await expect(wh.verify({ headers: sign(body, ts, 'other'), body })).rejects.toThrow(/signature/)
    await expect(wh.verify({ headers: { 'paddle-signature': 'garbage' }, body })).rejects.toThrow(/malformed/)
    await expect(wh.verify({ headers: {}, body })).rejects.toThrow(/missing/)
    // Rotation: any matching h1 is enough.
    const rotated = `ts=${ts};h1=${'0'.repeat(64)};h1=${sign(body, ts)['paddle-signature'].split('h1=')[1]}`
    await expect(wh.verify({ headers: { 'paddle-signature': rotated }, body })).resolves.toBeUndefined()
    // Wider tolerance is configurable.
    expect(() => verifyPaddleSignature({ headers: sign(body, ts - 60), body }, { secret: WH_SECRET, toleranceSeconds: 300, clock })).not.toThrow()
  })

  it('interprets transaction/subscription/adjustment events as sync', () => {
    const ref = paddleWebhookRef(WH_SECRET)
    const w = (event_type: string) => interpretPaddleWebhook({ headers: {}, body: JSON.stringify({ event_id: 'evt_1', event_type, data: {} }) }, ref)
    expect(w('transaction.completed')).toEqual({ action: 'sync', dedupeKey: 'paddle:evt_1', reason: 'transaction.completed', match: { field: 'webhookRef', value: ref } })
    expect(w('subscription.canceled').action).toBe('sync')
    expect(w('adjustment.updated').action).toBe('sync')
    expect(w('customer.created').action).toBe('ignore')
    expect(interpretPaddleWebhook({ headers: {}, body: 'nope' }, ref).action).toBe('ignore')
    expect(make().connector.webhook).toBeUndefined()
  })
})
