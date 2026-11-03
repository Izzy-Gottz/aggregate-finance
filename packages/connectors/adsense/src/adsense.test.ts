import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { ADSENSE_NO_RENEWAL, ADSENSE_SCOPE, ADSENSE_WRONG_ACCESS, AdSenseClient, cellMinor, createAdSenseConnector, getOnly, NOT_REVOKED, paymentMoney, REPORT_ROW_EARNED, REPORT_ROW_PAID } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/adsense.json', import.meta.url), 'utf8')) as { accounts: { accounts: Row[] }; report: Row; payments: { payments: Row[] } }

const ACCOUNT = 'accounts/pub-1234'
const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/adsense/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_a', workspaceId: 'ws1', connectorKey: 'adsense', secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: FAR } }, config: { account: ACCOUNT, timeZone: 'America/New_York' } }
const tokenBody = (o: Row = {}) => ({ access_token: 'at'.repeat(12), refresh_token: 'rt'.repeat(12), expires_in: 3599, token_type: 'Bearer', scope: ADSENSE_SCOPE, ...o })

function adsense(data: { report?: Row; payments?: Row[]; accounts?: Row; token?: Row; hook?: (u: URL) => FixtureResponse | undefined; revoke?: FixtureResponse } = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: (u) => u.href === 'https://oauth2.googleapis.com/token', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'POST', match: (u) => u.href === 'https://oauth2.googleapis.com/revoke', respond: () => data.revoke ?? { json: {} } },
    { method: 'GET', match: (u) => u.pathname === '/v2/accounts', respond: (u) => data.hook?.(u) ?? { json: data.accounts ?? fx.accounts } },
    { method: 'GET', match: (u) => u.pathname === `/v2/${ACCOUNT}/reports:generate`, respond: (u) => data.hook?.(u) ?? { json: data.report ?? fx.report } },
    { method: 'GET', match: (u) => u.pathname === `/v2/${ACCOUNT}/payments`, respond: (u) => data.hook?.(u) ?? { json: { payments: data.payments ?? fx.payments.payments } } },
  ]
}

function make(routes: FixtureRoute[] = adsense()) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createAdSenseConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const run = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const stops = async (routes: FixtureRoute[], message: RegExp) => {
  const m = make(routes)
  const e = await runSync(m.connector, m.conn, null).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(ConnectorError)
  expect((e as ConnectorError).message).toMatch(message)
}
const report = (o: Row) => ({ ...fx.report, ...o })
const paid = (amount: string, day = '2026-10-21'): Row => {
  const [year, month, d] = day.split('-').map(Number)
  return { name: `${ACCOUNT}/payments/${day}`, amount, date: { year, month, day: d } }
}

describe('adsense contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 12 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('the client can only GET', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'OPTIONS', 'HEAD'])('%s throws before anything leaves', async (method) => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await expect(getOnly(under)('https://adsense.googleapis.com/v2/accounts', { method })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })
  it('holds inside AdSenseClient, past its public surface', async () => {
    let sent = 0
    const client = new AdSenseClient('t'.repeat(24), { fetch: async () => (sent++, new Response('{}')) })
    const http = (client as unknown as { http: { request(r: unknown): Promise<unknown> } }).http
    await expect(http.request({ method: 'POST', path: '/v2/accounts', json: {} })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })
  it('a full sync sends nothing but GET', async () => {
    const { calls } = await run()
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('the sums, to the cent', () => {
  it('only ever report snapshots: 12 months in the account’s currency, with no net income', async () => {
    const { r } = await run()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
    expect(r.events).toHaveLength(12)
    for (const s of snaps(r.events).values()) {
      expect(s.totals).toBeUndefined()
      expect(s.rows.some((x) => /net income/i.test(x.account))).toBe(false)
    }
  })
  it('earnings by report month; payments by payment month, YouTube included, one over the other never netted', async () => {
    const m = snaps((await run()).r.events)
    expect(rows(m.get('adsense:2026-08:USD'))).toEqual({ [REPORT_ROW_EARNED]: 120_10, [REPORT_ROW_PAID]: 0 })
    expect(rows(m.get('adsense:2026-09:USD'))).toEqual({ [REPORT_ROW_EARNED]: 98_05, [REPORT_ROW_PAID]: 120_10 })
    // 1,098.05 + 10.00
    expect(rows(m.get('adsense:2026-10:USD'))).toEqual({ [REPORT_ROW_EARNED]: 34_56, [REPORT_ROW_PAID]: 1108_05 })
    expect(rows(m.get('adsense:2026-07:USD'))).toEqual({ [REPORT_ROW_EARNED]: 0, [REPORT_ROW_PAID]: 0 })
  })
  it('the unpaid balance never counts as paid, even as the only payment', async () => {
    const m = snaps((await run(adsense({ payments: [{ name: `${ACCOUNT}/payments/unpaid`, amount: '$9,999.99' }, { name: `${ACCOUNT}/payments/youtube-unpaid`, amount: '$7.00', date: {} }] }))).r.events)
    for (const s of m.values()) expect(rows(s)[REPORT_ROW_PAID]).toBe(0)
  })
  it('a payment older than the window is left out; a month this month runs to today', async () => {
    const { r } = await run()
    expect(JSON.stringify(r.events)).not.toContain('55500')
    expect(snaps(r.events).get('adsense:2026-10:USD')?.to).toBe('2026-10-09')
    expect(snaps(r.events).get('adsense:2026-09:USD')?.to).toBe('2026-09-30')
    expect(snaps(r.events).get('adsense:2025-11:USD')?.from).toBe('2025-11-01')
  })
  it('a month adjusted below zero keeps its sign', async () => {
    const m = snaps((await run(adsense({ report: report({ totalMatchedRows: '1', rows: [{ cells: [{ value: '2026-09' }, { value: '-3.21' }] }], totals: { cells: [{}, { value: '-3.21' }] } }) }))).r.events)
    expect(rows(m.get('adsense:2026-09:USD'))[REPORT_ROW_EARNED]).toBe(-321)
  })
  it('a payment in another currency gets its own snapshot, and a zero-decimal report stays whole', async () => {
    const r = await run(adsense({
      report: report({ totalMatchedRows: '1', headers: [{ name: 'MONTH', type: 'DIMENSION' }, { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY', currencyCode: 'JPY' }], rows: [{ cells: [{ value: '2026-09' }, { value: '1234' }] }], totals: { cells: [{}, { value: '1234' }] } }),
      payments: [paid('€12.50', '2026-09-21')],
    }))
    const m = snaps(r.r.events)
    expect(rows(m.get('adsense:2026-09:JPY'))).toEqual({ [REPORT_ROW_EARNED]: 1234, [REPORT_ROW_PAID]: 0 })
    expect(rows(m.get('adsense:2026-09:EUR'))).toEqual({ [REPORT_ROW_EARNED]: 0, [REPORT_ROW_PAID]: 12_50 })
  })
  it('a currency that has left a month goes to zero on the next sync', async () => {
    const m = make(adsense({ payments: [paid('€12.50')] }))
    const first = await runSync(m.connector, m.conn, null)
    expect(rows(snaps(first.events).get('adsense:2026-10:EUR'))[REPORT_ROW_PAID]).toBe(12_50)
    const n = make(adsense({ payments: [] }))
    const second = await runSync(n.connector, n.conn, first.cursor)
    expect(rows(snaps(second.events).get('adsense:2026-10:EUR'))[REPORT_ROW_PAID]).toBe(0)
  })
  it('asks for one custom range by month, one metric, and no site or ad unit', async () => {
    const { calls } = await run()
    const u = new URL(calls.find((c) => String(c.url).includes('reports:generate'))!.url)
    expect(Object.fromEntries(u.searchParams)).toEqual({ dateRange: 'CUSTOM', 'startDate.year': '2025', 'startDate.month': '11', 'startDate.day': '1', 'endDate.year': '2026', 'endDate.month': '10', 'endDate.day': '9', dimensions: 'MONTH', metrics: 'ESTIMATED_EARNINGS' })
  })
  it('today is on the account’s clock', async () => {
    const m = make()
    m.clock.t = Date.parse('2026-11-01T02:00:00Z')
    const r = await runSync(m.connector, m.conn, null)
    expect(new URL(m.calls.find((c) => String(c.url).includes('reports:generate'))!.url).searchParams.get('endDate.month')).toBe('10')
    expect(snaps(r.events).get('adsense:2026-10:USD')?.to).toBe('2026-10-31')
  })
})

describe('a shape that isn’t right stops the sync', () => {
  it.each([
    ['no headers', report({ headers: [] }), /a report/],
    ['a different metric', report({ headers: [{ name: 'MONTH', type: 'DIMENSION' }, { name: 'CLICKS', type: 'METRIC_TALLY' }] }), /a report/],
    ['no currency', report({ headers: [{ name: 'MONTH', type: 'DIMENSION' }, { name: 'ESTIMATED_EARNINGS', type: 'METRIC_CURRENCY' }] }), /a report/],
    ['a cut-off report', report({ totalMatchedRows: '4' }), /cut short/],
    ['a total that disagrees', report({ totals: { cells: [{}, { value: '252.72' }] } }), /total/],
    ['a month twice', report({ totalMatchedRows: '2', rows: [{ cells: [{ value: '2026-09' }, { value: '1.00' }] }, { cells: [{ value: '2026-09' }, { value: '1.00' }] }], totals: undefined }), /twice/],
    ['a month outside the range', report({ totalMatchedRows: '1', rows: [{ cells: [{ value: '2024-09' }, { value: '1.00' }] }], totals: undefined }), /outside/],
    ['an amount with too many decimals', report({ totalMatchedRows: '1', rows: [{ cells: [{ value: '2026-09' }, { value: '1.234' }] }], totals: undefined }), /an amount/],
    ['a formatted cell', report({ totalMatchedRows: '1', rows: [{ cells: [{ value: '2026-09' }, { value: '$1.00' }] }], totals: undefined }), /an amount/],
  ])('%s', async (_n, r, message) => stops(adsense({ report: r as Row }), message))

  it.each([
    ['an unknown payment name', { name: `${ACCOUNT}/payments/pending`, amount: '$1.00' }, /a payment/],
    ['a date that doesn’t match', { ...paid('$1.00'), date: { year: 2026, month: 10, day: 22 } }, /match/],
    ['a paid payment with no date', { name: `${ACCOUNT}/payments/2026-10-21`, amount: '$1.00' }, /no date/],
    ['an unpaid balance with a date', { name: `${ACCOUNT}/payments/unpaid`, amount: '$1.00', date: { year: 2026, month: 10, day: 21 } }, /unpaid/],
    ['a European format', paid('1.234,57 €'), /payment amount/],
    ['a number', { ...paid('$1.00'), amount: 12 }, /payment amount/],
  ])('%s', async (_n, p, message) => stops(adsense({ payments: [p as Row] }), message))
})

describe('amounts', () => {
  it.each([
    ['$1,234.57', 'USD', 123457, 'USD'],
    ['$1.5', 'CAD', 150, 'CAD'],
    ['£10.00', 'USD', 1000, 'GBP'],
    ['€10.00', 'USD', 1000, 'EUR'],
    ['USD 1,000.00', 'EUR', 100000, 'USD'],
    ['1,000.00 EUR', 'USD', 100000, 'EUR'],
    ['¥1,000', 'JPY', 1000, 'JPY'],
  ])('%s with a %s report', (text, report, minor, currency) => expect(paymentMoney(text, report)).toEqual({ minor, currency }))
  it.each([
    ['$1.00', 'EUR'],
    ['¥1,000', 'USD'],
    ['1,23', 'USD'],
    ['1.234', 'USD'],
    ['12', 'USD'],
    ['-$1.00', 'USD'],
    ['USD 1.00 EUR', 'USD'],
    ['USD $1.00', 'USD'],
    ['', 'USD'],
  ])('%s with a %s report stops', (text, report) => expect(() => paymentMoney(text, report)).toThrow(/AdSense sent/))
  it('a report cell is a plain decimal', () => {
    expect(cellMinor('0.10', 'USD')).toBe(10)
    expect(() => cellMinor('12.34', 'JPY')).toThrow(/an amount/)
    expect(() => cellMinor(1, 'USD')).toThrow(/an amount/)
  })
})

describe('sign-in', () => {
  it('asks for the one read-only scope, offline, with consent', async () => {
    const b = (await make().connector.begin({ state: 'st' })) as { kind: string; url: string }
    const u = new URL(b.url)
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ scope: ADSENSE_SCOPE, access_type: 'offline', prompt: 'consent', response_type: 'code', client_id: 'cid', state: 'st' })
  })
  it('connects an account, keeping its name, zone and tokens, and no sign-up tasks', async () => {
    const r = await make().connector.connect({ code: 'c' })
    expect(r.config).toEqual({ account: ACCOUNT, timeZone: 'America/New_York', displayName: 'AdSense · Sample Publisher' })
    expect(JSON.stringify(r)).not.toContain('PENDING-TASK')
  })
  it('two accounts share one grant', async () => {
    const two = { accounts: [...fx.accounts.accounts, { ...fx.accounts.accounts[0], name: 'accounts/pub-2', displayName: 'Second' }] }
    const routes = [...adsense({ accounts: two }), { method: 'GET', match: (u: URL) => u.pathname === '/v2/accounts/pub-2/payments', respond: () => ({ json: {} }) }] as FixtureRoute[]
    const r = await make(routes).connector.connect({ code: 'c' })
    expect(r.additional).toHaveLength(1)
    expect(r.config.sharedSecretKey).toBe(r.additional![0]!.config.sharedSecretKey)
  })
  it.each([
    ['the wider adsense scope', { scope: 'https://www.googleapis.com/auth/adsense' }],
    ['both scopes', { scope: `${ADSENSE_SCOPE} https://www.googleapis.com/auth/adsense` }],
    ['an extra scope', { scope: `${ADSENSE_SCOPE} openid` }],
    ['nothing granted', { scope: '' }],
    ['no scope field', { scope: undefined }],
  ])('refuses %s, before any read', async (_n, token) => {
    const m = make(adsense({ token }))
    await expect(m.connector.connect({ code: 'c' })).rejects.toThrow(ADSENSE_WRONG_ACCESS)
    expect(m.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })
  it('refuses a sign-in with no refresh token', async () => {
    await expect(make(adsense({ token: { refresh_token: undefined } })).connector.connect({ code: 'c' })).rejects.toThrow(ADSENSE_NO_RENEWAL)
  })
  it('no AdSense account, and no code, say so', async () => {
    await expect(make(adsense({ accounts: {} })).connector.connect({ code: 'c' })).rejects.toThrow(/doesn’t reach an AdSense account/)
    await expect(make().connector.connect({})).rejects.toThrow(/Google sign-in only/)
  })
  it('renews an expired token and saves it before reading', async () => {
    const m = make()
    const stale = { ...conn, secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: m.clock.now() - 1 } } }
    const r = await m.connector.sync(stale, null)
    expect(m.saved).toHaveLength(1)
    expect(r.updatedSecret).toBeTruthy()
  })
  it.each([[401, /Connect AdSense again/], [403, /Someone with access/]])('%i reads plainly and quotes nothing', async (status, message) => {
    await stops(adsense({ hook: () => ({ status, json: { error: { message: 'SECRET-TEXT' } } }) }), message)
  })
  it('an unexpected status names only the status', async () => {
    const e = await make(adsense({ hook: () => ({ status: 400, json: {} }) })).connector.sync(conn, null).catch((x: unknown) => x)
    expect((e as ConnectorError).message).toBe('AdSense HTTP 400')
  })
})

describe('what’s kept, and disconnect', () => {
  it('raw holds monthly totals only', async () => {
    const { raw } = await run()
    const kept = JSON.stringify([...raw.records.values()].map((x) => x.payload))
    expect(kept).not.toMatch(/Sample Publisher|pub-|site|PENDING/)
    expect([...raw.records.values()][0]!.payload).toEqual({ month: '2025-11', currency: 'USD', totals: { earned: 0, paid: 0 } })
  })
  it('revokes at Google with the refresh token, and says nothing went wrong', async () => {
    const m = make()
    expect(await m.connector.disconnect!(conn)).toBeUndefined()
    const c = m.calls.find((x) => String(x.url) === 'https://oauth2.googleapis.com/revoke')!
    expect(c.method).toBe('POST')
    expect(c.body).toEqual({ token: 'r'.repeat(24) })
  })
  it('a refused revoke tells the person where to end it', async () => {
    expect(await make(adsense({ revoke: { status: 400, json: {} } })).connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
  })
  it('keeps the token while another account on the sign-in still uses it, and revokes with the last', async () => {
    const shared = { ...conn, config: { ...conn.config, sharedSecretKey: 'adsense:x', lastOfGrant: false } }
    const m = make()
    await m.connector.disconnect!(shared)
    expect(m.calls).toHaveLength(0)
    await m.connector.disconnect!({ ...shared, config: { ...shared.config, lastOfGrant: true } })
    expect(m.calls).toHaveLength(1)
  })
})
