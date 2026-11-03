import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  amount,
  createOwnerRezConnector,
  getOnly,
  monthIn,
  NOT_REVOKED,
  OWNERREZ_MIXED_CURRENCY,
  OWNERREZ_NO_CURRENCY,
  OWNERREZ_NO_TIME_ZONE,
  ownerRezCurrencyGone,
  OWNERREZ_REFUSED,
  OWNERREZ_SCOPE,
  OWNERREZ_WRONG_SCOPE,
  OwnerRezClient,
  paymentLine,
  REPORT_ROW_NET_COLLECTED,
  userAgent,
} from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/ownerrez.json', import.meta.url), 'utf8')) as { me: Row; calendar: Row; payments: Row; refunds: Row }

const oauth = { clientId: 'c_12345', clientSecret: 's_secret', redirectUri: 'https://app.example.com/api/connectors/ownerrez/callback' }
const UA = userAgent(oauth.clientId)
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_o', workspaceId: 'ws1', connectorKey: 'ownerrez', secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), refreshToken: 'rt_' + 'r'.repeat(24), expiresAt: FAR } }, config: {} }
const tokenBody = (o: Row = {}) => ({ access_token: 'at_' + 'n'.repeat(24), token_type: 'bearer', scope: 'read', user_id: 1001, user_display_name: 'Sample Rentals', refresh_token_supported: true, refresh_token: 'rt_' + 'm'.repeat(24), expires_in: 2_592_000, ...o })
const list = (items: Row[], next: string | null = null) => ({ items, limit: 100, offset: 0, next_page_url: next })
const pay = (o: Row = {}) => ({ id: 1, amount: 10, collected_utc: '2026-09-05T15:00:00Z', total_fees: 0, type: 'credit_card', ...o })

interface Data {
  payments?: Row[]
  refunds?: Row
  calendar?: Row
  token?: Row
  hook?: (u: URL) => FixtureResponse | undefined
}

function ownerrez(data: Data = {}): FixtureRoute[] {
  const pages = data.payments ?? [fx.payments]
  return [
    { method: 'POST', match: (u) => u.href === 'https://api.ownerrez.com/oauth/token', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'DELETE', match: (u) => u.pathname.startsWith('/oauth/access_token/'), respond: (u) => data.hook?.(u) ?? { status: 200, json: {} } },
    { method: 'GET', match: (u) => u.pathname === '/v2/users/me', respond: (u) => data.hook?.(u) ?? { json: fx.me } },
    { method: 'GET', match: (u) => u.pathname === '/v2/calendar', respond: (u) => data.hook?.(u) ?? { json: data.calendar ?? fx.calendar } },
    { method: 'GET', match: (u) => u.pathname === '/v2/payments', respond: (u) => data.hook?.(u) ?? { json: pages[Number(u.searchParams.get('cursor') ?? 0)] } },
    { method: 'GET', match: (u) => u.pathname === '/v2/refunds', respond: (u) => data.hook?.(u) ?? { json: data.refunds ?? fx.refunds } },
  ]
}

function make(routes: FixtureRoute[] = ownerrez(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createOwnerRezConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const fails = async (payments: Row[]) => {
  const m = make(ownerrez({ payments: [list(payments)] }))
  return (await runSync(m.connector, m.conn, null).catch((e: unknown) => e)) as ConnectorError
}

describe('ownerrez connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 12 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to a hand-computed number: payments by collected month on the account’s clock, a refund in its own month, a chargeback off, fees apart', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    expect(s.size).toBe(12)
    expect(rows(s.get('ownerrez:2026-09:USD'))).toEqual({ 'Payments collected in OwnerRez': 1250_00, 'Refunds paid': -150_25, Chargebacks: 0, [REPORT_ROW_NET_COLLECTED]: 1099_75, 'Processing fees on those payments': -36_55 })
    // 03:30 UTC on Aug 2 is Aug 1 in New York.
    expect(rows(s.get('ownerrez:2026-08:USD'))).toEqual({ 'Payments collected in OwnerRez': 800_50, 'Refunds paid': 0, Chargebacks: -200_00, [REPORT_ROW_NET_COLLECTED]: 600_50, 'Processing fees on those payments': -15_00 })
    for (const snap of s.values()) {
      expect(snap.totals).toBeUndefined()
      expect(snap.basis).toBe('cash')
    }
  })

  it('a month that has begun on the account’s clock but not in UTC starts before it ends', async () => {
    const m = make(ownerrez({ hook: (u) => (u.pathname === '/v2/users/me' ? { json: { ...fx.me, time_zone: 'Pacific/Auckland' } } : undefined) }))
    m.clock.t = Date.parse('2026-10-31T12:00:00Z') // 01:00 on Nov 1 in Auckland
    const s = snaps((await runSync(m.connector, m.conn, null)).events).get('ownerrez:2026-11:USD')
    expect(s).toMatchObject({ from: '2026-11-01', to: '2026-11-01' })
  })

  it('leaves out an uncollected payment and one older than the run', async () => {
    const { r } = await sync()
    const total = [...snaps(r.events).values()].reduce((n, s) => n + (rows(s)['Payments collected in OwnerRez'] ?? 0), 0)
    expect(total).toBe(1250_00 + 800_50)
  })

  it('posts nothing: report snapshots only', async () => {
    const { r } = await sync()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('stores no names, emails or descriptions: not in an event, not in raw', async () => {
    const { r, raw } = await sync()
    for (const s of [JSON.stringify(r.events), JSON.stringify([...raw.records.values()])]) {
      expect(s).not.toContain('example.com')
      expect(s).not.toContain('Sam')
      expect(s).not.toContain('Sample Guest')
      expect(s).not.toContain('Early checkout')
    }
  })

  it('every call names the app and client id, and only GETs reach the API', async () => {
    const { calls } = await sync()
    expect(calls.length).toBeGreaterThan(2)
    for (const c of calls) expect(new URL(c.url).hostname).toBe('api.ownerrez.com')
    for (const c of calls) expect(c.method).toBe('GET')
    for (const c of calls) expect(c.headers['user-agent']).toBe('Aggregate/1.0 (c_12345)')
    await expect(getOnly((async () => new Response('{}')) as FetchLike)('https://api.ownerrez.com/v2/bookings', { method: 'PATCH' })).rejects.toThrow('only reads')
  })

  it('lists by created-or-changed since a year before the first month, then follows next_page_url only on OwnerRez', async () => {
    const paged = [list([pay({ id: 1 })], '/v2/payments?cursor=1&limit=100'), list([pay({ id: 2 })])]
    const { calls, r } = await sync(ownerrez({ payments: paged }))
    const urls = calls.map((c) => new URL(c.url)).filter((u) => u.pathname === '/v2/payments')
    expect(urls[0]!.searchParams.get('since_utc')).toBe('2024-10-30T00:00:00.000Z')
    expect(urls[1]!.searchParams.get('cursor')).toBe('1')
    expect(rows(snaps(r.events).get('ownerrez:2026-09:USD'))['Payments collected in OwnerRez']).toBe(20_00)
    const away = make(ownerrez({ payments: [list([pay()], 'https://evil.example.com/v2/payments?cursor=1')] }))
    await expect(runSync(away.connector, away.conn, null)).rejects.toThrow('won’t follow')
  })

  it('shows nothing until payments and refunds are both read', async () => {
    const m = make()
    const first = await m.connector.sync(m.conn, null)
    expect(first).toMatchObject({ events: [], hasMore: true })
    const second = await m.connector.sync(m.conn, first.cursor)
    expect(second.events.length).toBe(12)
    expect(second.hasMore).toBe(false)
  })

  it('stops rather than mix currencies, and when there’s no property to read one from', async () => {
    const mixed = make(ownerrez({ calendar: list([{ property_id: 1, currency_code: 'USD' }, { property_id: 2, currency_code: 'EUR' }]) }))
    await expect(runSync(mixed.connector, mixed.conn, null)).rejects.toThrow(OWNERREZ_MIXED_CURRENCY)
    const empty = make(ownerrez({ calendar: list([]) }))
    await expect(runSync(empty.connector, empty.conn, null)).rejects.toThrow(OWNERREZ_NO_CURRENCY)
  })

  it('a currency reported before stops the sync: its months are never zeroed or moved to the new one', async () => {
    const eur = make(ownerrez({ calendar: list([{ property_id: 1, currency_code: 'EUR' }]) }))
    const seeded = await runSync(eur.connector, eur.conn, null)
    const m = make()
    const e = (await runSync(m.connector, m.conn, seeded.cursor).catch((x: unknown) => x)) as ConnectorError
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(ownerRezCurrencyGone('EUR'))
    expect(m.calls.some((c) => new URL(c.url).pathname === '/v2/payments')).toBe(false)
    // The same currency again syncs as before.
    const again = make(ownerrez({ calendar: list([{ property_id: 1, currency_code: 'EUR' }]) }))
    const eurs = [...snaps((await runSync(again.connector, again.conn, seeded.cursor)).events).values()]
    expect(eurs.length).toBe(12)
    expect(eurs.every((s) => s.currency === 'EUR')).toBe(true)
  })

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a real zone', 'Mars/Olympus'],
  ])('a time zone that is %s stops the sync and the connect, never a guess at UTC', async (_n, zone) => {
    const routes = ownerrez({ hook: (u) => (u.pathname === '/v2/users/me' ? { json: { ...fx.me, time_zone: zone } } : undefined) })
    const m = make(routes)
    const e = (await runSync(m.connector, m.conn, null).catch((x: unknown) => x)) as ConnectorError
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(OWNERREZ_NO_TIME_ZONE)
    await expect(make(routes).connector.connect({ code: 'c' })).rejects.toThrow(OWNERREZ_NO_TIME_ZONE)
  })

  it.each([
    ['a string amount', pay({ amount: 'lots' })],
    ['no amount', pay({ amount: undefined })],
    ['a third decimal', pay({ amount: 1.234 })],
    ['a bad date', pay({ collected_utc: 'soon' })],
    ['a negative payment that isn’t a chargeback', pay({ amount: -5 })],
    ['a payment with no id', pay({ id: undefined })],
  ])('stops the sync on %s, and never counts it as zero', async (_n, p) => {
    const e = await fails([p])
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toMatch(/OwnerRez/)
  })

  it('a chargeback comes off by size, whichever sign it has', () => {
    expect(paymentLine(pay({ type: 'chargeback', amount: -40 }) as never, 'UTC', 'USD')!.totals.chargebacks).toBe(40_00)
    expect(paymentLine(pay({ type: 'chargeback', amount: 40 }) as never, 'UTC', 'USD')!.totals.chargebacks).toBe(40_00)
  })

  it('stops on a shape that isn’t a list', async () => {
    const m = make(ownerrez({ hook: (u) => (u.pathname === '/v2/payments' ? { json: { items: 'x' } } : undefined) }))
    await expect(runSync(m.connector, m.conn, null)).rejects.toMatchObject({ kind: 'permanent' })
  })

  it('a 403, a 429 or a 500 stops the sync with no totals, never $0', async () => {
    for (const status of [403, 429, 500]) {
      const m = make(ownerrez({ hook: (u) => (u.pathname === '/v2/payments' ? { status, json: { code: 'x' } } : undefined) }))
      const e = (await runSync(m.connector, m.conn, null).catch((x: unknown) => x)) as ConnectorError
      expect(e).toBeInstanceOf(ConnectorError)
      expect(m.raw.records.size).toBe(0)
      if (status === 403) expect(e.message).toBe(OWNERREZ_REFUSED)
    }
  }, 60_000)

  it('zero decimals: JPY stays whole', () => expect(amount(500, 'JPY')).toBe(500))

  it('files a payment by the account’s clock', () => {
    expect(paymentLine(pay({ collected_utc: '2026-10-01T02:00:00Z' }) as never, 'America/New_York', 'USD')!.month).toBe('2026-09')
    expect(monthIn('Not/AZone', Date.parse('2026-10-01T02:00:00Z'))).toBe('2026-10')
  })

  it('maps statuses', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'permanent'], [429, 'rate_limited']] as const) {
      const client = new OwnerRezClient('t'.repeat(24), 'c_1', { fetch: (async () => new Response('{}', { status })) as FetchLike, clock: fakeClock(), random: () => 0 })
      await expect(client.timeZone()).rejects.toMatchObject({ kind })
    }
  }, 30_000)

  it('sign-in asks only the read scope', async () => {
    const b = (await make().connector.begin({ state: 's' })) as { url: string }
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://app.ownerrez.com/oauth/authorize')
    expect(u.searchParams.get('scope')).toBe(OWNERREZ_SCOPE)
  })

  it('connects with the client in Basic and the app in the User-Agent, keeping no account details beyond a display name', async () => {
    const m = make()
    const c = await m.connector.connect({ code: 'x', redirectUri: oauth.redirectUri } as never)
    expect(c.config).toEqual({ accountId: '1001', displayName: 'OwnerRez · Sample Rentals' })
    expect((c.secret as { tokens: Row }).tokens.extra).toBeUndefined()
    const post = m.calls.find((x) => x.method === 'POST')!
    expect(post.headers.authorization).toBe(`Basic ${Buffer.from('c_12345:s_secret').toString('base64')}`)
    expect(post.headers['user-agent']).toBe(UA)
  })

  it('refuses a grant that isn’t read-only', async () => {
    for (const scope of ['full', undefined]) {
      const m = make(ownerrez({ token: { scope } }))
      await expect(m.connector.connect({ code: 'x' } as never)).rejects.toThrow(OWNERREZ_WRONG_SCOPE)
    }
  })

  it('saves the renewed tokens before reading', async () => {
    const m = make(undefined, { secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), refreshToken: 'rt_' + 'r'.repeat(24), expiresAt: 1 } } })
    const r = await m.connector.sync(m.conn, null)
    expect((m.saved[0] as { tokens: Row }).tokens.refreshToken).toBe('rt_' + 'm'.repeat(24))
    expect(r.updatedSecret).toBeTruthy()
    expect(m.calls[0]!.method).toBe('POST')
  })

  it('health never spends a refresh token', async () => {
    const m = make(undefined, { secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), refreshToken: 'rt_' + 'r'.repeat(24), expiresAt: 1 } } })
    expect((await m.connector.health(m.conn)).status).toBe('ok')
    expect(m.calls.length).toBe(0)
  })

  it('disconnect revokes the token at OwnerRez with the app’s credentials, and says where to remove it if that fails', async () => {
    const m = make()
    expect(await m.connector.disconnect!(m.conn)).toBeUndefined()
    const dels = m.calls.filter((x) => x.method === 'DELETE')
    expect(dels.map((d) => new URL(d.url).pathname)).toEqual([`/oauth/access_token/at_${'a'.repeat(24)}`, `/oauth/access_token/rt_${'r'.repeat(24)}`])
    for (const d of dels) expect(d.headers.authorization).toBe(`Basic ${Buffer.from('c_12345:s_secret').toString('base64')}`)
    const bad = make(ownerrez({ hook: (u) => (u.pathname.startsWith('/oauth/access_token/') ? { status: 500, json: {} } : undefined) }))
    expect(await bad.connector.disconnect!(bad.conn)).toEqual({ notRevoked: NOT_REVOKED })
    // The refresh token refused: still not ended, and the person is told. A 404 means the first call already ended it.
    const halfway = make(ownerrez({ hook: (u) => (u.pathname.startsWith('/oauth/access_token/rt_') ? { status: 500, json: {} } : undefined) }))
    expect(await halfway.connector.disconnect!(halfway.conn)).toEqual({ notRevoked: NOT_REVOKED })
    const ended = make(ownerrez({ hook: (u) => (u.pathname.startsWith('/oauth/access_token/rt_') ? { status: 404, json: {} } : undefined) }))
    expect(await ended.connector.disconnect!(ended.conn)).toBeUndefined()
    // A 404 on the access token is still a failure: nothing says the grant ended.
    const noAccess = make(ownerrez({ hook: (u) => (u.pathname.startsWith('/oauth/access_token/at_') ? { status: 404, json: {} } : undefined) }))
    expect(await noAccess.connector.disconnect!(noAccess.conn)).toEqual({ notRevoked: NOT_REVOKED })
    // No refresh token kept: one call.
    const one = make(ownerrez(), { secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), expiresAt: FAR } } })
    expect(await one.connector.disconnect!(one.conn)).toBeUndefined()
    expect(one.calls.filter((x) => x.method === 'DELETE').length).toBe(1)
  })
})
