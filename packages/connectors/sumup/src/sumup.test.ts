import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectBegin, ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync, type FetchLike } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createSumUpConnector, getOnly, NOT_REVOKED_KEY, NOT_REVOKED_OAUTH, PAYOUTS_LIMIT, REPORT_ROW_CASH, REPORT_ROW_CHARGEBACK_DEDUCTIONS, REPORT_ROW_CHARGEBACKS, REPORT_ROW_FEES, REPORT_ROW_OTHER_DEDUCTIONS, REPORT_ROW_PAID_OUT, REPORT_ROW_REFUND_DEDUCTIONS, REPORT_ROW_REFUNDS, REPORT_ROW_SALES, SumUpClient, SUMUP_KEY_REFUSED, SUMUP_KEY_WARNING, SUMUP_NOT_SET_UP, SUMUP_ROLE_MESSAGE, SUMUP_TOO_MUCH_ACCESS, splitDays, type SumUpConnectorOptions } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/sumup.json', import.meta.url), 'utf8')) as { memberships: { total_count: number; items: Row[] }; payouts: Row[]; transactions: Row[] }

const oauthOpt = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'https://app.example.com/api/connectors/sumup/callback' }
const conn: ConnectionRef = { id: 'conn_s', workspaceId: 'ws1', connectorKey: 'sumup', secret: { kind: 'key', apiKey: 'sup_sk_' + 'a'.repeat(20) }, config: { merchantCode: 'MH4H92C7' } }

const pay = (o: Row): Row => ({ id: 1, type: 'PAYOUT', amount: 10, fee: 1, date: '2026-09-02', currency: 'EUR', status: 'SUCCESSFUL', ...o })
const tx = (o: Row): Row => ({ type: 'PAYMENT', status: 'SUCCESSFUL', payment_type: 'POS', amount: 10, currency: 'EUR', timestamp: '2026-09-02T10:00:00Z', ...o })

/** A small SumUp: payouts filtered by date with a limit and no pages, history filtered by time and paged by oldest_ref. */
function sumup(data: { payouts?: Row[]; transactions?: Row[]; memberships?: Row; perPage?: number; hook?: (u: URL) => FixtureResponse | undefined } = {}): FixtureRoute[] {
  const payouts = data.payouts ?? fx.payouts
  const transactions = data.transactions ?? fx.transactions
  return [
    {
      method: 'GET',
      match: (u) => u.pathname === '/v0.1/memberships',
      respond: (u) => data.hook?.(u) ?? { json: data.memberships ?? fx.memberships },
    },
    {
      method: 'GET',
      match: (u) => u.pathname === '/v1.0/merchants/MH4H92C7/payouts',
      respond: (u) => {
        const hook = data.hook?.(u)
        if (hook) return hook
        const start = u.searchParams.get('start_date')!
        const end = u.searchParams.get('end_date')!
        const limit = Number(u.searchParams.get('limit'))
        return { json: payouts.filter((p) => (p.date as string) >= start && (p.date as string) <= end).slice(0, limit) }
      },
    },
    {
      method: 'GET',
      match: (u) => u.pathname === '/v2.1/merchants/MH4H92C7/transactions/history',
      respond: (u) => {
        const hook = data.hook?.(u)
        if (hook) return hook
        const oldest = u.searchParams.get('oldest_time')
        const rows = transactions.filter((t) => !oldest || Date.parse(t.timestamp as string) >= Date.parse(oldest))
        const size = data.perPage ?? Number(u.searchParams.get('limit') ?? 10)
        const at = Number(u.searchParams.get('oldest_ref') ?? 0)
        const more = at + size < rows.length
        const keep = oldest ? `&oldest_time=${oldest}` : ''
        return { json: { items: rows.slice(at, at + size), links: more ? [{ rel: 'next', href: `limit=${size}&oldest_ref=${at + size}&order=ascending${keep}` }] : [] } }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = sumup(), opts: Partial<SumUpConnectorOptions> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createSumUpConnector({ ...opts }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const history = (u: URL | string) => new URL(u).pathname.endsWith('/transactions/history')
const stored = (raw: MemoryRawSink) => [...raw.records.values()].map((x) => x.payload)
const run = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const stops = async (routes: FixtureRoute[], message: RegExp) => {
  const m = make(routes)
  const e = await runSync(m.connector, m.conn, null).catch((x: unknown) => x)
  expect(e).toBeInstanceOf(ConnectorError)
  expect((e as ConnectorError).message).toMatch(message)
  return e as ConnectorError
}

describe('sumup contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 48 })
    expect(r.pages).toBeGreaterThan(0)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe('the client can only GET', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'OPTIONS', 'HEAD'])('%s throws before anything leaves', async (method) => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await expect(getOnly(under)('https://api.sumup.com/v0.1/memberships', { method })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })
  it('a GET, and a request with no method, goes through', async () => {
    let sent = 0
    const under: FetchLike = async () => (sent++, new Response('{}'))
    await getOnly(under)('https://api.sumup.com/x', { method: 'GET' })
    await getOnly(under)('https://api.sumup.com/x')
    expect(sent).toBe(2)
  })
  it('holds inside SumUpClient, past its public surface', async () => {
    let sent = 0
    const client = new SumUpClient('t'.repeat(24), { fetch: async () => (sent++, new Response('{}')) })
    const http = (client as unknown as { http: { request(r: unknown): Promise<unknown> } }).http
    await expect(http.request({ method: 'POST', path: '/v0.1/merchants/X/payouts', json: {} })).rejects.toThrow('only reads')
    expect(sent).toBe(0)
  })
  it('a full sync sends nothing but GET', async () => {
    const { calls } = await run()
    expect(calls.length).toBeGreaterThan(0)
    expect(new Set(calls.map((c) => c.method))).toEqual(new Set(['GET']))
  })
})

describe('only ever a report snapshot', () => {
  it('emits report.snapshot and nothing that could post', async () => {
    const { r } = await run()
    expect(new Set(r.events.map((e) => e.type))).toEqual(new Set(['report.snapshot']))
  })
  it('one snapshot per month per currency', async () => {
    const { r } = await run()
    expect(r.events).toHaveLength(48)
    expect(new Set(r.events.map((e) => e.externalId)).size).toBe(48)
    expect(snaps(r.events).has('sumup:2026-09:EUR')).toBe(true)
    expect(snaps(r.events).has('sumup:2026-09:CLP')).toBe(true)
  })
  it('carries no net income a check could read as books', async () => {
    const { r } = await run()
    for (const s of snaps(r.events).values()) {
      expect(s.totals).toBeUndefined()
      expect(s.rows.some((x) => /net income/i.test(x.account))).toBe(false)
    }
  })
  it('keeps no person, card or description: raw and events hold the month’s totals only', async () => {
    const { r, raw } = await run()
    const kept = JSON.stringify([r.events, stored(raw)])
    for (const leak of ['@example.com', 'MUST-NOT-BE-KEPT', 'VISA', 'TEENSK4W2K', 'payout-1']) expect(kept).not.toContain(leak)
    expect(stored(raw)).toHaveLength(48)
    for (const p of stored(raw)) expect(Object.keys(p as object).sort()).toEqual(['currency', 'month', 'totals'])
  })
})

describe('totals, worked by hand', () => {
  const september = {
    [REPORT_ROW_SALES]: 160_20, // 100.10 + 60.00 + 0.10; pending, failed, cancelled and cash are out
    [REPORT_ROW_CASH]: 20_00,
    [REPORT_ROW_REFUNDS]: 25_50,
    [REPORT_ROW_CHARGEBACKS]: 40_00,
    [REPORT_ROW_PAID_OUT]: 132_75, // 132.45 + 0.10 + 0.20; the failed 500.00 is out
    [REPORT_ROW_FEES]: 3_42, // 3.12 + 0.20 + 0.10; the failed payout's 9.99 is out
    [REPORT_ROW_REFUND_DEDUCTIONS]: 25_50,
    [REPORT_ROW_CHARGEBACK_DEDUCTIONS]: 40_00,
    [REPORT_ROW_OTHER_DEDUCTIONS]: 6_25, // 5.00 + 1.25
  }
  it('September in EUR, to the cent, every row its own', async () => {
    const { r } = await run()
    expect(rows(snaps(r.events).get('sumup:2026-09:EUR'))).toEqual(september)
  })
  it('a sale and a payout count in their own months, split at UTC midnight', async () => {
    const { r } = await run()
    const oct = rows(snaps(r.events).get('sumup:2026-10:EUR'))
    expect(oct[REPORT_ROW_SALES]).toBe(20)
    expect(oct[REPORT_ROW_PAID_OUT]).toBe(80_00)
    expect(oct[REPORT_ROW_FEES]).toBe(2_00)
  })
  it('a time with an offset lands in its UTC month', async () => {
    const { r } = await run(sumup({ payouts: [], transactions: [tx({ timestamp: '2026-09-01T00:30:00+02:00', amount: 3 })] }))
    expect(rows(snaps(r.events).get('sumup:2026-08:EUR'))[REPORT_ROW_SALES]).toBe(3_00)
  })
  it('each currency alone, zero-decimal included, never added together', async () => {
    const { r } = await run()
    const clp = rows(snaps(r.events).get('sumup:2026-09:CLP'))
    expect(clp[REPORT_ROW_SALES]).toBe(5000)
    expect(clp[REPORT_ROW_PAID_OUT]).toBe(1000)
    expect(clp[REPORT_ROW_FEES]).toBe(30)
    expect(snaps(r.events).get('sumup:2026-09:CLP')?.currency).toBe('CLP')
  })
  it('floats add up exactly: 0.1 + 0.2 three times over', async () => {
    const amounts = [0.1, 0.2, 0.1, 0.2, 0.1, 0.2]
    const { r } = await run(sumup({ transactions: [], payouts: amounts.map((amount, id) => pay({ id, amount, fee: amount })) }))
    const s = rows(snaps(r.events).get('sumup:2026-09:EUR'))
    expect(s[REPORT_ROW_PAID_OUT]).toBe(90)
    expect(s[REPORT_ROW_FEES]).toBe(90)
  })
  it('deductions read the same whichever sign SumUp sends', async () => {
    const { r } = await run(sumup({ transactions: [], payouts: [pay({ type: 'REFUND_DEDUCTION', amount: -7.5, fee: 0 }), pay({ id: 2, type: 'REFUND_DEDUCTION', amount: -2.5, fee: 0 })] }))
    expect(rows(snaps(r.events).get('sumup:2026-09:EUR'))[REPORT_ROW_REFUND_DEDUCTIONS]).toBe(10_00)
  })
  it('a fee on a deduction record isn’t counted, and PAYOUT never subtracts a deduction', async () => {
    const { r } = await run(sumup({ transactions: [], payouts: [pay({ amount: 100, fee: 2 }), pay({ id: 2, type: 'REFUND_DEDUCTION', amount: 30, fee: 1 })] }))
    const s = rows(snaps(r.events).get('sumup:2026-09:EUR'))
    expect(s[REPORT_ROW_PAID_OUT]).toBe(100_00)
    expect(s[REPORT_ROW_FEES]).toBe(2_00)
  })
  it('a chargeback status keeps the sale, and a cash refund isn’t a SumUp refund', async () => {
    const { r } = await run(sumup({ payouts: [], transactions: [tx({ status: 'CHARGE_BACK', amount: 12 }), tx({ type: 'REFUND', amount: 4, payment_type: 'CASH' })] }))
    const s = rows(snaps(r.events).get('sumup:2026-09:EUR'))
    expect(s[REPORT_ROW_SALES]).toBe(12_00)
    expect(s[REPORT_ROW_REFUNDS]).toBe(0)
  })
  it('a month a currency has left reads zero', async () => {
    const m = make(sumup({ payouts: [], transactions: [tx({ currency: 'GBP', timestamp: '2024-11-05T10:00:00Z' })] }))
    const r = await runSync(m.connector, m.conn, null)
    const s = rows(snaps(r.events).get('sumup:2026-09:GBP'))
    expect(Object.values(s).every((v) => v === 0)).toBe(true)
    expect(Object.is(snaps(r.events).get('sumup:2026-09:GBP')?.rows[0]?.amount.minor, 0)).toBe(true)
  })
  it('a merchant with no records at all gets no snapshots, and that isn’t an error', async () => {
    const { r } = await run(sumup({ payouts: [], transactions: [] }))
    expect(r.events).toEqual([])
    expect(r.complete).toBe(true)
  })
  it('the current month ends today', async () => {
    const { r } = await run()
    expect(snaps(r.events).get('sumup:2026-10:EUR')?.to).toBe('2026-10-09')
    expect(snaps(r.events).get('sumup:2026-09:EUR')?.to).toBe('2026-09-30')
  })
})

describe('a shape that doesn’t match stops the sync; nothing counts as zero', () => {
  it.each([
    ['a missing amount', { amount: undefined }, /amount/],
    ['a null amount', { amount: null }, /amount/],
    ['a blank amount', { amount: ' ' }, /amount/],
    ['an object for an amount', { amount: {} }, /amount/],
    ['a missing fee', { fee: undefined }, /amount/],
    ['no currency', { currency: undefined }, /no currency/],
    ['an unknown type', { type: 'INTEREST' }, /payout type/],
    ['an unknown status', { status: 'SCHEDULED' }, /payout status/],
    ['a payout below zero', { amount: -3 }, /below zero/],
  ])('payout: %s', async (_n, o, message) => {
    const e = await stops(sumup({ transactions: [], payouts: [pay(o)] }), message)
    expect(e.message).not.toContain('undefined')
  })
  it.each([
    ['a missing amount', { amount: undefined }, /amount/],
    ['no currency', { currency: 7 }, /no currency/],
    ['an unknown type', { type: 'TIP' }, /transaction type/],
    ['no type', { type: undefined }, /transaction type/],
    ['an unknown status', { status: 'DONE' }, /transaction status/],
    ['no payment type', { payment_type: undefined }, /no payment type/],
    ['a sale below zero', { amount: -1 }, /below zero/],
  ])('transaction: %s', async (_n, o, message) => {
    await stops(sumup({ payouts: [], transactions: [tx(o)] }), message)
  })
  it('a date or a time that isn’t one', async () => {
    await stops(sumup({ transactions: [], hook: (u) => (u.pathname.endsWith('/payouts') ? { json: [pay({ date: '02/09/2026' })] } : undefined) }), /payout date/)
    await stops(sumup({ payouts: [], hook: (u) => (history(u) ? { json: { items: [tx({ timestamp: undefined })], links: [] } } : undefined) }), /transaction time/)
  })
  it('an amount it can’t read is never repeated', async () => {
    const e = await stops(sumup({ transactions: [], payouts: [pay({ amount: 'cardholder Jane' })] }), /amount/)
    expect(e.message).not.toContain('Jane')
  })
  it('a payout outside the dates asked for stops it: it would count twice', async () => {
    const routes = sumup({ hook: (u) => (u.pathname.endsWith('/payouts') ? { json: [pay({ date: '2020-01-01' })] } : undefined) })
    await stops(routes, /outside the dates/)
  })
  it('a sale before the run stops it: the time filter wasn’t applied', async () => {
    const routes = sumup({ payouts: [], hook: (u) => (history(u) ? { json: { items: [tx({ timestamp: '2020-01-01T00:00:00Z' })], links: [] } } : undefined) })
    await stops(routes, /outside the dates/)
  })
  it('a sale after the run’s last month waits for the next run', async () => {
    const m = make(sumup({ payouts: [], transactions: [tx({}), tx({ timestamp: '2026-11-01T00:00:00Z', amount: 99 })] }))
    const r = await runSync(m.connector, m.conn, null)
    expect(snaps(r.events).has('sumup:2026-11:EUR')).toBe(false)
  })
  it.each([
    ['fee', [pay({ fee: 1 }), pay({ id: 2, fee: -1 })]],
    ['a deduction', [pay({ type: 'REFUND_DEDUCTION', amount: 1, fee: 0 }), pay({ id: 2, type: 'REFUND_DEDUCTION', amount: -1, fee: 0 })]],
  ])('both signs on %s stops it: the sizes can’t be added', async (_n, payouts) => {
    await stops(sumup({ transactions: [], payouts }), /mixed signs/)
  })
  it('both signs across two months stops it too', async () => {
    await stops(sumup({ transactions: [], payouts: [pay({ fee: 1 }), pay({ id: 2, fee: -1, date: '2026-08-02' })] }), /mixed signs/)
  })
  it('a refund on a sale with no refund record stops it, rather than show no refunds', async () => {
    await stops(sumup({ payouts: [], transactions: [tx({ status: 'REFUNDED', refunded_amount: 5 })] }), /no matching refund records/)
  })
  it('a refund record on a sale older than the run is fine', async () => {
    const { r } = await run(sumup({ payouts: [], transactions: [tx({ type: 'REFUND', amount: 5 })] }))
    expect(rows(snaps(r.events).get('sumup:2026-09:EUR'))[REPORT_ROW_REFUNDS]).toBe(5_00)
  })
  it.each([
    ['payouts as an object', '/payouts', { json: { items: [] } }],
    ['payouts as text', '/payouts', { text: 'ok' }],
    ['a payout that isn’t a record', '/payouts', { json: ['x'] }],
    ['history with no items', '/history', { json: { links: [] } }],
    ['history with no links', '/history', { json: { items: [] } }],
    ['history as a list', '/history', { json: [] }],
  ])('a 200 that isn’t a list never reads as a month of nothing: %s', async (_n, path, response) => {
    // A non-JSON body is now caught by the shared client (non-JSON response); a wrong JSON shape by sumup (can’t read).
    await stops(sumup({ hook: (u) => (u.pathname.endsWith(path) ? (response as FixtureResponse) : undefined) }), /can’t read|non-JSON/)
  })
  it('stop or no stop, no snapshot is emitted on the way there', async () => {
    const m = make(sumup({ payouts: [], transactions: [tx({ type: 'TIP' })] }))
    await expect(runSync(m.connector, m.conn, null)).rejects.toThrow()
    expect(stored(m.raw)).toEqual([])
  })
})

describe('paging and cost', () => {
  it('every history page is read, and the next query is the one SumUp gave', async () => {
    const { r, calls } = await run(sumup({ perPage: 2 }))
    expect(rows(snaps(r.events).get('sumup:2026-09:EUR'))[REPORT_ROW_SALES]).toBe(160_20)
    const pages = calls.filter((c) => history(c.url))
    expect(pages.length).toBeGreaterThan(4)
    expect(new URL(pages[1]!.url).searchParams.get('oldest_ref')).toBe('2')
  })
  it('a stop on any page resumes without losing or doubling a cent', async () => {
    const m = make(sumup({ perPage: 2 }))
    const whole = await runSync(m.connector, m.conn, null)
    const n = make(sumup({ perPage: 2 }))
    let cursor: string | null = null
    let events: NormalizedEvent[] = []
    for (let i = 0; i < 100; i++) {
      // A fresh connector each step: everything lives in the cursor.
      const fresh = make(sumup({ perPage: 2 }))
      const step = await fresh.connector.sync(n.conn, cursor)
      events = [...events, ...step.events]
      cursor = step.cursor
      if (!step.hasMore) break
    }
    expect([...snaps(events).entries()].map(([k, v]) => [k, rows(v)])).toEqual([...snaps(whole.events).entries()].map(([k, v]) => [k, rows(v)]))
  })
  it('a next link that asks for the same page is refused, not read for ever', async () => {
    const same = { json: { items: [tx({})], links: [{ rel: 'next', href: 'oldest_ref=x&limit=100' }] } }
    await stops(sumup({ payouts: [], hook: (u) => (history(u) ? same : undefined) }), /can’t read/)
  })
  it.each(['https://evil.example/x?oldest_ref=1', '//evil.example/?a=1', '/v2.1/other?a=1'])('refuses a next link that isn’t a query: %s', async (href) => {
    await stops(sumup({ payouts: [], hook: (u) => (history(u) ? { json: { items: [], links: [{ rel: 'next', href }] } } : undefined) }), /won’t follow/)
  })
  it('a next link with a key twice is refused: half a filter is a wrong total', async () => {
    await stops(sumup({ payouts: [], hook: (u) => (history(u) ? { json: { items: [], links: [{ rel: 'next', href: 'statuses[]=A&statuses[]=B' }] } } : undefined) }), /can’t read/)
  })
  it('first sync reads 24 months, one payouts call each; later ones recompute 6', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const payouts = () => m.calls.filter((c) => new URL(c.url).pathname.endsWith('/payouts'))
    const q = (c: { url: string }) => new URL(c.url).searchParams
    expect(payouts()).toHaveLength(24)
    expect(q(payouts()[0]!).get('start_date')).toBe('2024-11-01')
    expect(q(payouts()[0]!).get('end_date')).toBe('2024-11-30')
    expect(q(m.calls.find((c) => history(c.url))!).get('oldest_time')).toBe('2024-11-01T00:00:00Z')
    m.calls.length = 0
    const later = await runSync(m.connector, m.conn, first.cursor)
    expect(payouts()).toHaveLength(6)
    expect(q(payouts()[0]!).get('start_date')).toBe('2026-05-01')
    expect(later.events).toHaveLength(12)
  })
  it('a payouts answer at the limit is cut short, so the range is split until each part fits', async () => {
    const full = Array.from({ length: PAYOUTS_LIMIT + 5 }, (_, i) => pay({ id: i, amount: 1, fee: 0, date: `2026-09-${String((i % 30) + 1).padStart(2, '0')}` }))
    const { r } = await run(sumup({ transactions: [], payouts: full }))
    expect(rows(snaps(r.events).get('sumup:2026-09:EUR'))[REPORT_ROW_PAID_OUT]).toBe((PAYOUTS_LIMIT + 5) * 100)
  })
  it('one day at the limit stops the sync; it never counts what came back', async () => {
    const full = Array.from({ length: PAYOUTS_LIMIT }, (_, i) => pay({ id: i, amount: 1, fee: 0 }))
    await stops(sumup({ transactions: [], payouts: full }), /more payout records for one day/)
  })
  it('splitDays covers the range once', () => {
    expect(splitDays('2026-09-01', '2026-09-30')).toEqual([['2026-09-01', '2026-09-15'], ['2026-09-16', '2026-09-30']])
    expect(splitDays('2026-09-01', '2026-09-02')).toEqual([['2026-09-01', '2026-09-01'], ['2026-09-02', '2026-09-02']])
  })
})

describe('headers', () => {
  it('every request carries a bearer token', async () => {
    const { calls } = await run()
    for (const c of calls) expect(c.headers.authorization).toBe(`Bearer sup_sk_${'a'.repeat(20)}`)
  })
  it('calls only payouts and history: no customers, receipts, persons or single transactions', async () => {
    const { calls } = await run()
    for (const c of calls) expect(new URL(c.url).pathname).toMatch(/\/(payouts|transactions\/history)$/)
    expect(calls.every((c) => new URL(c.url).host === 'api.sumup.com')).toBe(true)
  })
})

describe('errors', () => {
  const failing = (status: number, headers?: Record<string, string>) => sumup({ hook: (u) => (u.pathname.endsWith('/payouts') ? { status, json: { detail: 'jane@example.com' }, ...(headers ? { headers } : {}) } : undefined) })
  it('401 is an auth failure with the words to fix it', async () => {
    const e = await stops(failing(401), /no longer accepts/)
    expect(e.kind).toBe('auth')
  })
  it('403 says who may connect, and no provider text comes through', async () => {
    const e = await stops(failing(403), /account owner/)
    expect(e.kind).toBe('auth')
    expect(e.message).not.toContain('jane')
  })
  it('health turns a 401 into needing a reconnect', async () => {
    const m = make(failing(401))
    expect((await m.connector.health!(m.conn)).status).toBe('needs_reauth')
  })
  it('health is ok when both reads work', async () => {
    const m = make()
    expect((await m.connector.health!(m.conn)).status).toBe('ok')
  })
})

describe('signing in', () => {
  const token = (extra: Row = {}): FixtureRoute => ({
    method: 'POST',
    match: (u) => u.host === 'api.sumup.com' && u.pathname === '/token',
    respond: () => ({ json: { access_token: 'acc_' + 'b'.repeat(20), refresh_token: 'ref_' + 'c'.repeat(20), expires_in: 3599, token_type: 'Bearer', scope: 'transactions.history user.profile_readonly', ...extra } }),
  })
  const signedIn = (routes: FixtureRoute[] = sumup()) => make([token(), ...routes], { oauth: oauthOpt })

  it('begins at api.sumup.com with exactly the read scopes, always', async () => {
    const { connector } = signedIn()
    const b = (await connector.begin({ state: 'st' })) as Extract<ConnectBegin, { kind: 'oauth' }>
    const u = new URL(b.url)
    expect(u.origin + u.pathname).toBe('https://api.sumup.com/authorize')
    expect(u.searchParams.get('scope')).toBe('transactions.history user.profile_readonly')
    expect(u.searchParams.get('scope')).not.toContain('app-settings')
    expect(u.searchParams.get('response_type')).toBe('code')
    expect(u.searchParams.get('state')).toBe('st')
    expect(connector.describe().auth).toBe('oauth')
  })
  it('exchanges the code with the secret in the form, and keeps the live merchant only', async () => {
    const { connector, calls } = signedIn()
    const out = await connector.connect({ code: 'abc' })
    const post = calls.find((c) => c.method === 'POST')!
    expect(post.body).toMatchObject({ grant_type: 'authorization_code', code: 'abc', client_id: 'cid', client_secret: 'csec' })
    expect(out.config).toMatchObject({ merchantCode: 'MH4H92C7', displayName: 'SumUp · Sample Cafe' })
    expect(out.additional).toBeUndefined()
    const asked = new URL(calls.find((c) => c.url.includes('/v0.1/memberships'))!.url).searchParams
    expect(asked.get('kind')).toBe('merchant')
    expect(asked.get('status')).toBe('accepted')
    expect(asked.get('resource.attributes.sandbox')).toBe('false')
    expect(JSON.stringify(out)).not.toMatch(/MUST-NOT|invite/)
  })
  it('refuses a token that holds more than was asked for', async () => {
    const m = make([token({ scope: 'transactions.history user.profile_readonly user.app-settings' }), ...sumup()], { oauth: oauthOpt })
    await expect(m.connector.connect({ code: 'abc' })).rejects.toThrow(SUMUP_TOO_MUCH_ACCESS)
    expect(m.calls.filter((c) => c.method === 'GET')).toHaveLength(0)
  })
  it('several merchants become several connections on one shared token', async () => {
    const two = { total_count: 2, items: [fx.memberships.items[0], { ...fx.memberships.items[0], resource: { id: 'MK01A8C2', type: 'merchant', name: 'Second Cafe' } }] }
    const second: FixtureRoute[] = [{ method: 'GET', match: (u) => /MK01A8C2/.test(u.pathname), respond: (u) => (u.pathname.endsWith('/payouts') ? { json: [] } : { json: { items: [], links: [] } }) }]
    const { connector } = signedIn([...sumup({ memberships: two }), ...second])
    const out = await connector.connect({ code: 'abc' })
    expect(out.additional).toHaveLength(1)
    expect(out.config.sharedSecretKey).toBeDefined()
    expect(out.additional![0]!.config.sharedSecretKey).toBe(out.config.sharedSecretKey)
  })
  it('reads memberships past the first page', async () => {
    const one = (id: string) => ({ ...fx.memberships.items[0], resource: { id, type: 'merchant', name: id } })
    let page = 0
    const routes = sumup({ hook: (u) => (u.pathname === '/v0.1/memberships' ? { json: page++ === 0 ? { total_count: 2, items: [one('MK01A8C2')] } : { total_count: 2, items: [one('MH4H92C7')] } } : undefined) })
    const other: FixtureRoute[] = [{ method: 'GET', match: (u) => /MK01A8C2/.test(u.pathname), respond: () => ({ status: 403, json: {} }) }]
    const { connector, calls } = signedIn([...other, ...routes])
    const out = await connector.connect({ code: 'abc' })
    expect(out.config.merchantCode).toBe('MH4H92C7')
    expect(new URL(calls.filter((c) => c.url.includes('/v0.1/memberships'))[1]!.url).searchParams.get('offset')).toBe('1')
  })
  it('a merchant this person can’t read is left out, and none at all says who should connect', async () => {
    const { connector } = signedIn(sumup({ hook: (u) => (u.pathname.endsWith('/payouts') ? { status: 403, json: {} } : undefined) }))
    await expect(connector.connect({ code: 'abc' })).rejects.toThrow(SUMUP_ROLE_MESSAGE)
  })
  it('only a sandbox merchant says so; test money never connects', async () => {
    const { connector } = signedIn(sumup({ memberships: { total_count: 1, items: [fx.memberships.items[1]] } }))
    await expect(connector.connect({ code: 'abc' })).rejects.toThrow(/live merchant/)
  })
  it('a membership list that isn’t one stops the connect', async () => {
    const { connector } = signedIn(sumup({ memberships: { items: [] } }))
    await expect(connector.connect({ code: 'abc' })).rejects.toThrow(/can’t read/)
  })
  it('a merchant code that wouldn’t be safe in a path stops the connect', async () => {
    const bad = { total_count: 1, items: [{ ...fx.memberships.items[0], resource: { id: '../x', type: 'merchant', name: 'x' } }] }
    const { connector } = signedIn(sumup({ memberships: bad }))
    await expect(connector.connect({ code: 'abc' })).rejects.toThrow(/can’t read/)
  })
  it('an expired access token renews first, and the new pair is saved before any read', async () => {
    const m = signedIn()
    const oauthConn: ConnectionRef = { ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'ref', expiresAt: m.clock.now() - 1 } } }
    const step = await m.connector.sync(oauthConn, null)
    expect(m.calls[0]!.method).toBe('POST')
    expect(m.calls[0]!.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'ref' })
    expect(m.saved).toHaveLength(1)
    expect(step.updatedSecret).toEqual(m.saved[0])
  })
  it('keeps the refresh token when SumUp doesn’t send a new one', async () => {
    const noRotate: FixtureRoute = { method: 'POST', match: (u) => u.pathname === '/token', respond: () => ({ json: { access_token: 'new', expires_in: 3599 } }) }
    const m = make([noRotate, ...sumup()], { oauth: oauthOpt })
    const oauthConn: ConnectionRef = { ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'old', refreshToken: 'ref', expiresAt: m.clock.now() - 1 } } }
    const step = await m.connector.sync(oauthConn, null)
    expect((step.updatedSecret as { tokens: { refreshToken: string } }).tokens.refreshToken).toBe('ref')
  })
  it('a sign-in connection on a server without the app asks for a reconnect', async () => {
    const m = make()
    await expect(m.connector.sync({ ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'x' } } }, null)).rejects.toThrow(/Connect SumUp again/)
  })
})

describe('a pasted key, self-host only', () => {
  const input = { apiKey: 'sup_sk_' + 'd'.repeat(24), merchantCode: 'mh4h92c7' }
  it('sign-in first: with the app set up there’s no paste step', async () => {
    const { connector } = make(sumup(), { oauth: oauthOpt })
    expect((await connector.begin({ state: 's' })).kind).toBe('oauth')
  })
  it('self-hosted without the app: asks for the key and the merchant code, and says it has full access', async () => {
    const b = (await make().connector.begin({ state: 's' })) as Extract<ConnectBegin, { kind: 'api_key' }>
    expect(b.kind).toBe('api_key')
    expect(b.fields!.map((f) => f.name)).toEqual(['merchantCode', 'apiKey'])
    expect(b.permissions?.join(' ')).toMatch(/can’t be limited/)
  })
  it('hosted without the app refuses to begin', async () => {
    await expect(make(sumup(), { hosted: true }).connector.begin({ state: 's' })).rejects.toThrow(SUMUP_NOT_SET_UP)
  })
  it('hosted never takes a pasted key, app or no app', async () => {
    await expect(make(sumup(), { hosted: true }).connector.connect(input)).rejects.toThrow(SUMUP_KEY_REFUSED)
    await expect(make(sumup(), { hosted: true, oauth: oauthOpt }).connector.connect(input)).rejects.toThrow(SUMUP_KEY_REFUSED)
  })
  it('checks it with reads and warns of the full access', async () => {
    const { connector, calls } = make()
    const out = await connector.connect(input)
    expect(out.secret).toEqual({ kind: 'key', apiKey: input.apiKey })
    expect(out.config).toMatchObject({ merchantCode: 'MH4H92C7', warnings: [SUMUP_KEY_WARNING] })
    expect(calls.length).toBe(2)
    expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('1')
  })
  it.each([
    ['a short key', { ...input, apiKey: 'short' }, /secret API key/],
    ['a key with spaces', { ...input, apiKey: 'sup sk ' + 'd'.repeat(24) }, /secret API key/],
    ['a bad merchant code', { ...input, merchantCode: '../x' }, /merchant code/],
  ])('refuses %s without a call', async (_n, bad, message) => {
    const { connector, calls } = make()
    await expect(connector.connect(bad)).rejects.toThrow(message)
    expect(calls).toHaveLength(0)
  })
})

describe('disconnect', () => {
  it('a sign-in says only what’s documented: there’s no revoke call', async () => {
    const { connector, calls } = make(sumup(), { oauth: oauthOpt })
    const out = await connector.disconnect!({ ...conn, secret: { kind: 'oauth', tokens: { accessToken: 'x' } } })
    expect(out).toEqual({ notRevoked: NOT_REVOKED_OAUTH })
    expect(calls).toHaveLength(0)
  })
  it('a pasted key says where to revoke it', async () => {
    expect(await make().connector.disconnect!(conn)).toEqual({ notRevoked: NOT_REVOKED_KEY })
  })
})
