import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  SHOPIFY_API_VERSION,
  SHOPIFY_DEGRADED_WARNING,
  SHOPIFY_NO_PAYMENTS_NOTE,
  SHOPIFY_SUMMARY_SYNC_WARNING,
  SHOPIFY_WRITE_REFUSED,
  createShopifyConnector,
  interpretShopifyWebhook,
  kindForType,
  normalizeShop,
  verifyShopifyOAuthCallback,
  type ShopifyConnectorOptions,
} from './index.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/dev-store.json', import.meta.url), 'utf8')) as {
  cost: unknown
  account: unknown
  scopes: unknown
  balance_transactions: unknown[]
  payouts: unknown[]
  access_denied: unknown
  throttled: unknown
  oauth_token: unknown
  orders_paid_webhook: unknown
}

const SHOP = 'example-store.myshopify.com'
const GQL = `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`
const conn: ConnectionRef = {
  id: 'conn_shopify',
  workspaceId: 'ws1',
  connectorKey: 'shopify',
  secret: { accessToken: 'shpat_redacted_custom_app_token_1' },
  config: { shop: SHOP, shopName: 'Example Store', balanceTransactions: true, warnings: [] },
}

/** Relay-style paging simulated from variables: after = "c:<offset>". */
function connection(rows: unknown[], vars: { first?: number; after?: string | null }) {
  const off = vars.after ? Number(vars.after.slice(2)) : 0
  const first = vars.first ?? 100
  const nodes = rows.slice(off, off + first)
  return { nodes, pageInfo: { hasNextPage: off + first < rows.length, endCursor: nodes.length ? `c:${off + nodes.length}` : null } }
}

type Gql = { query: string; variables?: { first?: number; after?: string | null } }
type Override = (q: Gql) => FixtureResponse | undefined

function routes(override?: Override): FixtureRoute[] {
  return [
    { method: 'POST', match: '/admin/oauth/access_token', respond: { json: fx.oauth_token } },
    {
      method: 'POST',
      match: GQL,
      respond: (_u, body) => {
        const q = body as Gql
        const o = override?.(q)
        if (o) return o
        const ok = (data: unknown) => ({ json: { data, extensions: { cost: fx.cost } } })
        if (q.query.includes('AggregateAccount')) return ok(fx.account)
        if (q.query.includes('AggregateScopes')) return ok(fx.scopes)
        if (q.query.includes('AggregateBalanceTxns')) return ok({ shopifyPaymentsAccount: { balanceTransactions: connection(fx.balance_transactions, q.variables ?? {}) } })
        if (q.query.includes('AggregatePayouts')) return ok({ shopifyPaymentsAccount: { payouts: connection(fx.payouts, q.variables ?? {}) } })
        return { json: { errors: [{ message: 'unknown query', extensions: { code: 'BAD_USER_INPUT' } }] } }
      },
    },
  ]
}

const OPTS: ShopifyConnectorOptions = { clientId: 'shopify-client-id', clientSecret: 'shopify-app-secret', pageSize: 3 }

function make(override?: Override, opts: ShopifyConnectorOptions = OPTS) {
  const f = fixtureFetch(routes(override))
  const clock = fakeClock()
  const connector = createShopifyConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const txn = (events: NormalizedEvent[], id: string) =>
  events.find((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.externalId === id)
const BT = (n: number) => `gid://shopify/ShopifyPaymentsBalanceTransaction/${n}`
const PO = (n: number) => `gid://shopify/ShopifyPaymentsPayout/${n}`
const denied: Override = (q) => (q.query.includes('AggregateBalanceTxns') ? { json: fx.access_denied } : undefined)

describe('shopify contract', () => {
  it('passes the connector contract', async () => {
    await runConnectorContract({
      make: () => make(),
      signs: { [BT(108)]: '+', [BT(107)]: '-', [BT(104)]: '-', [BT(102)]: '-', [PO(9001)]: '-' },
      minEvents: 11,
    })
  })

  it('passes the contract in degraded (payout summary) mode', async () => {
    await runConnectorContract({ make: () => make(denied), signs: { [`${PO(9001)}#charges`]: '+', [`${PO(9001)}#adjustments`]: '-' }, minEvents: 8 })
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('shopify mapping', () => {
  it('maps balance to a processor_balance account and snapshot', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(events.find((e): e is AccountUpsert => e.type === 'account.upsert')).toMatchObject({ externalId: `${SHOP}:USD`, accountType: 'processor_balance', institution: 'Shopify Payments' })
    expect(events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot')).toMatchObject({ externalId: `${SHOP}:USD@2026-10-09`, current: { minor: 43210, currency: 'USD' }, at: '2026-10-09T12:00:00.000Z' })
  })

  it('maps balance transactions with golden values; skips test rows and the payout transfer row', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, BT(108))).toMatchObject({ kind: 'charge', gross: { minor: 5000 }, fee: { minor: 175 }, net: { minor: 4825 }, sourceExternalId: '5001', at: '2026-10-08T14:00:00.000Z' })
    expect(txn(events, BT(108))?.payoutExternalId).toBeUndefined()
    expect(txn(events, BT(107))).toMatchObject({ kind: 'refund', gross: { minor: -2000 }, fee: { minor: 0 }, net: { minor: -2000 } })
    expect(txn(events, BT(105))).toMatchObject({ kind: 'charge', net: { minor: 97070 }, payoutExternalId: PO(9001) })
    expect(txn(events, BT(104))).toMatchObject({ kind: 'dispute', gross: { minor: -4000 }, fee: { minor: 1500 }, net: { minor: -5500 } })
    expect(txn(events, BT(102))).toMatchObject({ kind: 'fee', net: { minor: -850 } })
    expect(txn(events, BT(101))).toMatchObject({ net: { minor: 9680 }, payoutExternalId: PO(8001) })
    expect(txn(events, BT(103))).toBeUndefined()
    expect(txn(events, BT(106))).toBeUndefined()
    // Payouts: negative; failed → zero. Rows settled by payout 9001 add up to it.
    expect(txn(events, PO(9001))).toMatchObject({ kind: 'payout', gross: { minor: -90720 }, fee: { minor: 0 }, net: { minor: -90720 }, payoutExternalId: PO(9001), at: '2026-10-03T06:00:00.000Z' })
    expect(txn(events, PO(9002))?.net.minor).toBe(0)
    const settled = events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.payoutExternalId === PO(9001) && e.kind !== 'payout')
    expect(settled.reduce((s, e) => s + e.net.minor, 0)).toBe(90720)
    // No summary rows when balance transactions are readable.
    expect(events.some((e) => e.externalId.includes('#'))).toBe(false)
  })

  it('kinds', () => {
    expect(['CHARGE', 'REFUND_FAILURE', 'DISPUTE_REVERSAL', 'CHARGEBACK_FEE', 'STRIPE_FEE', 'SHIPPING_LABEL_ADJUSTMENT', 'CURRENCY_CONVERSION', 'RESERVED_FUNDS', 'TRANSFER', 'VAT_REFUND_CREDIT'].map(kindForType)).toEqual([
      'charge', 'refund', 'dispute', 'fee', 'fee', 'fee', 'transfer', 'adjustment', 'payout', 'other',
    ])
  })

  it('access-denied balanceTransactions degrades to payout summaries', async () => {
    const { connector } = make(denied)
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
    expect(r.events.some((e) => e.externalId.startsWith(BT(0).slice(0, -1)))).toBe(false)
    expect(txn(r.events, `${PO(9001)}#charges`)).toMatchObject({ kind: 'charge', gross: { minor: 100000 }, fee: { minor: 2930 }, net: { minor: 97070 }, payoutExternalId: PO(9001) })
    expect(txn(r.events, `${PO(9001)}#adjustments`)).toMatchObject({ kind: 'adjustment', gross: { minor: -4850 }, fee: { minor: 1500 }, net: { minor: -6350 } })
    expect(txn(r.events, `${PO(9001)}#refunds`)).toBeUndefined()
    // Failed payouts contribute no summary rows.
    expect(txn(r.events, `${PO(9002)}#charges`)).toBeUndefined()
  })

  it('uses only payout summaries when connect recorded balanceTransactions=false', async () => {
    const { connector, calls } = make()
    const r = await runSync(connector, { ...conn, config: { ...conn.config, balanceTransactions: false } }, null)
    expect(calls.some((c) => (c.body as Gql).query?.includes('AggregateBalanceTxns'))).toBe(false)
    expect(txn(r.events, `${PO(8001)}#charges`)?.net.minor).toBe(9680)
  })

  it('warns on the page where payout summaries replace balance transactions', async () => {
    const collect = async (c: ConnectionRef, connector: ReturnType<typeof make>['connector']) => {
      const out: Array<string[] | undefined> = []
      let cursor: string | null = null
      for (;;) {
        const r = await connector.sync(c, cursor)
        out.push(r.warnings)
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return out
    }
    const denied1 = await collect(conn, make(denied).connector)
    expect(denied1[1]).toEqual([SHOPIFY_SUMMARY_SYNC_WARNING])
    expect(denied1.filter(Boolean)).toHaveLength(1)
    const known = await collect({ ...conn, config: { ...conn.config, balanceTransactions: false } }, make().connector)
    expect(known[0]).toEqual([SHOPIFY_SUMMARY_SYNC_WARNING])
    expect(known.filter(Boolean)).toHaveLength(1)
    expect((await collect(conn, make().connector)).every((w) => w === undefined)).toBe(true)
  })

  it('next cycle re-reads 35 days (payout links and late payout failures arrive after the sale), then stops', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const second = await runSync(connector, conn, first.cursor)
    expect(txn(second.events, BT(108))).toBeDefined()
    expect(txn(second.events, BT(107))).toBeDefined()
    // Days older than the last cycle but within 35 days come again, so a payout id assigned since is picked up.
    expect(txn(second.events, BT(105))).toBeDefined()
    // Newest-first walk stops at the first page that reaches older rows: never more pages than the first cycle read.
    const isTxns = (c: (typeof calls)[number]) => (c.body as Gql).query.includes('AggregateBalanceTxns')
    expect(calls.slice(n).filter(isTxns).length).toBeLessThanOrEqual(calls.slice(0, n).filter(isTxns).length)
  })

  it('sends the access token header, pinned API version, reads only', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(calls.every((c) => c.url === `https://${SHOP}${GQL}` && c.headers['x-shopify-access-token'] === 'shpat_redacted_custom_app_token_1')).toBe(true)
    expect(calls.every((c) => /^\s*query /.test((c.body as Gql).query))).toBe(true)
  })
})

describe('shopify errors', () => {
  it('GraphQL THROTTLED (HTTP 200) waits for the bucket and retries', async () => {
    let n = 0
    const { connector, clock } = make((q) => (q.query.includes('AggregateAccount') && n++ === 0 ? { json: fx.throttled } : undefined))
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBe(2)
    // (52 requested − 10 available) / 100 per second = 420 ms.
    expect(clock.sleeps).toEqual([420])
  })

  it('persistent THROTTLED becomes rate_limited', async () => {
    const { connector } = make(() => ({ json: fx.throttled }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'rate_limited', code: 'THROTTLED' })
  })

  it('ACCESS_DENIED elsewhere is auth naming the scope', async () => {
    const { connector } = make((q) =>
      q.query.includes('AggregateAccount')
        ? { json: { errors: [{ message: 'Access denied for shopifyPaymentsAccount field. Required access: `read_shopify_payments_accounts` access scope.', path: ['shopifyPaymentsAccount'], extensions: { code: 'ACCESS_DENIED' } }], data: { shopifyPaymentsAccount: null } } }
        : undefined,
    )
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'ACCESS_DENIED', message: expect.stringContaining('read_shopify_payments_accounts') })
    expect((await connector.health(conn)).status).toBe('needs_reauth')
  })

  it('HTTP 401 is auth; health needs_reauth; ok otherwise', async () => {
    const { connector } = make(() => ({ status: 401, json: { errors: '[API] Invalid API key or access token (unrecognized login or wrong password)' } }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect((await connector.health(conn)).status).toBe('needs_reauth')
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('HTTP 429 retried after Retry-After', async () => {
    let n = 0
    const { connector, clock } = make(() => (n++ === 0 ? { status: 429, headers: { 'retry-after': '2' }, json: { errors: 'Exceeded 2 calls per second' } } : undefined))
    await runSync(connector, conn, null, { maxPages: 1 })
    expect(clock.sleeps).toContain(2000)
  })

  it('a store without Shopify Payments connects (OAuth, uninstall hook), syncs nothing yet, and picks payouts up once Payments is on', async () => {
    let payments = false
    const noPayments = (q: Gql) => (q.query.includes('AggregateAccount') && !payments ? { json: { data: { shop: { name: 'Review Store', currencyCode: 'USD' }, shopifyPaymentsAccount: null } } } : q.query.includes('webhookSubscriptionCreate') ? { json: { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'w1' }, userErrors: [] } } } } : undefined)
    const { connector, calls } = make(noPayments, { ...OPTS, webhookUrl: 'https://app.example.com/api/webhooks/shopify' })
    const q: Record<string, string> = { code: 'oauth-code-1', shop: SHOP, state: 'st8', timestamp: '1791547200' }
    const hmac = createHmac('sha256', OPTS.clientSecret!).update(Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')).digest('hex')
    const out = await connector.connect({ query: { ...q, hmac } })
    expect(out.secret).toEqual({ accessToken: 'shpua_redacted_offline_token_1' })
    expect(out.config).toMatchObject({ shop: SHOP, shopName: 'Review Store', displayName: 'Shopify · Review Store', warnings: [SHOPIFY_NO_PAYMENTS_NOTE] })
    expect(calls.some((c) => JSON.stringify(c.body).includes('webhookSubscriptionCreate'))).toBe(true)

    const live = { ...conn, secret: out.secret, config: out.config }
    // Nothing to show, nothing "gone": no events, the note as a warning, and health is ok with the same note.
    const first = await connector.sync(live, null)
    expect(first).toMatchObject({ events: [], hasMore: false, warnings: [SHOPIFY_NO_PAYMENTS_NOTE] })
    expect(await connector.health(live)).toEqual({ status: 'ok', message: SHOPIFY_NO_PAYMENTS_NOTE })

    // Payments turned on: the next sync creates the balance account and goes on to the payouts.
    payments = true
    const next = await runSync(connector, live, first.cursor)
    expect(next.events.some((e) => e.type === 'account.upsert')).toBe(true)
    expect(next.events.some((e) => e.type === 'txn.upsert' || e.type === 'balance.snapshot')).toBe(true)
    expect(await connector.health(live)).toEqual({ status: 'ok' })
  })

  it('malformed stored secret is auth; bad shop is invalid_input', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: {} }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.sync({ ...conn, config: { shop: 'evil.example.com' } }, null)).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('refreshes an expiring offline token and returns updatedSecret', async () => {
    const { connector, calls, clock } = make()
    const expiring = { ...conn, secret: { accessToken: 'shpat_old_expiring_token_01', refreshToken: 'shprt_redacted_1', expiresAt: clock.now() + 60_000 } }
    const page = await connector.sync(expiring, null)
    expect(page.updatedSecret).toMatchObject({ accessToken: 'shpua_redacted_offline_token_1', refreshToken: 'shprt_redacted_1' })
    expect(calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'shprt_redacted_1', client_id: OPTS.clientId })
  })
})

describe('shopify connect and begin', () => {
  it('normalizes shop domains', () => {
    expect(normalizeShop('https://Example-Store.myshopify.com/admin')).toBe(SHOP)
    expect(normalizeShop('example.com')).toBeUndefined()
  })

  it('custom-app token: verifies with a read, probes balance transactions and scopes', async () => {
    const { connector } = make()
    const out = await connector.connect({ shop: 'Example-Store.myshopify.com', accessToken: 'shpat_redacted_custom_app_token_1' })
    expect(out.secret).toEqual({ accessToken: 'shpat_redacted_custom_app_token_1' })
    expect(out.config).toEqual({ shop: SHOP, shopName: 'Example Store', displayName: 'Shopify · Example Store', balanceTransactions: true, warnings: [] })
  })

  it('warns on access-denied balance transactions and on write scopes', async () => {
    const { connector } = make((q) => {
      if (q.query.includes('AggregateBalanceTxns')) return { json: fx.access_denied }
      if (q.query.includes('AggregateScopes')) return { json: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_orders' }] } } } }
      return undefined
    })
    const out = await connector.connect({ shop: SHOP, accessToken: 'shpat_redacted_custom_app_token_1' })
    expect(out.config.balanceTransactions).toBe(false)
    expect(out.config.warnings).toEqual([SHOPIFY_DEGRADED_WARNING, expect.stringContaining('write_orders')])
  })

  it('hosted: refuses a store app that can write, accepts a read-only one', async () => {
    const writes = (q: { query: string }) =>
      q.query.includes('AggregateScopes') ? { json: { data: { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'write_orders' }] } } } } : undefined
    const hosted = make(writes, { ...OPTS, hosted: true }).connector
    await expect(hosted.connect({ shop: SHOP, accessToken: 'shpat_redacted_custom_app_token_1' })).rejects.toMatchObject({ message: SHOPIFY_WRITE_REFUSED(['write_orders']) })
    const ok = await make(undefined, { ...OPTS, hosted: true }).connector.connect({ shop: SHOP, accessToken: 'shpat_redacted_custom_app_token_1' })
    expect(ok.config.warnings).toEqual([])
  })

  it('OAuth callback: validates the hmac, then exchanges the code', async () => {
    const q: Record<string, string> = { code: 'oauth-code-1', shop: SHOP, state: 'st8', timestamp: '1791547200', host: 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZXhhbXBsZQ' }
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')
    const hmac = createHmac('sha256', OPTS.clientSecret!).update(msg).digest('hex')
    const { connector, calls } = make()
    const out = await connector.connect({ query: { ...q, hmac } })
    expect(out.secret).toEqual({ accessToken: 'shpua_redacted_offline_token_1' })
    expect(calls[0]?.url).toBe(`https://${SHOP}/admin/oauth/access_token`)
    // expiring=1: an expiring offline token (required for new public apps).
    expect(calls[0]?.body).toMatchObject({ code: 'oauth-code-1', client_id: OPTS.clientId, client_secret: OPTS.clientSecret, expiring: '1' })
    await expect(make().connector.connect({ query: { ...q, shop: 'other-store.myshopify.com', hmac } })).rejects.toMatchObject({ kind: 'auth' })
    expect(() => verifyShopifyOAuthCallback({ ...q }, OPTS.clientSecret!)).toThrow(/no hmac/)
  })

  it('OAuth install subscribes app/uninstalled for that shop; "already taken" and failures never fail the connect', async () => {
    const q: Record<string, string> = { code: 'oauth-code-1', shop: SHOP, state: 'st8', timestamp: '1791547200' }
    const hmac = createHmac('sha256', OPTS.clientSecret!).update(Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')).digest('hex')
    const opts = { ...OPTS, webhookUrl: 'https://app.example.com/api/webhooks/shopify' }
    const sub = (respond: FixtureResponse) => (g: Gql) => (g.query.includes('webhookSubscriptionCreate') ? respond : undefined)
    const ok = make(sub({ json: { data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'gid://shopify/WebhookSubscription/1' }, userErrors: [] } } } }), opts)
    await ok.connector.connect({ query: { ...q, hmac } })
    const call = ok.calls.find((c) => JSON.stringify(c.body).includes('webhookSubscriptionCreate'))
    expect(call?.headers['x-shopify-access-token']).toBe('shpua_redacted_offline_token_1')
    expect((call?.body as Gql & { variables: Record<string, unknown> }).variables).toEqual({ callbackUrl: 'https://app.example.com/api/webhooks/shopify' })
    expect((call?.body as Gql).query).toMatch(/topic: APP_UNINSTALLED[\s\S]*format: JSON/)

    const taken = make(sub({ json: { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ['webhookSubscription', 'callbackUrl'], message: 'Address for this topic has already been taken' }] } } } }), opts)
    await expect(taken.connector.connect({ query: { ...q, hmac } })).resolves.toMatchObject({ config: { shop: SHOP } })
    const down = make(sub({ status: 500, json: {} }), opts)
    await expect(down.connector.connect({ query: { ...q, hmac } })).resolves.toMatchObject({ config: { shop: SHOP } })
    // A pasted Admin API token (self-host custom app) never subscribes: that app manages its own webhooks.
    const pasted = make(undefined, opts)
    await pasted.connector.connect({ shop: SHOP, accessToken: 'shpat_redacted_custom_app_token_1' })
    expect(pasted.calls.some((c) => JSON.stringify(c.body).includes('webhookSubscriptionCreate'))).toBe(false)
  })

  it('validates input', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ shop: 'example.com', accessToken: 'shpat_redacted_custom_app_token_1' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ shop: SHOP })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('begin: OAuth URL on re-auth (shop known), key guidance for a new store', async () => {
    const { connector } = make()
    const ctx = { workspaceId: 'ws1', redirectUri: 'https://agfn.example.com/api/connectors/shopify/callback', state: 'st8', userRef: 'u1' }
    const paste = await connector.begin(ctx)
    expect(paste).toMatchObject({ kind: 'api_key', permissions: ['read_shopify_payments_payouts', 'read_shopify_payments_accounts'] })
    expect((paste as { fields: Array<{ name: string }> }).fields.map((f) => f.name)).toEqual(['shop', 'clientId', 'clientSecret'])
    const b = await connector.begin({ ...ctx, connection: conn })
    expect(b.kind).toBe('oauth')
    const u = new URL((b as { url: string }).url)
    expect(u.origin + u.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`)
    expect(u.searchParams.get('client_id')).toBe(OPTS.clientId)
    expect(u.searchParams.get('scope')).toBe('read_shopify_payments_payouts,read_shopify_payments_accounts')
    expect(u.searchParams.get('state')).toBe('st8')
    expect(u.searchParams.get('redirect_uri')).toBe(ctx.redirectUri)
  })
})

describe('shopify sign-in tokens', () => {
  it("connects with the store owner's own app (client credentials) and fetches a new token when it expires", async () => {
    let n = 0
    const f = fixtureFetch([{ method: 'POST', match: '/admin/oauth/access_token', respond: () => ({ json: { access_token: `shpca_owner_token_${++n}_padding`, scope: 'read_shopify_payments_payouts', expires_in: 86399 } }) }, ...routes()])
    const clock = fakeClock()
    const connector = createShopifyConnector({ pageSize: 3 }, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
    const calls = f.calls
    const out = await connector.connect({ shop: SHOP, clientId: 'owner-app-id', clientSecret: 'owner-app-secret' })
    expect(out.secret).toMatchObject({ accessToken: 'shpca_owner_token_1_padding', appClientId: 'owner-app-id', appClientSecret: 'owner-app-secret', expiresAt: expect.any(Number) })
    expect(calls[0]?.body).toMatchObject({ grant_type: 'client_credentials', client_id: 'owner-app-id', client_secret: 'owner-app-secret' })
    // A day later the token is fetched again with the same app credentials, and saved.
    clock.t += 86_400_000
    const page = await connector.sync({ ...conn, secret: out.secret, config: out.config }, null)
    expect(page.updatedSecret).toMatchObject({ accessToken: 'shpca_owner_token_2_padding' })
  })

})

describe('shopify webhooks', () => {
  const body = JSON.stringify(fx.orders_paid_webhook)
  const sign = (b: string, secret = OPTS.clientSecret!) => createHmac('sha256', secret).update(b).digest('base64')
  const headers = (b: string, topic = 'orders/paid') => ({
    'x-shopify-hmac-sha256': sign(b), 'x-shopify-topic': topic, 'x-shopify-shop-domain': SHOP, 'x-shopify-event-id': 'evt-1',
  })

  it('accepts a valid signature', async () => {
    await expect(make().connector.webhook!.verify({ headers: headers(body), body })).resolves.toBeUndefined()
  })

  it('rejects tampered body, wrong secret and missing header (no signed timestamp, so no staleness check)', async () => {
    const wh = make().connector.webhook!
    await expect(wh.verify({ headers: headers(body), body: body.replace('50.00', '5000.00') })).rejects.toMatchObject({ kind: 'auth' })
    await expect(wh.verify({ headers: { ...headers(body), 'x-shopify-hmac-sha256': sign(body, 'other') }, body })).rejects.toThrow(/signature/)
    await expect(wh.verify({ headers: {}, body })).rejects.toThrow(/missing/)
  })

  it('webhookSecret overrides the app secret; none configured → no webhook', async () => {
    const custom = make(undefined, { webhookSecret: 'admin-webhook-secret' }).connector
    await expect(custom.webhook!.verify({ headers: { 'x-shopify-hmac-sha256': sign(body, 'admin-webhook-secret') }, body })).resolves.toBeUndefined()
    expect(make(undefined, {}).connector.webhook).toBeUndefined()
  })

  it('interprets topics, matched on the shop domain', () => {
    expect(interpretShopifyWebhook({ headers: headers(body), body })).toEqual({ action: 'sync', dedupeKey: 'shopify:evt-1', reason: 'orders/paid', match: { field: 'shop', value: SHOP } })
    const t = (topic: string) => interpretShopifyWebhook({ headers: headers('{}', topic), body: '{}' }).action
    expect(t('app/uninstalled')).toBe('disconnected')
    expect(t('payouts/update')).toBe('sync')
    expect(t('refunds/create')).toBe('sync')
    expect(t('products/update')).toBe('ignore')
    // Mandatory privacy webhooks: no customer data held; the store's data is erased on shop/redact.
    expect(t('customers/data_request')).toBe('ignore')
    expect(t('customers/redact')).toBe('ignore')
    expect(t('shop/redact')).toBe('erase')
  })
})

describe('shopify install from Shopify', () => {
  const signed = (q: Record<string, string>): Record<string, string> => {
    const msg = Object.keys(q).sort().map((k) => `${k}=${q[k]}`).join('&')
    return { ...q, hmac: createHmac('sha256', OPTS.clientSecret!).update(msg).digest('hex') }
  }

  it('verifies the signed install link and builds the consent URL for that shop', () => {
    const { connector, clock } = make()
    const now = Math.floor(clock.now() / 1000)
    expect(connector.verifyInstall!(signed({ shop: SHOP, timestamp: String(now), host: 'abc' }))).toBe(SHOP)
    expect(() => connector.verifyInstall!({ ...signed({ shop: SHOP, timestamp: String(now) }), shop: 'other-store.myshopify.com' })).toThrow(/hmac/)
    expect(() => connector.verifyInstall!(signed({ shop: SHOP, timestamp: String(now - 2 * 3600) }))).toThrow(/expired/)
    expect(() => connector.verifyInstall!(signed({ shop: 'evil.example.com', timestamp: String(now) }))).toThrow(/myshopify/)
    const u = new URL(connector.authorizeUrl!(SHOP, 'https://app.example/api/connectors/shopify/callback', 'st8'))
    expect(u.origin + u.pathname).toBe(`https://${SHOP}/admin/oauth/authorize`)
    expect(u.searchParams.get('scope')).toBe('read_shopify_payments_payouts,read_shopify_payments_accounts')
    expect(u.searchParams.get('state')).toBe('st8')
    expect(make(undefined, {}).connector.verifyInstall).toBeUndefined()
  })

  it('the callback signature covers state; the redirect URI comes from the server, not the query', async () => {
    const q = signed({ code: 'oauth-code-1', shop: SHOP, state: 'st8', timestamp: '1791547200' })
    const { connector } = make()
    // What the server passes: the fields minus state, plus the untouched query.
    const { state: _s, ...rest } = q
    await expect(connector.connect({ ...rest, query: q, redirectUri: 'https://app.example/api/connectors/shopify/callback' })).resolves.toMatchObject({ secret: { accessToken: expect.any(String) } })
    // Without the untouched query, the stripped state breaks the signature.
    await expect(make().connector.connect({ ...rest })).rejects.toMatchObject({ kind: 'auth' })
  })
})
