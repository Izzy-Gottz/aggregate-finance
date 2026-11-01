import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, InvoiceUpsert, NormalizedEvent, ProcessorBalanceTxn } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createPayPalConnector, interpretPayPalWebhook, kindForEventCode, PAYPAL_NO_BALANCES_WARNING, PAYPAL_NO_INVOICES_WARNING, PAYPAL_WRITE_WARNING, type PayPalConnectorOptions } from './index.ts'
import type { PayPalTransactionDetail } from './types.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox-account.json', import.meta.url), 'utf8')) as {
  token: unknown
  balances: unknown
  transactions: PayPalTransactionDetail[]
  invoice_pages: Record<string, unknown>
  webhook_event: unknown
}

const CLIENT_ID = 'AbCdEfGhIjKlMnOpQrStUvWx_sandbox01'
const conn: ConnectionRef = {
  id: 'conn_paypal',
  workspaceId: 'ws1',
  connectorKey: 'paypal',
  secret: { clientId: CLIENT_ID, clientSecret: 'test-secret' },
  config: { env: 'sandbox', accountId: 'MERCHANTSBX01', currencies: ['USD', 'EUR'], invoices: true, warnings: [] },
}

/** Simulates Transaction Search: filters the fixture rows by the requested window and pages by page/page_size. */
function searchResponder(u: URL) {
  const start = Date.parse(u.searchParams.get('start_date') ?? '')
  const end = Date.parse(u.searchParams.get('end_date') ?? '')
  if (!(end > start) || end - start > 31 * 86_400_000) {
    return { status: 400, json: { name: 'INVALID_REQUEST', message: 'Request is not well-formed, syntactically incorrect, or violates schema.', debug_id: 'dbg1' } }
  }
  const size = Number(u.searchParams.get('page_size'))
  const page = Number(u.searchParams.get('page'))
  const rows = fx.transactions.filter((t) => {
    const at = Date.parse(t.transaction_info.transaction_initiation_date ?? '')
    return at >= start && at <= end
  })
  const total_pages = Math.max(1, Math.ceil(rows.length / size))
  return { json: { transaction_details: rows.slice((page - 1) * size, page * size), account_number: 'MERCHANTSBX01', page, total_items: rows.length, total_pages } }
}

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { method: 'POST', match: '/v1/oauth2/token', respond: { json: fx.token } },
    { match: '/v1/reporting/balances', respond: { json: fx.balances } },
    { match: '/v1/reporting/transactions', respond: (u) => searchResponder(u) },
    {
      match: '/v2/invoicing/invoices',
      respond: (u) => {
        const p = fx.invoice_pages[u.searchParams.get('page') ?? '1']
        return p ? { json: p } : { json: { items: [], total_pages: 2 } }
      },
    },
  ]
}

const OPTS: PayPalConnectorOptions = { pageSize: 2 }

function make(extra: FixtureRoute[] = [], opts: PayPalConnectorOptions = OPTS) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createPayPalConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const txn = (events: NormalizedEvent[], id: string) =>
  events.find((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.externalId === id)

describe('paypal contract', () => {
  it('passes the connector contract', async () => {
    await runConnectorContract({
      make: () => make(),
      signs: { CHARGE0001AAAAAAA: '+', REFUND0001AAAAAAA: '-', WITHDRAW001AAAAAA: '-', CBFEE0001AAAAAAAA: '-', CHARGEBACK01AAAAA: '-', CONVEUR001AAAAAAA: '+' },
      minEvents: 17,
    })
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('paypal mapping', () => {
  it('maps balances to one processor_balance account per currency with snapshots', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const usd = events.find((e): e is AccountUpsert => e.type === 'account.upsert' && e.externalId === 'MERCHANTSBX01:USD')
    expect(usd).toMatchObject({ accountType: 'processor_balance', currency: 'USD', institution: 'PayPal' })
    const snap = events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot' && e.accountExternalId === 'MERCHANTSBX01:USD')
    expect(snap).toMatchObject({ externalId: 'MERCHANTSBX01:USD@2026-10-09', at: '2026-10-09T09:00:00.000Z', current: { minor: 123456, currency: 'USD' }, available: { minor: 120000 } })
    expect(events.find((e) => e.type === 'balance.snapshot' && e.accountExternalId === 'MERCHANTSBX01:EUR')).toMatchObject({ current: { minor: 10000, currency: 'EUR' } })
    // JPY has no balance row but a transaction: it still gets an account.
    expect(events.some((e) => e.type === 'account.upsert' && e.externalId === 'MERCHANTSBX01:JPY')).toBe(true)
  })

  it('maps transactions: fee sign flip, kinds, payouts, refunds', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'CHARGE0001AAAAAAA')).toMatchObject({
      kind: 'charge', gross: { minor: 10000 }, fee: { minor: 349 }, net: { minor: 9651 }, customer: 'Example Buyer LLC', at: '2026-09-15T10:00:00.000Z', accountExternalId: 'MERCHANTSBX01:USD',
    })
    // A refund returns part of the fee: negative fee.
    expect(txn(events, 'REFUND0001AAAAAAA')).toMatchObject({ kind: 'refund', gross: { minor: -2500 }, fee: { minor: -75 }, net: { minor: -2425 }, sourceExternalId: 'CHARGE0001AAAAAAA' })
    expect(txn(events, 'WITHDRAW001AAAAAA')).toMatchObject({ kind: 'payout', gross: { minor: -500000 }, fee: { minor: 0 }, net: { minor: -500000 }, payoutExternalId: 'WITHDRAW001AAAAAA' })
    expect(txn(events, 'CBFEE0001AAAAAAAA')).toMatchObject({ kind: 'fee', net: { minor: -2000 } })
    expect(txn(events, 'CHARGEBACK01AAAAA')).toMatchObject({ kind: 'dispute', net: { minor: -5000 } })
    expect(txn(events, 'CONVUSD001AAAAAAA')).toMatchObject({ kind: 'transfer', net: { minor: -11000, currency: 'USD' } })
    expect(txn(events, 'CONVEUR001AAAAAAA')).toMatchObject({ kind: 'transfer', net: { minor: 10000, currency: 'EUR' }, accountExternalId: 'MERCHANTSBX01:EUR' })
    expect(txn(events, 'JPYCHARGE01AAAAAA')).toMatchObject({ gross: { minor: 5000, currency: 'JPY' }, fee: { minor: 250 }, net: { minor: 4750 } })
    expect(txn(events, 'PENDING001AAAAAAA')).toMatchObject({ net: { minor: 3830 } })
    expect(txn(events, 'OLDCHARGE2024AAAA')).toMatchObject({ net: { minor: 921 } })
    expect(txn(events, 'DENIED0001AAAAAAA')).toBeUndefined()
  })

  it('event code families', () => {
    expect(['T0006', 'T0106', 'T0200', 'T0300', 'T0400', 'T1107', 'T1106', 'T1201', 'T1501', 'T9900', 'x'].map(kindForEventCode)).toEqual([
      'charge', 'fee', 'transfer', 'transfer', 'payout', 'refund', 'dispute', 'dispute', 'adjustment', 'other', 'other',
    ])
  })

  it('maps invoices across pages', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const inv = (id: string) => events.find((e): e is InvoiceUpsert => e.type === 'invoice.upsert' && e.externalId === id)
    expect(inv('INV2-SBX1-0001')).toMatchObject({ direction: 'receivable', number: '0001', status: 'paid', counterparty: 'Example Co', total: { minor: 50000 }, amountPaid: { minor: 50000 }, issueDate: '2026-09-01', dueDate: '2026-09-11' })
    expect(inv('INV2-SBX1-0002')).toMatchObject({ status: 'open', counterparty: 'Sample Client', total: { minor: 25000 }, amountPaid: { minor: 0, currency: 'USD' }, dueDate: '2026-10-31' })
  })

  it('walks 31-day windows over 3 years, with seconds-precision RFC 3339 params, fields=all', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    const searches = calls.filter((c) => c.url.includes('/v1/reporting/transactions')).map((c) => new URL(c.url).searchParams)
    expect(searches[0]?.get('start_date')).toBe('2023-10-10T12:00:00Z')
    expect(searches.at(-1)?.get('end_date')).toBe('2026-10-09T12:00:00Z')
    for (const s of searches) {
      expect(s.get('fields')).toBe('all')
      expect(s.get('balance_affecting_records_only')).toBe('Y')
      expect(Date.parse(s.get('end_date')!) - Date.parse(s.get('start_date')!)).toBeLessThanOrEqual(31 * 86_400_000)
    }
    // Only read endpoints were called; the token is fetched once and reused.
    expect(calls.filter((c) => c.url.includes('/v1/oauth2/token'))).toHaveLength(1)
    expect(calls.every((c) => c.method === 'GET' || c.url.includes('/v1/oauth2/token'))).toBe(true)
    expect(calls.find((c) => c.url.includes('/v1/reporting/balances'))?.headers.authorization).toBe('Bearer A21AA-redacted-token-1')
  })

  it('next cycle is incremental with a 3-day overlap', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    await runSync(connector, conn, first.cursor)
    const searches = calls.slice(n).filter((c) => c.url.includes('/v1/reporting/transactions')).map((c) => new URL(c.url).searchParams)
    expect(searches).toHaveLength(1)
    expect(searches[0]?.get('start_date')).toBe('2026-10-06T12:00:00Z')
  })

  it('skips invoices when Invoicing is not enabled', async () => {
    const { connector, calls } = make()
    const r = await runSync(connector, { ...conn, config: { ...conn.config, invoices: false } }, null)
    expect(r.events.some((e) => e.type === 'invoice.upsert')).toBe(false)
    expect(calls.some((c) => c.url.includes('/v2/invoicing'))).toBe(false)
  })

  it('warns when invoices are skipped for missing permission', async () => {
    const drain = async (connector: ReturnType<typeof make>['connector'], c: ConnectionRef) => {
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
    // Known at connect.
    const known = await drain(make().connector, { ...conn, config: { ...conn.config, invoices: false } })
    expect(known.at(-1)).toEqual([PAYPAL_NO_INVOICES_WARNING])
    expect(known.filter(Boolean)).toHaveLength(1)
    // Permission removed since connect: 403 on the invoices page.
    const denied = make([{ match: '/v2/invoicing/invoices', respond: { status: 403, json: { name: 'PERMISSION_DENIED', message: 'No permission' } } }])
    const late = await drain(denied.connector, conn)
    expect(late.at(-1)).toEqual([PAYPAL_NO_INVOICES_WARNING])
    expect(late.filter(Boolean)).toHaveLength(1)
    // Fully permitted: no warnings.
    expect((await drain(make().connector, conn)).every((w) => w === undefined)).toBe(true)
  })
})

describe('paypal errors', () => {
  it('bad client credentials are auth; health needs_reauth', async () => {
    const { connector } = make([{ match: '/v1/oauth2/token', respond: { status: 401, json: { error: 'invalid_client', error_description: 'Client Authentication failed' } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', message: 'Client Authentication failed' })
    expect(await connector.health(conn)).toEqual({ status: 'needs_reauth', message: 'Client Authentication failed' })
  })

  it('Transaction Search not enabled (403) is auth with a hint', async () => {
    const { connector } = make([{ match: '/v1/reporting/balances', respond: { status: 403, json: { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions', debug_id: 'd' } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('Transaction search') })
  })

  it('re-mints the token once on a 401 from an API call', async () => {
    let n = 0
    const { connector, calls } = make([
      { match: (u) => u.pathname === '/v1/reporting/balances' && n++ === 1, respond: { status: 401, json: { name: 'AUTHENTICATION_FAILURE', message: 'token expired' } } },
    ])
    expect(await connector.health(conn)).toEqual({ status: 'ok' })
    expect(await connector.health(conn)).toEqual({ status: 'ok' })
    expect(calls.filter((c) => c.url.includes('/v1/oauth2/token'))).toHaveLength(2)
  })

  it('retries 429 after Retry-After', async () => {
    let n = 0
    const { connector, clock } = make([
      { match: (u) => u.pathname === '/v1/reporting/balances' && n++ === 0, respond: { status: 429, headers: { 'retry-after': '7' }, json: { name: 'RATE_LIMIT_REACHED', message: 'Too many requests' } } },
    ])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(7000)
  })

  it('malformed stored secret is auth', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { clientId: 'x' } }, null)).rejects.toMatchObject({ kind: 'auth' })
    expect((await connector.health({ ...conn, secret: null })).status).toBe('needs_reauth')
  })

  it('a garbage cursor is cursor_invalid', async () => {
    const { connector } = make()
    await expect(connector.sync(conn, 'nope')).rejects.toMatchObject({ kind: 'cursor_invalid' })
  })
})

describe('paypal connect and begin', () => {
  it('validates input', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ clientId: CLIENT_ID, clientSecret: 's', env: 'prod' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ clientId: 'short', clientSecret: 's' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('verifies the credential with a read and returns secret + config with warnings', async () => {
    const { connector, calls } = make()
    const out = await connector.connect({ clientId: CLIENT_ID, clientSecret: 'test-secret', env: 'sandbox' })
    expect(out.secret).toEqual({ clientId: CLIENT_ID, clientSecret: 'test-secret' })
    expect(out.config).toEqual({ env: 'sandbox', accountId: 'MERCHANTSBX01', currencies: ['USD', 'EUR'], invoices: true, warnings: [PAYPAL_WRITE_WARNING] })
    expect(calls[0]?.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token')
    expect(calls[0]?.headers.authorization).toBe('Basic ' + Buffer.from(`${CLIENT_ID}:test-secret`).toString('base64'))
  })

  it('warns when Invoicing is not enabled', async () => {
    const { connector } = make([{ match: '/v2/invoicing/invoices', respond: { status: 403, json: { name: 'PERMISSION_DENIED', message: 'No permission' } } }])
    const out = await connector.connect({ clientId: CLIENT_ID, clientSecret: 'test-secret' })
    expect(out.config).toMatchObject({ env: 'live', invoices: false })
    expect((out.config.warnings as string[]).length).toBe(2)
  })

  it('begin asks for an API key', async () => {
    const { connector } = make()
    expect(await connector.begin()).toMatchObject({ kind: 'api_key', helpUrl: expect.stringContaining('developer.paypal.com') })
  })
})

describe('paypal webhooks', () => {
  const body = JSON.stringify(fx.webhook_event)
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-sandbox',
    'paypal-transmission-id': 'tx-0001',
    'paypal-transmission-sig': 'c2lnbmF0dXJl',
    'paypal-transmission-time': '2026-10-09T11:00:00Z',
  }
  const app = { clientId: CLIENT_ID, clientSecret: 'test-secret', env: 'sandbox' as const }

  function withVerify(status: 'SUCCESS' | 'FAILURE') {
    return make([{ method: 'POST', match: '/v1/notifications/verify-webhook-signature', respond: { json: { verification_status: status } } }], { webhookId: 'WH-ID-1', webhookApp: app })
  }

  it('accepts a webhook PayPal verifies, passing the raw event and webhook id', async () => {
    const { connector, calls } = withVerify('SUCCESS')
    await connector.webhook!.verify({ headers, body })
    const call = calls.find((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature'))
    expect(call?.body).toMatchObject({ auth_algo: 'SHA256withRSA', transmission_id: 'tx-0001', webhook_id: 'WH-ID-1', webhook_event: fx.webhook_event })
  })

  it('rejects FAILURE, missing headers and non-JSON', async () => {
    const { connector } = withVerify('FAILURE')
    await expect(connector.webhook!.verify({ headers, body })).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.webhook!.verify({ headers: {}, body })).rejects.toThrow(/missing/)
    await expect(connector.webhook!.verify({ headers, body: 'nope' })).rejects.toThrow(/JSON/)
  })

  it('a stale or replayed transmission that PayPal answers 400 for is rejected as auth', async () => {
    const { connector } = make(
      [{ method: 'POST', match: '/v1/notifications/verify-webhook-signature', respond: { status: 400, json: { name: 'VALIDATION_ERROR', message: 'Invalid request' } } }],
      { webhookId: 'WH-ID-1', webhookApp: app },
    )
    await expect(connector.webhook!.verify({ headers, body })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('no webhook without configuration', () => {
    expect(make().connector.webhook).toBeUndefined()
  })

  it('interprets event types', () => {
    const w = (o: object) => interpretPayPalWebhook({ headers: {}, body: JSON.stringify({ id: 'WH-1', ...o }) }, 'WH-ID-1')
    expect(interpretPayPalWebhook({ headers, body }, 'WH-ID-1')).toEqual({ action: 'sync', dedupeKey: 'paypal:WH-SBX-0001-EVENT', reason: 'PAYMENT.CAPTURE.COMPLETED', match: { field: 'accountId', value: 'MERCHANTSBX01' } })
    expect(w({ event_type: 'INVOICING.INVOICE.PAID', resource: {} })).toMatchObject({ action: 'sync', match: { field: 'webhookId', value: 'WH-ID-1' } })
    expect(w({ event_type: 'CUSTOMER.DISPUTE.CREATED' }).action).toBe('sync')
    expect(w({ event_type: 'MERCHANT.PARTNER-CONSENT.REVOKED' }).action).toBe('disconnected')
    expect(w({ event_type: 'CATALOG.PRODUCT.CREATED' }).action).toBe('ignore')
    expect(interpretPayPalWebhook({ headers: {}, body: 'x' }).action).toBe('ignore')
  })
})

describe('paypal partner mode (hosted one-click)', () => {
  const partner = { clientId: 'AggPartnerClient_sandbox_0001', clientSecret: 'agg-secret', merchantId: 'AGGPARTNER01', env: 'sandbox' as const }
  const ctx = { workspaceId: 'ws1', redirectUri: 'https://app.example/api/connectors/paypal/callback', state: 'state-123456789', userRef: 'p1' }
  const SEARCH = 'https://uri.paypal.com/services/reporting/search/read'
  const assertionFor = (payer: string) => `${Buffer.from('{"alg":"none"}').toString('base64')}.${Buffer.from(JSON.stringify({ iss: partner.clientId, payer_id: payer })).toString('base64')}.`
  const integration = (tracking: string, scopes: string[]): FixtureRoute => ({
    match: '/v1/customer/partners/AGGPARTNER01/merchant-integrations/SELLER0001',
    respond: { json: { tracking_id: tracking, oauth_integrations: [{ integration_type: 'OAUTH_THIRD_PARTY', oauth_third_party: [{ partner_client_id: partner.clientId, scopes }] }] } },
  })
  const referral: FixtureRoute = { method: 'POST', match: '/v2/customer/partner-referrals', respond: { status: 201, json: { links: [{ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/customer/partner-referrals/x' }, { rel: 'action_url', href: 'https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=abc' }] } } }

  it('without the partner app it stays a pasted REST app', async () => {
    const { connector } = make([], OPTS)
    expect(connector.describe().auth).toBe('api_key')
    expect(await connector.begin(ctx)).toMatchObject({ kind: 'api_key' })
  })

  it('begin creates a partner referral asking only for reporting features, returning to our callback with the state', async () => {
    const { connector, calls } = make([referral], { ...OPTS, partner })
    expect(connector.describe().auth).toBe('oauth')
    expect(await connector.begin(ctx)).toEqual({ kind: 'oauth', url: 'https://www.sandbox.paypal.com/bizsignup/partner/entry?referralToken=abc' })
    const call = calls.find((c) => c.url.includes('partner-referrals'))
    const body = call?.body as { tracking_id: string; operations: Array<{ api_integration_preference: { rest_api_integration: { third_party_details: { features: string[] } } } }>; partner_config_override: { return_url: string } }
    expect(body.tracking_id).toBe(ctx.state)
    expect(body.operations[0]?.api_integration_preference.rest_api_integration.third_party_details.features).toEqual(['ADVANCED_TRANSACTIONS_SEARCH', 'ACCESS_MERCHANT_INFORMATION'])
    expect(body.partner_config_override.return_url).toBe(`${ctx.redirectUri}?state=${ctx.state}`)
    // A partner-level call is made as ourselves: our token, no assertion naming anyone.
    expect(call?.headers['paypal-auth-assertion']).toBeUndefined()
    expect(call?.headers.authorization).toBe('Bearer A21AA-redacted-token-1')
  })

  it('connect checks the seller onboarded through this attempt with search access, then reads as them', async () => {
    const { connector, calls } = make([integration(ctx.state, [SEARCH])], { ...OPTS, partner })
    const r = await connector.connect({ merchantIdInPayPal: 'SELLER0001', merchantId: ctx.state, permissionsGranted: 'true', query: { state: ctx.state } })
    expect(r.secret).toEqual({ kind: 'partner', payerId: 'SELLER0001' })
    expect(r.config).toMatchObject({ env: 'sandbox', invoices: false, currencies: expect.any(Array) })
    const bal = calls.find((c) => c.url.includes('/v1/reporting/balances'))
    expect(bal?.headers['paypal-auth-assertion']).toBe(assertionFor('SELLER0001'))
    // The onboarding-status read is partner-level: no assertion.
    const status = calls.find((c) => c.url.includes('/merchant-integrations/'))
    expect(status?.headers['paypal-auth-assertion']).toBeUndefined()
    expect(status?.headers.authorization).toMatch(/^Bearer /)

    // Syncs read as that seller with Aggregate's token.
    const { connector: c2, calls: calls2 } = make([], { ...OPTS, partner })
    await runSync(c2, { ...conn, secret: r.secret, config: r.config }, null)
    const reads = calls2.filter((c) => c.url.includes('/v1/reporting/'))
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((c) => c.headers['paypal-auth-assertion'] === assertionFor('SELLER0001'))).toBe(true)
  })

  it('refuses a seller from another attempt, without search access, or who declined', async () => {
    const other = make([integration('someone-elses-state', [SEARCH])], { ...OPTS, partner })
    await expect(other.connector.connect({ merchantIdInPayPal: 'SELLER0001', query: { state: ctx.state } })).rejects.toThrow(/doesn’t match/)
    const noScope = make([integration(ctx.state, ['https://uri.paypal.com/services/payments/realtimepayment'])], { ...OPTS, partner })
    await expect(noScope.connector.connect({ merchantIdInPayPal: 'SELLER0001', query: { state: ctx.state } })).rejects.toThrow(/transaction history/)
    await expect(make([], { ...OPTS, partner }).connector.connect({ merchantIdInPayPal: 'SELLER0001', permissionsGranted: 'false', query: { state: ctx.state } })).rejects.toThrow(/wasn’t granted/)
  })

  const noBalances: FixtureRoute = { match: '/v1/reporting/balances', respond: { status: 403, json: { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions', debug_id: 'd' } } }

  it('connects without the balance permission: seller as account, currencies from recent transactions, a warning', async () => {
    const recent = { match: '/v1/reporting/transactions', respond: { json: { transaction_details: [fx.transactions[0], ...fx.transactions], total_pages: 1 } } }
    const { connector, calls } = make([integration(ctx.state, [SEARCH]), noBalances, recent], { ...OPTS, partner })
    const r = await connector.connect({ merchantIdInPayPal: 'SELLER0001', query: { state: ctx.state } })
    expect(r.config).toMatchObject({ accountId: 'SELLER0001', invoices: false, warnings: [PAYPAL_NO_BALANCES_WARNING] })
    expect([...(r.config.currencies as string[])].sort()).toEqual(['EUR', 'JPY', 'USD'])
    const search = calls.find((c) => c.url.includes('/v1/reporting/transactions'))
    expect(search?.headers['paypal-auth-assertion']).toBe(assertionFor('SELLER0001'))
    // No recent transactions (or the search failing) still connects, just with no currencies yet.
    const empty = make([integration(ctx.state, [SEARCH]), noBalances, { match: '/v1/reporting/transactions', respond: { status: 500, json: { name: 'INTERNAL_SERVICE_ERROR', message: 'x' } } }], { ...OPTS, partner })
    expect((await empty.connector.connect({ merchantIdInPayPal: 'SELLER0001', query: { state: ctx.state } })).config).toMatchObject({ currencies: [], warnings: [PAYPAL_NO_BALANCES_WARNING] })
  })

  it('syncs transactions with a warning when balances are refused, and health stays ok', async () => {
    const { connector } = make([noBalances], { ...OPTS, partner })
    const seller: ConnectionRef = { ...conn, secret: { kind: 'partner', payerId: 'SELLER0001' }, config: { env: 'sandbox', accountId: 'SELLER0001', currencies: [], invoices: false, warnings: [] } }
    const first = await connector.sync(seller, null)
    expect(first.warnings).toEqual([PAYPAL_NO_BALANCES_WARNING])
    expect(first.events).toEqual([])
    const { events } = await runSync(connector, seller, null)
    expect(txn(events, 'CHARGE0001AAAAAAA')).toMatchObject({ accountExternalId: 'SELLER0001:USD' })
    expect(events.some((e) => e.type === 'account.upsert' && e.externalId === 'SELLER0001:USD')).toBe(true)
    expect(events.some((e) => e.type === 'balance.snapshot')).toBe(false)
    expect(await connector.health(seller)).toEqual({ status: 'ok', message: PAYPAL_NO_BALANCES_WARNING })
    // A pasted REST app's 403 is still a hard failure: there the fix is in the seller's own app.
    await expect(runSync(make([noBalances]).connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('a 403 for a partner seller says to reconnect, not to fix a REST app they don’t have', async () => {
    const forbidden = { match: '/v1/reporting/transactions', respond: { status: 403, json: { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions' } } }
    const { connector } = make([forbidden], { ...OPTS, partner })
    const seller: ConnectionRef = { ...conn, secret: { kind: 'partner', payerId: 'SELLER0001' }, config: { env: 'sandbox', accountId: 'SELLER0001', currencies: [], invoices: false, warnings: [] } }
    const e = (await runSync(connector, seller, null).then(() => undefined, (x: unknown) => x)) as Error
    expect(e).toMatchObject({ kind: 'auth', status: 403 })
    expect(e.message).toContain('Reconnect PayPal from Aggregate')
    expect(e.message).not.toContain('REST app')
  })
})

describe('paypal oversized windows (RESULTSET_TOO_LARGE)', () => {
  const tooLarge = (issueInDetails: boolean) =>
    issueInDetails
      ? { status: 400, json: { name: 'INVALID_REQUEST', message: 'Request is not well-formed.', details: [{ issue: 'RESULTSET_TOO_LARGE', description: 'Result set size is greater than the maximum limit.' }] } }
      : { status: 400, json: { name: 'RESULTSET_TOO_LARGE', message: 'Result set size is greater than the maximum limit. Change the filter criteria and try again.' } }
  const days = (s: URLSearchParams) => (Date.parse(s.get('end_date')!) - Date.parse(s.get('start_date')!) + 1000) / 86_400_000
  const searches = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('/v1/reporting/transactions')).map((c) => new URL(c.url).searchParams)

  for (const inDetails of [false, true]) {
    it(`halves the window from the same start, then grows back (${inDetails ? 'issue in details' : 'top-level name'})`, async () => {
      // October 2023 is busy: more than 7 days of it at once is too many rows.
      const busy: FixtureRoute = {
        match: (u) => u.pathname === '/v1/reporting/transactions' && Date.parse(u.searchParams.get('start_date')!) < Date.parse('2023-11-01T00:00:00Z') && days(u.searchParams) > 7,
        respond: tooLarge(inDetails),
      }
      const { connector, calls } = make([busy])
      const { events } = await runSync(connector, conn, null)
      const s = searches(calls)
      expect(s.slice(0, 4).map((x) => [x.get('start_date'), days(x)])).toEqual([
        ['2023-10-10T12:00:00Z', 31],
        ['2023-10-10T12:00:00Z', 15],
        ['2023-10-10T12:00:00Z', 7],
        // Next window starts right after and tries double the size.
        ['2023-10-17T12:00:00Z', 14],
      ])
      // Once past the busy month, windows are back to 31 days and the backfill finishes.
      expect(s.some((x, i) => i > 4 && days(x) === 31)).toBe(true)
      expect(s.at(-1)?.get('end_date')).toBe('2026-10-09T12:00:00Z')
      expect(txn(events, 'CHARGE0001AAAAAAA')).toBeDefined()
    })
  }

  it('a single day that is still too large is a clear permanent error', async () => {
    const { connector, calls } = make([{ match: '/v1/reporting/transactions', respond: tooLarge(false) }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'permanent', code: 'RESULTSET_TOO_LARGE', message: expect.stringContaining('too many transactions on 2023-10-10') })
    expect(searches(calls).map(days)).toEqual([31, 15, 7, 3, 1])
  })

  it('other 400s are still invalid_input', async () => {
    const { connector } = make([{ match: '/v1/reporting/transactions', respond: { status: 400, json: { name: 'INVALID_REQUEST', message: 'bad' } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'invalid_input' })
  })
})
