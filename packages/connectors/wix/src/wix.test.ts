import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createWixConnector, NOT_REVOKED, orderLine, ordersOnly, price, REPORT_ROW_NET_SALES, verifySignedInstance, WIX_NOT_INSTALLED, WIX_ORDERS_URL, WIX_OWNER_ONLY, WIX_ROLE_MESSAGE, WIX_SIGNED_OUT, WixClient } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/wix.json', import.meta.url), 'utf8')) as { page: { orders: Row[]; metadata: Row } }

const app = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/wix/callback' }
const conn: ConnectionRef = { id: 'conn_w', workspaceId: 'ws1', connectorKey: 'wix', secret: { instanceId: 'site-1' }, config: {} } as ConnectionRef
const none = { count: 0, cursors: {}, hasNext: false }
const more = (next: string) => ({ count: 1, cursors: { next }, hasNext: true })
const order = (id: string, o: Row = {}) => ({ id, currency: 'USD', createdDate: '2026-09-05T15:00:00.000Z', paymentStatus: 'PAID', balanceSummary: { paid: { amount: '10.00' } }, ...o })

function wix(data: { pages?: Array<{ orders: Row[]; metadata: Row }>; token?: FixtureResponse; hook?: (search: Row) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const pages = data.pages ?? [fx.page]
  return [
    { method: 'POST', match: (u) => u.href === 'https://www.wixapis.com/oauth2/token', respond: () => data.token ?? { json: { access_token: 'at'.repeat(12), expires_in: 14400 } } },
    {
      method: 'POST',
      match: (u) => u.href === WIX_ORDERS_URL,
      respond: (_u, body) => {
        const search = (body as { search: Row }).search
        const hooked = data.hook?.(search)
        if (hooked) return hooked
        const c = (search.cursorPaging as Row).cursor as string | undefined
        return { json: pages[c ? Number(c) : 0] }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = wix(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const connector = createWixConnector({ app }, { raw, fetch: f.fetch, clock, random: () => 0 })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const fails = async (orders: Row[]) => {
  const m = make(wix({ pages: [{ orders, metadata: none }] }))
  return (await runSync(m.connector, m.conn, null).catch((e: unknown) => e)) as ConnectorError
}

const sign = (claims: Row, secret = app.clientSecret) => {
  const data = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${createHmac('sha256', secret).update(data).digest('base64url')}.${data}`
}

describe('wix connector', () => {
  const nowIso = () => new Date(fakeClock().now()).toISOString()
  const claims = (o: Row = {}) => ({ instanceId: 'site-1', signDate: nowIso(), uid: 'u1', permissions: 'OWNER', siteOwnerId: 'u1', ...o })

  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 12 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to a hand-computed number: a sale, a part refund, a cancelled refund, an unpaid order, an import by its own date', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    expect(s.size).toBe(12)
    expect(rows(s.get('wix:2026-09:USD'))).toEqual({ 'Sales reported by the store': 59_99, 'Refunds of sales': -10_00, [REPORT_ROW_NET_SALES]: 49_99 })
    expect(rows(s.get('wix:2026-08:USD'))).toEqual({ 'Sales reported by the store': 100_00, 'Refunds of sales': -25_00, [REPORT_ROW_NET_SALES]: 75_00 })
    expect(rows(s.get('wix:2026-07:USD'))).toEqual({ 'Sales reported by the store': 20_00, 'Refunds of sales': 0, [REPORT_ROW_NET_SALES]: 20_00 })
    for (const snap of s.values()) expect(snap.totals).toBeUndefined()
  })

  it('posts nothing: report snapshots only', async () => {
    const { r } = await sync()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('stores no customer: not in an event, not in raw, and the client drops it from the page', async () => {
    const { r, raw } = await sync()
    expect(JSON.stringify(r.events)).not.toContain('example.com')
    expect(JSON.stringify(raw)).not.toContain('example.com')
    const page = await new WixClient('t', { fetch: fixtureFetch(wix()).fetch, clock: fakeClock() }).orders(null, null)
    expect(JSON.stringify(page)).not.toContain('buyerInfo')
    expect(JSON.stringify(page)).not.toContain('example.com')
  })

  it('the one read is a POST to Search Orders, with the token bare', async () => {
    const { calls } = await sync()
    const reads = calls.filter((c) => !c.url.endsWith('/oauth2/token'))
    expect(reads.length).toBeGreaterThan(0)
    for (const c of reads) expect([c.method, c.url, c.headers.authorization]).toEqual(['POST', WIX_ORDERS_URL, 'at'.repeat(12)])
  })

  it.each([
    ['GET on the path', WIX_ORDERS_URL, 'GET'],
    ['another read path', 'https://www.wixapis.com/ecom/v1/orders/query', 'POST'],
    ['a write on an order', 'https://www.wixapis.com/ecom/v1/orders/abc/cancel', 'POST'],
    ['the path with a suffix', `${WIX_ORDERS_URL}/x`, 'POST'],
    ['another host', 'https://evil.example.com/ecom/v1/orders/search', 'POST'],
  ])('refuses %s before it leaves', async (_n, url, method) => {
    let sent = 0
    const guarded = ordersOnly((async () => (sent++, new Response('{}'))) as FetchLike)
    await expect(guarded(url, { method })).rejects.toThrow('only reads orders')
    expect(sent).toBe(0)
  })

  it('the first page holds the window, oldest first, both archived states; later pages only the cursor; a repeat counts once', async () => {
    const paged = [
      { orders: [order('a')], metadata: more('1') },
      { orders: [order('a'), order('b')], metadata: none },
    ]
    const { calls, r } = await sync(wix({ pages: paged }))
    const bodies = calls.filter((c) => c.url === WIX_ORDERS_URL).map((c) => c.body as { search: Row })
    expect(bodies[0]!.search).toEqual({
      filter: { archived: { $in: [true, false] }, createdDate: { $gte: '2025-10-30T00:00:00.000Z', $lte: nowIso() } },
      sort: [{ fieldName: 'createdDate', order: 'ASC' }],
      cursorPaging: { limit: 100 },
    })
    expect(bodies[1]!.search).toEqual({ cursorPaging: { limit: 100, cursor: '1' } })
    const total = [...snaps(r.events).values()].reduce((n, s) => n + (rows(s)['Sales reported by the store'] ?? 0), 0)
    expect(total).toBe(20_00)
  })

  it('shows nothing until the whole run is read, and resumes from the cursor', async () => {
    const paged = [{ orders: [order('a')], metadata: more('1') }, { orders: [order('b')], metadata: none }]
    const m = make(wix({ pages: paged }))
    const first = await m.connector.sync(m.conn, null)
    expect(first.events).toEqual([])
    expect(first.hasMore).toBe(true)
    const resumed = make(wix({ pages: paged }))
    const second = await resumed.connector.sync(resumed.conn, first.cursor)
    expect(second.events.length).toBe(12)
    expect(second.hasMore).toBe(false)
    expect(rows(snaps(second.events).get('wix:2026-09:USD'))['Sales reported by the store']).toBe(20_00)
  })

  it('a stale Wix cursor starts the run over, and any other failure stops it', async () => {
    const paged = [{ orders: [order('a')], metadata: more('1') }]
    const stale = (status: number) => wix({ pages: paged, hook: (s) => ((s.cursorPaging as Row).cursor ? { status, json: {} } : undefined) })
    const m = make(stale(400))
    const first = await m.connector.sync(m.conn, null)
    const second = await m.connector.sync(m.conn, first.cursor)
    expect(second).toMatchObject({ events: [], hasMore: true })
    const n = make(stale(403))
    const c = await n.connector.sync(n.conn, null)
    await expect(n.connector.sync(n.conn, c.cursor)).rejects.toMatchObject({ kind: 'auth' })
  })

  it('zeroes a currency that has left, so an old total doesn’t stay', async () => {
    const m = make(wix({ pages: [{ orders: [], metadata: none }] }))
    const seeded = await runSync(make(wix({ pages: [{ orders: [order('a', { currency: 'EUR' })], metadata: none }] })).connector, m.conn, null)
    expect([...snaps(seeded.events).keys()].filter((k) => k.endsWith(':EUR')).length).toBe(12)
    const after = await m.connector.sync(m.conn, seeded.cursor)
    expect([...snaps(after.events).keys()].filter((k) => k.endsWith(':EUR')).length).toBe(12)
    expect([...snaps(after.events).values()].every((s) => rows(s)[REPORT_ROW_NET_SALES] === 0)).toBe(true)
  })

  it('a store with no orders sends nothing, and never a made-up zero', async () => {
    const { r } = await sync(wix({ pages: [{ orders: [], metadata: none }] }))
    expect(r.events).toEqual([])
  })

  it('keeps each currency apart, and files by UTC month', async () => {
    const { r } = await sync(wix({ pages: [{ orders: [order('a'), order('b', { currency: 'JPY', createdDate: '2026-08-31T23:59:59.000Z', balanceSummary: { paid: { amount: '500.00' } } })], metadata: none }] }))
    const s = snaps(r.events)
    expect(rows(s.get('wix:2026-09:USD'))[REPORT_ROW_NET_SALES]).toBe(10_00)
    expect(rows(s.get('wix:2026-08:JPY'))[REPORT_ROW_NET_SALES]).toBe(500)
    expect(rows(s.get('wix:2026-09:JPY'))[REPORT_ROW_NET_SALES]).toBe(0)
  })

  it('zero decimals and three decimals stay exact', () => {
    expect(price({ amount: '500' }, 'JPY')).toBe(500)
    expect(price({ amount: '1.234' }, 'BHD')).toBe(1234)
    expect(() => price({ amount: '1.5' }, 'JPY')).toThrow(ConnectorError)
  })

  it.each(['NOT_PAID', 'UNSPECIFIED', 'PENDING', 'CANCELED', 'DECLINED', undefined])('%s with no money adds nothing', (paymentStatus) => {
    expect(orderLine(order('a', { paymentStatus, balanceSummary: undefined }) as never)).toMatchObject({ sales: 0, refunds: 0 })
  })

  it.each([
    ['a number for an amount', order('a', { balanceSummary: { paid: { amount: 10 } } })],
    ['a third decimal', order('a', { balanceSummary: { paid: { amount: '1.234' } } })],
    ['a negative amount', order('a', { balanceSummary: { paid: { amount: '-1.00' } } })],
    ['a paid order with no amount', order('a', { balanceSummary: {} })],
    ['a part paid order with no balance', order('a', { paymentStatus: 'PARTIALLY_PAID', balanceSummary: undefined })],
    ['a status nobody has seen', order('a', { paymentStatus: 'SOMETHING_NEW' })],
    ['a bad date', order('a', { createdDate: 'soon' })],
    ['no currency', order('a', { currency: undefined })],
    ['no id', order('', {})],
    ['a refunded order with no refund', order('a', { paymentStatus: 'FULLY_REFUNDED' })],
    ['a refund above what was paid', order('a', { balanceSummary: { paid: { amount: '10.00' }, refunded: { amount: '10.01' } } })],
  ])('stops the sync on %s, and never counts it as zero', async (_n, o) => {
    const e = await fails([o])
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toMatch(/Wix/)
  })

  it.each([
    ['no orders array', { orders: 'x', metadata: none }],
    ['no metadata', { orders: [] }],
    ['a next page with no cursor', { orders: [], metadata: { hasNext: true, cursors: {} } }],
  ])('stops on a shape that isn’t a page: %s', async (_n, json) => {
    const m = make(wix({ hook: () => ({ json }) }))
    await expect(runSync(m.connector, m.conn, null)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('maps statuses, the message written from the status alone', async () => {
    for (const [status, kind, message] of [[401, 'auth', WIX_SIGNED_OUT], [403, 'auth', WIX_ROLE_MESSAGE], [429, 'rate_limited', 'Wix HTTP 429']] as const) {
      const client = new WixClient('t', { fetch: (async () => new Response('{"message":"quoted"}', { status })) as FetchLike, clock: fakeClock(), random: () => 0 })
      await expect(client.orders(null, null)).rejects.toMatchObject({ kind, message })
    }
  }, 30_000)

  it.each([400, 401, 403])('a token refused with %i asks for a new connection', async (status) => {
    const m = make(wix({ token: { status, json: {} } }))
    await expect(m.connector.sync(m.conn, null)).rejects.toMatchObject({ kind: 'auth', message: WIX_SIGNED_OUT })
    expect((await m.connector.health(m.conn)).status).not.toBe('ok')
  })

  it('stops on a token reply with no token', async () => {
    const m = make(wix({ token: { json: {} } }))
    await expect(m.connector.sync(m.conn, null)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('keeps a token for its life, mints after, and drops one that stops working', async () => {
    const m = make()
    const mints = () => m.calls.filter((c) => c.url.endsWith('/oauth2/token')).length
    await m.connector.sync(m.conn, null)
    await m.connector.sync(m.conn, null)
    expect(mints()).toBe(1)
    expect(m.calls[0]!.body).toEqual({ grant_type: 'client_credentials', client_id: 'cid', client_secret: 'csec', instance_id: 'site-1' })
    m.clock.t += 4 * 3_600_000
    await m.connector.sync(m.conn, null)
    expect(mints()).toBe(2)

    let refuse = true
    const n = make(wix({ hook: () => (refuse ? { status: 401, json: {} } : undefined) }))
    await expect(n.connector.sync(n.conn, null)).rejects.toMatchObject({ kind: 'auth' })
    refuse = false
    await n.connector.sync(n.conn, null)
    expect(n.calls.filter((c) => c.url.endsWith('/oauth2/token')).length).toBe(2)
  })

  it('the install link carries the state inside the return URL, and asks no permission', async () => {
    const b = (await make().connector.begin({ state: 's' })) as { kind: string; url: string }
    const u = new URL(b.url)
    expect(`${u.origin}${u.pathname}`).toBe('https://www.wix.com/app-installer')
    expect(u.searchParams.get('appId')).toBe('cid')
    expect(u.searchParams.get('postInstallationUrl')).toBe(`${app.redirectUri}?state=s`)
    expect(u.searchParams.has('shareUrlId')).toBe(false)
    const f = fixtureFetch([])
    const shared = createWixConnector({ app: { ...app, shareUrlId: 'share-1' } }, { raw: new MemoryRawSink(), fetch: f.fetch })
    expect(new URL(((await shared.begin({ state: 's' })) as { url: string }).url).searchParams.get('shareUrlId')).toBe('share-1')
  })

  it('connects a signed install: it reads one order and keeps only the instance', async () => {
    const m = make()
    const c = await m.connector.connect({ instanceId: 'site-1', appId: 'cid', signedInstance: sign(claims()), tenantId: 't' } as never)
    expect(c.secret).toEqual({ instanceId: 'site-1' })
    expect(c.config).toEqual({ displayName: 'Wix store' })
    expect((m.calls[1]!.body as { search: Row }).search.cursorPaging).toEqual({ limit: 1 })
  })

  it('takes an owner named by id too', () => {
    expect(verifySignedInstance(sign(claims({ permissions: '' })), 'site-1', app.clientSecret, fakeClock().now())).toBe('site-1')
  })

  it.each([
    ['a forged signature', () => sign(claims(), 'not-the-secret'), 'site-1'],
    ['a site that isn’t the one signed', () => sign(claims()), 'site-2'],
    ['no signature', () => Buffer.from(JSON.stringify(claims())).toString('base64url'), 'site-1'],
    ['an old install', () => sign(claims({ signDate: '2020-01-01T00:00:00.000Z' })), 'site-1'],
    ['no date', () => sign(claims({ signDate: undefined })), 'site-1'],
  ])('refuses %s and makes no call', async (_n, signed, instanceId) => {
    const m = make()
    await expect(m.connector.connect({ instanceId, signedInstance: signed() } as never)).rejects.toMatchObject({ kind: 'auth' })
    expect(m.calls.length).toBe(0)
  })

  it('refuses a contributor: payment details are for site owners', async () => {
    const m = make()
    await expect(m.connector.connect({ instanceId: 'site-1', signedInstance: sign(claims({ permissions: '', uid: 'u2' })) } as never)).rejects.toThrow(WIX_OWNER_ONLY)
    expect(m.calls.length).toBe(0)
  })

  it('refuses another app’s install, and an install that didn’t finish', async () => {
    const m = make()
    await expect(m.connector.connect({ instanceId: 'site-1', appId: 'other', signedInstance: sign(claims()) } as never)).rejects.toMatchObject({ kind: 'auth' })
    await expect(m.connector.connect({ state: 's' } as never)).rejects.toThrow(WIX_NOT_INSTALLED)
  })

  it('disconnect says where to remove the app: there’s no revoke call', async () => {
    const m = make()
    expect(await m.connector.disconnect!(m.conn)).toEqual({ notRevoked: NOT_REVOKED })
    expect(m.calls.length).toBe(0)
  })
})
