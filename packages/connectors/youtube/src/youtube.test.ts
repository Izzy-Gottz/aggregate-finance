import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createYouTubeConnector, getOnly, monthRows, NOT_REVOKED, REPORT_ROW_EARNED, revenueMinor, YOUTUBE_NO_RENEWAL, YOUTUBE_NO_REVENUE, YOUTUBE_REFUSED, YOUTUBE_SCOPES, YOUTUBE_WRONG_ACCESS, YouTubeClient } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/youtube.json', import.meta.url), 'utf8')) as { channels: Row; report: Row }

const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa'
const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/youtube/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_y', workspaceId: 'ws1', connectorKey: 'youtube', secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: FAR } }, config: { channel: CHANNEL } }
const tokenBody = (o: Row = {}) => ({ access_token: 'at'.repeat(12), refresh_token: 'rt'.repeat(12), expires_in: 3599, token_type: 'Bearer', scope: YOUTUBE_SCOPES.join(' '), ...o })

function youtube(data: { report?: Row; channels?: Row; token?: Row; tokenResponse?: FixtureResponse; hook?: (u: URL) => FixtureResponse | undefined; revoke?: FixtureResponse } = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: (u) => u.href === 'https://oauth2.googleapis.com/token', respond: () => data.tokenResponse ?? { json: tokenBody(data.token) } },
    { method: 'POST', match: (u) => u.href === 'https://oauth2.googleapis.com/revoke', respond: () => data.revoke ?? { json: {} } },
    { method: 'GET', match: (u) => u.pathname === '/youtube/v3/channels', respond: (u) => data.hook?.(u) ?? { json: data.channels ?? fx.channels } },
    { method: 'GET', match: (u) => u.pathname === '/v2/reports', respond: (u) => data.hook?.(u) ?? { json: data.report ?? fx.report } },
  ]
}

function make(routes: FixtureRoute[] = youtube()) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createYouTubeConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const earned = (s: ReportSnapshot | undefined) => s?.rows.find((r) => r.account === REPORT_ROW_EARNED)?.amount.minor
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
const report = (rows: unknown) => ({ ...fx.report, rows })

describe('youtube contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 3 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('the client can only GET', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'OPTIONS', 'HEAD'])('%s throws before anything leaves', async (method) => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await expect(getOnly(under)('https://youtubeanalytics.googleapis.com/v2/reports', { method })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })
  it('the client’s own transports refuse a POST', async () => {
    let sent = 0
    const client = new YouTubeClient('t'.repeat(24), { fetch: async () => (sent++, new Response('{}')) })
    for (const key of ['data', 'analytics']) {
      const http = (client as unknown as Record<string, { request(r: unknown): Promise<unknown> }>)[key]!
      await expect(http.request({ method: 'POST', path: '/x', json: {} })).rejects.toThrow('only reads')
    }
    expect(sent).toBe(0)
  })
  it('a full sync sends nothing but GET', async () => {
    const { calls } = await run()
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('the report it asks for', () => {
  it('channel totals only: one metric, by month, both dates on a first day, in dollars', async () => {
    const { calls } = await run()
    const u = new URL(String(calls.find((c) => String(c.url).includes('/v2/reports'))!.url))
    expect(Object.fromEntries(u.searchParams)).toEqual({ ids: `channel==${CHANNEL}`, startDate: '2025-11-01', endDate: '2026-10-01', metrics: 'estimatedRevenue', dimensions: 'month', sort: 'month', currency: 'USD' })
  })
  it('a sync never reads the channel list or anything about videos', async () => {
    const { calls } = await run()
    expect(calls.some((c) => String(c.url).includes('/youtube/v3/'))).toBe(false)
  })
})

describe('the sums, to the cent', () => {
  it('only ever report snapshots, with no net income', async () => {
    const { r } = await run()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
    for (const s of snaps(r.events).values()) {
      expect(s.totals).toBeUndefined()
      expect(s.rows.some((x) => /net income/i.test(x.account))).toBe(false)
    }
  })
  it('each month is YouTube’s estimate rounded to the cent, and a real zero stays zero', async () => {
    const m = snaps((await run()).r.events)
    expect(earned(m.get('youtube:2026-08:USD'))).toBe(120_10)
    expect(earned(m.get('youtube:2026-09:USD'))).toBe(0)
    expect(earned(m.get('youtube:2026-10:USD'))).toBe(34_56)
  })
  it('a month with no row gets no snapshot, not a zero', async () => {
    const m = snaps((await run()).r.events)
    expect(m.size).toBe(3)
    expect(m.has('youtube:2026-07:USD')).toBe(false)
  })
  it('an adjustment below zero is kept', async () => {
    const m = snaps((await run(youtube({ report: report([['2026-09', 5], ['2026-10', -1.25]]) }))).r.events)
    expect(earned(m.get('youtube:2026-10:USD'))).toBe(-1_25)
  })
  it('a month running now ends today; a finished one ends on its last day', async () => {
    const m = snaps((await run()).r.events)
    expect(m.get('youtube:2026-10:USD')?.to).toBe('2026-10-09')
    expect(m.get('youtube:2026-08:USD')?.to).toBe('2026-08-31')
    expect(m.get('youtube:2026-08:USD')?.from).toBe('2026-08-01')
  })
  it('float noise doesn’t move a cent', () => {
    expect(revenueMinor(0.1 + 0.2)).toBe(30)
    expect(revenueMinor(1e-7)).toBe(0)
  })
  it('zero never shows as minus zero', () => {
    expect(Object.is(monthRows(-0)[0]!.amount.minor, 0)).toBe(true)
  })
})

describe('no revenue is not $0', () => {
  it.each([
    ['no rows at all', { ...fx.report, rows: undefined }],
    ['an empty list', report([])],
    ['twelve zeros', report([['2026-09', 0], ['2026-10', 0]])],
  ])('%s: a plain message and no snapshots', async (_n, body) => {
    await stops(youtube({ report: body }), /no revenue for this channel/)
    const e = await make(youtube({ report: body })).connector.connect({ code: 'c' }).catch((x: unknown) => x)
    expect((e as ConnectorError).message).toBe(YOUTUBE_NO_REVENUE)
    expect((e as ConnectorError).forUser).toBe(true)
  })
  it('a 403 on the report, quota included, reads as unknown, quotes nothing and asks for no new sign-in', async () => {
    const hook = (u: URL) => (u.pathname === '/v2/reports' ? { status: 403, json: { error: { message: 'SECRET-TEXT', errors: [{ reason: 'quotaExceeded' }] } } } : undefined)
    const e = await runSync(make(youtube({ hook })).connector, conn, null).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ConnectorError)
    expect((e as ConnectorError).message).toBe(YOUTUBE_REFUSED)
    expect((e as ConnectorError).message).not.toMatch(/no revenue|\$0|SECRET/)
    expect((e as ConnectorError).kind).toBe('permanent')
  })
  it.each([403, 429, 500])('a %i ends the sync with an error: it never comes back as a zero month', async (status) => {
    const hook = (u: URL) => (u.pathname === '/v2/reports' ? { status, json: { error: {} } } : undefined)
    const m = make(youtube({ hook }))
    const out = await runSync(m.connector, m.conn, null).then((r) => r, (x: unknown) => x)
    expect(out).toBeInstanceOf(ConnectorError)
  })
})

describe('what stops a sync', () => {
  it.each([
    ['another metric', { ...fx.report, columnHeaders: [(fx.report.columnHeaders as Row[])[0], { name: 'views', columnType: 'METRIC' }] }],
    ['another dimension', { ...fx.report, columnHeaders: [{ name: 'day', columnType: 'DIMENSION' }, (fx.report.columnHeaders as Row[])[1]] }],
    ['no headers', { rows: [] }],
    ['a third column', report([['2026-10', 1, 2]])],
    ['a string amount', report([['2026-10', '1.00']])],
    ['a bad month', report([['2026-10-01', 1]])],
    ['rows that aren’t a list', report({})],
  ])('%s', async (_n, body) => {
    await stops(youtube({ report: body }), /can’t read/)
  })
  it('a month outside the window, or twice', async () => {
    await stops(youtube({ report: report([['2024-01', 1]]) }), /outside the dates/)
    await stops(youtube({ report: report([['2026-10', 1], ['2026-10', 2]]) }), /a month twice/)
  })
  it('a connection with no channel', async () => {
    await expect(make().connector.sync({ ...conn, config: {} }, null)).rejects.toThrow(/no YouTube channel/)
  })
  it.each([[401, /Connect YouTube again/], [429, /YouTube HTTP 429/]])('%i is handled from the status alone', async (status, message) => {
    const e = await make(youtube({ hook: () => ({ status, json: { error: { message: 'SECRET-TEXT' } } }) })).connector.sync(conn, null).catch((x: unknown) => x)
    expect((e as ConnectorError).message).toMatch(message)
    expect((e as ConnectorError).message).not.toContain('SECRET-TEXT')
  })
})

describe('sign-in', () => {
  it('asks for the two read-only scopes, offline, with consent', async () => {
    const b = (await make().connector.begin({ state: 'st' })) as { kind: string; url: string }
    const u = new URL(b.url)
    expect(`${u.origin}${u.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ scope: YOUTUBE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', response_type: 'code', client_id: 'cid', state: 'st' })
  })
  it('connects one channel, keeping its id and name only', async () => {
    const r = await make().connector.connect({ code: 'c' })
    expect(r.config).toEqual({ channel: CHANNEL, displayName: 'YouTube · Sample Channel' })
    expect(JSON.stringify(r)).not.toContain('NOT-READ')
  })
  it.each([
    ['full YouTube access', { scope: 'https://www.googleapis.com/auth/youtube' }],
    ['the two plus write', { scope: `${YOUTUBE_SCOPES.join(' ')} https://www.googleapis.com/auth/youtube` }],
    ['only one of the two', { scope: YOUTUBE_SCOPES[0] }],
    ['an extra scope', { scope: `${YOUTUBE_SCOPES.join(' ')} openid` }],
    ['nothing granted', { scope: '' }],
    ['no scope field', { scope: undefined }],
  ])('refuses %s, before any read', async (_n, token) => {
    const m = make(youtube({ token }))
    await expect(m.connector.connect({ code: 'c' })).rejects.toThrow(YOUTUBE_WRONG_ACCESS)
    expect(m.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })
  it('takes the two scopes in either order', async () => {
    const r = await make(youtube({ token: { scope: [...YOUTUBE_SCOPES].reverse().join(' ') } })).connector.connect({ code: 'c' })
    expect(r.config.channel).toBe(CHANNEL)
  })
  it('refuses a sign-in with no refresh token', async () => {
    await expect(make(youtube({ token: { refresh_token: undefined } })).connector.connect({ code: 'c' })).rejects.toThrow(YOUTUBE_NO_RENEWAL)
  })
  it('no channel, several channels, and no code each stop', async () => {
    await expect(make(youtube({ channels: {} })).connector.connect({ code: 'c' })).rejects.toThrow(/doesn’t have a YouTube channel/)
    await expect(make(youtube({ channels: { items: [] } })).connector.connect({ code: 'c' })).rejects.toThrow(/doesn’t have a YouTube channel/)
    const two = { items: [...(fx.channels.items as Row[]), ...(fx.channels.items as Row[])] }
    await expect(make(youtube({ channels: two })).connector.connect({ code: 'c' })).rejects.toThrow(/can’t read/)
    await expect(make().connector.connect({})).rejects.toThrow(/Google sign-in only/)
  })
  it('renews an expired token and saves it before reading', async () => {
    const m = make()
    const stale = { ...conn, secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: m.clock.now() - 1 } } }
    const r = await m.connector.sync(stale, null)
    expect(m.saved).toHaveLength(1)
    expect(r.updatedSecret).toBeTruthy()
  })
  it('a refused refresh token is a revoke, so the server erases', async () => {
    const m = make(youtube({ tokenResponse: { status: 400, json: { error: 'invalid_grant' } } }))
    const stale = { ...conn, secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: m.clock.now() - 1 } } }
    await expect(m.connector.sync(stale, null)).rejects.toMatchObject({ kind: 'auth', code: 'revoked', forUser: true })
  })
})

describe('what’s kept, and disconnect', () => {
  it('raw holds monthly estimates only', async () => {
    const { raw } = await run()
    const kept = JSON.stringify([...raw.records.values()].map((x) => x.payload))
    expect(kept).not.toMatch(/Sample Channel|UCaaa|video/)
    expect([...raw.records.values()][0]!.payload).toEqual({ month: '2026-08', currency: 'USD', earned: 120_10 })
  })
  it('revokes at Google with the refresh token, and says nothing went wrong', async () => {
    const m = make()
    expect(await m.connector.disconnect!(conn)).toBeUndefined()
    const c = m.calls.find((x) => String(x.url) === 'https://oauth2.googleapis.com/revoke')!
    expect(c.method).toBe('POST')
    expect(c.body).toEqual({ token: 'r'.repeat(24) })
  })
  it('a refused revoke tells the person where to end it', async () => {
    expect(await make(youtube({ revoke: { status: 400, json: {} } })).connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED })
  })
})
