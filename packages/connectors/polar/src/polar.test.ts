import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn, SubscriptionUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync, type Clock } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { POLAR_SCOPES, classifyPolarError, createPolarConnector, type PolarConnectorOptions, type PolarSecret } from './index.ts'

type Page = { items: unknown[]; pagination: { total_count: number; max_page: number } }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/polar.json', import.meta.url), 'utf8')) as {
  organizations: Page
  orders: Record<string, Page>
  refunds: Page
  disputes: Page
  subscriptions: Page
}

const conn: ConnectionRef = {
  id: 'conn_polar',
  workspaceId: 'ws1',
  connectorKey: 'polar',
  secret: { token: 'polar_oat_redacted_0000' },
  config: { environment: 'sandbox', organizationId: 'org_1' },
}

const API = '/v1'
const at = (p: string) => (u: URL) => u.pathname === `${API}${p}`

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: at('/organizations/'), respond: { json: fx.organizations } },
    {
      match: at('/orders/'),
      respond: (u) => ({ json: u.searchParams.has('created_after') ? fx.orders.incremental : fx.orders[u.searchParams.get('page') ?? '1'] }),
    },
    { match: at('/refunds/'), respond: { json: fx.refunds } },
    { match: at('/disputes/'), respond: { json: fx.disputes } },
    { match: at('/subscriptions/'), respond: { json: fx.subscriptions } },
  ]
}

function make(extra: FixtureRoute[] = [], opts: PolarConnectorOptions = {}, clock: Clock & { t: number } = fakeClock()) {
  const f = fixtureFetch(routes(extra))
  const saved: unknown[] = []
  const connector = createPolarConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, saved }
}

const find = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as T | undefined

describe('polar contract', () => {
  it('passes the connector contract', async () => {
    const report = await runConnectorContract({
      make: () => make(),
      signs: { ord_1: '+', ord_4: '+', ref_1: '-', ref_0: '-', dsp_1: '-', dsp_2: '-' },
      minEvents: 19,
    })
    expect(report.pages).toBe(5)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('polar ledger rows', () => {
  it('a paid order: gross is the pre-tax amount after discounts, fee is Polar’s, net = gross − fee', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('ord_1')).toMatchObject({
      kind: 'charge',
      accountExternalId: 'polar:sandbox:org_1:USD',
      gross: { minor: 1000, currency: 'USD' },
      fee: { minor: 90, currency: 'USD' },
      net: { minor: 910, currency: 'USD' },
      customer: 'cus_ord_1',
      counterparty: 'Ada Example',
      at: '2026-09-01T10:00:00.000Z',
    })
    // A fully refunded order was still paid: its charge stays, the refund is its own row.
    expect(t('ord_4')).toMatchObject({ gross: { minor: 5000 }, fee: { minor: 250 }, net: { minor: 4750 } })
    // Not paid yet, or free: nothing.
    expect(t('ord_3')).toBeUndefined()
    expect(t('ord_5')).toBeUndefined()
  })

  it('a fee Polar states in another currency is its own fee row on that currency’s balance', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('ord_2')).toMatchObject({ accountExternalId: 'polar:sandbox:org_1:EUR', gross: { minor: 2000, currency: 'EUR' }, fee: { minor: 0 }, net: { minor: 2000 }, counterparty: 'buyer@example.com' })
    expect(t('ord_2:fee')).toMatchObject({ kind: 'fee', accountExternalId: 'polar:sandbox:org_1:USD', gross: { minor: 0, currency: 'USD' }, fee: { minor: 160 }, net: { minor: -160 }, sourceExternalId: 'ord_2' })
    const accounts = events.filter((e): e is AccountUpsert => e.type === 'account.upsert')
    expect(accounts.map((a) => [a.externalId, a.accountType, a.currency])).toEqual([
      ['polar:sandbox:org_1:EUR', 'processor_balance', 'EUR'],
      ['polar:sandbox:org_1:USD', 'processor_balance', 'USD'],
    ])
  })

  it('refunds: succeeded only, tax excluded, Polar’s fee not returned', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('ref_1')).toMatchObject({ kind: 'refund', gross: { minor: -5000 }, fee: { minor: 0 }, net: { minor: -5000 }, sourceExternalId: 'ord_4' })
    expect(t('ref_2')).toBeUndefined()
  })

  it('disputes: $15 once opened whatever the outcome, plus the disputed amount when lost; prevented ones cost nothing', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => find<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('dsp_1')).toMatchObject({ kind: 'dispute', gross: { minor: -1000, currency: 'USD' }, fee: { minor: 1500 }, net: { minor: -2500 } })
    expect(t('dsp_2')).toMatchObject({ gross: { minor: 0 }, fee: { minor: 1500 }, net: { minor: -1500 } })
    expect(t('dsp_3')).toBeUndefined()
    // A EUR dispute still open: only the (USD) fee so far.
    expect(t('dsp_4:fee')).toMatchObject({ accountExternalId: 'polar:sandbox:org_1:USD', fee: { minor: 1500, currency: 'USD' }, net: { minor: -1500 } })
    expect(t('dsp_4')).toBeUndefined()
  })
})

describe('polar MRR', () => {
  it('monthly-normalized after discounts still in effect; only active and past_due count', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const mrr = (id: string) => find<SubscriptionUpsert>(events, 'subscription.upsert', id)?.mrr.minor
    expect(mrr('sub_m')).toBe(750) // 10.00 − 25% forever
    expect(mrr('sub_y')).toBe(1000) // 120.00 a year; its 3-month discount ended in April
    expect(mrr('sub_y2')).toBe(900) // (120.00 − 12.00) / 12 while the 12-month discount runs
    expect(mrr('sub_t')).toBe(0)
    expect(mrr('sub_c')).toBe(0)
    expect(mrr('sub_w')).toBe(1083) // 5.00 every 2 weeks × 52 / 24 = 10.83
    expect(mrr('sub_once')).toBe(2000) // a once-only discount doesn't recur
    expect(mrr('sub_seats')).toBe(3000) // Polar's amount already covers every seat
    expect(find<SubscriptionUpsert>(events, 'subscription.upsert', 'sub_seats')).toMatchObject({
      status: 'active',
      interval: 'month',
      intervalCount: 1,
      customer: 'cus_sub_seats',
      items: [{ priceExternalId: 'price_sub_seats', product: 'prod_sub_seats', quantity: 3, amount: { minor: 3000, currency: 'USD' } }],
    })
    expect(find<SubscriptionUpsert>(events, 'subscription.upsert', 'sub_c')).toMatchObject({ status: 'canceled', endedAt: '2026-09-15T00:00:00.000Z' })
  })
})

describe('polar sync cycles', () => {
  it('the next cycle reads orders created since the last one (less 30 days) and stops at older refunds', async () => {
    const { connector, calls, clock } = make()
    const first = await runSync(connector, conn, null)
    clock.t += 86_400_000
    const again = await runSync(connector, conn, first.cursor)
    const orderCalls = calls.filter((c) => new URL(c.url).pathname === `${API}/orders/`).map((c) => new URL(c.url).searchParams)
    expect(orderCalls.at(-1)?.get('created_after')).toBe('2026-09-09T12:00:00.000Z')
    expect(orderCalls.every((q) => q.get('organization_id') === 'org_1' && q.get('sorting') === 'created_at')).toBe(true)
    const ids = again.events.filter((e) => e.type === 'processor.balance_txn').map((e) => e.externalId)
    // ref_1 and ref_0 are older than the window; disputes are re-read every cycle.
    expect(ids).not.toContain('ref_1')
    expect(ids).toContain('dsp_1')
    // Balance accounts are emitted once per connection.
    expect(again.events.filter((e) => e.type === 'account.upsert')).toEqual([])
  })
})

describe('polar connect', () => {
  const app = { clientId: 'polar_ci_test', clientSecret: 'polar_cs_test_0000', redirectUri: 'https://app.example.test/api/connectors/polar/callback' }
  const tokenRoute = (scope: string): FixtureRoute => ({
    match: (u) => u.pathname === '/v1/oauth2/token',
    respond: { json: { token_type: 'Bearer', access_token: 'polar_at_test_0001', refresh_token: 'polar_rt_test_0001', expires_in: 864000, scope } },
  })

  it('sign-in: asks for read scopes only; each organization becomes a connection sharing the token', async () => {
    const two = { items: [{ id: 'org_b', name: 'Beta Co' }, { id: 'org_a', name: 'Alpha Co' }], pagination: { total_count: 2, max_page: 1 } }
    const { connector, calls } = make([tokenRoute(POLAR_SCOPES.join(' ')), { match: at('/organizations/'), respond: { json: two } }], { oauth: app })
    const begin = await connector.begin({ state: 'st_1' })
    expect(begin.kind).toBe('oauth')
    const url = new URL((begin as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://polar.sh/oauth2/authorize')
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(POLAR_SCOPES)
    expect(POLAR_SCOPES.every((s) => s.endsWith(':read'))).toBe(true)
    const r = await connector.connect({ code: 'code_1' })
    expect(r.config).toMatchObject({ environment: 'production', organizationId: 'org_a', displayName: 'Polar · Alpha Co' })
    expect(r.additional?.map((a) => a.config.organizationId)).toEqual(['org_b'])
    expect(r.config.sharedSecretKey).toBeTruthy()
    expect(r.additional?.[0]?.config.sharedSecretKey).toBe(r.config.sharedSecretKey)
    expect((r.secret as { tokens: { accessToken: string } }).tokens.accessToken).toBe('polar_at_test_0001')
    expect(calls.some((c) => new URL(c.url).pathname === '/v1/orders/' && new URL(c.url).searchParams.get('organization_id') === 'org_a')).toBe(true)
  })

  it('sign-in without every read scope is refused', async () => {
    const { connector } = make([tokenRoute('orders:read')], { oauth: app })
    await expect(connector.connect({ code: 'code_1' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('a pasted organization token (self-host), refused on hosted', async () => {
    const { connector } = make()
    const begin = await connector.begin({ state: 'st' })
    expect(begin).toMatchObject({ kind: 'api_key', placeholder: 'polar_oat_…' })
    const r = await connector.connect({ token: 'polar_oat_redacted_0000', environment: 'sandbox' })
    expect(r.config).toMatchObject({ environment: 'sandbox', organizationId: 'org_1', displayName: 'Polar · Example Labs' })
    const hosted = make([], { oauth: app, hosted: true })
    await expect(hosted.connector.connect({ token: 'polar_oat_redacted_0000' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('renews an access token close to expiry on sync and saves the new pair first', async () => {
    const renewed = { match: (u: URL) => u.pathname === '/v1/oauth2/token', respond: { json: { token_type: 'Bearer', access_token: 'polar_at_test_0002', refresh_token: 'polar_rt_test_0002', expires_in: 864000 } } }
    const { connector, saved, clock } = make([renewed], { oauth: app })
    const old: PolarSecret = { tokens: { accessToken: 'polar_at_test_0001', refreshToken: 'polar_rt_test_0001', expiresAt: clock.now() + 3_600_000 } }
    const r = await connector.sync({ ...conn, secret: old }, null)
    expect((r.updatedSecret as { tokens: { accessToken: string } }).tokens.accessToken).toBe('polar_at_test_0002')
    expect(saved).toHaveLength(1)
  })
})

describe('polar errors', () => {
  it('401 and 403 are plain auth errors; 429 is rate limited', () => {
    expect(classifyPolarError(401, { error: 'Unauthorized', detail: 'x' })).toMatchObject({ kind: 'auth', forUser: true })
    expect(classifyPolarError(403, { error: 'InsufficientScope', detail: 'x' }).message).toContain('orders:read')
    expect(classifyPolarError(429, {}).kind).toBe('rate_limited')
  })

  it('health says needs_reauth on a revoked token', async () => {
    const { connector } = make([{ match: at('/orders/'), respond: { status: 401, json: { error: 'Unauthorized', detail: 'Invalid token' } } }])
    expect((await connector.health(conn)).status).toBe('needs_reauth')
  })
})
