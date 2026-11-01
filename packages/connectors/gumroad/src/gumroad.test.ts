import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  GUMROAD_NOT_SET_UP,
  GUMROAD_TOKEN_REFUSED,
  GUMROAD_TOKEN_WARNING,
  classifyGumroadError,
  createGumroadConnector,
  decimalToMinor,
  gumroadPartialRefundWarning,
  gumroadPayoutCurrencyWarning,
  roundDiv,
  type GumroadConnectorOptions,
} from './index.ts'

type Pages = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/gumroad.json', import.meta.url), 'utf8')) as {
  user: unknown
  sales: Pages
  payouts: Pages
  errors: { unauthorized: unknown }
}

const conn: ConnectionRef = {
  id: 'conn_gr',
  workspaceId: 'ws1',
  connectorKey: 'gumroad',
  secret: { kind: 'oauth', accessToken: 'gr_test_token_redacted_0001' },
  config: { sellerId: 'S1ll3r' },
}
const CTX = { workspaceId: 'ws1', userRef: 'p1', state: 's', redirectUri: 'x' }
const OAUTH = { clientId: 'gr_client', clientSecret: 'gr_client_secret', redirectUri: 'https://app.example.com/api/connectors/gumroad/callback' }

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  const byKey = (pages: Pages, u: URL) => ({ json: pages[u.searchParams.get('page_key') ?? '1'] ?? { success: true, sales: [], payouts: [] } })
  return [
    ...extra,
    { match: (u) => u.pathname === '/v2/user', respond: { json: fx.user } },
    { match: (u) => u.pathname === '/v2/sales', respond: (u) => byKey(fx.sales, u) },
    { match: (u) => u.pathname === '/v2/payouts', respond: (u) => byKey(fx.payouts, u) },
  ]
}

function make(extra: FixtureRoute[] = [], opts: Omit<GumroadConnectorOptions, 'deps'> = {}, c: ConnectionRef = conn) {
  const f = fixtureFetch(routes(extra))
  const connector = createGumroadConnector({ ...opts, deps: { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() } })
  return { connector, conn: c, calls: f.calls }
}

const txn = (events: NormalizedEvent[], id: string) =>
  events.findLast((e) => e.type === 'processor.balance_txn' && e.externalId === id) as ProcessorBalanceTxn | undefined
const amounts = (t: ProcessorBalanceTxn | undefined) => t && [t.gross.minor, t.fee.minor, t.net.minor]

/** Page through one cycle by hand and return the final page's warnings (runSync doesn't keep them). */
async function lastWarnings(connector: ReturnType<typeof make>['connector'], c: ConnectionRef): Promise<string[] | undefined> {
  let cursor: string | null = null
  for (let i = 0; i < 50; i++) {
    const page = await connector.sync(c, cursor)
    if (!page.hasMore) return page.warnings
    cursor = page.cursor
  }
  throw new Error('cycle did not finish')
}

describe('gumroad contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { 'sale-1': '+', 'sale-2:refund': '-', 'sale-3:refund': '-', 'sale-5:chargeback': '-', 'payout:po-1': '-' },
      minEvents: 12,
    })
    expect(r.pages).toBe(5)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('gumroad mapping', () => {
  it('books sales in USD with Gumroad’s fee plus the affiliate cut, refunds and chargebacks as mirrors', async () => {
    const { connector, calls } = make()
    const { events, complete } = await runSync(connector, conn, null)
    expect(complete).toBe(true)
    const acct = events.find((e) => e.type === 'account.upsert') as AccountUpsert
    expect(acct).toMatchObject({ externalId: 'gumroad:S1ll3r:USD', accountType: 'processor_balance', currency: 'USD', institution: 'Gumroad', name: 'Synthetic Seller balance (Gumroad)' })
    expect(amounts(txn(events, 'sale-1'))).toEqual([1000, 120, 880])
    // Affiliate's $2.50 is part of the fee; the full refund returns it.
    expect(amounts(txn(events, 'sale-2'))).toEqual([2000, 540, 1460])
    expect(amounts(txn(events, 'sale-2:refund'))).toEqual([-2000, -540, -1460])
    // $50 sale with $30 still refundable: $20 refunded, fee share round(550 × 2000 ÷ 5000) = 220.
    expect(amounts(txn(events, 'sale-3:refund'))).toEqual([-2000, -220, -1780])
    expect(txn(events, 'sale-3:refund')).toMatchObject({ kind: 'refund', sourceExternalId: 'sale-3', at: '2026-10-03T10:00:00.000Z' })
    // EUR partial refund: amount unreadable, charge kept at full price (warned).
    expect(amounts(txn(events, 'sale-4'))).toEqual([1200, 150, 1050])
    expect(txn(events, 'sale-4:refund')).toBeUndefined()
    expect(txn(events, 'sale-5:chargeback')).toMatchObject({ kind: 'dispute', gross: { minor: -1500 }, fee: { minor: -175 }, net: { minor: -1325 } })
    // Free sales move nothing.
    expect(events.some((e) => e.externalId.startsWith('sale-6'))).toBe(false)
    // Read-only: GETs with the Bearer token, never the token in the URL.
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
    expect(calls[0]!.headers.authorization).toBe('Bearer gr_test_token_redacted_0001')
    expect(calls.some((c) => c.url.includes('gr_test_token'))).toBe(false)
  })

  it('records USD payouts leaving the balance; failed ones move nothing; other currencies and upcoming are skipped', async () => {
    const { connector, calls } = make()
    const res = await runSync(connector, conn, null)
    expect(txn(res.events, 'payout:po-1')).toMatchObject({ kind: 'payout', net: { minor: -15000, currency: 'USD' }, at: '2026-10-03T09:00:00.000Z', arrivalDate: '2026-10-03', payoutExternalId: 'po-1' })
    expect(txn(res.events, 'payout:po-2')?.net.minor).toBe(0)
    expect(txn(res.events, 'payout:po-3')).toBeUndefined()
    expect(txn(res.events, 'payout:po-4')).toMatchObject({ net: { minor: -27550 }, at: '2026-09-10T00:00:00.000Z' })
    expect(calls.filter((c) => c.url.includes('/v2/payouts')).every((c) => new URL(c.url).searchParams.get('include_upcoming') === 'false')).toBe(true)
    expect(await lastWarnings(make().connector, conn)).toEqual([gumroadPartialRefundWarning(1), gumroadPayoutCurrencyWarning(1)])
  })

  it('incremental cycles re-read 90 days of sales and 35 days of payouts before the newest sale', async () => {
    const first = make()
    const full = await runSync(first.connector, conn, null)
    const again = make()
    await runSync(again.connector, conn, full.cursor)
    const sales = again.calls.find((c) => c.url.includes('/v2/sales'))!
    const payouts = again.calls.find((c) => c.url.includes('/v2/payouts'))!
    expect(new URL(sales.url).searchParams.get('after')).toBe('2026-07-07')
    expect(new URL(payouts.url).searchParams.get('after')).toBe('2026-08-31')
  })

  it('amount helpers', () => {
    expect(decimalToMinor('$2.50')).toBe(250)
    expect(decimalToMinor('1,234.5')).toBe(123450)
    expect(decimalToMinor('150.00')).toBe(15000)
    expect(decimalToMinor('7')).toBe(700)
    expect(decimalToMinor('abc')).toBeUndefined()
    expect(roundDiv(7, 2)).toBe(4)
    expect(roundDiv(-7, 2)).toBe(-4)
    expect(roundDiv(4, 3)).toBe(1)
  })
})

describe('gumroad auth', () => {
  it('signs in with read-only scopes when Aggregate’s app is configured', async () => {
    const { connector } = make([], { oauth: OAUTH, hosted: true })
    const b = await connector.begin({ ...CTX, state: 'st8', redirectUri: OAUTH.redirectUri })
    expect(b.kind).toBe('oauth')
    const u = new URL((b as { url: string }).url)
    expect(u.origin + u.pathname).toBe('https://gumroad.com/oauth/authorize')
    expect(u.searchParams.get('scope')).toBe('view_sales view_payouts')
    expect(u.searchParams.get('state')).toBe('st8')
    expect(connector.describe().auth).toBe('oauth')
  })

  it('exchanges the code and keeps the token', async () => {
    const { connector, calls } = make([{ method: 'POST', match: (u) => u.pathname === '/oauth/token', respond: { json: { access_token: 'gr_oauth_token_redacted_01', token_type: 'Bearer', scope: 'view_sales view_payouts' } } }], { oauth: OAUTH, hosted: true })
    const r = await connector.connect({ code: 'abc' })
    expect(r.secret).toEqual({ kind: 'oauth', accessToken: 'gr_oauth_token_redacted_01' })
    expect(r.config).toMatchObject({ sellerId: 'S1ll3r', sellerName: 'Synthetic Seller', warnings: [] })
    const tok = calls.find((c) => c.url.includes('/oauth/token'))!
    expect(tok.body).toMatchObject({ grant_type: 'authorization_code', code: 'abc', client_id: 'gr_client', redirect_uri: OAUTH.redirectUri })
  })

  it('hosted refuses a generated token and needs the app', async () => {
    await expect(make([], { oauth: OAUTH, hosted: true }).connector.connect({ accessToken: 'gr_full_access_token_0001' })).rejects.toThrow(GUMROAD_TOKEN_REFUSED)
    await expect(make([], { hosted: true }).connector.begin({ ...CTX })).rejects.toThrow(GUMROAD_NOT_SET_UP)
  })

  it('self-hosted takes a generated token and says it has full access', async () => {
    const { connector } = make()
    const b = await connector.begin({ ...CTX })
    expect(b.kind).toBe('api_key')
    const r = await connector.connect({ accessToken: 'gr_full_access_token_0001' })
    expect(r.secret).toEqual({ kind: 'token', accessToken: 'gr_full_access_token_0001' })
    expect(r.config.warnings).toEqual([GUMROAD_TOKEN_WARNING])
    const tokenConn = { ...conn, secret: r.secret }
    expect((await lastWarnings(make([], {}, tokenConn).connector, tokenConn))?.at(-1)).toBe(GUMROAD_TOKEN_WARNING)
  })

  it('classifies errors and reports health', async () => {
    expect(classifyGumroadError(401, fx.errors.unauthorized)).toMatchObject({ kind: 'auth', message: 'The access token is invalid.' })
    expect(classifyGumroadError(429, {}).kind).toBe('rate_limited')
    expect(classifyGumroadError(503, {}).kind).toBe('transient')
    expect(classifyGumroadError(402, {}).kind).toBe('invalid_input')
    expect(classifyGumroadError(404, {})).toBeInstanceOf(ConnectorError)
    const bad = make([{ match: (u) => u.pathname === '/v2/user', respond: { status: 401, json: fx.errors.unauthorized } }])
    expect((await bad.connector.health(conn)).status).not.toBe('ok')
    expect((await make().connector.health(conn)).status).toBe('ok')
  })
})
