import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectBegin, ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createLightspeedConnector, LIGHTSPEED_NOT_SET_UP, LIGHTSPEED_TOKEN_REFUSED, LIGHTSPEED_TOKEN_WARNING, monthStartMs, NOT_REVOKED_OAUTH, NOT_REVOKED_TOKEN, parseDomainPrefix, REPORT_ROW_NET_SALES, type LightspeedConnectorOptions } from './index.ts'

interface Sale { id: string; date: string; state: string; totals?: Record<string, unknown>; [k: string]: unknown }
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/lightspeed.json', import.meta.url), 'utf8')) as { retailer: { data: Record<string, unknown> }; sales: Sale[] }

const HOST = 'https://samplestore.retail.lightspeed.app'
const API = `${HOST}/api/2026-10`
const oauthOpt = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/lightspeed/callback' }
const conn: ConnectionRef = { id: 'conn_l', workspaceId: 'ws1', connectorKey: 'lightspeed', secret: { kind: 'token', domainPrefix: 'samplestore', accessToken: 'tok_' + 'a'.repeat(20) }, config: { domainPrefix: 'samplestore' } }

/** A small Lightspeed: filters by state and UTC date, sorts by date, pages by offset. */
function store(data: { sales?: Sale[]; retailer?: unknown; hook?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const sales = data.sales ?? fx.sales
  return [
    { method: 'GET', match: (u) => u.pathname === '/api/2026-10/retailer', respond: { json: data.retailer ?? fx.retailer } },
    {
      method: 'GET',
      match: (u) => u.pathname === '/api/2026-10/search',
      respond: (u) => {
        const hook = data.hook?.(u)
        if (hook) return hook
        const q = u.searchParams
        const from = Date.parse(q.get('date_from') ?? '0')
        const to = Date.parse(q.get('date_to') ?? '9999')
        const rows = sales.filter((s) => s.state === q.get('state') && Date.parse(s.date) >= from && Date.parse(s.date) < to).sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
        const offset = Number(q.get('offset') ?? 0)
        const size = Number(q.get('page_size') ?? 1000)
        return { json: { data: rows.slice(offset, offset + size), total_count: rows.length, page_info: { has_next_page: offset + size < rows.length, start_cursor: null, end_cursor: null }, version: { min: null, max: null } } }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = store(), opts: Partial<LightspeedConnectorOptions> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createLightspeedConnector({ ...opts }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sale = (o: Partial<Sale> & { id: string }, price = 0, tax = 0): Sale => ({ date: '2026-09-10T12:00:00+00:00', state: 'closed', totals: { price, tax, price_incl_tax: price + tax, loyalty: 0, surcharge: 0 }, ...o })

describe('lightspeed contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThanOrEqual(24)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('only ever a report snapshot, totals only', () => {
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
  it('stores no item, customer or sale: raw holds the month’s totals and nothing else', async () => {
    const { connector, raw } = make()
    const { events } = await runSync(connector, conn, null)
    const stored = [...raw.records.values()]
    expect(JSON.stringify([events, stored])).not.toMatch(/MUST-NOT-BE-KEPT|line_items|product|customer/)
    expect(new Set(stored.map((r) => r.kind))).toEqual(new Set(['lightspeed.month']))
    expect(stored.length).toBe(24)
  })
  it('sends nothing but GET', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('totals, worked by hand', () => {
  // New York, EDT (UTC-4): September is 09-01T04:00:00Z up to, not including, 10-01T04:00:00Z.
  // Sales: 100.10 (s1, the first second) + 49.95 (s2) + 1000.00 (s3, the last second) = 1150.05.
  // Refunds: 20.10 (r1). Net: 1129.95. Tax: 8.01 + 4.00 + 80.00 = 92.01; tax refunded 1.61.
  // Left out: s5 is August here, s4 is October, p1 is pending, v1 is voided, k1 is parked.
  const september = { 'Sales reported by the store': 115005, 'Refunds of sales': -2010, [REPORT_ROW_NET_SALES]: 112995, 'Sales tax collected': 9201, 'Sales tax refunded': -161 }
  it('September, to the cent, with tax out of sales', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))).toEqual(september)
  })
  it('a refund counts in the month it happened, and can take a month below zero', async () => {
    const { connector } = make(store({ sales: [sale({ id: 'a', date: '2026-08-10T12:00:00+00:00' }, 50, 4), sale({ id: 'b' }, -80, -6.4)] }))
    const { events } = await runSync(connector, conn, null)
    const s = snaps(events)
    expect(rows(s.get('lightspeed:2026-08:USD'))[REPORT_ROW_NET_SALES]).toBe(5000)
    expect(rows(s.get('lightspeed:2026-09:USD'))).toMatchObject({ [REPORT_ROW_NET_SALES]: -8000, 'Sales tax refunded': -640 })
  })
  it('a zero-decimal currency stays whole', async () => {
    const retailer = { data: { ...fx.retailer.data, currency: { code: 'JPY' }, timezone: 'Asia/Tokyo' } }
    const { connector } = make(store({ retailer, sales: [sale({ id: 'a' }, 5000, 500)] }))
    const { events } = await runSync(connector, conn, null)
    const s = snaps(events).get('lightspeed:2026-09:JPY')
    expect(s?.currency).toBe('JPY')
    expect(rows(s)).toMatchObject({ [REPORT_ROW_NET_SALES]: 5000, 'Sales tax collected': 500 })
  })
  it('floats add up exactly: 0.1 + 0.2 three times over', async () => {
    const sales = [1, 2, 3].flatMap((n) => [sale({ id: `a${n}` }, 0.1), sale({ id: `b${n}` }, 0.2)])
    const { connector } = make(store({ sales }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(90)
  })
  it('a voided, deleted or out-of-month sale that gets through the filter still isn’t counted', async () => {
    const leaked = [sale({ id: 'a', state: 'voided' }, 9), sale({ id: 'b', deleted_at: '2026-09-11T00:00:00Z' }, 9), sale({ id: 'c', date: '2026-08-10T12:00:00+00:00' }, 9), sale({ id: 'd' }, 1)]
    const { connector } = make(store({ hook: (u) => (u.searchParams.get('date_from')?.startsWith('2026-09-01') ? { json: { data: leaked, total_count: 4, page_info: { has_next_page: false } } } : undefined) }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(100)
  })
  it('the current month ends today, by the store’s calendar', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(snaps(events).get('lightspeed:2026-10:USD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09', basis: 'accrual', kind: 'profit_and_loss' })
    expect(snaps(events).get('lightspeed:2026-09:USD')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
  })
  it.each([
    ['no totals', { id: 'a', totals: undefined }],
    ['an unreadable price', { id: 'a', totals: { price: 'SECRET-TEXT', tax: 0 } }],
    ['no tax', { id: 'a', totals: { price: 5 } }],
    ['no date', { id: 'a', date: '' }],
  ])('a sale with %s stops the sync; it never reads as zero, and nothing it sent is repeated', async (_n, bad) => {
    const { connector } = make(store({ hook: (u) => (u.pathname.endsWith('/search') ? { json: { data: [{ date: '2026-09-10T12:00:00Z', state: 'closed', ...bad }], total_count: 1, page_info: { has_next_page: false } } } : undefined) }))
    const e = await runSync(connector, conn, null).catch((x: Error) => x)
    expect(e).toBeInstanceOf(ConnectorError)
    expect((e as Error).message).not.toContain('SECRET-TEXT')
  })
  it('a retailer with no currency stops the sync; it’s never guessed as dollars', async () => {
    const { connector } = make(store({ retailer: { data: { timezone: 'UTC', currency: {} } } }))
    await expect(runSync(connector, conn, null)).rejects.toBeInstanceOf(ConnectorError)
  })
})

describe('months by the store’s clock', () => {
  it.each([
    ['2026-09', 'America/New_York', '2026-09-01T04:00:00.000Z'],
    ['2026-11', 'America/New_York', '2026-11-01T04:00:00.000Z'],
    ['2026-12', 'America/New_York', '2026-12-01T05:00:00.000Z'],
    ['2026-10', 'Pacific/Auckland', '2026-09-30T11:00:00.000Z'],
    ['2026-07', 'Pacific/Auckland', '2026-06-30T12:00:00.000Z'],
    ['2026-09', 'UTC', '2026-09-01T00:00:00.000Z'],
    ['2026-09', 'Not/AZone', '2026-09-01T00:00:00.000Z'],
  ])('%s in %s starts at %s', (month, tz, iso) => {
    expect(new Date(monthStartMs(month, tz)).toISOString()).toBe(iso)
  })
  it('asks for each month by the store’s bounds, only closed sales, oldest first', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    const q = calls.map((c) => new URL(c.url)).filter((u) => u.searchParams.get('date_from') === '2026-09-01T04:00:00Z')[0]!.searchParams
    expect(Object.fromEntries(q)).toMatchObject({ type: 'sales', state: 'closed', date_to: '2026-10-01T04:00:00Z', order_by: 'date', order_direction: 'asc', offset: '0' })
  })
})

describe('paging', () => {
  const many = Array.from({ length: 450 }, (_, i) => sale({ id: `m${i}`, date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}T12:${String(i % 60).padStart(2, '0')}:00+00:00` }, 1))
  it('every page is read', async () => {
    const { connector, calls } = make(store({ sales: many }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(45000)
    expect(calls.filter((c) => c.url.includes('date_from=2026-09-01')).length).toBe(3)
  })
  it('a row pushed onto the next page doesn’t count twice', async () => {
    const pages: Record<string, FixtureResponse> = {
      '0': { json: { data: [sale({ id: 'a' }, 1), sale({ id: 'b' }, 10)], total_count: 3, page_info: { has_next_page: true } } },
      '2': { json: { data: [sale({ id: 'b' }, 10), sale({ id: 'c' }, 100)], total_count: 3, page_info: { has_next_page: false } } },
    }
    const { connector } = make(store({ hook: (u) => (u.searchParams.get('date_from')?.startsWith('2026-09-01') ? pages[u.searchParams.get('offset') ?? '0'] : undefined) }))
    const { events } = await runSync(connector, conn, null)
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(11100)
  })
  it('a stop on any page resumes without losing or doubling a cent', async () => {
    const whole = await runSync(make(store({ sales: many })).connector, conn, null)
    const { connector } = make(store({ sales: many }))
    let cursor: string | null = null
    const events: NormalizedEvent[] = []
    for (;;) {
      const page = await connector.sync(conn, cursor)
      events.push(...page.events)
      cursor = page.cursor
      if (!page.hasMore) break
    }
    expect(rows(snaps(events).get('lightspeed:2026-09:USD'))).toEqual(rows(snaps(whole.events).get('lightspeed:2026-09:USD')))
  })
  it('reads 24 months first, then recomputes 6', async () => {
    const { connector } = make()
    const first = await runSync(connector, conn, null)
    expect(snaps(first.events).size).toBe(24)
    const second = await runSync(connector, conn, first.cursor)
    expect(snaps(second.events).size).toBe(6)
    expect([...snaps(second.events).keys()].sort()[0]).toBe('lightspeed:2026-05:USD')
  })
  it('an ID-only or HTML answer never reads as a month of no sales', async () => {
    for (const bad of [{ text: '<html>down</html>' }, { json: { data: ['id-only'], total_count: 1, page_info: { has_next_page: false } } }]) {
      const { connector } = make(store({ hook: (u) => (u.pathname.endsWith('/search') ? bad : undefined) }))
      await expect(runSync(connector, conn, null)).rejects.toBeInstanceOf(ConnectorError)
    }
  })
})

describe('errors', () => {
  const failing = (r: FixtureResponse): FixtureRoute[] => [{ match: (u) => u.hostname.endsWith('.retail.lightspeed.app'), respond: r }]
  it('401 is an auth failure with the words to fix it', async () => {
    const { connector } = make(failing({ status: 401, json: { error: 'STORE-TEXT' } }))
    const e = await connector.sync(conn, null).catch((x: Error) => x)
    expect(e).toMatchObject({ kind: 'auth', status: 401, forUser: true })
    expect((e as Error).message).not.toContain('STORE-TEXT')
  })
  it('403 is a missing scope, named', async () => {
    const { connector } = make(failing({ status: 403 }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', status: 403, forUser: true, message: expect.stringContaining('sales:read') })
  })
  it('429 waits until Lightspeed’s Retry-After date, then carries on', async () => {
    const until = new Date(Date.parse('2026-10-09T12:00:07Z')).toUTCString()
    const { connector, clock } = make([{ match: (u) => u.pathname.endsWith('/retailer'), respond: [{ status: 429, headers: { 'retry-after': until } }, { json: fx.retailer }] }, ...store()])
    await connector.sync(conn, null)
    expect(clock.sleeps.some((ms) => ms >= 6000 && ms <= 8000)).toBe(true)
  })
  it('429 far in the future is rate_limited, for the scheduler', async () => {
    const until = new Date(Date.parse('2026-10-09T13:00:00Z')).toUTCString()
    const { connector } = make(failing({ status: 429, headers: { 'retry-after': until } }))
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'rate_limited' })
  })
  it('health turns a 401 into needing a reconnect', async () => {
    const { connector } = make(failing({ status: 401 }))
    expect((await connector.health(conn)).status).not.toBe('ok')
  })
})

describe('domain prefix', () => {
  it.each(['samplestore', 'sample-store', 'A1'])('takes %s', (v) => expect(parseDomainPrefix(v)).toBe(v.toLowerCase()))
  it.each(['', '-x', 'x-', 'a.b', 'evil.example.com/', 'a b', 'a/b', '../x', 'x'.repeat(64), 'a@b'])('refuses %j, so a callback can’t steer the token call', (v) => {
    expect(() => parseDomainPrefix(v)).toThrow(ConnectorError)
  })
})

describe('signing in', () => {
  const token = { access_token: 'at_' + 'x'.repeat(20), token_type: 'Bearer', expires: 1791000000, expires_in: 86400, refresh_token: 'rt_' + 'y'.repeat(20), domain_prefix: 'samplestore', scope: 'sales:read retailer:read payment_types:read' }
  const tokenRoute = (json: unknown = token): FixtureRoute => ({ method: 'POST', match: (u) => u.href === `${HOST}/api/1.0/token`, respond: { json } })
  it('begins at secure.retail.lightspeed.app with read scopes only', async () => {
    const { connector } = make(store(), { oauth: oauthOpt })
    const b = (await connector.begin({ state: 'stateval1' } as never)) as Extract<ConnectBegin, { kind: 'oauth' }>
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://secure.retail.lightspeed.app/connect')
    expect(Object.fromEntries(u.searchParams)).toEqual({ response_type: 'code', client_id: 'cid', redirect_uri: oauthOpt.redirectUri, state: 'stateval1', scope: 'sales:read retailer:read payment_types:read' })
    expect(u.searchParams.get('scope')).not.toMatch(/write|customers|products/)
    expect(connector.describe().auth).toBe('oauth')
  })
  it('exchanges the code at the store’s own host, form-encoded, and notes the store', async () => {
    const { connector, calls } = make([tokenRoute(), ...store()], { oauth: oauthOpt })
    const r = await connector.connect({ code: 'thecode', domain_prefix: 'samplestore' })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.url).toBe(`${HOST}/api/1.0/token`)
    expect(post.body).toEqual({ code: 'thecode', client_id: 'cid', client_secret: 'csec', grant_type: 'authorization_code', redirect_uri: oauthOpt.redirectUri })
    expect(r.config).toMatchObject({ domainPrefix: 'samplestore', currency: 'USD', displayName: 'Lightspeed · samplestore' })
    expect(r.secret).toMatchObject({ kind: 'oauth', domainPrefix: 'samplestore', tokens: { refreshToken: token.refresh_token } })
  })
  it('refuses a callback whose store is missing or malformed, before any call', async () => {
    const { connector, calls } = make(store(), { oauth: oauthOpt })
    await expect(connector.connect({ code: 'thecode' })).rejects.toBeInstanceOf(ConnectorError)
    await expect(connector.connect({ code: 'thecode', domain_prefix: 'evil.example.com/' })).rejects.toBeInstanceOf(ConnectorError)
    expect(calls).toEqual([])
  })
  it('refuses when the token is for a different store than the callback named', async () => {
    const { connector } = make([tokenRoute({ ...token, domain_prefix: 'otherstore' }), ...store()], { oauth: oauthOpt })
    await expect(connector.connect({ code: 'thecode', domain_prefix: 'samplestore' })).rejects.toMatchObject({ forUser: true })
  })
  it('refuses a grant without the sales or retailer scope', async () => {
    const { connector } = make([tokenRoute({ ...token, scope: 'retailer:read' }), ...store()], { oauth: oauthOpt })
    await expect(connector.connect({ code: 'thecode', domain_prefix: 'samplestore' })).rejects.toThrow(/sales:read/)
  })
  it('refuses a grant that came back with write access', async () => {
    const { connector } = make([tokenRoute({ ...token, scope: `${token.scope} sales:write` }), ...store()], { oauth: oauthOpt })
    await expect(connector.connect({ code: 'thecode', domain_prefix: 'samplestore' })).rejects.toThrow(/read/)
  })
  it('an expiring token renews at the store’s host; the rotated refresh token is saved before any read', async () => {
    const stored = { kind: 'oauth', domainPrefix: 'samplestore', tokens: { accessToken: 'old_' + 'o'.repeat(20), refreshToken: 'oldr_' + 'o'.repeat(20), expiresAt: 0 } }
    const { connector, calls, saved } = make([tokenRoute(), ...store()], { oauth: oauthOpt })
    const page = await connector.sync({ ...conn, secret: stored }, null)
    expect(calls[0]).toMatchObject({ url: `${HOST}/api/1.0/token`, body: { grant_type: 'refresh_token', refresh_token: stored.tokens.refreshToken } })
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ domainPrefix: 'samplestore', tokens: { refreshToken: token.refresh_token } })
    expect(page.updatedSecret).toEqual(saved[0])
    expect(calls[1]!.headers.authorization).toBe(`Bearer ${token.access_token}`)
  })
  it('a sign-in connection on a server without the app asks for a reconnect', async () => {
    const { connector } = make(store())
    await expect(connector.sync({ ...conn, secret: { kind: 'oauth', domainPrefix: 'samplestore', tokens: { accessToken: 'x'.repeat(20) } } }, null)).rejects.toMatchObject({ kind: 'auth', forUser: true })
  })
})

describe('a pasted token, self-host only', () => {
  const begin = (o: Partial<LightspeedConnectorOptions>) => make(store(), o).connector.begin({ state: 'stateval1' } as never)
  it('sign-in first: with the app set up there’s no paste step', async () => {
    expect((await begin({ oauth: oauthOpt })).kind).toBe('oauth')
  })
  it('self-hosted without the app asks for the store and the token', async () => {
    const b = (await begin({})) as Extract<ConnectBegin, { kind: 'api_key' }>
    expect(b.kind).toBe('api_key')
    expect(b.fields?.map((f) => f.name)).toEqual(['domainPrefix', 'accessToken'])
  })
  it('hosted without the app refuses to begin', async () => {
    await expect(begin({ hosted: true })).rejects.toThrow(LIGHTSPEED_NOT_SET_UP)
  })
  it('hosted never takes a pasted token', async () => {
    for (const o of [{ hosted: true }, { hosted: true, oauth: oauthOpt }]) {
      const { connector, calls } = make(store(), o)
      await expect(connector.connect({ accessToken: 'p'.repeat(30), domainPrefix: 'samplestore' })).rejects.toThrow(LIGHTSPEED_TOKEN_REFUSED)
      expect(calls).toEqual([])
    }
  })
  it('checks it with one read and warns that its scopes can’t be seen', async () => {
    const { connector } = make()
    const r = await connector.connect({ accessToken: 'p'.repeat(30), domainPrefix: 'samplestore' })
    expect(r.secret).toEqual({ kind: 'token', domainPrefix: 'samplestore', accessToken: 'p'.repeat(30) })
    expect(r.config).toMatchObject({ domainPrefix: 'samplestore', currency: 'USD', warnings: [LIGHTSPEED_TOKEN_WARNING] })
  })
  it('refuses a short token', async () => {
    const { connector, calls } = make()
    await expect(connector.connect({ accessToken: 'short', domainPrefix: 'samplestore' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(calls).toEqual([])
  })
})

describe('disconnect', () => {
  it('says where to remove access: Lightspeed documents no revoke call for this flow', async () => {
    const { connector, calls } = make(store(), { oauth: oauthOpt })
    expect(await connector.disconnect!({ ...conn, secret: { kind: 'oauth', domainPrefix: 'samplestore', tokens: { accessToken: 'x'.repeat(20) } } })).toEqual({ notRevoked: NOT_REVOKED_OAUTH })
    expect(await connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED_TOKEN })
    expect(calls).toEqual([])
  })
})
