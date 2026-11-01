import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, InvoiceUpsert, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, hmac, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { RAMP_NO_BILLS_WARNING, RAMP_NO_REIMBURSEMENTS_WARNING, createRampConnector, interpretRampWebhook, parseRampInput, verifyRampWebhook, type RampConnectorOptions } from './index.ts'
import { RAMP_SCOPES } from './client.ts'

type Page = { data: unknown[]; page: { next: string | null } }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/business.json', import.meta.url), 'utf8')) as {
  token: Record<string, unknown>
  business: unknown
  balance: unknown
  transactions: Record<string, Page>
  reimbursements: Record<string, Page>
  bills: Record<string, Page>
}

const secret = { clientId: 'ramp_id_test', clientSecret: 'ramp_sec_test' }
const conn: ConnectionRef = { id: 'conn_ramp', workspaceId: 'ws1', connectorKey: 'ramp', secret, config: { businessId: 'biz_1' } }
const BEARER = `Bearer ${String(fx.token.access_token)}`

const paged = (pages: Record<string, Page>): FixtureRoute['respond'] => (u) => {
  const p = pages[u.searchParams.get('start') ?? '']
  return p ? { json: p } : { status: 400, json: { error_v2: { error_code: 'BAD', message: 'bad start', error_id: '00000000', notes: '', additional_info: {} } } }
}

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { method: 'POST', match: (u) => u.pathname === '/developer/v1/token', respond: { json: fx.token } },
    { match: (u) => u.pathname === '/developer/v1/business', respond: { json: fx.business } },
    { match: (u) => u.pathname === '/developer/v1/business/balance', respond: { json: fx.balance } },
    { match: (u) => u.pathname === '/developer/v1/transactions', respond: paged(fx.transactions) },
    { match: (u) => u.pathname === '/developer/v1/reimbursements', respond: paged(fx.reimbursements) },
    { match: (u) => u.pathname === '/developer/v1/bills', respond: paged(fx.bills) },
  ]
}

function make(extra: FixtureRoute[] = [], opts: RampConnectorOptions = { pageSize: 2 }) {
  const f = fixtureFetch(routes(extra))
  const clock = fakeClock()
  const connector = createRampConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  return { connector, conn, calls: f.calls, clock }
}

const txn = (events: NormalizedEvent[], id: string) => events.find((e): e is TxnUpsert => e.type === 'txn.upsert' && e.externalId === id)
const apiCalls = <C extends { url: string }>(calls: C[]) => calls.filter((c) => !c.url.includes('/token'))

describe('ramp contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({
      make: () => make(),
      signs: { rtx_purchase: '-', rtx_refund: '+', rmb_1: '-' },
      minEvents: 12,
    })
    // business, txns ×2, reimbursements, bills
    expect(r.pages).toBe(5)
  })

  it('fixture is redacted', () => assertRedacted(fx))
})

describe('ramp mapping', () => {
  it('maps accounts, balance, card transactions', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const acct = (id: string) => events.find((e): e is AccountUpsert => e.type === 'account.upsert' && e.externalId === id)
    expect(acct('biz_1:card')).toMatchObject({ accountType: 'credit_card', name: 'EXAMPLE LABS Ramp Card', currency: 'USD', institution: 'Ramp' })
    expect(acct('biz_1:reimbursements')).toMatchObject({ accountType: 'other', name: 'Ramp Reimbursements' })
    const bal = events.find((e): e is BalanceSnapshot => e.type === 'balance.snapshot')
    expect(bal).toMatchObject({ externalId: 'biz_1:card@2026-10-09', accountExternalId: 'biz_1:card', current: { minor: -312045, currency: 'USD' } })
    expect(txn(events, 'rtx_purchase')).toMatchObject({
      amount: { minor: -12345, currency: 'USD' }, status: 'posted', date: '2026-10-03', counterparty: 'Figma',
      rawText: 'FIGMA.COM SAN FRANCISCO | Design seats', categoryHint: 'Software', linkRefs: { card_id: 'card_r1' },
    })
    expect(txn(events, 'rtx_pending')).toMatchObject({ status: 'pending', date: '2026-09-25', amount: { minor: -10000 } })
    expect(txn(events, 'rtx_refund')?.amount.minor).toBe(2000)
    expect(txn(events, 'rtx_declined')?.status).toBe('void')
    // One token for the whole sync; every API call carries it; all GET.
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1)
    expect(apiCalls(calls).every((c) => c.method === 'GET' && c.headers.authorization === BEARER)).toBe(true)
    const tokenCall = calls.find((c) => c.url.includes('/token'))!
    expect(tokenCall.headers.authorization).toBe('Basic ' + Buffer.from('ramp_id_test:ramp_sec_test').toString('base64'))
    expect(tokenCall.body).toEqual({ grant_type: 'client_credentials', scope: 'transactions:read business:read bills:read reimbursements:read' })
  })

  it('maps reimbursements and bills', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(txn(events, 'rmb_1')).toMatchObject({ accountExternalId: 'biz_1:reimbursements', amount: { minor: -4550 }, status: 'posted', date: '2026-09-30', counterparty: 'Office Depot', rawText: 'Printer paper', categoryHint: 'reimbursement:OUT_OF_POCKET' })
    expect(txn(events, 'rmb_2')?.status).toBe('pending')
    expect(txn(events, 'rmb_3')?.status).toBe('void')
    const bill = (id: string) => events.find((e): e is InvoiceUpsert => e.type === 'invoice.upsert' && e.externalId === id)
    expect(bill('bill_open')).toEqual(expect.objectContaining({
      direction: 'payable', number: 'INV-2041', counterparty: 'Legal Partners LLP', issueDate: '2026-09-28', dueDate: '2026-10-28',
      total: { minor: 250000, currency: 'USD' }, amountPaid: { minor: 0, currency: 'USD' }, status: 'open',
      lines: [{ description: 'September retainer', amount: { minor: 250000, currency: 'USD' } }],
    }))
    expect(bill('bill_paid')).toMatchObject({ status: 'paid', amountPaid: { minor: 99900 } })
  })

  it('incremental cycle: window from the oldest pending, open + recently paid bills', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    await runSync(connector, conn, first.cursor)
    const later = apiCalls(calls.slice(n)).map((c) => new URL(c.url))
    const tx = later.find((u) => u.pathname.endsWith('/transactions') && !u.searchParams.get('start'))!
    expect(tx.searchParams.get('from_date')).toBe('2026-09-25T00:00:00Z')
    expect(later.find((u) => u.pathname.endsWith('/reimbursements'))?.searchParams.get('updated_after')).toBe('2026-09-25T00:00:00Z')
    const bills = later.filter((u) => u.pathname.endsWith('/bills')).map((u) => Object.fromEntries(u.searchParams))
    expect(bills).toEqual([
      { page_size: '2', payment_status: 'OPEN' },
      { page_size: '2', payment_status: 'PAID', from_paid_at: '2026-09-25T00:00:00Z' },
      { page_size: '2', is_archived: 'true' },
    ])
    // the cached token is reused across syncs
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1)
  })

  it('skips bills and reimbursements without the scope', async () => {
    const forbidden = { status: 403, json: { error_v2: { error_code: 'FORBIDDEN', message: 'missing scope', error_id: 'abcd1234', notes: '', additional_info: {} } } }
    const { connector } = make([
      { match: (u) => u.pathname === '/developer/v1/bills', respond: forbidden },
      { match: (u) => u.pathname === '/developer/v1/reimbursements', respond: forbidden },
    ])
    const r = await runSync(connector, conn, null)
    expect(r.complete).toBe(true)
    expect(r.events.some((e) => e.type === 'invoice.upsert')).toBe(false)
  })

  it('warns when bills or reimbursements are skipped for a missing scope', async () => {
    const forbidden = { status: 403, json: { error_v2: { error_code: 'FORBIDDEN', message: 'missing scope', error_id: 'abcd1234', notes: '', additional_info: {} } } }
    const { connector, calls } = make([
      { match: (u) => u.pathname === '/developer/v1/bills', respond: forbidden },
      { match: (u) => u.pathname === '/developer/v1/reimbursements', respond: forbidden },
    ])
    const cycle = async (start: string | null) => {
      const warnings: string[] = []
      let cursor = start
      for (;;) {
        const r = await connector.sync(conn, cursor)
        warnings.push(...(r.warnings ?? []))
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return { warnings, cursor }
    }
    const first = await cycle(null)
    expect(first.warnings).toEqual([RAMP_NO_REIMBURSEMENTS_WARNING, RAMP_NO_BILLS_WARNING])
    const n = calls.length
    // Incremental cycle: open bills denied → the paid-bills pass is skipped, one warning.
    const second = await cycle(first.cursor)
    expect(second.warnings).toEqual([RAMP_NO_REIMBURSEMENTS_WARNING, RAMP_NO_BILLS_WARNING])
    expect(calls.slice(n).filter((c) => new URL(c.url).pathname === '/developer/v1/bills')).toHaveLength(1)
    // With all scopes: no warnings.
    const ok = make()
    let cursor: string | null = null
    for (;;) {
      const r = await ok.connector.sync(conn, cursor)
      expect(r.warnings).toBeUndefined()
      cursor = r.cursor
      if (!r.hasMore) break
    }
  })
})

describe('ramp auth, tokens and errors', () => {
  it('refreshes an expired token and retries once after a 401 with a cached token', async () => {
    let tokens = 0
    let rejectOnce = true
    const { connector, calls, clock } = make([
      { method: 'POST', match: (u) => u.pathname === '/developer/v1/token', respond: () => ({ json: { ...fx.token, access_token: `ramp_business_tok_${++tokens}`, expires_in: 3600 } }) },
      {
        match: (u, init) => u.pathname === '/developer/v1/business/balance' && rejectOnce && new Headers(init?.headers).get('authorization') === 'Bearer ramp_business_tok_2',
        respond: () => {
          rejectOnce = false
          return { status: 401, json: { error_v2: { error_code: 'UNAUTHORIZED', message: 'token revoked', error_id: '00000001', notes: '', additional_info: {} } } }
        },
      },
    ])
    await connector.health(conn)
    expect(tokens).toBe(1)
    clock.t += 3_600_000 // past expiry
    await runSync(connector, conn, null, { maxPages: 1 })
    expect(tokens).toBe(3) // expired → token 2, 401 → token 3
    const bal = calls.filter((c) => c.url.includes('/business/balance'))
    expect(bal.map((c) => c.headers.authorization)).toEqual(['Bearer ramp_business_tok_2', 'Bearer ramp_business_tok_3'])
  })

  it('bad client credentials → auth, health needs_reauth', async () => {
    const { connector, calls } = make([{ method: 'POST', match: (u) => u.pathname === '/developer/v1/token', respond: { status: 401, json: { error: 'invalid_client', error_description: 'Client authentication failed' } } }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
    expect(await connector.health(conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/client id\/secret/) })
  })

  it('429 with Retry-After is retried; health ok', async () => {
    let n = 0
    const { connector, clock } = make([{ match: (u) => u.pathname === '/developer/v1/business' && n++ === 0, respond: { status: 429, headers: { 'retry-after': '1' }, json: { error_v2: { error_code: 'RATE', message: 'slow', error_id: '1', notes: '', additional_info: {} } } } }])
    const r = await runSync(connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBe(3)
    expect(clock.sleeps).toContain(1000)
    expect(await make().connector.health(conn)).toEqual({ status: 'ok' })
  })

  it('refuses to follow a pagination link to another host', async () => {
    const evil = { data: [], page: { next: 'https://evil.example.com/developer/v1/transactions?start=x' } }
    const { connector } = make([{ match: (u) => u.pathname === '/developer/v1/transactions' && !u.searchParams.get('start'), respond: { json: evil } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow(/another host/)
  })

  it('malformed secret → auth; connect validates input', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { clientId: 'x' } }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'no-colon' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(parseRampInput({ apiKey: ' a:b:c ' })).toEqual({ clientId: 'a', clientSecret: 'b:c' })
    expect(await connector.connect({ clientId: 'ramp_id_test', clientSecret: 'ramp_sec_test' })).toEqual({
      secret, config: { businessId: 'biz_1', businessName: 'Example Labs Inc.' },
    })
  })

  it('begin and describe', async () => {
    const { connector } = make()
    expect(await connector.begin()).toMatchObject({ kind: 'api_key', label: 'Ramp developer app', steps: expect.arrayContaining([expect.stringContaining('Client Credentials')]), helpUrl: expect.stringContaining('docs.ramp.com') })
    expect(connector.describe()).toMatchObject({ key: 'ramp', group: 'spend', auth: 'api_key', provides: ['balances', 'transactions', 'bills'] })
  })
})

describe('ramp webhooks', () => {
  const key = 'ramp-subscription-secret'
  const body = JSON.stringify({ id: 'evt_1', type: 'transactions.cleared', created_at: '2026-10-09T11:59:00Z', business_id: 'biz_1', object: { id: 'rtx_purchase' } })
  const sig = (b: string, k = key) => hmac('sha256', k, b).toString('hex')

  it('verifies signatures', async () => {
    const { connector } = make([], { webhookSecret: key })
    await expect(connector.webhook!.verify({ headers: { 'x-ramp-signature': sig(body) }, body })).resolves.toBeUndefined()
    expect(() => verifyRampWebhook({ headers: { 'x-ramp-signature': sig(body) }, body: body.replace('biz_1', 'biz_2') }, key)).toThrow(/signature/)
    expect(() => verifyRampWebhook({ headers: { 'x-ramp-signature': sig(body, 'other') }, body }, key)).toThrow(/signature/)
    expect(() => verifyRampWebhook({ headers: { 'x-ramp-signature': 'sha256=abc' }, body }, key)).toThrow(/malformed/)
    expect(() => verifyRampWebhook({ headers: {}, body }, key)).toThrow(/missing/)
  })

  it('interprets events', () => {
    expect(make().connector.webhook).toBeUndefined()
    expect(interpretRampWebhook({ headers: { 'x-ramp-webhook-id': 'evt_1' }, body })).toEqual({ action: 'sync', dedupeKey: 'ramp:evt_1', reason: 'transactions.cleared', match: { field: 'businessId', value: 'biz_1' } })
    expect(interpretRampWebhook({ headers: {}, body: JSON.stringify({ type: 'webhooks.verification', challenge: 'ramp_challenge_x' }) }).action).toBe('ignore')
    expect(interpretRampWebhook({ headers: {}, body: JSON.stringify({ id: 'e2', type: 'bills.paid', business_id: 'biz_1' }) })).toMatchObject({ action: 'sync', dedupeKey: 'ramp:e2' })
  })
})

describe('ramp one-click sign-in (OAuth)', () => {
  const app = { oauthClientId: 'agg_app_id', oauthClientSecret: 'agg_app_secret' }
  const ctx = { workspaceId: 'ws1', redirectUri: 'https://app.example/api/connectors/ramp/callback', state: 'state-123456789', userRef: 'p1' }
  const appBasic = `Basic ${Buffer.from('agg_app_id:agg_app_secret').toString('base64')}`

  it('without the app it stays paste-your-own-app', async () => {
    const { connector } = make()
    expect(connector.describe().auth).toBe('api_key')
    expect(await connector.begin(ctx)).toMatchObject({ kind: 'api_key' })
  })

  it('begin sends people to Ramp with read scopes', async () => {
    const { connector } = make([], { pageSize: 2, ...app })
    expect(connector.describe().auth).toBe('oauth')
    const b = await connector.begin(ctx)
    const u = new URL(b.kind === 'oauth' ? b.url : '')
    expect(u.origin + u.pathname).toBe('https://app.ramp.com/v1/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'agg_app_id',
      redirect_uri: ctx.redirectUri,
      scope: 'transactions:read business:read bills:read reimbursements:read',
      state: 'state-123456789',
    })
    const sb = make([], { pageSize: 2, env: 'sandbox', ...app })
    const ub = await sb.connector.begin(ctx)
    expect(ub.kind === 'oauth' && new URL(ub.url).host).toBe('demo.ramp.com')
  })

  it('connect exchanges the code with the app credentials; syncs use the refresh token', async () => {
    const { connector, calls } = make(
      [{ method: 'POST', match: (u, _i, body) => u.pathname === '/developer/v1/token' && (body as Record<string, string>).grant_type === 'authorization_code', respond: { json: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600 } } }],
      { pageSize: 2, ...app },
    )
    const r = await connector.connect({ code: 'code_1', redirectUri: ctx.redirectUri })
    expect(r.secret).toEqual({ kind: 'oauth', refreshToken: 'rt_1' })
    expect(r.config).toMatchObject({ businessId: expect.any(String) })
    const exchange = calls.find((c) => (c.body as Record<string, string>).grant_type === 'authorization_code')
    expect(exchange?.headers.authorization).toBe(appBasic)
    expect(exchange?.body).toMatchObject({ redirect_uri: ctx.redirectUri })
    const refresh = calls.find((c) => (c.body as Record<string, string>).grant_type === 'refresh_token')
    expect(refresh?.headers.authorization).toBe(appBasic)
    expect(refresh?.body).toMatchObject({ refresh_token: 'rt_1' })
  })

  it('a refresh token Ramp no longer accepts asks for a reconnect', async () => {
    const { connector } = make([{ method: 'POST', match: '/developer/v1/token', respond: { status: 400, json: { error: 'invalid_grant', error_description: 'revoked' } } }], { pageSize: 2, ...app })
    const oauthConn: ConnectionRef = { ...conn, secret: { kind: 'oauth', refreshToken: 'rt_dead' } }
    await expect(connector.sync(oauthConn, null)).rejects.toThrow(/reconnect Ramp/)
    expect(await connector.health(oauthConn)).toMatchObject({ status: 'needs_reauth' })
  })

  it('disconnect revokes sign-in tokens only; already-revoked is fine', async () => {
    const { connector, calls } = make([{ method: 'POST', match: '/developer/v1/token/revoke', respond: [{ status: 200, text: '' }, { status: 400, json: { error: 'invalid_grant' } }] }], { pageSize: 2, ...app })
    const oauthConn: ConnectionRef = { ...conn, secret: { kind: 'oauth', refreshToken: 'rt_1' } }
    await connector.disconnect!(oauthConn)
    await connector.disconnect!(oauthConn)
    await connector.disconnect!(conn)
    const revokes = calls.filter((c) => c.url.endsWith('/developer/v1/token/revoke'))
    expect(revokes).toHaveLength(2)
    expect(revokes[0]?.body).toEqual({ token: 'rt_1' })
    expect(revokes[0]?.headers.authorization).toBe(appBasic)
  })
})

describe('ramp: declined, archived, scopes, refresh lifetime', () => {
  const app = { oauthClientId: 'agg_app_id', oauthClientSecret: 'agg_app_secret' }
  const bill = (events: NormalizedEvent[], id: string) => events.find((e): e is InvoiceUpsert => e.type === 'invoice.upsert' && e.externalId === id)

  it('asks for transactions in every state, so a declined one replaces its pending row', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    expect(txn(first.events, 'rtx_pending')?.status).toBe('pending')
    const txCalls = () => calls.filter((c) => new URL(c.url).pathname === '/developer/v1/transactions' && !new URL(c.url).searchParams.get('start'))
    expect(txCalls().every((c) => new URL(c.url).searchParams.get('state') === 'ALL')).toBe(true)
    // Next cycle Ramp reports the same transaction as DECLINED (only returned because of state=ALL).
    const declined = { data: [{ ...(fx.transactions[''] as Page).data.find((t) => (t as { id: string }).id === 'rtx_pending') as object, state: 'DECLINED' }], page: { next: null } }
    const later = make([{ match: (u) => u.pathname === '/developer/v1/transactions' && u.searchParams.get('state') === 'ALL', respond: { json: declined } }])
    const second = await runSync(later.connector, conn, first.cursor)
    expect(txn(second.events, 'rtx_pending')?.status).toBe('void')
  })

  it('incremental cycles read archived bills so a stored bill turns void; a fresh connection skips that pass', async () => {
    const archived = { data: [{ ...(fx.bills[''] as Page).data[0] as object, status_summary: 'ARCHIVED' }], page: { next: null } }
    const { connector, calls } = make([{ match: (u) => u.pathname === '/developer/v1/bills' && u.searchParams.get('is_archived') === 'true', respond: { json: archived } }])
    const first = await runSync(connector, conn, null)
    expect(first.complete).toBe(true)
    expect(bill(first.events, 'bill_open')?.status).toBe('open')
    expect(calls.some((c) => new URL(c.url).searchParams.has('is_archived'))).toBe(false)
    const second = await runSync(connector, conn, first.cursor)
    expect(second.complete).toBe(true)
    // bills_open emits it as open first, then the archived pass voids it (later events win).
    const last = second.events.filter((e): e is InvoiceUpsert => e.type === 'invoice.upsert' && e.externalId === 'bill_open').at(-1)
    expect(last?.status).toBe('void')
    // The cycle closes cleanly: the next one starts at the business page again.
    const third = await connector.sync(conn, second.cursor)
    expect(third.events.some((e) => e.type === 'account.upsert')).toBe(true)
  })

  it('does not ask for cards:read', async () => {
    expect(RAMP_SCOPES).not.toContain('cards:read')
    const steps = await make().connector.begin()
    expect(JSON.stringify(steps)).not.toContain('cards:read')
  })

  it('stores the refresh lifetime when Ramp sends one, and keeps it across refreshes', async () => {
    const { connector, clock } = make(
      [
        { method: 'POST', match: (u, _i, body) => u.pathname === '/developer/v1/token' && (body as Record<string, string>).grant_type === 'authorization_code', respond: { json: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600, refresh_token_expires_in: 30 * 86400 } } },
        // A refresh reports a fresh-looking lifetime; it must not move the stored expiry.
        { method: 'POST', match: (u, _i, body) => u.pathname === '/developer/v1/token' && (body as Record<string, string>).grant_type === 'refresh_token', respond: { json: { access_token: 'at_2', expires_in: 3600, refresh_token_expires_in: 30 * 86400 } } },
      ],
      { pageSize: 2, ...app },
    )
    const r = await connector.connect({ code: 'code_1', redirectUri: 'https://app.example/cb' })
    expect(r.secret).toEqual({ kind: 'oauth', refreshToken: 'rt_1', refreshExpiresAt: '2026-11-08T12:00:00.000Z' })
    const oauthConn: ConnectionRef = { ...conn, secret: r.secret }
    // Far from the end: no warning, and no secret change.
    const early = await connector.sync(oauthConn, null)
    expect(early.warnings).toBeUndefined()
    expect(early.updatedSecret).toBeUndefined()
    // Within 7 days of the stored expiry: warn once per cycle.
    clock.t = Date.parse('2026-11-02T12:00:00Z')
    const near = await connector.sync(oauthConn, null)
    expect(near.warnings).toEqual(['Ramp access ends on 2026-11-08; reconnect Ramp before then'])
    // Past it: needs reauth, saying when it ended.
    clock.t = Date.parse('2026-11-08T12:00:01Z')
    await expect(connector.sync(oauthConn, null)).rejects.toMatchObject({ kind: 'auth', message: 'Ramp access ended on 2026-11-08; reconnect Ramp' })
    expect(await connector.health(oauthConn)).toMatchObject({ status: 'needs_reauth' })
  })

  it('without refresh_token_expires_in the secret shape is unchanged and nothing warns', async () => {
    const { connector } = make(
      [{ method: 'POST', match: (u, _i, body) => u.pathname === '/developer/v1/token' && (body as Record<string, string>).grant_type === 'authorization_code', respond: { json: { access_token: 'at_1', refresh_token: 'rt_1', expires_in: 3600 } } }],
      { pageSize: 2, ...app },
    )
    const r = await connector.connect({ code: 'code_1', redirectUri: 'https://app.example/cb' })
    expect(r.secret).toEqual({ kind: 'oauth', refreshToken: 'rt_1' })
    expect((await connector.sync({ ...conn, secret: r.secret }, null)).warnings).toBeUndefined()
  })
})
