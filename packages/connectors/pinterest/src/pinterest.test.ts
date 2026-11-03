import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createPinterestConnector, getOnly, microsToMinor, monthRows, NOT_REVOKED, PINTEREST_NO_RENEWAL, PINTEREST_REFUSED, PINTEREST_SCOPE, PINTEREST_WRONG_ACCESS, PinterestClient, REPORT_ROW_SPEND, SPEND_COLUMN } from './index.ts'

type Row = Record<string, unknown>
// Hand-built from Pinterest's OpenAPI description, not recorded from a real account.
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/pinterest.json', import.meta.url), 'utf8')) as { adAccounts: { items: Row[] }; analytics: Row[] }

const ID = '54975588517'
const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/pinterest/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const secret = { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: FAR } }
const conn: ConnectionRef = { id: 'conn_a', workspaceId: 'ws1', connectorKey: 'pinterest', secret, config: { adAccountId: ID, currency: 'USD' } } as ConnectionRef
const tokenBody = (o: Row = {}) => ({ access_token: 'at'.repeat(12), refresh_token: 'rt'.repeat(12), expires_in: 2592000, token_type: 'bearer', scope: PINTEREST_SCOPE, ...o })
const day = (date: string, micros: unknown): Row => ({ AD_ACCOUNT_ID: ID, DATE: date, [SPEND_COLUMN]: micros })

function pinterest(data: { analytics?: unknown; accounts?: unknown; token?: Row; hook?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: (u) => u.href === 'https://api.pinterest.com/v5/oauth/token', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'GET', match: (u) => u.pathname === '/v5/ad_accounts', respond: (u) => data.hook?.(u) ?? { json: data.accounts ?? fx.adAccounts } },
    { method: 'GET', match: (u) => u.pathname === `/v5/ad_accounts/${ID}/analytics`, respond: (u) => data.hook?.(u) ?? { json: data.analytics ?? fx.analytics } },
  ]
}

function make(routes: FixtureRoute[] = pinterest()) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createPinterestConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const spend = (s: ReportSnapshot | undefined) => s?.rows.find((r) => r.account === REPORT_ROW_SPEND)?.amount
const stops = async (routes: FixtureRoute[], message: RegExp) => {
  const m = make(routes)
  const e = await runSync(m.connector, m.conn, null).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(ConnectorError)
  expect((e as ConnectorError).message).toMatch(message)
}

describe('pinterest contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 2 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('what a sync sends', () => {
  it('adds days to the month, in micro-units, and rounds once at the end', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    const s = snaps(r.events)
    expect([...s.keys()]).toEqual(['pinterest:2026-09:USD', 'pinterest:2026-10:USD'])
    // 12.34 + 1.005 = 13.345: rounding each day first would give 13.35 too, so the next test pins the difference.
    expect(spend(s.get('pinterest:2026-09:USD'))).toEqual({ minor: 13_35, currency: 'USD' })
    expect(spend(s.get('pinterest:2026-10:USD'))).toEqual({ minor: 20_00, currency: 'USD' })
  })
  it('reconciles to the cent where rounding by day would not', async () => {
    const days = ['2026-09-01', '2026-09-02', '2026-09-03'].map((d) => day(d, 4_000))
    const m = make(pinterest({ analytics: days }))
    const s = snaps((await runSync(m.connector, m.conn, null)).events)
    expect(spend(s.get('pinterest:2026-09:USD'))?.minor).toBe(1)
  })
  it('never posts: report snapshots only, one row, no totals', async () => {
    const m = make()
    const r = await runSync(m.connector, m.conn, null)
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
    for (const e of r.events as ReportSnapshot[]) {
      expect(e).toMatchObject({ kind: 'profit_and_loss', basis: 'accrual', currency: 'USD' })
      expect(e.totals).toBeUndefined()
      expect(e.rows).toHaveLength(1)
    }
  })
  it('a whole month ends on its last day, this month on today', async () => {
    const m = make()
    const s = snaps((await runSync(m.connector, m.conn, null)).events)
    expect(s.get('pinterest:2026-09:USD')).toMatchObject({ from: '2026-09-01', to: '2026-09-30' })
    expect(s.get('pinterest:2026-10:USD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09' })
  })
  it('asks only for whole months inside 90 days, and for the one column, account-wide', async () => {
    let asked: URL | undefined
    const m = make(pinterest({ hook: (u) => { if (u.pathname.endsWith('/analytics')) asked = u; return undefined } }))
    await runSync(m.connector, m.conn, null)
    expect(Object.fromEntries(asked!.searchParams)).toEqual({ start_date: '2026-08-01', end_date: '2026-10-09', columns: 'SPEND_IN_MICRO_DOLLAR', granularity: 'DAY' })
  })
  it('a month starting exactly at the edge of the window counts', async () => {
    let asked: URL | undefined
    const m = make(pinterest({ analytics: [], hook: (u) => { if (u.pathname.endsWith('/analytics')) asked = u; return undefined } }))
    m.clock.t = Date.parse('2026-09-28T12:00:00Z')
    await runSync(m.connector, m.conn, null)
    expect(asked!.searchParams.get('start_date')).toBe('2026-07-01')
    expect((Date.parse('2026-09-28') - Date.parse('2026-07-01')) / 86_400_000).toBeLessThanOrEqual(90)
  })
  it.each([['JPY', 1_500_000, 2], ['JPY', 1_499_999, 1], ['KWD', 1_234_500, 1235], ['USD', 4_999, 0], ['USD', 5_000, 1], ['USD', 0, 0]])('%s: %i micro-units are %i', (currency, micros, minor) => {
    expect(microsToMinor(micros, currency)).toBe(minor)
  })
  it('uses the account’s currency, with zero decimals where it has none', async () => {
    const m = make(pinterest({ analytics: [day('2026-10-01', 1_500_000_000)] }))
    const s = snaps((await runSync(m.connector, { ...conn, config: { adAccountId: ID, currency: 'JPY' } }, null)).events)
    expect(spend(s.get('pinterest:2026-10:JPY'))).toEqual({ minor: 1500, currency: 'JPY' })
  })
  it('zero never shows as minus zero', () => {
    expect(Object.is(monthRows(-0, 'USD')[0]!.amount.minor, 0)).toBe(true)
  })
})

describe('no answer is not $0', () => {
  it('an empty report sends no month at all', async () => {
    const m = make(pinterest({ analytics: [] }))
    expect((await runSync(m.connector, m.conn, null)).events).toEqual([])
  })
  it.each([403, 429, 500, 503])('a %i ends the sync with an error, and no zero month comes out', async (status) => {
    const m = make(pinterest({ hook: (u) => (u.pathname.endsWith('/analytics') ? { status, json: { code: 1, message: 'SECRET-TEXT' } } : undefined) }))
    const out = await runSync(m.connector, m.conn, null).then((r) => r, (x: unknown) => x)
    expect(out).toBeInstanceOf(ConnectorError)
    expect(m.raw.records.size).toBe(0)
  })
  it('a 403 reads as unknown, quotes nothing and asks for no new sign-in', async () => {
    const hook = (u: URL) => (u.pathname.endsWith('/analytics') ? { status: 403, json: { code: 29, message: 'SECRET-TEXT' } } : undefined)
    const e = await runSync(make(pinterest({ hook })).connector, conn, null).catch((x: unknown) => x)
    expect((e as ConnectorError).message).toBe(PINTEREST_REFUSED)
    expect((e as ConnectorError).message).toMatch(/doesn’t know/)
    expect((e as ConnectorError).message).not.toMatch(/\$0|SECRET/)
    expect((e as ConnectorError).kind).toBe('permanent')
    expect((e as ConnectorError).forUser).toBe(true)
  })
  it('a day with no spend figure stops the sync: left out is not zero', async () => {
    await stops(pinterest({ analytics: [day('2026-10-01', 5_000_000), { AD_ACCOUNT_ID: ID, DATE: '2026-10-02' }] }), /a day of spend/)
  })
})

describe('what stops a sync', () => {
  it.each([
    ['a string amount', [day('2026-10-01', '100')]],
    ['a fraction of a micro-unit', [day('2026-10-01', 1.5)]],
    ['null', [day('2026-10-01', null)]],
    ['below zero', [day('2026-10-01', -1)]],
    ['too large to be exact', [day('2026-10-01', 2 ** 60)]],
    ['not a list', { items: [] }],
    ['a bad date', [day('10/01/2026', 1)]],
    ['no date', [{ AD_ACCOUNT_ID: ID, [SPEND_COLUMN]: 1 }]],
    ['another account', [{ ...day('2026-10-01', 1), AD_ACCOUNT_ID: '999' }]],
  ])('%s', async (_n, analytics) => {
    await stops(pinterest({ analytics }), /can’t read/)
  })
  it('a day outside the window, or twice', async () => {
    await stops(pinterest({ analytics: [day('2026-07-31', 1)] }), /outside the dates/)
    await stops(pinterest({ analytics: [day('2026-10-10', 1)] }), /outside the dates/)
    await stops(pinterest({ analytics: [day('2026-10-01', 1), day('2026-10-01', 1)] }), /a day twice/)
  })
  it('a total too large to add exactly', async () => {
    const big = Number.MAX_SAFE_INTEGER
    await stops(pinterest({ analytics: [day('2026-10-01', big), day('2026-10-02', big)] }), /too large/)
  })
  it.each([[{}], [{ adAccountId: '../x', currency: 'USD' }], [{ adAccountId: ID, currency: 'UNK' }], [{ adAccountId: ID }]])('a connection with no usable account: %j', async (config) => {
    await expect(make().connector.sync({ ...conn, config }, null)).rejects.toThrow(/no Pinterest ad account/)
  })
  it.each([[401, /Connect Pinterest again/], [429, /Pinterest HTTP 429/]])('%i is handled from the status alone', async (status, message) => {
    const e = await make(pinterest({ hook: () => ({ status, json: { message: 'SECRET-TEXT' } }) })).connector.sync(conn, null).catch((x: unknown) => x)
    expect((e as ConnectorError).message).toMatch(message)
    expect((e as ConnectorError).message).not.toContain('SECRET-TEXT')
  })
})

describe('sign-in', () => {
  it('asks for ads:read only', async () => {
    const b = (await make().connector.begin({ state: 'st' })) as { kind: string; url: string }
    const u = new URL(b.url)
    expect(`${u.origin}${u.pathname}`).toBe('https://www.pinterest.com/oauth/')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ scope: 'ads:read', response_type: 'code', client_id: 'cid', state: 'st' })
  })
  it('sends the app’s credentials in a Basic header', async () => {
    const m = make()
    await m.connector.connect({ code: 'c' })
    const call = m.calls.find((c) => c.url.includes('/oauth/token'))!
    expect(JSON.stringify(call.headers)).toMatch(/Basic /)
  })
  it('connects one account, keeping its id, currency and name only', async () => {
    const r = await make().connector.connect({ code: 'c' })
    expect(r.config).toEqual({ adAccountId: ID, currency: 'USD', displayName: 'Pinterest Ads · Sample Advertiser' })
    expect(JSON.stringify(r)).not.toContain('NOT-READ')
  })
  it('each ad account is its own connection, paging through the list', async () => {
    const a = (id: string) => ({ ...fx.adAccounts.items[0], id })
    const hook = (u: URL) => (u.pathname !== '/v5/ad_accounts' ? undefined : u.searchParams.get('bookmark') ? { json: { items: [a('2')], bookmark: null } } : { json: { items: [a('1')], bookmark: 'next' } })
    const r = await make(pinterest({ hook })).connector.connect({ code: 'c' })
    expect(r.config.adAccountId).toBe('1')
    expect(r.additional?.map((x) => x.config.adAccountId)).toEqual(['2'])
    expect(r.config.sharedSecretKey).toMatch(/^pinterest:/)
  })
  it('a list whose bookmark never moves stops', async () => {
    const hook = (u: URL) => (u.pathname === '/v5/ad_accounts' ? { json: { items: fx.adAccounts.items, bookmark: 'same' } } : undefined)
    await expect(make(pinterest({ hook })).connector.connect({ code: 'c' })).rejects.toThrow(/can’t read/)
  })
  it.each([
    ['ads:write too', { scope: 'ads:read,ads:write' }],
    ['ads:write alone', { scope: 'ads:write' }],
    ['space-separated extra', { scope: 'ads:read user_accounts:read' }],
    ['nothing granted', { scope: '' }],
  ])('refuses a grant of %s', async (_n, token) => {
    const m = make(pinterest({ token }))
    await expect(m.connector.connect({ code: 'c' })).rejects.toThrow(PINTEREST_WRONG_ACCESS)
    expect(m.calls.some((c) => c.url.includes('/ad_accounts'))).toBe(false)
  })
  it('takes a token that names no scope, since the docs make it optional', async () => {
    const r = await make(pinterest({ token: { scope: undefined } })).connector.connect({ code: 'c' })
    expect(r.config.adAccountId).toBe(ID)
  })
  it('refuses a sign-in with no way to renew', async () => {
    await expect(make(pinterest({ token: { refresh_token: undefined } })).connector.connect({ code: 'c' })).rejects.toThrow(PINTEREST_NO_RENEWAL)
  })
  it('no code, no account, a currency that isn’t one', async () => {
    await expect(make().connector.connect({})).rejects.toThrow(/sign-in only/)
    await expect(make(pinterest({ accounts: { items: [] } })).connector.connect({ code: 'c' })).rejects.toThrow(/doesn’t reach an ad account/)
    await expect(make(pinterest({ accounts: { items: [{ ...fx.adAccounts.items[0], currency: 'UNK' }] } })).connector.connect({ code: 'c' })).rejects.toThrow(/can’t read/)
  })
  it('renews a token close to running out, and saves it before reading', async () => {
    const m = make()
    const near = { ...conn, secret: { tokens: { ...secret.tokens, expiresAt: m.clock.t + 1000 } } }
    const r = await m.connector.sync(near, null)
    expect(m.saved).toHaveLength(1)
    expect(r.updatedSecret).toBeTruthy()
    expect(m.calls.findIndex((c) => c.url.includes('/oauth/token'))).toBeLessThan(m.calls.findIndex((c) => c.url.includes('/analytics')))
  })
})

describe('read-only', () => {
  it('getOnly refuses anything but GET before a byte leaves', async () => {
    let reached = 0
    const inner: FetchLike = async () => { reached++; return new Response('{}') }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(getOnly(inner)('https://api.pinterest.com/v5/x', { method })).rejects.toThrow(/only reads/)
    expect(reached).toBe(0)
    await getOnly(inner)('https://api.pinterest.com/v5/x')
    expect(reached).toBe(1)
  })
  it('a sync sends no POST, and the client has no way to', async () => {
    const m = make()
    await runSync(m.connector, m.conn, null)
    expect(m.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(Object.getOwnPropertyNames(PinterestClient.prototype).sort()).toEqual(['adAccounts', 'constructor', 'dailySpend'])
  })
})

describe('health and disconnect', () => {
  it('health is ok, and an unknown failure is not', async () => {
    expect((await make().connector.health!(conn)).status).toBe('ok')
    const h = await make(pinterest({ hook: () => ({ status: 401, json: {} }) })).connector.health!(conn)
    expect(h.status).not.toBe('ok')
  })
  it('there’s no revoke call, so a disconnect says where to end it', async () => {
    const m = make()
    expect(await m.connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
    expect(m.calls).toHaveLength(0)
  })
  it('says nothing while another ad account still uses the sign-in', async () => {
    expect(await make().connector.disconnect!({ ...conn, config: { ...conn.config, sharedSecretKey: 'k', lastOfGrant: false } })).toBeUndefined()
  })
})
