import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createZeffyConnector, getOnly, NOT_REVOKED, parseZone, REPORT_ROW_NET, TIME_ZONES, ZEFFY_KEY_CAN_WRITE, ZEFFY_KEY_REJECTED, ZEFFY_REFUSED } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/zeffy.json', import.meta.url), 'utf8')) as { payments: Row[] }

const KEY = 'k'.repeat(40)
const conn: ConnectionRef = { id: 'conn_zf', workspaceId: 'ws1', connectorKey: 'zeffy', secret: { apiKey: KEY, zone: 'America/Toronto' }, config: {} }
const PATH = '/api/v1/payments'

interface Data {
  payments?: Row[]
  /** Answers first; undefined falls through to the list below. */
  hook?: (u: URL) => FixtureResponse | undefined
}

/** A small Zeffy: filters by created[gte], newest first, pages by starting_after and limit. */
function zeffy(data: Data = {}): FixtureRoute[] {
  const payments = data.payments ?? fx.payments
  return [{ method: 'GET', match: () => true, respond: (u) => data.hook?.(u) ?? route(u) }]
  function route(u: URL): FixtureResponse {
    if (u.pathname !== PATH) return { status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_not_found', status: 404 } } }
    const gte = Number(u.searchParams.get('created[gte]') ?? 0)
    const limit = Number(u.searchParams.get('limit') ?? 10)
    const rows = payments.filter((p) => typeof p.created !== 'number' || p.created >= gte).sort((a, b) => Number(b.created) - Number(a.created))
    const after = u.searchParams.get('starting_after')
    const start = after ? rows.findIndex((p) => p.id === after) + 1 : 0
    const data = rows.slice(start, start + limit)
    const has_more = start + limit < rows.length
    return { json: { object: 'list', data, has_more, next_cursor: has_more ? data.at(-1)!.id : null } }
  }
}

function make(routes: FixtureRoute[] = zeffy(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const connector = createZeffyConnector({ raw, fetch: f.fetch, clock, random: () => 0 })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[], over?: Partial<ConnectionRef>) => {
  const m = make(routes, over)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const failure = async (routes: FixtureRoute[]) => {
  const m = make(routes)
  return (await runSync(m.connector, m.conn, null).catch((x: unknown) => x)) as ConnectorError
}
const unix = (iso: string) => Date.parse(iso) / 1000
const payment = (p: Row = {}): Row => ({ id: 'p-x', created: unix('2026-09-15T12:00:00Z'), amount: 1000, currency: 'cad', status: 'succeeded', type: 'online', refunds: [], ...p })
const ONLINE = 'Online payments through Zeffy'

describe('zeffy connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(zeffy({ payments: Array.from({ length: 250 }, (_, i) => payment({ id: `p-${i}`, created: unix('2026-09-15T12:00:00Z') + i })) })), minEvents: 12 })
    expect(r.pages).toBeGreaterThan(2)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('adds up to hand-computed numbers: online payments by the organization’s month, refunds in their own month, currencies apart', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    // 12 months × CAD and USD.
    expect(s.size).toBe(24)
    // 03:30 UTC on Sep 1 is Aug 31 in Toronto.
    expect(rows(s.get('zeffy:2026-08:CAD'))).toEqual({ [ONLINE]: 9_00, Refunds: 0, [REPORT_ROW_NET]: 9_00 })
    // 50.00 + 20.00 (03:00 UTC Oct 1 is Sep 30 in Toronto). Its refund comes off in October, not here.
    expect(rows(s.get('zeffy:2026-09:CAD'))).toEqual({ [ONLINE]: 70_00, Refunds: 0, [REPORT_ROW_NET]: 70_00 })
    // Manual, imported, failed and pending are out. Refunds: 25.00 on p-01 and 10.00 on a June 2025 payment (lookback).
    expect(rows(s.get('zeffy:2026-10:CAD'))).toEqual({ [ONLINE]: 0, Refunds: -35_00, [REPORT_ROW_NET]: -35_00 })
    // A pending refund isn't taken off.
    expect(rows(s.get('zeffy:2026-08:USD'))).toEqual({ [ONLINE]: 75_00, Refunds: 0, [REPORT_ROW_NET]: 75_00 })
    expect(rows(s.get('zeffy:2025-11:CAD'))).toEqual({ [ONLINE]: 0, Refunds: 0, [REPORT_ROW_NET]: 0 })
    expect(s.get('zeffy:2026-10:CAD')).toMatchObject({ from: '2026-10-01', to: '2026-10-09', basis: 'accrual', kind: 'profit_and_loss' })
    for (const snap of s.values()) expect(snap.totals).toBeUndefined()
  })

  it('reads from a year before the first month, two days early, in pages of 100 by starting_after', async () => {
    const many = Array.from({ length: 230 }, (_, i) => payment({ id: `p-${i}`, created: unix('2026-09-15T12:00:00Z') + i }))
    const { calls, r } = await sync(zeffy({ payments: many }))
    const urls = calls.map((c) => new URL(c.url))
    expect(urls.map((u) => u.searchParams.get('starting_after'))).toEqual([null, 'p-130', 'p-30'])
    for (const u of urls) {
      expect(u.searchParams.get('limit')).toBe('100')
      expect(u.searchParams.get('created[gte]')).toBe(String(unix('2024-10-30T00:00:00Z')))
    }
    expect(rows(snaps(r.events).get('zeffy:2026-09:CAD'))[ONLINE]).toBe(2300_00)
  })

  it('a month that has begun on the organization’s clock but not in UTC starts before it ends', async () => {
    const m = make(zeffy(), { secret: { apiKey: KEY, zone: 'America/St_Johns' } })
    m.clock.t = Date.parse('2026-11-01T03:00:00Z') // 00:30 on Nov 1 in St. John's
    const s = snaps((await runSync(m.connector, m.conn, null)).events).get('zeffy:2026-11:CAD')
    expect(s).toMatchObject({ from: '2026-11-01', to: '2026-11-01' })
  })

  it('a refund on a payment made in the lookback year comes off; one on a payment made before it doesn’t', async () => {
    const refund = { amount: 300, currency: 'cad', status: 'succeeded', created: unix('2026-09-02T12:00:00Z') }
    const { r } = await sync(zeffy({ payments: [payment({ id: 'in', created: unix('2024-11-15T12:00:00Z'), refunds: [refund] }), payment({ id: 'before', created: unix('2024-10-31T12:00:00Z'), refunds: [refund] })] }))
    expect(rows(snaps(r.events).get('zeffy:2026-09:CAD'))).toEqual({ [ONLINE]: 0, Refunds: -3_00, [REPORT_ROW_NET]: -3_00 })
  })

  it('a currency once reported keeps its months, as zeros, when it goes quiet', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const again = createZeffyConnector({ raw: m.raw, fetch: fixtureFetch(zeffy({ payments: [] })).fetch, clock: m.clock, random: () => 0 })
    const r = await runSync(again, m.conn, first.cursor)
    expect(rows(snaps(r.events).get('zeffy:2026-08:USD'))).toEqual({ [ONLINE]: 0, Refunds: 0, [REPORT_ROW_NET]: 0 })
  })

  it('posts nothing: report snapshots only', async () => {
    const { r } = await sync()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })

  it('stores no donor names, emails, addresses, answers or tributes: not in an event, not in raw', async () => {
    const { r, raw } = await sync()
    for (const s of [JSON.stringify(r.events), JSON.stringify([...raw.records.values()])]) {
      for (const word of ['example.com', 'Sample', 'Street', 'Wrong size', 'Honouree', 'visa']) expect(s).not.toContain(word)
    }
  })

  it('only GETs reach the API, with the key as a Bearer token, and anything else is refused before it leaves', async () => {
    const { calls } = await sync()
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe('https://api.zeffy.com')
      expect(c.method).toBe('GET')
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(c.url).not.toContain(KEY)
    }
    let sent = 0
    const inner: FetchLike = async () => (sent++, new Response('{}'))
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(getOnly(inner)('https://api.zeffy.com/api/v1/payments/p-01', { method })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })

  it('stops, never zero, on what the docs don’t say', async () => {
    const bad: Array<[Row, RegExp]> = [
      [payment({ amount: 10.5 }), /an amount/],
      [payment({ amount: -100 }), /an amount/],
      [payment({ amount: '1000' }), /an amount/],
      [payment({ currency: 'eur' }), /a currency/],
      [payment({ status: 'refunded' }), /a payment status/],
      [payment({ type: 'kiosk' }), /a payment type/],
      [payment({ created: '2026-09-15' }), /a date/],
      [payment({ refunds: [{ amount: 100, currency: 'usd', status: 'succeeded', created: unix('2026-09-20T12:00:00Z') }] }), /another currency/],
      [payment({ refunds: [{ amount: 100, currency: 'cad', status: 'reversed', created: unix('2026-09-20T12:00:00Z') }] }), /a refund status/],
      // Out of the counted set, but still read: a value that isn't what the docs say is never passed over.
      [payment({ type: 'manual', amount: null }), /an amount/],
    ]
    for (const [p, re] of bad) {
      const e = await failure(zeffy({ payments: [p] }))
      expect(e).toBeInstanceOf(ConnectorError)
      expect(e.message).toMatch(re)
      expect(e.message).toMatch(/No totals were changed/)
    }
  })

  it('a page that says there’s more without a new cursor stops instead of starting over', async () => {
    const e = await failure(zeffy({ hook: () => ({ json: { object: 'list', data: [payment()], has_more: true, next_cursor: null } }) }))
    expect(e.message).toMatch(/already sent/)
    const notList = await failure(zeffy({ hook: () => ({ json: { data: [] } }) }))
    expect(notList.message).toMatch(/a list/)
  })

  it('says plainly when the key is rejected or refused, never quoting Zeffy’s message', async () => {
    const e401 = await failure(zeffy({ hook: () => ({ status: 401, json: { error: { code: 'invalid_api_key', message: 'key abc' } } }) }))
    expect(e401).toMatchObject({ kind: 'auth', message: ZEFFY_KEY_REJECTED })
    const e403 = await failure(zeffy({ hook: () => ({ status: 403, json: { error: { message: 'secret detail' } } }) }))
    expect(e403).toMatchObject({ kind: 'permanent', message: ZEFFY_REFUSED })
  })

  it('waits Retry-After on a 429', async () => {
    let n = 0
    const m = make(zeffy({ hook: () => (n++ === 0 ? { status: 429, headers: { 'retry-after': '1' }, json: { error: { code: 'rate_limit_exceeded' } } } : undefined) }))
    const r = await runSync(m.connector, m.conn, null)
    expect(r.complete).toBe(true)
    expect(m.clock.sleeps).toContain(1000)
  })

  it('connect checks the key with one GET, keeps the picked time zone and warns the key could write', async () => {
    const m = make()
    const begin = await m.connector.begin()
    expect(begin).toMatchObject({ kind: 'api_key', fields: [{ name: 'apiKey', secret: true }, { name: 'zone', options: TIME_ZONES.map(([l]) => l) }] })
    const out = await m.connector.connect({ apiKey: ` ${KEY} `, zone: 'Pacific (Vancouver, Los Angeles)' })
    expect(out).toMatchObject({ secret: { apiKey: KEY, zone: 'America/Vancouver' }, config: { zone: 'America/Vancouver', warnings: [ZEFFY_KEY_CAN_WRITE] } })
    expect(m.calls).toHaveLength(1)
    expect(new URL(m.calls[0]!.url).searchParams.get('limit')).toBe('1')
    await expect(m.connector.connect({ apiKey: 'short', zone: 'America/Toronto' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(m.connector.connect({ apiKey: KEY, zone: 'Mars/Olympus' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(m.connector.connect({ apiKey: KEY })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('every time zone label names a zone the runtime knows', () => {
    for (const [label, zone] of TIME_ZONES) expect(parseZone(label)).toBe(zone)
    expect(parseZone('Europe/Paris')).toBe('Europe/Paris')
    expect(parseZone('UTC')).toBeNull()
  })

  it('disconnect says where to remove the key', async () => {
    expect(await make().connector.disconnect?.(conn)).toEqual({ notRevoked: NOT_REVOKED })
  })
})
