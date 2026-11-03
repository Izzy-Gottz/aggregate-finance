import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectBegin, ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createHarvestConnector, getOnly, HarvestClient, HARVEST_NOT_SET_UP, HARVEST_TOKEN_REFUSED, HARVEST_TOKEN_WARNING, NOT_REVOKED_OAUTH, NOT_REVOKED_TOKEN, REPORT_ROW_INVOICED, REPORT_ROW_PAID, REPORT_ROW_TAX, type HarvestConnectorOptions } from './index.ts'

type Row = Record<string, unknown> & { id: number; state: string; issue_date: string; paid_date: string | null; currency: string; amount: number; due_amount: number }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/harvest.json', import.meta.url), 'utf8')) as { accounts: { accounts: unknown[] }; invoices: Row[]; payments: Record<string, unknown[]> }

const oauthOpt = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/harvest/callback' }
const conn: ConnectionRef = { id: 'conn_h', workspaceId: 'ws1', connectorKey: 'harvest', secret: { kind: 'token', accessToken: 'tok_' + 'a'.repeat(20) }, config: { accountId: '111' } }
const API = 'https://api.harvestapp.com/v2'

/** A small Harvest: filters on `from`, pages by following links.next, payments by cursor. */
function harvest(data: { invoices?: Row[]; payments?: Record<string, unknown[]>; perPayments?: number; hook?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const invoices = data.invoices ?? fx.invoices
  const payments = data.payments ?? fx.payments
  return [
    {
      method: 'GET',
      match: (u) => u.pathname === '/v2/invoices',
      respond: (u) => {
        const hook = data.hook?.(u)
        if (hook) return hook
        const from = u.searchParams.get('from')
        const rows = invoices.filter((i) => !from || i.issue_date >= from)
        const size = Number(u.searchParams.get('per_page') ?? 2000)
        const n = Number(u.searchParams.get('page') ?? 1)
        const more = n * size < rows.length
        const next = new URL(u)
        next.searchParams.set('page', String(n + 1))
        return { json: { invoices: rows.slice((n - 1) * size, n * size), links: { next: more ? next.toString() : null } } }
      },
    },
    {
      method: 'GET',
      match: (u) => /^\/v2\/invoices\/\d+\/payments$/.test(u.pathname),
      respond: (u) => {
        const hook = data.hook?.(u)
        if (hook) return hook
        const id = u.pathname.split('/')[3]!
        const rows = payments[id] ?? []
        const size = data.perPayments ?? 2000
        const at = Number(u.searchParams.get('cursor') ?? 0)
        const more = at + size < rows.length
        const next = new URL(u)
        next.searchParams.set('cursor', String(at + size))
        return { json: { invoice_payments: rows.slice(at, at + size), links: { next: more ? next.toString() : null } } }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = harvest(), opts: Partial<HarvestConnectorOptions> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createHarvestConnector({ ...opts }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const inv = (o: Partial<Row> & { id: number }): Row => ({ state: 'open', currency: 'USD', amount: 0, due_amount: 0, tax_amount: 0, tax2_amount: 0, issue_date: '2026-09-02', paid_date: null, ...o })
const pay = (id: number, amount: number, paid_date: string) => ({ id, amount, paid_date })

describe('harvest contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('the client can only GET', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'OPTIONS', 'HEAD'])('%s throws before anything leaves', async (method) => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await expect(getOnly(under)(`${API}/invoices/1`, { method })).rejects.toBeInstanceOf(ConnectorError)
    expect(sent).toBe(0)
  })
  it('a GET, and a request with no method, goes through', async () => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await getOnly(under)(`${API}/invoices`)
    await getOnly(under)(`${API}/invoices`, { method: 'GET' })
    expect(sent).toBe(2)
  })
  it('holds inside HarvestClient, past its public surface', async () => {
    const f = fixtureFetch(harvest())
    const client = new HarvestClient('t'.repeat(20), '111', { fetch: f.fetch, clock: fakeClock() })
    const http = (client as unknown as { http: { request(r: { method: string; path: string; json?: unknown }): Promise<unknown> } }).http
    for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) await expect(http.request({ method, path: '/invoices/1', json: {} })).rejects.toMatchObject({ kind: 'permanent' })
    expect(f.calls).toEqual([])
  })
  it('a full sync sends nothing but GET', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('only ever a report snapshot', () => {
  it('emits report.snapshot and nothing that could post', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })
  it('carries no net income a check could read as books', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    for (const s of snaps(events).values()) {
      expect(s.totals).toBeUndefined()
      expect(s.rows.map((r) => r.account.toLowerCase()).join()).not.toMatch(/income|profit/)
    }
  })
  it('keeps no client, line, note or person: raw holds the month’s totals only', async () => {
    const { connector, raw } = make()
    const { events } = await runSync(connector, conn, null)
    const everything = JSON.stringify([events, [...raw.records.entries()]])
    expect(everything).not.toMatch(/MUST-NOT-BE-KEPT|owner@example|client|line_items/)
  })
})

describe('totals, worked by hand', () => {
  // USD September, by issue_date: 1200.50 (1001) + 999.99 (1002) + 150.01 (1004, written off, still invoiced)
  //   + -25.00 (1005, a credit) = 2325.50. 1003 is a draft, 1000 is August, and 900 is outside the window.
  // Tax: 100.25 (1001) + 9.99 (1002, second tax) = 110.24.
  // Paid in September, by paid_date, whatever month the invoice is from: 1200.50 (1001) + 100.00 (1004) + 400.00 (1000,
  //   an August invoice) + 650.00 - 50.00 (900, a 2024 invoice, with a payment reversed) = 2300.50.
  it('September in USD, to the cent', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))).toEqual({ [REPORT_ROW_INVOICED]: 232550, [REPORT_ROW_TAX]: 11024, [REPORT_ROW_PAID]: 230050 })
  })
  it('a payment counts in the month it was paid, not the invoice’s', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const s = snaps(events)
    expect(rows(s.get('harvest:2026-10:USD'))).toEqual({ [REPORT_ROW_INVOICED]: 0, [REPORT_ROW_TAX]: 0, [REPORT_ROW_PAID]: 50000 })
    expect(rows(s.get('harvest:2026-08:USD'))).toEqual({ [REPORT_ROW_INVOICED]: 40000, [REPORT_ROW_TAX]: 0, [REPORT_ROW_PAID]: 0 })
  })
  it('each currency alone, zero-decimal included, never added together', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const s = snaps(events)
    expect(rows(s.get('harvest:2026-09:JPY'))).toEqual({ [REPORT_ROW_INVOICED]: 50000, [REPORT_ROW_TAX]: 5000, [REPORT_ROW_PAID]: 50000 })
    expect(s.get('harvest:2026-09:JPY')?.currency).toBe('JPY')
    expect(rows(s.get('harvest:2026-09:EUR'))).toEqual({ [REPORT_ROW_INVOICED]: 10010, [REPORT_ROW_TAX]: 0, [REPORT_ROW_PAID]: 0 })
  })
  it('a credit invoice and a reversed payment bring the month down, past zero if need be', async () => {
    const invoices = [inv({ id: 1, amount: -40, due_amount: 0, state: 'paid', paid_date: '2026-09-05' })]
    const { connector } = make(harvest({ invoices, payments: { 1: [pay(1, -40, '2026-09-05')] } }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))).toEqual({ [REPORT_ROW_INVOICED]: -4000, [REPORT_ROW_TAX]: 0, [REPORT_ROW_PAID]: -4000 })
  })
  it('floats add up exactly: 0.1 + 0.2 three times over', async () => {
    const invoices = [1, 2, 3].flatMap((n) => [inv({ id: n * 10, amount: 0.1, due_amount: 0.1 }), inv({ id: n * 10 + 1, amount: 0.2, due_amount: 0.2 })])
    const { connector } = make(harvest({ invoices }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))[REPORT_ROW_INVOICED]).toBe(90)
  })
  it('a month a currency has left reads zero, and one with no invoices at all gets a snapshot', async () => {
    const { connector } = make()
    const first = await runSync(connector, conn, null)
    const { connector: later } = make(harvest({ invoices: [inv({ id: 1, amount: 5, due_amount: 5 })] }))
    const { events } = await runSync(later, conn, first.cursor)
    expect(rows(snaps(events).get('harvest:2026-09:JPY'))[REPORT_ROW_INVOICED]).toBe(0)
    expect(snaps(events).get('harvest:2026-07:EUR')).toBeDefined()
  })
  it('the current month ends today', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(snaps(events).get('harvest:2026-10:USD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09', basis: 'accrual', kind: 'profit_and_loss' })
    expect(snaps(events).get('harvest:2026-09:USD')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
  })
  it('an amount that isn’t a number stops the sync without repeating it', async () => {
    const { connector } = make(harvest({ invoices: [inv({ id: 1, amount: 'SECRET-TEXT' as never })] }))
    const e = await runSync(connector, conn, null).catch((x: Error) => x)
    expect(e).toBeInstanceOf(ConnectorError)
    expect((e as Error).message).not.toContain('SECRET-TEXT')
  })
  it('an invoice with no currency stops the sync; it’s never guessed as dollars', async () => {
    const { connector } = make(harvest({ invoices: [inv({ id: 1, currency: '', amount: 5, due_amount: 5 })] }))
    await expect(runSync(connector, conn, null)).rejects.toBeInstanceOf(ConnectorError)
  })
})

describe('paging and cost', () => {
  const many = Array.from({ length: 250 }, (_, i) => inv({ id: 5000 - i, amount: 1, due_amount: 1 }))
  it('every page is read, by following links.next', async () => {
    const { connector, calls } = make(harvest({ invoices: many }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))[REPORT_ROW_INVOICED]).toBe(25000)
    expect(calls.filter((c) => new URL(c.url).pathname === '/v2/invoices').length).toBe(3)
  })
  it('a payments list on several pages is read to the end', async () => {
    const payments = { 1: [pay(1, 1, '2026-09-05'), pay(2, 2, '2026-09-06'), pay(3, 4, '2026-09-07')] }
    const { connector } = make(harvest({ invoices: [inv({ id: 1, amount: 7, due_amount: 0, state: 'paid', paid_date: '2026-09-07' })], payments, perPayments: 2 }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))[REPORT_ROW_PAID]).toBe(700)
  })
  it('a row pushed onto the next page by a new invoice doesn’t count twice', async () => {
    const invoices = [inv({ id: 3, amount: 1, due_amount: 1 }), inv({ id: 2, amount: 10, due_amount: 10 }), inv({ id: 1, amount: 100, due_amount: 100 })]
    const pages: Record<string, FixtureResponse> = {
      '1': { json: { invoices: invoices.slice(0, 2), links: { next: `${API}/invoices?page=2` } } },
      // Invoice 2 again: something new arrived at the top between the two reads.
      '2': { json: { invoices: invoices.slice(1), links: { next: null } } },
    }
    const { connector } = make(harvest({ hook: (u) => (u.pathname === '/v2/invoices' ? pages[u.searchParams.get('page') ?? '1'] : undefined) }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('harvest:2026-09:USD'))[REPORT_ROW_INVOICED]).toBe(11100)
  })
  it('a stop on any page resumes without losing or doubling a cent', async () => {
    const whole = await runSync(make(harvest({ invoices: many })).connector, conn, null)
    const { connector } = make(harvest({ invoices: many }))
    let cursor: string | null = null
    const events: NormalizedEvent[] = []
    for (;;) {
      const page = await connector.sync(conn, cursor)
      events.push(...page.events)
      cursor = page.cursor
      if (!page.hasMore) break
    }
    expect(rows(snaps(events).get('harvest:2026-09:USD'))).toEqual(rows(snaps(whole.events).get('harvest:2026-09:USD')))
  })
  it('asks for no payments on an unpaid invoice or a draft', async () => {
    const { connector, calls } = make(harvest({ invoices: [inv({ id: 1, amount: 9, due_amount: 9 }), inv({ id: 2, amount: 9, due_amount: 9, state: 'draft' })] }))
    await runSync(connector, conn, null)
    expect(calls.filter((c) => c.url.includes('/payments'))).toEqual([])
  })
  it('asks for no payments on an invoice fully paid before the window', async () => {
    const invoices = [inv({ id: 1, amount: 9, due_amount: 0, state: 'paid', issue_date: '2024-03-01', paid_date: '2024-04-01' })]
    const { connector, calls } = make(harvest({ invoices }))
    await runSync(connector, conn, null)
    expect(calls.filter((c) => c.url.includes('/payments'))).toEqual([])
  })
  it('first sync reads 24 months, with a year of older invoices for their payments; later ones recompute 6', async () => {
    const { connector, calls } = make()
    const first = await runSync(connector, conn, null)
    expect(new URL(calls[0]!.url).searchParams.get('from')).toBe('2023-11-01')
    expect([...snaps(first.events).keys()].sort()[0]).toBe('harvest:2024-11:EUR')
    const later = make()
    const second = await runSync(later.connector, conn, first.cursor)
    expect(new URL(later.calls[0]!.url).searchParams.get('from')).toBe('2025-05-01')
    expect([...snaps(second.events).keys()].sort()[0]).toBe('harvest:2026-05:EUR')
  })
  it('refuses a next link off Harvest’s API: the token never leaves', async () => {
    const { connector, calls } = make(harvest({ hook: (u) => (u.pathname === '/v2/invoices' && !u.searchParams.get('page') ? { json: { invoices: [inv({ id: 1 })], links: { next: 'https://evil.example.com/v2/invoices?page=2' } } } : undefined) }))
    await expect(runSync(connector, conn, null)).rejects.toBeInstanceOf(ConnectorError)
    expect(calls.every((c) => c.url.startsWith(API))).toBe(true)
  })
  it('a 200 that isn’t a list never reads as a month of nothing', async () => {
    const { connector } = make(harvest({ hook: (u) => (u.pathname === '/v2/invoices' ? { text: '<html>maintenance</html>' } : undefined) }))
    await expect(runSync(connector, conn, null)).rejects.toBeInstanceOf(ConnectorError)
  })
})

describe('headers', () => {
  it('every request carries the account, a bearer token and a User-Agent naming Aggregate with a link', async () => {
    const { connector, calls } = make()
    await connector.sync(conn, null)
    expect(calls[0]!.headers).toMatchObject({ 'harvest-account-id': '111', authorization: `Bearer ${'tok_' + 'a'.repeat(20)}` })
    expect(calls[0]!.headers['user-agent']).toMatch(/^Aggregate \(https:\/\/aggregate\.finance\)$/)
  })
})

describe('errors', () => {
  const failing = (r: FixtureResponse): FixtureRoute[] => [{ match: (u) => u.hostname === 'api.harvestapp.com', respond: r }]
  it('401 is an auth failure with the words to fix it', async () => {
    const { connector } = make(failing({ status: 401, json: { error: 'invalid_token' } }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', status: 401, forUser: true })
  })
  it('403 says who may connect: this person’s role can’t read invoices', async () => {
    const { connector } = make(failing({ status: 403, json: { message: 'CLIENT-TEXT' } }))
    const e = await connector.sync(conn, null).catch((x: Error) => x)
    expect(e).toMatchObject({ kind: 'auth', status: 403, forUser: true })
    expect((e as Error).message).toMatch(/Administrator|Manager/)
    expect((e as Error).message).not.toContain('CLIENT-TEXT')
  })
  it('429 waits out Retry-After, then carries on', async () => {
    const { connector, clock } = make([{ match: (u) => u.pathname === '/v2/invoices', respond: [{ status: 429, headers: { 'retry-after': '7' } }, { json: { invoices: [], links: { next: null } } }] }])
    await connector.sync(conn, null)
    expect(clock.sleeps).toContain(7000)
  })
  it('429 that outlasts the retries is rate_limited, for the scheduler', async () => {
    const { connector } = make(failing({ status: 429, headers: { 'retry-after': '900' } }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'rate_limited' })
  })
  it('health turns a 401 into needing a reconnect', async () => {
    const { connector } = make(failing({ status: 401 }))
    expect((await connector.health(conn)).status).not.toBe('ok')
  })
})

describe('signing in', () => {
  const token = { access_token: 'at_' + 'x'.repeat(20), refresh_token: 'rt_' + 'y'.repeat(20), token_type: 'bearer', expires_in: 1209600 }
  const idRoutes = (accounts: unknown = fx.accounts): FixtureRoute[] => [
    { method: 'POST', match: (u) => u.href === 'https://id.getharvest.com/api/v2/oauth2/token', respond: { json: token } },
    { method: 'GET', match: (u) => u.href === 'https://id.getharvest.com/api/v2/accounts', respond: { json: accounts } },
  ]
  it('begins at id.getharvest.com when the app is set up, with no scope we can’t ask for', async () => {
    const { connector } = make(harvest(), { oauth: oauthOpt })
    const b = (await connector.begin({ state: 'stateval' } as never)) as Extract<ConnectBegin, { kind: 'oauth' }>
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://id.getharvest.com/oauth2/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', redirect_uri: oauthOpt.redirectUri, state: 'stateval' })
    expect(connector.describe().auth).toBe('oauth')
  })
  it('exchanges the code with a User-Agent, sends the secret in the form, and keeps the Harvest accounts only', async () => {
    const { connector, calls } = make([...idRoutes(), ...harvest()], { oauth: oauthOpt })
    const r = await connector.connect({ code: 'thecode' })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ code: 'thecode', client_id: 'cid', client_secret: 'csec', grant_type: 'authorization_code' })
    expect(post.headers['user-agent']).toMatch(/^Aggregate/)
    expect(r.config).toMatchObject({ accountId: '111', displayName: 'Harvest · Sample Studio' })
    expect(r.additional).toBeUndefined()
    expect(JSON.stringify(r.config)).not.toContain('owner@example')
    expect((r.secret as { tokens: { refreshToken: string } }).tokens.refreshToken).toBe(token.refresh_token)
  })
  it('several Harvest accounts become several connections on one shared token', async () => {
    const accounts = { accounts: [{ id: 2, name: 'Bravo', product: 'harvest' }, { id: 1, name: 'Alpha', product: 'harvest' }] }
    const { connector } = make([...idRoutes(accounts), ...harvest()], { oauth: oauthOpt })
    const r = await connector.connect({ code: 'thecode' })
    expect(r.config).toMatchObject({ accountId: '1' })
    expect(r.additional?.[0]?.config).toMatchObject({ accountId: '2' })
    expect(r.config.sharedSecretKey).toBeTruthy()
    expect(r.additional?.[0]?.config.sharedSecretKey).toBe(r.config.sharedSecretKey)
  })
  it('an account this person can’t read invoices in is left out, and none at all says who should connect', async () => {
    const accounts = { accounts: [{ id: 1, name: 'Alpha', product: 'harvest' }, { id: 2, name: 'Bravo', product: 'harvest' }] }
    const onlyOne: FixtureRoute = { match: (u, i) => u.pathname === '/v2/invoices' && new Headers(i?.headers).get('harvest-account-id') === '1', respond: { status: 403 } }
    const some = make([...idRoutes(accounts), onlyOne, ...harvest()], { oauth: oauthOpt })
    const r = await some.connector.connect({ code: 'thecode' })
    expect(r.config).toMatchObject({ accountId: '2' })
    expect(r.additional).toBeUndefined()
    const none = make([...idRoutes(accounts), { match: (u) => u.pathname === '/v2/invoices', respond: { status: 403 } }], { oauth: oauthOpt })
    await expect(none.connector.connect({ code: 'thecode' })).rejects.toThrow(/Administrator|Manager/)
  })
  it('a sign-in with no Harvest account says so', async () => {
    const { connector } = make(idRoutes({ accounts: [{ id: 9, name: 'F', product: 'forecast' }] }), { oauth: oauthOpt })
    await expect(connector.connect({ code: 'thecode' })).rejects.toMatchObject({ forUser: true })
  })
  it('an expired access token renews first, and the new pair is saved before any read', async () => {
    const stored = { kind: 'oauth', tokens: { accessToken: 'old_' + 'o'.repeat(20), refreshToken: 'oldr_' + 'o'.repeat(20), expiresAt: 0 } }
    const { connector, calls, saved } = make([...idRoutes(), ...harvest()], { oauth: oauthOpt })
    const page = await connector.sync({ ...conn, secret: stored }, null)
    expect(calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: stored.tokens.refreshToken })
    expect(saved).toHaveLength(1)
    expect(page.updatedSecret).toMatchObject({ kind: 'oauth', tokens: { accessToken: token.access_token } })
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${token.access_token}`)
  })
  it('a sign-in connection on a server without the app asks for a reconnect', async () => {
    const { connector } = make(harvest())
    await expect(connector.sync({ ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'x'.repeat(20) } } }, null)).rejects.toMatchObject({ kind: 'auth', forUser: true })
  })
})

describe('a pasted token, self-host only', () => {
  const begin = (o: Partial<HarvestConnectorOptions>) => make(harvest(), o).connector.begin({ state: 's' } as never)
  it('sign-in first: with the app set up there’s no paste step', async () => {
    expect((await begin({ oauth: oauthOpt })).kind).toBe('oauth')
  })
  it('self-hosted without the app: asks for the token and the account id, and says it has full access', async () => {
    const b = (await begin({})) as Extract<ConnectBegin, { kind: 'api_key' }>
    expect(b.kind).toBe('api_key')
    expect(b.fields?.map((f) => f.name)).toEqual(['accountId', 'accessToken'])
    expect(b.permissions?.join()).toMatch(/can’t be limited/)
  })
  it('hosted without the app refuses to begin', async () => {
    await expect(begin({ hosted: true })).rejects.toThrow(HARVEST_NOT_SET_UP)
  })
  it('hosted never takes a pasted token, app or no app', async () => {
    for (const o of [{ hosted: true }, { hosted: true, oauth: oauthOpt }]) {
      const { connector, calls } = make(harvest(), o)
      await expect(connector.connect({ accessToken: 'p'.repeat(30), accountId: '111' })).rejects.toThrow(HARVEST_TOKEN_REFUSED)
      expect(calls).toEqual([])
    }
  })
  it('checks it with one read and warns of the full access', async () => {
    const { connector } = make()
    const r = await connector.connect({ accessToken: 'p'.repeat(30), accountId: '111' })
    expect(r.secret).toEqual({ kind: 'token', accessToken: 'p'.repeat(30) })
    expect(r.config).toMatchObject({ accountId: '111', warnings: [HARVEST_TOKEN_WARNING] })
  })
  it.each([['short', '111'], ['p'.repeat(30), 'not-a-number'], ['p'.repeat(30), '']])('refuses bad input (%s, %s)', async (accessToken, accountId) => {
    const { connector, calls } = make()
    await expect(connector.connect({ accessToken, accountId })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(calls).toEqual([])
  })
})

describe('disconnect', () => {
  it('says where to remove access: Harvest documents no revoke call', async () => {
    const { connector, calls } = make(harvest(), { oauth: oauthOpt })
    expect(await connector.disconnect!({ ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'x'.repeat(20) } } })).toEqual({ notRevoked: NOT_REVOKED_OAUTH })
    expect(await connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED_TOKEN })
    expect(calls).toEqual([])
  })
})
