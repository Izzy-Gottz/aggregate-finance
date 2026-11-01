import type { ConnectionRef, CreditNoteUpsert, InvoiceUpsert, NormalizedEvent, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, cursorCodec, hmac, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { aging, docKey, Subledger } from '@agfn/invoices'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { classifyQboError, createQuickBooksConnector, MAPPING_VERSION, resetIntuitDiscovery, type QuickBooksSecret } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox.json', import.meta.url), 'utf8')) as Record<string, unknown>
const ENTITIES = ['Account', 'Invoice', 'CreditMemo', 'Payment', 'Bill', 'VendorCredit', 'BillPayment']
const NOW = Date.parse('2026-10-09T12:00:00Z')

// Intuit's discovery document, as published (production and sandbox share these three).
const DISCOVERY = {
  issuer: 'https://oauth.platform.intuit.com/op/v1',
  authorization_endpoint: 'https://appcenter.intuit.com/connect/oauth2',
  token_endpoint: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  revocation_endpoint: 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke',
}
beforeEach(() => resetIntuitDiscovery())

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    {
      match: (url) => url.pathname.endsWith('/query'),
      respond: (url) => {
        const q = url.searchParams.get('query') ?? ''
        const entity = ENTITIES.find((e) => new RegExp(`FROM ${e}\\b`).test(q)) as string
        const start = Number(/STARTPOSITION (\d+)/.exec(q)?.[1] ?? 1)
        const max = Number(/MAXRESULTS (\d+)/.exec(q)?.[1] ?? 1000)
        const all = (FIX[entity] as unknown[]) ?? []
        return { json: { QueryResponse: { [entity]: all.slice(start - 1, start - 1 + max), startPosition: start, maxResults: max }, time: '2026-10-09T05:00:00-07:00' } }
      },
    },
    // CDC answers for the entities asked (the connector asks one at a time).
    {
      match: '/cdc',
      respond: (url) => {
        const want = new Set((url.searchParams.get('entities') ?? '').split(','))
        const cdc = FIX.CDC as { CDCResponse: Array<{ QueryResponse: Array<Record<string, unknown>> }> }
        return { json: { CDCResponse: cdc.CDCResponse.map((r) => ({ QueryResponse: r.QueryResponse.map((qr) => Object.fromEntries(Object.entries(qr).filter(([k]) => want.has(k)))) })) } }
      },
    },
    { match: (u) => u.pathname.startsWith('/.well-known/openid'), respond: { json: DISCOVERY } },
    { match: '/reports/ProfitAndLoss', respond: { json: FIX.ProfitAndLoss } },
    { match: '/companyinfo/', respond: { json: { CompanyInfo: { CompanyName: 'Example Co' } } } },
    { match: '/preferences', respond: { json: { Preferences: { CurrencyPrefs: { HomeCurrency: { value: 'USD' } } } } } },
  ]
}

function make(opts: { tokens?: Partial<QuickBooksSecret['tokens']>; extra?: FixtureRoute[]; pageSize?: number; now?: number } = {}) {
  const ff = fixtureFetch(routes(opts.extra))
  const raw = new MemoryRawSink()
  const clock = fakeClock(opts.now ?? NOW)
  const connector = createQuickBooksConnector({
    deps: { raw, fetch: ff.fetch, clock, random: () => 0.5 },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test', redirectUri: 'https://app.example.com/oauth/quickbooks' },
    pageSize: opts.pageSize ?? 2,
  })
  const secret: QuickBooksSecret = { tokens: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: NOW + 3_600_000, ...opts.tokens } }
  const conn: ConnectionRef = {
    id: 'conn_qbo',
    workspaceId: 'ws_1',
    connectorKey: 'quickbooks',
    secret,
    config: { realmId: '9130000000000000', environment: 'sandbox', homeCurrency: 'USD', pnlMonths: 1 },
  }
  return { connector, conn, ff, raw }
}

const byId = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T, id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as Extract<NormalizedEvent, { type: T }> | undefined

describe('quickbooks connector', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract (paging, determinism, resume)', async () => {
    const report = await runConnectorContract({ make: () => make(), minEvents: 15 })
    expect(report.pages).toBeGreaterThan(ENTITIES.length) // pageSize 2 forces several pages
  })

  it('maps documents, payments and credits (golden)', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })

    expect(byId(events, 'invoice.upsert', '130')).toMatchObject({
      direction: 'receivable',
      number: '1037',
      counterparty: 'Example Studio LLC',
      total: { minor: 108_000, currency: 'USD' },
      tax: { minor: 8_000, currency: 'USD' },
      subtotal: { minor: 100_000, currency: 'USD' },
      amountPaid: { minor: 108_000, currency: 'USD' },
      status: 'paid',
      lines: [{ description: 'Design retainer, August', amount: { minor: 100_000, currency: 'USD' }, quantity: 1, category: 'revenue' }],
    })
    expect(byId(events, 'invoice.upsert', '132')).toMatchObject({
      total: { minor: 40_000, currency: 'EUR' },
      lines: [{ amount: { minor: 45_000, currency: 'EUR' } }, { amount: { minor: -5_000, currency: 'EUR' } }],
    })
    expect(byId(events, 'invoice.upsert', '133')?.status).toBe('void')
    expect(byId(events, 'invoice.upsert', '160')).toMatchObject({ direction: 'payable', lines: [{ category: 'software' }], status: 'open' })
    expect(byId(events, 'invoice.upsert', '161')).toMatchObject({ lines: [{ category: 'rent' }], status: 'paid' })
    expect(byId(events, 'ledger_account.upsert', '7')).toMatchObject({ classification: 'expense', code: '6100', name: 'Software & Subscriptions' })
    expect(byId(events, 'ledger_account.upsert', '1')?.classification).toBe('income')

    // Payment 150: 1930 cash + a 100 credit memo, across two invoices.
    expect(byId(events, 'payment.applied', '150')).toMatchObject({
      amount: { minor: 193_000, currency: 'USD' },
      reference: 'WIRE-8812',
      method: 'Wire',
      applications: [
        { invoiceExternalId: '130', amount: { minor: 98_000, currency: 'USD' } },
        { invoiceExternalId: '131', amount: { minor: 95_000, currency: 'USD' } },
      ],
    })
    expect(byId(events, 'credit_note.upsert', '140~150')).toMatchObject({
      amount: { minor: 10_000, currency: 'USD' },
      applications: [{ invoiceExternalId: '130', amount: { minor: 10_000, currency: 'USD' } }],
      appliedTo: 'invoice',
    })
    expect(byId(events, 'credit_note.upsert', '140')).toMatchObject({ amount: { minor: 5_000, currency: 'USD' }, appliedTo: 'customer_credit', status: 'open' })
    expect(byId(events, 'payment.applied', '151')).toMatchObject({ unapplied: { minor: 25_000, currency: 'USD' } })
    expect(byId(events, 'payment.applied', '170')).toMatchObject({ direction: 'payable', method: 'Check', applications: [{ invoiceExternalId: '161' }] })

    const pnl = events.find((e) => e.type === 'report.snapshot') as ReportSnapshot
    expect(pnl.externalId).toBe('pnl:2026-10-01:2026-10-09:accrual')
    // QuickBooks' own summary rows, for checking our P&L against theirs.
    expect(pnl.totals?.netIncome).toEqual({ minor: -131_240, currency: 'USD' })
    expect(pnl.rows.map((r) => [r.section, r.account, r.amount.minor, r.depth])).toEqual([
      ['Income', 'Services', 350_000, 1],
      ['Income', 'Total Income', 350_000, 0],
      ['Expenses', 'Rent or Lease', 400_000, 1],
      ['Expenses', 'Software & Subscriptions', 81_240, 1],
      ['Expenses', 'Total Expenses', 481_240, 0],
      ['NetIncome', 'Net Income', -131_240, 0],
    ])
    expect(events.filter((e) => e.type === 'report.snapshot').map((e) => e.externalId)).toEqual([
      'pnl:2026-10-01:2026-10-09:accrual',
      'pnl:2026-09-01:2026-09-30:accrual',
    ])
  })

  it('feeds the subledger to the cent: QBO balances equal our remaining amounts', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    const s = new Subledger()
    const issues = events
      .filter((e): e is InvoiceUpsert | PaymentApplied | CreditNoteUpsert => e.type === 'invoice.upsert' || e.type === 'payment.applied' || e.type === 'credit_note.upsert')
      .flatMap((e) => s.apply(e).issues)
    expect(issues).toEqual([])
    const asOf = '2026-10-09'
    for (const o of [...(FIX.Invoice as Array<Record<string, unknown>>), ...(FIX.Bill as Array<Record<string, unknown>>)]) {
      const v = s.view(docKey(conn.id, String(o.Id)), asOf)
      expect(v?.remaining.minor, `doc ${o.Id}`).toBe(Math.round(Number(o.Balance) * 100))
    }
    expect(s.view(docKey(conn.id, '131'), asOf)).toMatchObject({ status: 'partially_paid', paid: { minor: 100_000, currency: 'USD' } })
    expect(s.unappliedCredits('receivable').map((c) => [c.sourceKey, c.amount.minor]).sort()).toEqual([
      [docKey(conn.id, '140'), 5_000],
      [docKey(conn.id, '151'), 25_000],
    ])
    const [eur, usd] = aging(s, 'receivable', asOf)
    expect(eur?.total.minor).toBe(40_000)
    expect(usd?.buckets['1_30'].minor).toBe(150_000)
  })

  it('a cursor from an older mapping version re-reads everything once (new entity types reach old data)', async () => {
    const { connector, conn, ff } = make()
    const old = cursorCodec('quickbooks', MAPPING_VERSION - 1).encode({ p: 0, s: 1, since: '2026-10-09T11:55:00+00:00', mark: '2026-10-09T11:55:00+00:00' })
    const r = await runSync(connector, conn, old)
    const queries = ff.calls.filter((c) => c.url.includes('/query')).map((c) => new URL(c.url).searchParams.get('query') ?? '')
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.some((q) => q.includes('LastUpdatedTime'))).toBe(false)
    expect(r.events.some((e) => e.type === 'invoice.upsert')).toBe(true)
  })

  it('incremental pass filters by LastUpdatedTime and turns CDC deletions into voids', async () => {
    const { connector, conn, ff } = make()
    const first = await runSync(connector, conn, null)
    ff.calls.length = 0
    const second = await runSync(connector, conn, first.cursor)
    // (The chart-of-accounts lookup for line sections is always a full read.)
    const queries = ff.calls.filter((c) => c.url.includes('/query') && !decodeURIComponent(c.url).replace(/\+/g, ' ').includes('Active IN (true,false) ORDERBY')).map((c) => new URL(c.url).searchParams.get('query') ?? '')
    expect(queries.filter((q) => !q.includes("MetaData.LastUpdatedTime >= '2026-10-09T11:55:00+00:00'"))).toEqual([])
    expect(ff.calls.some((c) => c.url.includes('/cdc') && c.url.includes('changedSince=2026-10-09T11%3A55%3A00%2B00%3A00'))).toBe(true)
    expect(byId(second.events, 'invoice.upsert', '129')).toMatchObject({ status: 'void', total: { minor: 0, currency: 'USD' }, issueDate: '2026-10-08' })
    expect(byId(second.events, 'payment.applied', '149')).toMatchObject({ status: 'void', applications: [] })
    // Non-deleted CDC rows are ignored (the queries already return them).
    expect(second.events.filter((e) => e.externalId === '131' && e.type === 'invoice.upsert')).toHaveLength(1)
  })

  it("a refused refresh while the sign-in still had time is a revoke (removed in QuickBooks); after it ended, only a reconnect", async () => {
    const refused = [{ method: 'POST' as const, match: '/oauth2/v1/tokens/bearer', respond: { status: 400, json: { error: 'invalid_grant', error_description: 'Incorrect Token type or clientID' } } }]
    const live = make({ tokens: { expiresAt: NOW - 1, extra: { refreshExpiresAt: NOW + 50 * 86_400_000 } }, extra: refused })
    await expect(live.connector.sync(live.conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'revoked', message: expect.stringMatching(/removed in QuickBooks.*deleted from Aggregate/) })
    // No stored end date (secrets from before it was kept): a refusal is still a revoke.
    const old = make({ tokens: { expiresAt: NOW - 1 }, extra: refused })
    await expect(old.connector.sync(old.conn, null)).rejects.toMatchObject({ code: 'revoked' })
    const ended = make({ tokens: { expiresAt: NOW - 1, extra: { refreshExpiresAt: NOW - 1000 } }, extra: refused })
    await expect(ended.connector.sync(ended.conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'invalid_grant' })
    // Our own app credentials refused is never the person's revoke.
    const client = make({ tokens: { expiresAt: NOW - 1 }, extra: [{ method: 'POST', match: '/oauth2/v1/tokens/bearer', respond: { status: 401, json: { error: 'invalid_client' } } }] })
    await expect(client.connector.sync(client.conn, null)).rejects.toMatchObject({ code: 'invalid_client' })
  })

  it('refreshes an expired token and hands back the rotated secret', async () => {
    const { connector, conn, ff } = make({
      tokens: { expiresAt: NOW - 1 },
      extra: [{ method: 'POST', match: '/oauth2/v1/tokens/bearer', respond: { json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, token_type: 'bearer' } } }],
    })
    const r = await connector.sync(conn, null)
    expect((r as { updatedSecret?: QuickBooksSecret }).updatedSecret?.tokens).toMatchObject({ accessToken: 'at-new', refreshToken: 'rt-new' })
    const tokenCall = ff.calls.find((c) => c.url.includes('/tokens/bearer'))
    expect(tokenCall?.headers.authorization).toMatch(/^Basic /)
    expect(ff.calls.find((c) => c.url.includes('/query'))?.headers.authorization).toBe('Bearer at-new')
  })

  it("keeps when Intuit ends the sign-in and warns in its last 30 days (Intuit's five-year limit)", async () => {
    const refreshWith = (secs: number) =>
      make({ tokens: { expiresAt: NOW - 1 }, extra: [{ method: 'POST', match: '/oauth2/v1/tokens/bearer', respond: { json: { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600, x_refresh_token_expires_in: secs } } }] })
    const usual = refreshWith(8_726_400) // ~101 days: an ordinary rolling refresh
    const r1 = await usual.connector.sync(usual.conn, null)
    expect((r1 as { updatedSecret?: QuickBooksSecret }).updatedSecret?.tokens.extra?.refreshExpiresAt).toBe(NOW + 8_726_400_000)
    expect(r1.warnings ?? []).toEqual([])

    const ending = refreshWith(20 * 86_400)
    const r2 = await ending.connector.sync(ending.conn, null)
    expect(r2.warnings).toContain('QuickBooks ends this sign-in on October 29, 2026 (Intuit limits a sign-in to five years). Reconnect QuickBooks before then to keep syncing.')
    // Later syncs keep warning from the stored date, without a refresh.
    const later = make({ tokens: { extra: { refreshExpiresAt: NOW + 5 * 86_400_000 } } })
    expect((await later.connector.sync(later.conn, null)).warnings?.[0]).toMatch(/^QuickBooks ends this sign-in on October 14, 2026/)
  })

  it('maps provider faults: 401 → needs_reauth, throttling retried, validation is permanent', async () => {
    const fault = (type: string, code: string) => ({ Fault: { Error: [{ Message: 'msg', Detail: 'detail', code }], type } })
    const reauth = make({ extra: [{ match: '/companyinfo/', respond: { status: 401, json: fault('AUTHENTICATION', '3200') } }] })
    expect((await reauth.connector.health(reauth.conn)).status).toBe('needs_reauth')

    const throttled = make({
      extra: [{ match: (u) => u.pathname.endsWith('/query'), respond: [{ status: 429, headers: { 'retry-after': '1' }, json: fault('THROTTLE', '003001') }, { json: { QueryResponse: {} } }] }],
    })
    await expect(throttled.connector.sync(throttled.conn, null)).resolves.toMatchObject({ hasMore: true })

    const bad = make({ extra: [{ match: (u) => u.pathname.endsWith('/query'), respond: { status: 400, json: fault('ValidationFault', '4000') } }] })
    await expect(bad.connector.sync(bad.conn, null)).rejects.toMatchObject({ kind: 'permanent' })
    await expect(bad.connector.sync({ ...bad.conn, secret: null }, null)).rejects.toBeInstanceOf(ConnectorError)
  })

  it('connect exchanges the code and reads the home currency', async () => {
    const { connector } = make({
      extra: [{ method: 'POST', match: '/oauth2/v1/tokens/bearer', respond: { json: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 } } }],
    })
    const c = await connector.connect({ code: 'code-1', realmId: '9130000000000000', environment: 'sandbox' })
    expect(c.config).toEqual({ realmId: '9130000000000000', environment: 'sandbox', homeCurrency: 'USD', companyName: 'Example Co', displayName: 'QuickBooks · Example Co' })
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('verifies webhooks by HMAC and only asks for a sync', () => {
    const { connector } = make()
    const body = JSON.stringify({ eventNotifications: [{ realmId: '9130000000000000', dataChangeEvent: { entities: [{ name: 'Invoice', id: '130', operation: 'Update' }] } }] })
    const sig = hmac('sha256', 'verifier-test', body).toString('base64')
    expect(connector.verifyWebhook({ headers: { 'intuit-signature': sig }, body }, 'verifier-test')).toMatchObject([
      { match: { field: 'realmId', value: '9130000000000000' }, action: 'sync' },
    ])
    expect(connector.verifyWebhook({ headers: { 'intuit-signature': 'bad' }, body }, 'verifier-test')).toEqual([])
  })

  it('disconnect revokes at Intuit: the refresh token, Basic client auth, JSON body, and no refresh first', async () => {
    const { connector, conn, ff } = make({ tokens: { expiresAt: NOW - 1 }, extra: [{ method: 'POST', match: '/v2/oauth2/tokens/revoke', respond: { status: 200, json: {} } }] })
    await connector.disconnect!(conn)
    // The revoke endpoint comes from Intuit's sandbox discovery document (this connection is sandbox).
    expect(ff.calls.map((c) => [c.method, new URL(c.url).host + new URL(c.url).pathname])).toEqual([
      ['GET', 'developer.api.intuit.com/.well-known/openid_sandbox_configuration'],
      ['POST', 'developer.api.intuit.com/v2/oauth2/tokens/revoke'],
    ])
    const call = ff.calls[1]!
    expect(call.headers.authorization).toBe(`Basic ${Buffer.from('client-test:secret-test').toString('base64')}`)
    expect(call.body).toEqual({ token: 'rt-test' })
  })

  it('a revoke Intuit refuses or never answers is reported with what to do in QuickBooks, never with a token', async () => {
    const refused = make({ extra: [{ method: 'POST', match: '/v2/oauth2/tokens/revoke', respond: { status: 400, json: { error: 'invalid_request' } } }] })
    const err = await refused.connector.disconnect!(refused.conn).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/refused to revoke access \(HTTP 400\).*Settings → Apps/)
    expect(err?.message).not.toMatch(/rt-test|at-test|secret-test/)
    const down = createQuickBooksConnector({ deps: { raw: new MemoryRawSink(), fetch: async () => { throw new TypeError('fetch failed') }, clock: fakeClock(NOW) }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x' } })
    await expect(down.disconnect!(refused.conn)).rejects.toThrow(/could not be reached.*Settings → Apps/)
  })

  it("an entity this company's plan lacks is skipped with an \"unknown, not zero\" warning; the rest of the sync goes on", async () => {
    const planFault = { Fault: { Error: [{ Message: 'Feature Not Supported', Detail: "We're sorry, this feature is not included in your QuickBooks Online Simple Start subscription.", code: '5020' }], type: 'ValidationFault' } }
    const { connector, conn, ff } = make({ extra: [{ match: (u) => u.pathname.endsWith('/query') && /FROM Bill\b/.test(u.searchParams.get('query') ?? ''), respond: { status: 400, json: planFault } }] })
    const first = await runSync(connector, conn, null)
    expect(first.complete).toBe(true)
    const q = (e: string) => ff.calls.some((c) => new RegExp(`FROM ${e}\\b`).test(new URL(c.url).searchParams.get('query') ?? ''))
    // Later phases still ran.
    expect(['VendorCredit', 'BillPayment', 'Purchase', 'Deposit', 'JournalEntry'].every(q)).toBe(true)
    expect(ff.calls.some((c) => c.url.includes('/reports/ProfitAndLoss'))).toBe(true)
    // The next pass's CDC leaves Bill out too, after its query is refused again.
    ff.calls.length = 0
    const page = await connector.sync(conn, first.cursor)
    expect(page.warnings ?? []).toEqual([])
    const all = await runSync(connector, conn, first.cursor)
    expect(ff.calls.filter((c) => c.url.includes('/cdc')).map((c) => new URL(c.url).searchParams.get('entities'))).not.toContain('Bill')
    expect(all.complete).toBe(true)
  })

  it('says "unknown, not zero" for what the plan leaves out', async () => {
    const planFault = { Fault: { Error: [{ Message: 'Feature Not Supported', Detail: 'This feature is not included in your QuickBooks plan.', code: '5020' }], type: 'ValidationFault' } }
    const { connector, conn } = make({ extra: [{ match: (u) => u.pathname.endsWith('/query') && /FROM Bill\b/.test(u.searchParams.get('query') ?? ''), respond: { status: 400, json: planFault } }] })
    const warnings: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 40; i++) {
      const r = await connector.sync(conn, cursor)
      warnings.push(...(r.warnings ?? []))
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(warnings).toContain("Your QuickBooks plan doesn't include bills, so Aggregate can't read them: they're unknown here, not zero.")
  })

  it("a CDC entity at Intuit's 1,000-object cap warns instead of silently missing deletions", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ Id: String(9000 + i), MetaData: { LastUpdatedTime: '2026-10-09T10:00:00-07:00' } }))
    const { connector, conn } = make()
    const first = await runSync(connector, conn, null)
    const capped = make({ extra: [{ match: (u) => u.pathname.endsWith('/cdc') && u.searchParams.get('entities') === 'Invoice', respond: { json: { CDCResponse: [{ QueryResponse: [{ Invoice: many }] }] } } }] })
    const warnings: string[] = []
    let cursor: string | null = first.cursor
    for (let i = 0; i < 40; i++) {
      const r = await capped.connector.sync(capped.conn, cursor)
      warnings.push(...(r.warnings ?? []))
      cursor = r.cursor
      if (!r.hasMore) break
    }
    expect(warnings.some((w) => /more invoices than it reports at once \(1,000\)/.test(w))).toBe(true)
  })

  it('maps faults: throttling waits a minute (rescheduled, not slept through), codes with or without leading zeros, 5xx first', async () => {
    const f = (code: string, type = 'ValidationFault', msg = 'm') => ({ Fault: { Error: [{ Message: msg, code }], type } })
    expect(classifyQboError({ status: 429, body: f('3001', 'THROTTLE') })).toMatchObject({ kind: 'rate_limited', retryAfterMs: 60_000 })
    expect(classifyQboError({ status: 401, body: f('003200', 'AUTHENTICATION', 'message=AuthenticationFailed; errorCode=003200; statusCode=401: Token revoked') })).toMatchObject({ kind: 'auth', code: '3200', message: expect.stringMatching(/^QuickBooks access was removed or has expired.*Reconnect/) })
    expect(classifyQboError({ status: 500, body: f('3100') })).toMatchObject({ kind: 'transient' })
    expect(classifyQboError({ status: 403, body: f('3100', 'AUTHORIZATION') })).toMatchObject({ kind: 'auth' })
    expect(classifyQboError({ status: 400, body: f('6000', 'ValidationFault', 'Business Validation Error') })).toMatchObject({ kind: 'permanent' })
    expect(classifyQboError({ status: 400, body: f('5020', 'ValidationFault', 'Feature Not Supported: does not support this feature') })).toMatchObject({ kind: 'permanent', code: 'plan_limit' })
  })

  it('reads inactive accounts and items too (their lines keep their P&L section)', async () => {
    const { connector, conn, ff } = make()
    await runSync(connector, conn, null)
    const qs = ff.calls.map((c) => new URL(c.url).searchParams.get('query') ?? '').filter((q) => /FROM (Account|Item)\b/.test(q))
    expect(qs.length).toBeGreaterThan(0)
    expect(qs.every((q) => q.includes('Active IN (true,false)'))).toBe(true)
  })

  it('webhooks: legacy and CloudEvents notices both mean "sync that company", one outcome per company; a bad signature is refused', async () => {
    const f = fixtureFetch(routes())
    const connector = createQuickBooksConnector({ deps: { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock(NOW) }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x' }, webhookVerifier: 'verifier-test' })
    const sign = (body: string) => hmac('sha256', 'verifier-test', body).toString('base64')
    const cloud = JSON.stringify([
      { specversion: '1.0', id: 'e1', source: 'intuit.qbo', type: 'qbo.invoice.created.v1', intuitentityid: '129', intuitaccountid: '9130000000000000' },
      { specversion: '1.0', id: 'e2', source: 'intuit.qbo', type: 'qbo.bill.updated.v1', intuitentityid: '7', intuitaccountid: '9130000000000002' },
    ])
    await connector.webhook!.verify({ headers: { 'intuit-signature': sign(cloud) }, body: cloud })
    expect(connector.webhook!.interpret({ headers: {}, body: cloud }).map((o) => [o.action, o.match?.value])).toEqual([['sync', '9130000000000000'], ['sync', '9130000000000002']])
    const legacy = JSON.stringify({ eventNotifications: [{ realmId: '9130000000000000', dataChangeEvent: { entities: [{ name: 'Invoice', id: '129', operation: 'Update' }] } }] })
    expect(connector.webhook!.interpret({ headers: {}, body: legacy }).map((o) => o.match?.value)).toEqual(['9130000000000000'])
    await expect(connector.webhook!.verify({ headers: { 'intuit-signature': 'bad' }, body: cloud })).rejects.toMatchObject({ kind: 'auth' })
    expect(createQuickBooksConnector({ deps: { raw: new MemoryRawSink() }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x' } }).webhook).toBeUndefined()
  })

  it("takes Intuit's endpoints from its discovery document, only on intuit.com, and falls back when it can't be read", async () => {
    const revoke = (doc: unknown, status = 200) => {
      resetIntuitDiscovery()
      return make({ extra: [{ match: (u) => u.pathname.startsWith('/.well-known/'), respond: { status, json: doc } }, { method: 'POST', match: (u) => u.pathname.includes('revoke'), respond: { json: {} } }] })
    }
    const moved = revoke({ ...DISCOVERY, revocation_endpoint: 'https://oauth.platform.intuit.com/v3/revoke' })
    await moved.connector.disconnect!(moved.conn)
    expect(moved.ff.calls.at(-1)?.url).toBe('https://oauth.platform.intuit.com/v3/revoke')
    const hostile = revoke({ ...DISCOVERY, revocation_endpoint: 'https://evil.example.com/revoke' })
    await hostile.connector.disconnect!(hostile.conn)
    expect(hostile.ff.calls.at(-1)?.url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke')
    const down = revoke({}, 503)
    await down.connector.disconnect!(down.conn)
    expect(down.ff.calls.at(-1)?.url).toBe('https://developer.api.intuit.com/v2/oauth2/tokens/revoke')
  })
})

describe('QuickBooks P&L months are the company\'s local months', () => {
  const pnlRanges = async (now: number, timeZone?: string) => {
    const { connector, conn, ff } = make({ now })
    await runSync(connector, timeZone ? { ...conn, timeZone } : conn, null)
    return ff.calls.filter((c) => c.url.includes('/reports/ProfitAndLoss')).map((c) => { const u = new URL(c.url); return `${u.searchParams.get('start_date')}:${u.searchParams.get('end_date')}` })
  }

  it('the evening of Sep 30 in California is still September there, though UTC is already Oct 1', async () => {
    const now = Date.parse('2026-10-01T03:00:00Z')
    expect(await pnlRanges(now, 'America/Los_Angeles')).toEqual(['2026-09-01:2026-09-30', '2026-08-01:2026-08-31'])
    // Without a workspace time zone: UTC, as before.
    expect(await pnlRanges(now)).toEqual(['2026-10-01:2026-10-01', '2026-09-01:2026-09-30'])
  })

  it('the morning of Oct 1 in Sydney is October there, though UTC is still Sep 30', async () => {
    expect(await pnlRanges(Date.parse('2026-09-30T22:00:00Z'), 'Australia/Sydney')).toEqual(['2026-10-01:2026-10-01', '2026-09-01:2026-09-30'])
  })
})

describe('QuickBooks full listings and its own exchange rates', () => {
  it('a full pass ends with listing.complete naming when it began; an incremental pass and a pass missing an entity do not', async () => {
    const { connector, conn } = make()
    const first = await runSync(connector, conn, null)
    const listings = first.events.filter((e) => e.type === 'listing.complete')
    expect(listings).toEqual([{ type: 'listing.complete', externalId: `listing:${new Date(NOW).toISOString()}`, connectionId: conn.id, kinds: ['invoice', 'bill', 'payment', 'journal', 'credit_note'], startedAt: new Date(NOW).toISOString() }])
    assertValidEvents(first.events, { connectionId: conn.id })
    const next = await runSync(connector, conn, first.cursor)
    expect(next.events.some((e) => e.type === 'listing.complete')).toBe(false)

    const planFault = { Fault: { Error: [{ Message: 'Feature Not Supported', Detail: 'not included in your QuickBooks Online Simple Start subscription.', code: '5020' }], type: 'ValidationFault' } }
    const lacking = make({ extra: [{ match: (u) => u.pathname.endsWith('/query') && /FROM Bill\b/.test(u.searchParams.get('query') ?? ''), respond: { status: 400, json: planFault } }] })
    expect((await runSync(lacking.connector, lacking.conn, null)).events.some((e) => e.type === 'listing.complete')).toBe(false)
  })

  it("a foreign-currency document carries QuickBooks' ExchangeRate as fx; a home-currency one doesn't", async () => {
    const eur = { Id: '9001', DocNumber: 'E-1', TxnDate: '2026-09-15', CustomerRef: { value: '1', name: 'Euro GmbH' }, CurrencyRef: { value: 'EUR' }, ExchangeRate: 1.085, TotalAmt: 1000, Balance: 1000, Line: [{ Amount: 1000, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: {} }], MetaData: { LastUpdatedTime: '2026-09-15T10:00:00-07:00' } }
    const { connector, conn } = make({
      extra: [{ match: (u) => u.pathname.endsWith('/query') && /FROM Invoice\b/.test(u.searchParams.get('query') ?? '') && u.searchParams.get('query')!.includes('STARTPOSITION 1 '), respond: { json: { QueryResponse: { Invoice: [eur, { ...eur, Id: '9002', CurrencyRef: { value: 'USD' }, ExchangeRate: 1 }] } } } }],
    })
    const { events } = await runSync(connector, conn, null)
    const inv = (id: string) => events.find((e) => e.type === 'invoice.upsert' && e.externalId === id) as { fx?: unknown; total: { currency: string } } | undefined
    expect(inv('9001')).toMatchObject({ total: { currency: 'EUR' }, fx: { rate: '1.085', home: 'USD' } })
    expect(inv('9002')?.fx).toBeUndefined()
  })
})

