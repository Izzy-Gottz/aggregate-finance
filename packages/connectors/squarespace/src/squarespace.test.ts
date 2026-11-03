import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createSquarespaceConnector, documentLines, getOnly, money, monthIn, NOT_REVOKED, REPORT_ROW_NET_SALES, SQUARESPACE_NO_RENEWAL, SQUARESPACE_SCOPE, SquarespaceClient, USER_AGENT } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/squarespace.json', import.meta.url), 'utf8')) as { site: Row; page: { documents: Row[]; pagination: Row } }

const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/squarespace/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_s', workspaceId: 'ws1', connectorKey: 'squarespace', secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: FAR } }, config: { websiteId: 'site', timeZone: 'America/New_York' } }
const tokenBody = (o: Row = {}) => ({ token_type: 'bearer', access_token: 'at'.repeat(12), token: 'at'.repeat(12), access_token_expires_at: '1893456000.5', refresh_token: 'rt'.repeat(12), refresh_token_expires_at: '1893999999.5', ...o })
const none = { hasNextPage: false, nextPageCursor: null, nextPageUrl: null }
const usd = (value: number) => ({ currency: 'USD', value })
const pay = (o: Row = {}) => ({ amount: usd(10), refundedAmount: usd(0), paidOn: '2026-09-05T15:00:00.000Z', giftCardId: null, refunds: [], ...o })
const doc = (id: string, ...payments: Row[]) => ({ id, voided: false, payments })

function squarespace(data: { pages?: Array<{ documents: Row[]; pagination: Row }>; site?: Row; token?: Row; hook?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const pages = data.pages ?? [fx.page]
  return [
    { method: 'POST', match: (u) => u.href === 'https://login.squarespace.com/api/1/login/oauth/provider/tokens', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'GET', match: (u) => u.pathname === '/1.0/authorization/website', respond: (u) => data.hook?.(u) ?? { json: data.site ?? fx.site } },
    {
      method: 'GET',
      match: (u) => u.pathname === '/1.0/commerce/transactions',
      respond: (u) => {
        const hooked = data.hook?.(u)
        if (hooked) return hooked
        const c = u.searchParams.get('cursor')
        return { json: pages[c ? Number(c) : 0] }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = squarespace(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createSquarespaceConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const fails = async (documents: Row[]) => {
  const m = make(squarespace({ pages: [{ documents, pagination: none }] }))
  return (await runSync(m.connector, m.conn, null).catch((e: unknown) => e)) as ConnectorError
}

describe('squarespace connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 12 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to a hand-computed number: a sale, a part refund back in its own month, no voided order, no gift card', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    expect(s.size).toBe(12)
    expect(rows(s.get('squarespace:2026-09:USD'))).toEqual({ 'Sales reported by the store': 49_99, 'Refunds of sales': 0, [REPORT_ROW_NET_SALES]: 49_99 })
    expect(rows(s.get('squarespace:2026-08:USD'))).toEqual({ 'Sales reported by the store': 100_00, 'Refunds of sales': -25_00, [REPORT_ROW_NET_SALES]: 75_00 })
    for (const snap of s.values()) expect(snap.totals).toBeUndefined()
  })

  it('posts nothing: report snapshots only', async () => {
    const { r } = await sync()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('stores no email: not in an event, not in raw', async () => {
    const { r, raw } = await sync()
    expect(JSON.stringify(r.events)).not.toContain('example.com')
    expect(JSON.stringify(raw)).not.toContain('example.com')
  })

  it('every call carries a User-Agent and only GETs reach the API', async () => {
    const { calls } = await sync()
    expect(calls.length).toBeGreaterThan(1)
    for (const c of calls) expect(new URL(c.url).hostname).toBe('api.squarespace.com')
    for (const c of calls) expect(c.method).toBe('GET')
    for (const c of calls) expect(c.headers['user-agent']).toBe(USER_AGENT)
    await expect(getOnly((async () => new Response('{}')) as FetchLike)('https://api.squarespace.com/x', { method: 'POST' })).rejects.toThrow('only reads')
  })

  it('asks a window on the first page, and only the cursor after it, across pages, and a repeat counts once', async () => {
    const paged = [
      { documents: [doc('a', pay())], pagination: { hasNextPage: true, nextPageCursor: '1' } },
      { documents: [doc('a', pay()), doc('b', pay())], pagination: none },
    ]
    const { calls, r } = await sync(squarespace({ pages: paged }))
    const urls = calls.map((c) => new URL(c.url)).filter((u) => u.pathname.endsWith('transactions'))
    expect(urls[0]!.searchParams.get('modifiedAfter')).toBeTruthy()
    expect(urls[0]!.searchParams.get('modifiedBefore')).toBeTruthy()
    expect(urls[1]!.search).toBe('?cursor=1')
    const total = [...snaps(r.events).values()].reduce((n, s) => n + (rows(s)['Sales reported by the store'] ?? 0), 0)
    expect(total).toBe(20_00)
  })

  it('shows nothing until the whole run is read', async () => {
    const paged = [{ documents: [doc('a', pay())], pagination: { hasNextPage: true, nextPageCursor: '1' } }, { documents: [], pagination: none }]
    const m = make(squarespace({ pages: paged }))
    const first = await m.connector.sync(m.conn, null)
    expect(first.events).toEqual([])
    expect(first.hasMore).toBe(true)
    const second = await m.connector.sync(m.conn, first.cursor)
    expect(second.events.length).toBe(12)
    expect(second.hasMore).toBe(false)
  })

  it('a stale Squarespace cursor starts the run over, and any other failure stops it', async () => {
    const paged = [{ documents: [doc('a', pay())], pagination: { hasNextPage: true, nextPageCursor: '1' } }]
    const stale = (status: number) => squarespace({ pages: paged, hook: (u) => (u.searchParams.get('cursor') ? { status, json: {} } : undefined) })
    const m = make(stale(400))
    const first = await m.connector.sync(m.conn, null)
    const second = await m.connector.sync(m.conn, first.cursor)
    expect(second).toMatchObject({ events: [], hasMore: true })
    const n = make(stale(403))
    const c = await n.connector.sync(n.conn, null)
    await expect(n.connector.sync(n.conn, c.cursor)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('zeroes a currency that has left, so an old total doesn’t stay', async () => {
    const m = make(squarespace({ pages: [{ documents: [], pagination: none }] }))
    const c = await m.connector.sync(m.conn, null)
    expect(c.events.length).toBe(12)
    const seeded = await runSync(make(squarespace({ pages: [{ documents: [doc('a', pay({ amount: { currency: 'EUR', value: 10 }, refundedAmount: null }))], pagination: none }] })).connector, conn, null)
    const eur = [...snaps(seeded.events).keys()].filter((k) => k.endsWith(':EUR'))
    expect(eur.length).toBe(12)
    const after = await m.connector.sync(m.conn, seeded.cursor)
    expect([...snaps(after.events).keys()].filter((k) => k.endsWith(':EUR')).length).toBe(12)
    expect([...snaps(after.events).values()].filter((s) => s.currency === 'EUR').every((s) => rows(s)[REPORT_ROW_NET_SALES] === 0)).toBe(true)
  })

  it('a refund comes off by size, whichever sign it has', () => {
    const lines = (a: number) => documentLines(doc('a', pay({ amount: usd(100), refundedAmount: usd(a), refunds: [{ amount: usd(a) }] })) as never, 'UTC')
    expect(lines(25)[0]).toMatchObject({ sales: 100_00, refunds: 25_00 })
    expect(lines(-25)[0]).toMatchObject({ sales: 100_00, refunds: 25_00 })
  })

  it('a payment plan counts each payment in its own month', () => {
    const l = documentLines(doc('a', pay({ paidOn: '2026-08-01T12:00:00Z' }), pay({ paidOn: '2026-09-01T12:00:00Z' })) as never, 'UTC')
    expect(l.map((x) => x.month)).toEqual(['2026-08', '2026-09'])
  })

  it('files a sale by the site’s clock', () => {
    expect(documentLines(doc('a', pay({ paidOn: '2026-10-01T02:00:00Z' })) as never, 'America/New_York')[0]!.month).toBe('2026-09')
    expect(monthIn('Not/AZone', Date.parse('2026-10-01T02:00:00Z'))).toBe('2026-10')
  })

  it('an unpaid payment adds nothing', () => expect(documentLines(doc('a', pay({ paidOn: null })) as never, 'UTC')).toEqual([]))

  it.each([
    ['a string amount', pay({ amount: { currency: 'USD', value: 'lots' } })],
    ['no amount', pay({ amount: undefined })],
    ['a third decimal', pay({ amount: usd(1.234) })],
    ['a bad date', pay({ paidOn: 'soon' })],
    ['a negative payment', pay({ amount: usd(-5) })],
    ['refunds that don’t match', pay({ amount: usd(100), refundedAmount: usd(30), refunds: [{ amount: usd(25) }] })],
    ['a refund in another currency', pay({ amount: usd(100), refundedAmount: null, refunds: [{ amount: { currency: 'EUR', value: 25 } }] })],
    ['a refund list that isn’t one', pay({ refunds: 'none' })],
  ])('stops the sync on %s, and never counts it as zero', async (_n, p) => {
    const e = await fails([doc('a', p)])
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toMatch(/Squarespace/)
  })

  it('stops on a shape that isn’t a page', async () => {
    const m = make(squarespace({ hook: (u) => (u.pathname.endsWith('transactions') ? { json: { documents: 'x' } } : undefined) }))
    await expect(runSync(m.connector, m.conn, null)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('zero decimals: JPY stays whole', () => expect(money({ currency: 'JPY', value: 500 })).toEqual({ minor: 500, currency: 'JPY' }))

  it('maps statuses', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limited']] as const) {
      const client = new SquarespaceClient('t'.repeat(24), { fetch: (async () => new Response('{}', { status })) as FetchLike, clock: fakeClock(), random: () => 0 })
      await expect(client.site()).rejects.toMatchObject({ kind })
    }
  }, 30_000)

  it('sign-in asks one read-only permission, offline', async () => {
    const b = (await make().connector.begin({ state: 's' })) as { url: string }
    const u = new URL(b.url)
    expect(u.searchParams.get('scope')).toBe(SQUARESPACE_SCOPE)
    expect(u.searchParams.get('access_type')).toBe('offline')
  })

  it('connects, with the expiry in seconds, the repeat of the token dropped and the secret sent in Basic', async () => {
    const m = make()
    const c = await m.connector.connect({ code: 'x', redirectUri: oauth.redirectUri } as never)
    expect(c.config).toMatchObject({ websiteId: 'site-sample-abcd', displayName: 'Squarespace · Sample Shop' })
    const tokens = (c.secret as { tokens: Row }).tokens
    expect(tokens.expiresAt).toBe(1893456000500)
    expect(tokens.extra).toBeUndefined()
    const post = m.calls.find((x) => x.method === 'POST')!
    expect(post.headers.authorization).toBe(`Basic ${Buffer.from('cid:csec').toString('base64')}`)
    expect(post.headers['user-agent']).toBe(USER_AGENT)
  })

  it('refuses a sign-in with no refresh token', async () => {
    const m = make(squarespace({ token: { refresh_token: undefined } }))
    await expect(m.connector.connect({ code: 'x' } as never)).rejects.toThrow(SQUARESPACE_NO_RENEWAL)
  })

  it('saves the rotated refresh token before reading', async () => {
    const m = make(undefined, { secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: 1 } } })
    const r = await m.connector.sync(m.conn, null)
    expect((m.saved[0] as { tokens: Row }).tokens.refreshToken).toBe('rt'.repeat(12))
    expect(r.updatedSecret).toBeTruthy()
  })

  it('health never spends a refresh token', async () => {
    const m = make(undefined, { secret: { tokens: { accessToken: 'a'.repeat(24), refreshToken: 'r'.repeat(24), expiresAt: 1 } } })
    expect((await m.connector.health(m.conn)).status).toBe('ok')
    expect(m.calls.length).toBe(0)
  })

  it('disconnect says where to remove the app: there’s no revoke call', async () => {
    const m = make()
    expect(await m.connector.disconnect!(m.conn)).toEqual({ notRevoked: NOT_REVOKED })
    expect(m.calls.length).toBe(0)
  })
})
