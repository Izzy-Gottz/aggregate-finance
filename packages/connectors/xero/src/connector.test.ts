import type { ConnectionRef, CreditNoteUpsert, InvoiceUpsert, NormalizedEvent, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { hmac, MemoryRawSink, plainError, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { docKey, Subledger } from '@agfn/invoices'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createXeroConnector, type XeroSecret } from './connector.ts'
import { xeroDate } from './map.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/demo-company.json', import.meta.url), 'utf8')) as Record<string, unknown>
const NOW = Date.parse('2026-10-09T12:00:00Z')
const TENANT = 'aaaaaaaa-0000-4000-8000-00000000000a'

function paged(key: string): FixtureRoute {
  return {
    match: (url) => url.pathname.endsWith(`/${key}`),
    respond: (url) => {
      const page = Number(url.searchParams.get('page') ?? 1)
      const size = Number(url.searchParams.get('pageSize') ?? 100)
      const all = (FIX[key] as unknown[]) ?? []
      return { json: { [key]: all.slice((page - 1) * size, page * size) } }
    },
  }
}

function make(opts: { extra?: FixtureRoute[]; tokens?: Partial<XeroSecret['tokens']>; pageSize?: number; saved?: unknown[]; now?: number } = {}) {
  const ff = fixtureFetch([
    ...(opts.extra ?? []),
    { match: '/connections', respond: { json: FIX.connections } },
    { match: '/Organisation', respond: { json: { Organisations: FIX.Organisations } } },
    { match: '/Accounts', respond: { json: { Accounts: FIX.Accounts } } },
    ...['Invoices', 'CreditNotes', 'Payments', 'Overpayments', 'Prepayments', 'BankTransactions', 'ManualJournals'].map(paged),
    { match: '/Reports/ProfitAndLoss', respond: { json: FIX.ProfitAndLoss } },
  ])
  const connector = createXeroConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(opts.now ?? NOW), random: () => 0.5, saveSecret: async (_id, sec) => void opts.saved?.push(sec) },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test', redirectUri: 'https://app.example.com/oauth/xero' },
    pageSize: opts.pageSize ?? 3,
  })
  const conn: ConnectionRef = {
    id: 'conn_xero',
    workspaceId: 'ws_1',
    connectorKey: 'xero',
    secret: { tokens: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: NOW + 1_800_000, ...opts.tokens } } satisfies XeroSecret,
    config: { tenantId: TENANT, baseCurrency: 'GBP', pnlMonths: 0 },
  }
  return { connector, conn, ff }
}

const find = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T, id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as Extract<NormalizedEvent, { type: T }> | undefined

describe('xero connector', () => {
  // Xero's /Date(ms)/ timestamps are 13-digit numbers, not account numbers.
  it('fixtures are redacted', () => assertRedacted(FIX, [/^17\d{11}$/]))

  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 15 })
  })

  it('maps documents, credits, payments, overpayments (golden)', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(ff.calls.every((c) => c.url.includes('/connections') || c.headers['xero-tenant-id'] === TENANT)).toBe(true)

    expect(find(events, 'invoice.upsert', 'inv-a')).toMatchObject({
      number: 'INV-0101',
      issueDate: '2026-08-03',
      dueDate: '2026-09-02',
      total: { minor: 120_000, currency: 'GBP' },
      tax: { minor: 20_000, currency: 'GBP' },
      subtotal: { minor: 100_000, currency: 'GBP' },
      amountPaid: { minor: 50_000, currency: 'GBP' },
      status: 'partially_paid',
      lines: [{ description: 'Consulting', quantity: 4, amount: { minor: 100_000, currency: 'GBP' }, tax: { minor: 20_000, currency: 'GBP' }, category: 'revenue' }],
    })
    expect(find(events, 'invoice.upsert', 'inv-b')).toMatchObject({ amountCredited: { minor: 12_000, currency: 'GBP' }, status: 'partially_paid' })
    expect(find(events, 'invoice.upsert', 'inv-d')?.status).toBe('draft')
    expect(find(events, 'invoice.upsert', 'inv-e')?.status).toBe('void')
    expect(find(events, 'invoice.upsert', 'bill-a')).toMatchObject({ direction: 'payable', lines: [{ category: 'rent' }] })
    expect(find(events, 'invoice.upsert', 'bill-b')).toMatchObject({ status: 'paid', lines: [{ category: 'software' }] })
    expect(find(events, 'ledger_account.upsert', 'acc-old')).toMatchObject({ active: false })

    expect(find(events, 'payment.applied', 'pay-1')).toMatchObject({
      direction: 'receivable',
      date: '2026-08-20',
      reference: 'BACS 4471',
      method: 'batch:batch-9',
      applications: [{ invoiceExternalId: 'inv-a', amount: { minor: 50_000, currency: 'GBP' } }],
    })
    expect(find(events, 'payment.applied', 'pay-x')?.status).toBe('void')
    expect(find(events, 'payment.applied', 'overpayment:op-1')).toMatchObject({
      amount: { minor: 80_000, currency: 'USD' },
      applications: [{ invoiceExternalId: 'inv-c', amount: { minor: 50_000, currency: 'USD' } }],
      unapplied: { minor: 30_000, currency: 'USD' },
    })
    expect(find(events, 'credit_note.upsert', 'cn-1')).toMatchObject({ appliedTo: 'invoice', status: 'applied', invoiceExternalId: 'inv-b' })
    expect(find(events, 'credit_note.upsert', 'cn-2')).toMatchObject({ appliedTo: 'customer_credit', status: 'open', amount: { minor: 6_000, currency: 'GBP' } })

    const pnl = events.find((e) => e.type === 'report.snapshot') as ReportSnapshot
    expect(pnl.totals?.netIncome).toEqual({ minor: 135_100, currency: 'GBP' })
    expect(pnl.rows.map((r) => [r.section, r.account, r.amount.minor, r.accountExternalId ?? null])).toEqual([
      ['Income', 'Sales', 340_000, 'acc-200'],
      ['Income', 'Total Income', 340_000, null],
      ['Less Operating Expenses', 'Rent', 200_000, 'acc-469'],
      ['Less Operating Expenses', 'Subscriptions', 4_900, 'acc-485'],
      ['Less Operating Expenses', 'Total Operating Expenses', 204_900, null],
      ['Net Profit', 'Net Profit', 135_100, null],
    ])
  })

  it('feeds the subledger to the penny: Xero AmountDue equals our remaining', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    const s = new Subledger()
    const issues = events
      .filter((e): e is InvoiceUpsert | PaymentApplied | CreditNoteUpsert => e.type === 'invoice.upsert' || e.type === 'payment.applied' || e.type === 'credit_note.upsert')
      .flatMap((e) => s.apply(e).issues)
    expect(issues).toEqual([])
    for (const o of FIX.Invoices as Array<Record<string, unknown>>) {
      if (o.Status === 'DRAFT' || o.Status === 'VOIDED') continue
      expect(s.view(docKey(conn.id, String(o.InvoiceID)), '2026-10-09')?.remaining.minor, String(o.InvoiceID)).toBe(Math.round(Number(o.AmountDue) * 100))
    }
  })

  it('incremental passes send If-Modified-Since', async () => {
    const { connector, conn, ff } = make()
    const first = await runSync(connector, conn, null)
    ff.calls.length = 0
    await runSync(connector, conn, first.cursor)
    const listCalls = ff.calls.filter((c) => /\/(Invoices|CreditNotes|Payments|Overpayments|Prepayments)\?/.test(c.url))
    expect(listCalls.length).toBeGreaterThan(0)
    expect(listCalls.every((c) => c.headers['if-modified-since'] === '2026-10-09T11:55:00')).toBe(true)
  })

  it('stops on the daily limit instead of sleeping for hours', async () => {
    const { connector, conn } = make({
      extra: [{ match: '/Organisation', respond: { status: 429, headers: { 'retry-after': '36000', 'x-rate-limit-problem': 'day' }, json: {} } }],
    })
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'rate_limited', code: 'limit_day' })
    const h = await connector.health(conn)
    expect(h.status).toBe('rate_limited')
  })

  it('connect picks the organisation and its base currency', async () => {
    const { connector } = make({
      extra: [{ method: 'POST', match: '/connect/token', respond: { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 1800 } } }],
    })
    const c = await connector.connect({ code: 'code-1' })
    expect(c.config).toEqual({ tenantId: TENANT, baseCurrency: 'GBP', tenantName: 'Demo Company (UK)', displayName: 'Xero · Demo Company (UK)', xeroConnectionId: 'c0ffee00-0000-4000-8000-00000000000a' })
    await expect(connector.connect({ code: 'code-1', tenantId: 'nope' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('connect picks the organisation from this sign-in, not the first one ever shared', async () => {
    const jwt = (claims: object) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.')
    const orgs = [
      { id: 'c1', tenantId: 'old-org', tenantType: 'ORGANISATION', tenantName: 'Aggregate', authEventId: 'ev-old', createdDateUtc: '2026-10-11T02:50:00' },
      { id: 'c2', tenantId: TENANT, tenantType: 'ORGANISATION', tenantName: 'Demo Company (UK)', authEventId: 'ev-new', createdDateUtc: '2026-10-11T02:59:00' },
    ]
    const { connector } = make({
      extra: [
        { method: 'POST', match: '/connect/token', respond: { json: { access_token: jwt({ authentication_event_id: 'ev-new' }), refresh_token: 'rt-1', expires_in: 1800 } } },
        { match: '/connections', respond: { json: orgs } },
      ],
    })
    expect((await connector.connect({ code: 'code-1' })).config).toMatchObject({ tenantId: TENANT, tenantName: 'Demo Company (UK)' })
    const { justAuthorized } = await import('./connector.ts')
    // No event id in the token: the most recently connected organisation.
    expect(justAuthorized(orgs, 'not-a-jwt')?.tenantId).toBe(TENANT)
  })

  it('every organisation ticked in one sign-in becomes its own connection, sharing the token', async () => {
    const jwt = (claims: object) => ['h', Buffer.from(JSON.stringify(claims)).toString('base64url'), 's'].join('.')
    const orgs = [
      { id: 'c0', tenantId: 'older', tenantType: 'ORGANISATION', tenantName: 'Old Org', authEventId: 'ev-old', createdDateUtc: '2026-10-01T00:00:00' },
      { id: 'c1', tenantId: TENANT, tenantType: 'ORGANISATION', tenantName: 'Demo Company (UK)', authEventId: 'ev-1', createdDateUtc: '2026-10-11T02:59:00' },
      { id: 'c2', tenantId: 'acme-tenant', tenantType: 'ORGANISATION', tenantName: 'Acme Ltd', authEventId: 'ev-1', createdDateUtc: '2026-10-11T02:58:00' },
    ]
    const { connector } = make({
      extra: [
        { method: 'POST', match: '/connect/token', respond: { json: { access_token: jwt({ authentication_event_id: 'ev-1' }), refresh_token: 'rt-1', expires_in: 1800 } } },
        { match: '/connections', respond: { json: orgs } },
      ],
    })
    const r = await connector.connect({ code: 'code-1' })
    const all = [r, ...(r.additional ?? [])]
    expect(all.map((x) => [x.config.tenantId, x.config.displayName, x.config.xeroConnectionId, x.config.sharedSecretKey])).toEqual([
      [TENANT, 'Xero · Demo Company (UK)', 'c1', 'xero:ev-1'],
      ['acme-tenant', 'Xero · Acme Ltd', 'c2', 'xero:ev-1'],
    ])
    expect(all.every((x) => (x.secret as { tokens: { refreshToken: string } }).tokens.refreshToken === 'rt-1')).toBe(true)
  })

  it('disconnect removes only that organisation; the token is revoked only with the last one', async () => {
    const { connector, conn, ff } = make({
      extra: [
        { method: 'DELETE', match: '/connections/c2', respond: { status: 200, json: {} } },
        { method: 'POST', match: '/connect/revocation', respond: { status: 200, json: {} } },
      ],
    })
    const shared = { ...conn, config: { ...conn.config, xeroConnectionId: 'c2', sharedSecretKey: 'xero:ev-1' } }
    await connector.disconnect!({ ...shared, config: { ...shared.config, lastOfGrant: false } })
    expect(ff.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([['DELETE', '/connections/c2']])
    ff.calls.length = 0
    await connector.disconnect!({ ...shared, config: { ...shared.config, lastOfGrant: true } })
    expect(ff.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([['DELETE', '/connections/c2'], ['POST', '/connect/revocation']])
  })

  it('a connection saved before the id was stored finds its Xero connection by tenant, and removes it', async () => {
    const { connector, conn, ff } = make({
      extra: [
        { method: 'DELETE', match: '/connections/c0ffee00-0000-4000-8000-00000000000a', respond: { status: 200, json: {} } },
        { method: 'POST', match: '/connect/revocation', respond: { status: 200, json: {} } },
      ],
    })
    await connector.disconnect!(conn)
    expect(ff.calls.map((c) => [c.method, new URL(c.url).pathname])).toEqual([['GET', '/connections'], ['DELETE', '/connections/c0ffee00-0000-4000-8000-00000000000a'], ['POST', '/connect/revocation']])
  })

  it("a revoke Xero refuses isn't silent: the error says to remove the app in Xero, and never carries a token", async () => {
    const { connector, conn } = make({
      extra: [
        { method: 'DELETE', match: '/connections/c2', respond: { status: 200, json: {} } },
        { method: 'POST', match: '/connect/revocation', respond: { status: 400, json: { error: 'invalid_grant' } } },
      ],
    })
    const err = await connector.disconnect!({ ...conn, config: { ...conn.config, xeroConnectionId: 'c2' } }).then(() => null, (e: unknown) => e as Error)
    expect(err?.message).toMatch(/refused to revoke access \(HTTP 400\).*Settings → Connected apps/)
    expect(err?.message).not.toMatch(/rt-test|at-test/)
  })

  it('disconnecting one of several organisations that share a token saves the refreshed token for the others', async () => {
    const saved: unknown[] = []
    const { connector, conn } = make({
      saved,
      tokens: { expiresAt: NOW - 1 },
      extra: [
        { method: 'POST', match: '/connect/token', respond: { json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 1800, token_type: 'Bearer' } } },
        { method: 'DELETE', match: '/connections/c2', respond: { status: 200, json: {} } },
      ],
    })
    await connector.disconnect!({ ...conn, config: { ...conn.config, xeroConnectionId: 'c2', sharedSecretKey: 'xero:ev-1', lastOfGrant: false } })
    expect(saved).toEqual([{ tokens: expect.objectContaining({ accessToken: 'at-new', refreshToken: 'rt-new' }) }])
  })

  it('health never refreshes (Xero refresh tokens are single-use)', async () => {
    const { connector, conn, ff } = make({ tokens: { expiresAt: NOW - 1 } })
    expect(await connector.health(conn)).toMatchObject({ status: 'ok', message: expect.stringMatching(/next sync/) })
    expect(ff.calls).toHaveLength(0)
  })

  it('lists every organisation the grant reaches, and adds one as its own connection on the same token', async () => {
    const DEMO = 'bbbbbbbb-0000-4000-8000-00000000000b'
    const both = [...(FIX.connections as unknown[]), { id: 'c-demo', tenantId: DEMO, tenantType: 'ORGANISATION', tenantName: 'Demo Company (US)', authEventId: 'older' }]
    const { connector, conn } = make({
      extra: [
        { match: (u) => u.pathname === '/connections', respond: { json: both } },
        { match: (u, i) => u.pathname.endsWith('/Organisation') && (i?.headers as Record<string, string> | undefined)?.['xero-tenant-id'] === DEMO, respond: { json: { Organisations: [{ Name: 'Demo Company (US)', BaseCurrency: 'USD' }] } } },
      ],
    })
    expect((await connector.listShared!(conn)).map((o) => [o.id, o.name, o.match.field])).toEqual([
      [TENANT, expect.any(String), 'tenantId'],
      [DEMO, 'Demo Company (US)', 'tenantId'],
    ])
    const added = await connector.connectShared!(conn, DEMO)
    expect(added.secret).toEqual(conn.secret)
    expect(added.config).toMatchObject({ tenantId: DEMO, tenantName: 'Demo Company (US)', displayName: 'Xero · Demo Company (US)', xeroConnectionId: 'c-demo', sharedSecretKey: expect.stringMatching(/^xero:/) })
    await expect(connector.connectShared!(conn, 'nope')).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  // Certification (connection checkpoints): when the person removes Aggregate in Xero, or the refresh token lapses
  // after 60 days unused, the connection asks to reconnect. It never retries in a loop.
  it('a refresh token Xero refuses (app removed in Xero, or 60 days unused) means reconnect, not a retry', async () => {
    const { connector, conn, ff } = make({
      tokens: { expiresAt: NOW - 1 },
      extra: [{ method: 'POST', match: '/connect/token', respond: { status: 400, json: { error: 'invalid_grant' } } }],
    })
    const err = await connector.sync(conn, null).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'auth', retryable: false })
    expect(plainError(err, 'Xero').status).toBe('needs_reauth')
    // One refresh attempt, then nothing else: no data call with a dead token.
    expect(ff.calls.filter((c) => c.url.includes('/connect/token'))).toHaveLength(1)
    expect(ff.calls.filter((c) => c.url.includes('api.xero.com'))).toEqual([])
  })

  it('a live token Xero rejects (the organisation was disconnected in Xero) means reconnect; health says so too', async () => {
    const { connector, conn } = make({ extra: [{ match: (u) => u.host === 'api.xero.com', respond: { status: 401, json: { Title: 'Unauthorized', Detail: 'AuthenticationUnsuccessful' } } }] })
    const err = await connector.sync(conn, null).catch((e: unknown) => e)
    expect(err).toMatchObject({ kind: 'auth' })
    expect(plainError(err, 'Xero').status).toBe('needs_reauth')
    expect((await connector.health(conn)).status).toBe('needs_reauth')
  })

  it('webhook signature check', () => {
    const { connector } = make()
    const body = JSON.stringify({ events: [{ tenantId: TENANT, eventCategory: 'INVOICE', resourceId: 'inv-a' }], firstEventSequence: 1, lastEventSequence: 1 })
    const good = connector.verifyWebhook({ headers: { 'x-xero-signature': hmac('sha256', 'key-test', body).toString('base64') }, body }, 'key-test')
    expect(good).toMatchObject({ valid: true, outcomes: [{ match: { field: 'tenantId', value: TENANT }, action: 'sync' }] })
    expect(connector.verifyWebhook({ headers: { 'x-xero-signature': 'nope' }, body }, 'key-test').valid).toBe(false)
  })

  it('parses both Xero date forms', () => {
    expect(xeroDate('/Date(1787184000000+0000)/')).toBe('2026-08-20')
    expect(xeroDate('2026-08-03T00:00:00')).toBe('2026-08-03')
    expect(xeroDate('garbage')).toBeUndefined()
  })
})

describe("Xero P&L months are the organisation's local months", () => {
  const ranges = async (now: number, org: Record<string, unknown>, timeZone?: string) => {
    const orgs = [{ ...(FIX.Organisations as Array<Record<string, unknown>>)[0], ...org }]
    const { connector, conn, ff } = make({ now, extra: [{ match: '/Organisation', respond: { json: { Organisations: orgs } } }] })
    await runSync(connector, timeZone ? { ...conn, timeZone } : conn, null)
    return ff.calls.filter((c) => c.url.includes('/Reports/ProfitAndLoss')).map((c) => { const u = new URL(c.url); return `${u.searchParams.get('fromDate')}:${u.searchParams.get('toDate')}` })
  }

  it("uses Organisation.Timezone (a Windows zone id): Oct 1 morning in Auckland is October there, while UTC is still Sep 30", async () => {
    expect(await ranges(Date.parse('2026-09-30T20:00:00Z'), { Timezone: 'NEWZEALANDSTANDARDTIME' })).toEqual(['2026-10-01:2026-10-01'])
  })

  it("falls back to the workspace's zone when Xero's isn't one we know, and to UTC without either", async () => {
    const now = Date.parse('2026-10-01T03:00:00Z')
    expect(await ranges(now, { Timezone: 'SOMEWHERESTANDARDTIME' }, 'America/New_York')).toEqual(['2026-09-01:2026-09-30'])
    expect(await ranges(now, { Timezone: undefined })).toEqual(['2026-10-01:2026-10-01'])
  })
})

