import { readFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, ConnectionRef, InvoiceUpsert, NormalizedEvent, ProcessorBalanceTxn, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createSquareConnector, interpretSquareWebhook, kindForEntryType, mapCashPayment, mapCashRefund, mapEntry, mapPayment, SQUARE_NO_INVOICES_WARNING, SQUARE_NO_PAYMENTS_WARNING, SQUARE_PERSONAL_TOKEN_HOSTED_WARNING, SQUARE_PERSONAL_TOKEN_REFUSED, SQUARE_PERSONAL_TOKEN_WARNING, SQUARE_VERSION, type SquareConnectorOptions } from './index.ts'
import type { SquarePayment, SquarePayout, SquarePayoutEntry, SquareRefund } from './types.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox-seller.json', import.meta.url), 'utf8')) as {
  merchant: unknown
  locations: unknown
  payouts: SquarePayout[]
  entries: Record<string, SquarePayoutEntry[]>
  payments?: Array<{ location_id?: string } & Record<string, unknown>>
  refunds?: Array<{ location_id?: string } & Record<string, unknown>>
  invoices: Record<string, unknown[]>
  token: unknown
  refreshed_token: unknown
  webhook_event: unknown
}

const conn: ConnectionRef = {
  id: 'conn_square',
  workspaceId: 'ws1',
  connectorKey: 'square',
  secret: { kind: 'oauth', accessToken: 'EAAAsbx-redacted-access-1', refreshToken: 'EQAAsbx-redacted-refresh-1', expiresAt: '2026-11-08T12:00:00Z' },
  config: { env: 'sandbox', merchantId: 'MLSBXMERCHANT1', businessName: 'Example Coffee Co', warnings: [] },
}

/** Cursor pagination simulated from request params: cursor "i:<offset>". */
function page<T>(rows: T[], u: URL, key: string) {
  const limit = Number(u.searchParams.get('limit') ?? 100)
  const off = Number((u.searchParams.get('cursor') ?? 'i:0').slice(2))
  const slice = rows.slice(off, off + limit)
  return { json: { [key]: slice, ...(off + limit < rows.length ? { cursor: `i:${off + limit}` } : {}) } }
}

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { method: 'POST', match: '/oauth2/token', respond: (_u, body) => ({ json: (body as { grant_type?: string }).grant_type === 'refresh_token' ? fx.refreshed_token : fx.token }) },
    { match: '/v2/merchants/me', respond: { json: fx.merchant } },
    { match: '/v2/locations', respond: { json: fx.locations } },
    {
      match: /^\/v2\/payouts\/[^/]+\/payout-entries/,
      respond: (u) => page(fx.entries[decodeURIComponent(u.pathname.split('/')[3] ?? '')] ?? [], u, 'payout_entries'),
    },
    {
      match: /^\/v2\/payouts(\?|$)/,
      respond: (u) => {
        const loc = u.searchParams.get('location_id')
        const begin = Date.parse(u.searchParams.get('begin_time') ?? '1970-01-01T00:00:00Z')
        const rows = fx.payouts.filter((p) => p.location_id === loc && Date.parse(p.created_at ?? '') >= begin)
        return page(rows, u, 'payouts')
      },
    },
    { match: '/v2/invoices', respond: (u) => page(fx.invoices[u.searchParams.get('location_id') ?? ''] ?? [], u, 'invoices') },
    { match: /^\/v2\/payments(\?|$)/, respond: (u) => page((fx.payments ?? []).filter((x) => x.location_id === u.searchParams.get('location_id')), u, 'payments') },
    { match: /^\/v2\/refunds(\?|$)/, respond: (u) => page((fx.refunds ?? []).filter((x) => x.location_id === u.searchParams.get('location_id')), u, 'refunds') },
  ]
}

const OPTS: SquareConnectorOptions = { env: 'sandbox', clientId: 'sandbox-sq0idb-example', clientSecret: 'sandbox-sq0csb-example', pageSize: 2 }

function make(extra: FixtureRoute[] = [], opts: SquareConnectorOptions = OPTS) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createSquareConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const txn = (events: NormalizedEvent[], id: string) =>
  events.find((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.externalId === id)

describe('square contract', () => {
  it('passes the connector contract', async () => {
    await runConnectorContract({
      make: () => make(),
      signs: { 'pay:pay_sbx_1': '+', 'ref:pay_sbx_1_ref1': '-', poe_A4: '-', poe_B2: '-', po_sbx_A: '-', po_sbx_B: '-' },
      minEvents: 14,
    })
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })
})

describe('square mapping', () => {
  it('one processor_balance account per location currency', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const accts = events.filter((e): e is AccountUpsert => e.type === 'account.upsert')
    expect(accts.map((a) => a.externalId).sort()).toEqual(['MLSBXMERCHANT1:CAD', 'MLSBXMERCHANT1:USD'])
    expect(accts[0]).toMatchObject({ accountType: 'processor_balance', institution: 'Square', name: 'Example Coffee Co Square balance (USD)' })
    expect(events.some((e) => e.type === 'balance.snapshot')).toBe(false)
  })

  it('maps payout entries with gross/fee/net, kinds and payout ids', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'pay:pay_sbx_1')).toMatchObject({ kind: 'charge', gross: { minor: 3000 }, fee: { minor: 117 }, net: { minor: 2883 }, payoutExternalId: 'po_sbx_A', sourceExternalId: 'pay_sbx_1', at: '2026-09-19T15:00:00.000Z', accountExternalId: 'MLSBXMERCHANT1:USD' })
    expect(txn(events, 'ref:pay_sbx_1_ref1')).toMatchObject({ kind: 'refund', gross: { minor: -500 }, fee: { minor: -20 }, net: { minor: -480 }, sourceExternalId: 'pay_sbx_1_ref1' })
    expect(txn(events, 'poe_A4')).toMatchObject({ kind: 'fee', gross: { minor: 0 }, fee: { minor: 15 }, net: { minor: -15 } })
    expect(txn(events, 'poe_B2')).toMatchObject({ kind: 'dispute', net: { minor: -100 }, sourceExternalId: 'dsp_sbx_1' })
    // Payout rows: money out of the balance; entries of the payout sum to the payout amount.
    expect(txn(events, 'po_sbx_A')).toMatchObject({ kind: 'payout', gross: { minor: -3329 }, fee: { minor: 0 }, net: { minor: -3329 }, payoutExternalId: 'po_sbx_A', at: '2026-09-20T07:00:00.000Z' })
    const sumA = events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.payoutExternalId === 'po_sbx_A' && e.kind !== 'payout').reduce((s, e) => s + e.net.minor, 0)
    expect(sumA).toBe(3329)
    expect(txn(events, 'po_sbx_B')?.net.minor).toBe(-10000)
    // A failed payout never left the balance.
    expect(txn(events, 'po_sbx_C')).toMatchObject({ net: { minor: 0 }, gross: { minor: 0 } })
    expect(txn(events, 'pay:pay_sbx_4')?.net.minor).toBe(2500)
    // Outside the 3-year lookback.
    expect(txn(events, 'po_sbx_OLD')).toBeUndefined()
  })

  it('derives the fee when an entry does not add up, and maps kinds', () => {
    const e = mapEntry(
      { id: 'poe_x', payout_id: 'po_x', type: 'CHARGE', gross_amount_money: { amount: 100, currency: 'USD' }, fee_amount_money: { amount: -19, currency: 'USD' }, net_amount_money: { amount: 81, currency: 'USD' } },
      'M1', 'USD', 'c', 'r', '2026-10-09T00:00:00Z',
    )
    expect([e.gross.minor, e.fee.minor, e.net.minor]).toEqual([100, 19, 81])
    expect(kindForEntryType('TAX_ON_FEE')).toBe('fee')
    expect(kindForEntryType('RESERVE_HOLD')).toBe('adjustment')
    expect(kindForEntryType('SQUARE_PAYROLL_TRANSFER')).toBe('transfer')
    expect(kindForEntryType('SOMETHING_NEW')).toBe('other')
  })

  it('maps invoices', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const inv = (id: string) => events.find((e): e is InvoiceUpsert => e.type === 'invoice.upsert' && e.externalId === id)
    expect(inv('inv:0-SBX001')).toMatchObject({ direction: 'receivable', number: '000001', status: 'paid', counterparty: 'Example Events LLC', issueDate: '2026-08-31', dueDate: '2026-09-15', total: { minor: 25000 }, amountPaid: { minor: 25000 } })
    expect(inv('inv:0-SBX002')).toMatchObject({ status: 'partially_paid', counterparty: 'Sample Customer', issueDate: '2026-10-01', dueDate: '2026-11-01', total: { minor: 20000 }, amountPaid: { minor: 5000 } })
  })

  it('pins Square-Version, uses bearer auth, reads only', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(calls.every((c) => c.headers['square-version'] === SQUARE_VERSION && c.method === 'GET')).toBe(true)
    expect(calls[0]?.headers.authorization).toBe('Bearer EAAAsbx-redacted-access-1')
    expect(new URL(calls.find((c) => c.url.includes('/v2/payouts?'))!.url).searchParams.get('begin_time')).toBe('2023-10-10T12:00:00.000Z')
  })

  it('next cycle is incremental with a 35-day overlap (late-failing payouts are re-read)', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const second = await runSync(connector, conn, first.cursor)
    const payoutCalls = calls.slice(n).filter((c) => /\/v2\/payouts\?/.test(c.url))
    expect(new URL(payoutCalls[0]!.url).searchParams.get('begin_time')).toBe('2026-09-04T12:00:00.000Z')
    expect(txn(second.events, 'po_sbx_C')).toBeDefined()
    expect(txn(second.events, 'po_sbx_A')).toBeDefined() // 3 weeks old: still re-read, in case it failed late
  })

  it('refreshes an OAuth token close to expiry and returns updatedSecret', async () => {
    const { connector, calls } = make()
    const soon = { ...conn, secret: { ...(conn.secret as object), expiresAt: '2026-10-12T12:00:00Z' } }
    const page = await connector.sync(soon, null)
    expect(page.updatedSecret).toEqual({ kind: 'oauth', accessToken: 'EAAAsbx-redacted-access-2', refreshToken: 'EQAAsbx-redacted-refresh-1', expiresAt: '2026-11-12T12:00:00Z' })
    expect(calls[0]?.body).toEqual({ client_id: OPTS.clientId, client_secret: OPTS.clientSecret, grant_type: 'refresh_token', refresh_token: 'EQAAsbx-redacted-refresh-1' })
    expect(calls[1]?.headers.authorization).toBe('Bearer EAAAsbx-redacted-access-2')
    // runSync carries the rotated secret into later pages.
    const r = await runSync(connector, soon, null)
    expect(r.updatedSecret).toBeDefined()
  })

  it('a pasted token from the other Square environment just works (sandbox token, production default)', async () => {
    const unauthorized = { status: 401, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] } }
    const prod = (u: URL) => u.hostname === 'connect.squareup.com' && u.pathname === '/v2/merchants/me'
    const { connector } = make([{ match: prod, respond: unauthorized }], { ...OPTS, env: 'production' })
    const r = await connector.connect({ accessToken: 'EAAAsbx-personal-token-1' })
    expect(r.config).toMatchObject({ env: 'sandbox' })
    // Chosen explicitly: no second guess.
    await expect(make([{ match: prod, respond: unauthorized }], { ...OPTS, env: 'production' }).connector.connect({ accessToken: 'EAAAsbx-personal-token-1', env: 'production' })).rejects.toMatchObject({ kind: 'auth' })
  })

  it('hosted: Square sign-in only; a personal token is refused, and an existing one is asked to switch', async () => {
    const hosted = make([], { ...OPTS, hosted: true })
    await expect(hosted.connector.connect({ accessToken: 'EAAAsbx-personal-token-1' })).rejects.toMatchObject({ kind: 'invalid_input', forUser: true, message: SQUARE_PERSONAL_TOKEN_REFUSED })
    expect(hosted.calls).toHaveLength(0)
    expect((await hosted.connector.begin({ redirectUri: 'https://app.example/cb', state: 's1', workspaceId: 'ws1', userRef: 'u1' })).kind).toBe('oauth')
    await expect(make([], { env: 'sandbox', hosted: true }).connector.begin({ redirectUri: 'https://app.example/cb', state: 's1', workspaceId: 'ws1', userRef: 'u1' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const last = async (c: ReturnType<typeof make>['connector'], secret: unknown) => {
      let cursor: string | null = null
      let w: string[] | undefined
      for (;;) {
        const r = await c.sync({ ...conn, secret }, cursor)
        w = r.warnings
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return w ?? []
    }
    const personal = { kind: 'personal', accessToken: 'EAAAsbx-personal-token-1' }
    expect(await last(hosted.connector, personal)).toContain(SQUARE_PERSONAL_TOKEN_HOSTED_WARNING)
    expect(await last(make().connector, personal)).toContain(SQUARE_PERSONAL_TOKEN_WARNING)
    expect(await last(make().connector, conn.secret)).not.toContain(SQUARE_PERSONAL_TOKEN_WARNING)
  })

  it('personal access tokens never refresh', async () => {
    const { connector, calls } = make()
    const page = await connector.sync({ ...conn, secret: { kind: 'personal', accessToken: 'EAAAsbx-personal-token-1' } }, null)
    expect(page.updatedSecret).toBeUndefined()
    expect(calls.some((c) => c.url.includes('/oauth2/token'))).toBe(false)
  })

  it('skips invoices when INVOICES_READ was not granted', async () => {
    const { connector } = make([{ match: '/v2/invoices', respond: { status: 403, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'The merchant has not given your application sufficient permissions to do that.' }] } } }])
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
    expect(r.events.some((e) => e.type === 'invoice.upsert')).toBe(false)
  })

  it('warns on the final page when invoices are skipped for a missing scope', async () => {
    const drain = async (connector: ReturnType<typeof make>['connector']) => {
      const out: Array<string[] | undefined> = []
      let cursor: string | null = null
      for (;;) {
        const r = await connector.sync(conn, cursor)
        out.push(r.warnings)
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return out
    }
    const denied = make([{ match: '/v2/invoices', respond: { status: 403, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'missing INVOICES_READ' }] } } }])
    const w = await drain(denied.connector)
    expect(w.at(-1)).toEqual([SQUARE_NO_INVOICES_WARNING])
    expect(w.filter(Boolean)).toHaveLength(1)
    expect((await drain(make().connector)).every((x) => x === undefined)).toBe(true)
  })
})

describe('square errors', () => {
  const unauthorized = { status: 401, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] } }

  it('401 is auth; health needs_reauth', async () => {
    const { connector } = make([{ match: '/v2/locations', respond: unauthorized }, { match: '/v2/merchants/me', respond: unauthorized }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'UNAUTHORIZED' })
    expect(await connector.health(conn)).toEqual({ status: 'needs_reauth', message: 'This request could not be authorized.' })
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('missing scope on payouts is auth with a clear message', async () => {
    const { connector } = make([{ match: /^\/v2\/payouts/, respond: { status: 403, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'missing PAYOUTS_READ' }] } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', message: expect.stringContaining('PAYOUTS_READ') })
  })

  it('retries 429 after Retry-After', async () => {
    let n = 0
    const { connector, clock } = make([
      { match: (u) => u.pathname === '/v2/locations' && n++ === 0, respond: { status: 429, headers: { 'retry-after': '3' }, json: { errors: [{ category: 'RATE_LIMIT_ERROR', code: 'RATE_LIMITED', detail: 'slow down' }] } } },
    ])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(clock.sleeps).toContain(3000)
  })

  it('expired token without refresh is auth', async () => {
    const { connector } = make([], { env: 'sandbox' })
    await expect(connector.sync({ ...conn, secret: { ...(conn.secret as object), expiresAt: '2026-10-01T00:00:00Z' } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('malformed stored secret is auth', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { accessToken: 'x' } }, null)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('square connect and begin', () => {
  it('begin builds the OAuth URL from redirectUri and state', async () => {
    const { connector } = make()
    const b = await connector.begin({ workspaceId: 'ws1', redirectUri: 'https://meridn.example.com/api/connectors/square/callback', state: 'st8', userRef: 'u1' })
    expect(b.kind).toBe('oauth')
    const u = new URL((b as { url: string }).url)
    expect(u.origin + u.pathname).toBe('https://connect.squareupsandbox.com/oauth2/authorize')
    expect(u.searchParams.get('client_id')).toBe(OPTS.clientId)
    expect(u.searchParams.get('state')).toBe('st8')
    expect(u.searchParams.get('redirect_uri')).toBe('https://meridn.example.com/api/connectors/square/callback')
    expect(u.searchParams.get('scope')).toBe('PAYOUTS_READ PAYMENTS_READ MERCHANT_PROFILE_READ INVOICES_READ')
    expect(u.searchParams.get('session')).toBe('false')
  })

  it('begin without an OAuth app asks for a personal access token', async () => {
    const { connector } = make([], { env: 'sandbox' })
    const b = await connector.begin({ workspaceId: 'ws1', redirectUri: 'https://x.example.com/cb', state: 's', userRef: 'u' })
    expect(b).toMatchObject({ kind: 'api_key', helpUrl: 'https://developer.squareup.com/apps' })
    expect((b as { steps?: string[] }).steps).toHaveLength(3)
  })

  it('disconnect revokes an OAuth grant at Square with the app secret, and tolerates an already-revoked one', async () => {
    const { connector, calls } = make([{ match: '/oauth2/revoke', respond: { json: { success: true } } }])
    const oauthConn = { ...conn, secret: { kind: 'oauth', accessToken: 'EAAAsbx-redacted-access-1' } }
    await connector.disconnect!(oauthConn)
    const call = calls.find((c) => c.url.endsWith('/oauth2/revoke'))
    expect(call?.headers.authorization).toBe(`Client ${OPTS.clientSecret}`)
    expect(call?.body).toEqual({ client_id: OPTS.clientId, access_token: 'EAAAsbx-redacted-access-1' })
    // A personal token is the owner's: never revoked by us.
    const before = calls.length
    await connector.disconnect!({ ...conn, secret: { kind: 'personal', accessToken: 'EAAA-personal' } })
    expect(calls.length).toBe(before)
    const gone = make([{ match: '/oauth2/revoke', respond: { status: 401, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'revoked' }] } } }])
    await expect(gone.connector.disconnect!(oauthConn)).resolves.toBeUndefined()
  })

  it('exchanges an OAuth code (JSON body) and verifies with /v2/merchants/me', async () => {
    const { connector, calls } = make()
    const out = await connector.connect({ code: 'sq0cgb-code', redirectUri: 'https://meridn.example.com/cb' })
    expect(out.secret).toEqual({ kind: 'oauth', accessToken: 'EAAAsbx-redacted-access-1', refreshToken: 'EQAAsbx-redacted-refresh-1', expiresAt: '2026-11-08T12:00:00Z' })
    expect(out.config).toEqual({ env: 'sandbox', merchantId: 'MLSBXMERCHANT1', businessName: 'Example Coffee Co', warnings: [] })
    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.body).toMatchObject({ grant_type: 'authorization_code', code: 'sq0cgb-code', redirect_uri: 'https://meridn.example.com/cb' })
  })

  it('accepts a personal access token with a write-capability warning', async () => {
    const { connector } = make()
    const out = await connector.connect({ accessToken: 'EAAAsbx-personal-token-1' })
    expect(out.secret).toEqual({ kind: 'personal', accessToken: 'EAAAsbx-personal-token-1' })
    expect(out.config.warnings).toEqual([SQUARE_PERSONAL_TOKEN_WARNING])
  })

  it('validates input', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ accessToken: 'bad token' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ accessToken: 'EAAAsbx-personal-token-1', env: 'staging' })).rejects.toMatchObject({ kind: 'invalid_input' })
    const bad = make([{ method: 'POST', match: '/oauth2/token', respond: { status: 401, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'Invalid authorization code' }] } } }])
    await expect(bad.connector.connect({ code: 'used' })).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('square webhooks', () => {
  const url = 'https://meridn.example.com/api/webhooks/square'
  const key = 'sbx-signature-key'
  const body = JSON.stringify(fx.webhook_event)
  const sign = (b: string, u = url) => createHmac('sha256', key).update(u + b).digest('base64')
  const wh = () => make([], { ...OPTS, webhookSignatureKey: key, webhookUrl: url }).connector.webhook!

  it('accepts a valid signature', async () => {
    await expect(wh().verify({ headers: { 'x-square-hmacsha256-signature': sign(body) }, body })).resolves.toBeUndefined()
  })

  it('rejects tampered body, wrong URL, missing header and stale events', async () => {
    await expect(wh().verify({ headers: { 'x-square-hmacsha256-signature': sign(body) }, body: body.replace('po_sbx_A', 'po_sbx_X') })).rejects.toMatchObject({ kind: 'auth' })
    await expect(wh().verify({ headers: { 'x-square-hmacsha256-signature': sign(body, 'https://evil.example.com/') }, body })).rejects.toThrow(/signature/)
    await expect(wh().verify({ headers: {}, body })).rejects.toThrow(/missing/)
    const old = JSON.stringify({ ...(fx.webhook_event as object), created_at: '2026-10-01T00:00:00Z' })
    await expect(wh().verify({ headers: { 'x-square-hmacsha256-signature': sign(old) }, body: old })).rejects.toThrow(/too old/)
  })

  it('no webhook without configuration', () => {
    expect(make().connector.webhook).toBeUndefined()
  })

  it('interprets event types, matched on merchant id', () => {
    expect(interpretSquareWebhook({ headers: {}, body })).toEqual({ action: 'sync', dedupeKey: 'square:evt-sbx-0001', reason: 'payout.paid', match: { field: 'merchantId', value: 'MLSBXMERCHANT1' } })
    const w = (type: string) => interpretSquareWebhook({ headers: {}, body: JSON.stringify({ merchant_id: 'M1', type, event_id: 'e' }) }).action
    expect(w('payment.updated')).toBe('sync')
    expect(w('invoice.payment_made')).toBe('sync')
    expect(w('oauth.authorization.revoked')).toBe('disconnected')
    expect(w('catalog.version.updated')).toBe('ignore')
    expect(interpretSquareWebhook({ headers: {}, body: '{' }).action).toBe('ignore')
  })
})

describe('square sales as they happen', () => {
  const loc = (fx.payouts[0] as { location_id?: string }).location_id
  const sale = (id: string, amount: number, fee: number, o: Record<string, unknown> = {}) => ({ id, status: 'COMPLETED', source_type: 'CARD', location_id: loc, created_at: '2026-10-01T15:00:00Z', total_money: { amount, currency: 'USD' }, processing_fee: [{ type: 'INITIAL', amount_money: { amount: fee, currency: 'USD' } }], ...o })
  const extra: FixtureRoute[] = [
    {
      match: /^\/v2\/payments(\?|$)/,
      respond: (u) => page(u.searchParams.get('location_id') === loc ? [sale('pay_sbx_1', 3000, 117), sale('pay_sbx_9', 1250, 66), sale('pay_cash', 900, 0, { source_type: 'CASH' }), sale('pay_pending', 500, 0, { status: 'APPROVED' })] : [], u, 'payments'),
    },
    {
      match: /^\/v2\/refunds(\?|$)/,
      respond: (u) => page(u.searchParams.get('location_id') === loc ? [{ id: 'pay_sbx_1_ref1', status: 'COMPLETED', payment_id: 'pay_sbx_1', location_id: loc, created_at: '2026-10-02T15:00:00Z', amount_money: { amount: 500, currency: 'USD' }, processing_fee: [{ amount_money: { amount: -20, currency: 'USD' } }] }] : [], u, 'refunds'),
    },
  ]

  it('a sale not yet paid out is a charge now; one already in a payout is the same record, not a second', async () => {
    const { connector } = make(extra)
    const { events } = await runSync(connector, conn, null)
    const rows = events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn')
    // Not yet paid out: in the Square balance now, with Square's fee, and no payout yet.
    expect(txn(rows, 'pay:pay_sbx_9')).toMatchObject({ kind: 'charge', gross: { minor: 1250 }, fee: { minor: 66 }, net: { minor: 1184 } })
    expect(txn(rows, 'pay:pay_sbx_9')?.payoutExternalId).toBeUndefined()
    // Cash and not-completed payments never touch the Square balance (cash goes to the drawer instead).
    expect(txn(rows, 'pay:pay_cash')).toBeUndefined()
    expect(txn(rows, 'pay:pay_pending')).toBeUndefined()
    // The paid-out sale and its refund: one id each (payout entry and payment/refund share it), so the ledger keeps one
    // record; the version with the payout id says which payout settled it.
    const ids = rows.map((r) => r.externalId)
    expect(ids.filter((i) => i === 'pay:pay_sbx_1').length).toBeGreaterThanOrEqual(1)
    expect(rows.filter((r) => r.externalId === 'pay:pay_sbx_1').every((r) => r.net.minor === 2883)).toBe(true)
    expect(rows.filter((r) => r.externalId === 'ref:pay_sbx_1_ref1').every((r) => r.net.minor === -480)).toBe(true)
    expect(rows.some((r) => r.externalId === 'pay:pay_sbx_1' && r.payoutExternalId === 'po_sbx_A')).toBe(true)
  })

  it('cash and "other" tenders go into the location\'s cash drawer; a cash refund comes out of it, a card refund out of the balance', async () => {
    const cashExtra: FixtureRoute[] = [
      {
        match: /^\/v2\/payments(\?|$)/,
        respond: (u) =>
          page(
            u.searchParams.get('location_id') === loc
              ? [
                  sale('pay_card', 2000, 88),
                  sale('pay_cash1', 900, 0, { source_type: 'CASH', created_at: '2026-10-01T16:00:00Z' }),
                  sale('pay_cash2', 1500, 0, { source_type: 'CASH', created_at: '2026-10-01T17:00:00Z' }),
                  sale('pay_check', 4000, 0, { source_type: 'EXTERNAL', external_details: { type: 'CHECK', source: 'Check #104' } }),
                  sale('pay_cash_void', 700, 0, { source_type: 'CASH', status: 'CANCELED' }),
                ]
              : [],
            u,
            'payments',
          ),
      },
      {
        match: /^\/v2\/refunds(\?|$)/,
        respond: (u) =>
          page(
            u.searchParams.get('location_id') === loc
              ? [
                  { id: 'ref_card', status: 'COMPLETED', payment_id: 'pay_card', destination_type: 'CARD', location_id: loc, created_at: '2026-10-02T15:00:00Z', amount_money: { amount: 300, currency: 'USD' } },
                  { id: 'ref_cash', status: 'COMPLETED', payment_id: 'pay_cash2', destination_type: 'CASH', location_id: loc, created_at: '2026-10-02T16:00:00Z', amount_money: { amount: 500, currency: 'USD' } },
                ]
              : [],
            u,
            'refunds',
          ),
      },
    ]
    const { connector } = make(cashExtra)
    const { events } = await runSync(connector, conn, null)
    const drawers = events.filter((e): e is AccountUpsert => e.type === 'account.upsert' && e.accountType === 'cash_on_hand')
    // One drawer per location that took cash, named after the location; none for the location that took none.
    expect(drawers.map((d) => [d.externalId, d.name, d.currency])).toEqual([['MLSBXMERCHANT1:cash:' + loc, 'Square cash drawer (Main Street)', 'USD']])
    const cash = events.filter((e): e is TxnUpsert => e.type === 'txn.upsert')
    expect(cash.map((t) => [t.externalId, t.accountExternalId, t.amount.minor, t.date, t.categoryHint, t.rawText])).toEqual([
      ['cash:pay_cash1', 'MLSBXMERCHANT1:cash:' + loc, 900, '2026-10-01', 'INCOME_SALES', 'Square cash sale'],
      ['cash:pay_cash2', 'MLSBXMERCHANT1:cash:' + loc, 1500, '2026-10-01', 'INCOME_SALES', 'Square cash sale'],
      ['cash:pay_check', 'MLSBXMERCHANT1:cash:' + loc, 4000, '2026-10-01', 'INCOME_SALES', 'Square sale paid by check'],
      ['cashref:ref_cash', 'MLSBXMERCHANT1:cash:' + loc, -500, '2026-10-02', 'SALES_REFUND', 'Square refund paid from the cash drawer'],
    ])
    expect(cash.find((t) => t.externalId === 'cashref:ref_cash')?.linkRefs).toMatchObject({ refund_of: 'pay_cash2' })
    // None of it touches the Square balance; the card sale and its card refund still do.
    const rows = events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn')
    expect(rows.map((r) => r.externalId).filter((i) => /cash|check/.test(i))).toEqual([])
    expect(txn(rows, 'pay:pay_card')).toMatchObject({ kind: 'charge', gross: { minor: 2000 } })
    expect(txn(rows, 'ref:ref_card')).toMatchObject({ kind: 'refund', gross: { minor: -300 } })
    expect(txn(rows, 'ref:ref_cash')).toBeUndefined()
  })

  it('an older grant without PAYMENTS_READ still syncs payouts and says so', async () => {
    const denied = { status: 403, json: { errors: [{ category: 'AUTHENTICATION_ERROR', code: 'INSUFFICIENT_SCOPES', detail: 'no' }] } }
    const { connector } = make([{ match: /^\/v2\/(payments|refunds)(\?|$)/, respond: denied }])
    const warnings: string[] = []
    const events: NormalizedEvent[] = []
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      warnings.push(...(r.warnings ?? []))
      events.push(...r.events)
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(warnings).toContain(SQUARE_NO_PAYMENTS_WARNING)
    expect(txn(events, 'pay:pay_sbx_1')?.payoutExternalId).toBe('po_sbx_A')
  })
})

describe('square sale names', () => {
  const pay = (extra: Record<string, unknown>) => mapPayment({ id: 'p1', status: 'COMPLETED', source_type: 'CARD', created_at: '2026-10-01T10:00:00Z', amount_money: { amount: 1250, currency: 'USD' }, ...extra }, 'M1', 'USD', 'c1', 'raw')
  it('names a sale by the cardholder, else the buyer email, else the note; unnamed stays unnamed', () => {
    expect(pay({ card_details: { card: { cardholder_name: '  Dana   Ruiz ' } }, buyer_email_address: 'dana@example.com', note: 'Order 7' })?.counterparty).toBe('Dana Ruiz')
    expect(pay({ buyer_email_address: 'dana@example.com', note: 'Order 7' })?.counterparty).toBe('dana@example.com')
    expect(pay({ note: 'Catering for Barnett Design' })?.counterparty).toBe('Catering for Barnett Design')
    expect(pay({ note: '  ' })?.counterparty).toBeUndefined()
    expect(pay({})).not.toHaveProperty('counterparty')
  })
})

describe('Square cash drawer rows are dated where the sale happened', () => {
  const loc = { id: 'L1', cur: 'USD', tz: 'America/Los_Angeles' }
  const sale = { id: 'p1', status: 'COMPLETED', source_type: 'CASH', created_at: '2026-10-15T01:05:00Z', amount_money: { amount: 4500, currency: 'USD' } } as SquarePayment
  it("an evening sale in Los Angeles is that day, not tomorrow's UTC date; without a zone, the UTC day", () => {
    expect(mapCashPayment(sale, 'M1', loc, 'c', 'r')?.date).toBe('2026-10-14')
    expect(mapCashPayment(sale, 'M1', { id: 'L1', cur: 'USD' }, 'c', 'r')?.date).toBe('2026-10-15')
    const refund = { id: 'r1', status: 'COMPLETED', destination_type: 'CASH', payment_id: 'p1', created_at: '2026-10-15T01:10:00Z', amount_money: { amount: 1000, currency: 'USD' } } as SquareRefund
    expect(mapCashRefund(refund, 'M1', loc, 'c', 'r')?.date).toBe('2026-10-14')
  })
})


describe('square: an unreadable 2xx stops the sync, never a silent $0', () => {
  it('an empty body (e.g. a followed redirect to a sign-in or error page) fails visibly', async () => {
    const { connector } = make([{ match: '/v2/locations', respond: { text: '' } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
  it('a 200 whose body isn’t the expected object fails visibly', async () => {
    const { connector } = make([{ match: '/v2/locations', respond: { json: 5 } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
})
