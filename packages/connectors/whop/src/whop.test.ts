import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  amount,
  createWhopConnector,
  getOnly,
  NOT_REVOKED,
  readReport,
  REPORT_ROW_NET,
  verifierFor,
  WHOP_API_VERSION,
  WHOP_MANY_BUSINESSES,
  WHOP_NO_BUSINESS,
  WHOP_NO_LEDGER,
  WHOP_REFUSED,
  WHOP_SCOPE,
  WHOP_WRONG_SCOPE,
  whopCurrencyGone,
} from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/whop.json', import.meta.url), 'utf8')) as { accounts: Row; usd: Row; eur: Row }

const oauth = { clientId: 'app_12345', clientSecret: 's_secret', redirectUri: 'https://app.example.com/api/connectors/whop/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_w', workspaceId: 'ws1', connectorKey: 'whop', secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), refreshToken: 'rt_' + 'r'.repeat(24), expiresAt: FAR }, accountId: 'biz_SAMPLE000001' }, config: {} }
const tokenBody = (o: Row = {}) => ({ access_token: 'at_' + 'n'.repeat(24), token_type: 'Bearer', refresh_token: 'rt_' + 'm'.repeat(24), expires_in: 3600, ...o })

interface Data {
  usd?: Row
  eur?: Row
  accounts?: Row
  token?: Row
  hook?: (u: URL) => FixtureResponse | undefined
}

function whop(data: Data = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: (u) => u.href === 'https://api.whop.com/oauth/token', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'POST', match: (u) => u.href === 'https://api.whop.com/oauth/revoke', respond: (u) => data.hook?.(u) ?? { json: {} } },
    { method: 'GET', match: (u) => u.pathname === '/api/v1/accounts', respond: (u) => data.hook?.(u) ?? { json: data.accounts ?? fx.accounts } },
    {
      method: 'GET',
      match: (u) => u.pathname === '/api/v1/financial_reports',
      respond: (u) => data.hook?.(u) ?? { json: u.searchParams.get('currency') === 'eur' ? (data.eur ?? fx.eur) : (data.usd ?? fx.usd) },
    },
  ]
}

function make(routes: FixtureRoute[] = whop(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createWhopConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const failsWith = async (data: Data) => {
  const m = make(whop(data))
  return (await runSync(m.connector, m.conn, null).catch((e: unknown) => e)) as ConnectorError
}
const report = (rowsIn: Row[], total: unknown, currencies = ['usd']) => ({ report_type: 'income_statement', currencies, rows: rowsIn, total })

describe('whop connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThan(1)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('reports Whop’s own families per month, in Whop’s sign, with the net as their sum', async () => {
    const { r } = await sync()
    const s = snaps(r.events)
    expect(rows(s.get('whop:2026-09:USD'))).toEqual({ Payments: 1250_50, Refunds: -100_25, Disputes: 0, Fees: -36_55, [REPORT_ROW_NET]: 1113_70 })
    expect(rows(s.get('whop:2026-08:USD'))).toEqual({ Payments: 800_00, Refunds: 0, Disputes: -50_00, Fees: -24_10, [REPORT_ROW_NET]: 725_90 })
    expect(rows(s.get('whop:2026-10:EUR'))).toEqual({ Payments: 99_99, [REPORT_ROW_NET]: 99_99 })
    expect(s.get('whop:2026-10:USD')?.to).toBe('2026-10-09')
    expect(s.get('whop:2026-09:USD')?.basis).toBe('cash')
    expect(s.size).toBe(24)
  })

  it('reads each currency as itself, never converted, pinned to one API version, UTC months', async () => {
    const { calls } = await sync()
    const reads = calls.filter((c) => c.url.includes('/financial_reports')).map((c) => new URL(c.url))
    expect(reads.map((u) => u.searchParams.get('currency'))).toEqual(['usd', 'eur'])
    for (const u of reads) {
      expect(u.searchParams.get('in_currency')).toBeNull()
      expect(u.searchParams.get('report_type')).toBe('income_statement')
      expect(u.searchParams.get('timezone')).toBe('UTC')
      expect(u.searchParams.get('account_id')).toBe('biz_SAMPLE000001')
      expect(u.searchParams.get('from')).toBe('2025-11-01T00:00:00.000Z')
      expect(u.searchParams.get('to')).toBe('2026-11-01T00:00:00.000Z')
    }
    const headers = calls.find((c) => c.url.includes("/financial_reports"))?.headers as Record<string, string>
    expect(headers['api-version-date']).toBe(WHOP_API_VERSION)
  })

  it('a business with no USD reports no USD months, not zeros', async () => {
    const { r } = await sync(whop({ usd: report([], 0, ['eur']), eur: { ...fx.eur, currencies: ['eur'] } }))
    expect([...snaps(r.events).keys()].some((k) => k.endsWith(':USD'))).toBe(false)
    expect(snaps(r.events).size).toBe(12)
  })

  it('a business with no money at all reports nothing', async () => {
    const { r } = await sync(whop({ usd: report([], 0, []) }))
    expect(r.events).toEqual([])
  })

  it('stops when the rows don’t add up to Whop’s own total', async () => {
    const e = await failsWith({ usd: report([{ period: '2026-09', grouping: 'payments', amount: 10 }], 11) })
    expect(e.kind).toBe('permanent')
    expect(e.message).toMatch(/doesn’t add up/)
  })

  it('stops on a family it doesn’t know, an amount past the currency’s decimals, or a crypto currency', async () => {
    expect((await failsWith({ usd: report([{ period: '2026-09', grouping: 'new_thing', amount: 1 }], 1) })).message).toMatch(/can’t read/)
    expect((await failsWith({ usd: report([{ period: '2026-09', grouping: 'payments', amount: 1.005 }], 1.005) })).message).toMatch(/can’t read/)
    expect((await failsWith({ usd: report([], 0, ['usd', 'usdc']) })).message).toMatch(/currency Aggregate can’t read/)
    // Three letters isn't enough: btc would otherwise read as a two-decimal currency.
    expect((await failsWith({ usd: report([], 0, ['usd', 'btc']) })).message).toMatch(/currency Aggregate can’t read/)
    // USD rows from a business whose list doesn't name USD: the list can't be trusted, so no currency is dropped.
    expect((await failsWith({ usd: report([{ period: '2026-09', grouping: 'payments', amount: 5 }], 5, ['eur']) })).message).toMatch(/can’t read/)
    expect((await failsWith({ usd: { ...fx.usd, total: null } })).message).toMatch(/can’t read/)
    expect((await failsWith({ usd: { ...fx.usd, currencies: undefined } })).message).toMatch(/can’t read/)
  })

  it('a refused read or a missing ledger is an error, never $0', async () => {
    expect((await failsWith({ hook: (u) => (u.pathname.includes('financial') ? { status: 403, json: {} } : undefined) })).message).toBe(WHOP_REFUSED)
    expect((await failsWith({ hook: (u) => (u.pathname.includes('financial') ? { status: 404, json: {} } : undefined) })).message).toBe(WHOP_NO_LEDGER)
  })

  it('a currency gone from the report stops the sync, and its months are never rewritten as zero', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const m2 = make(whop({ usd: { ...fx.usd, currencies: ['usd'] } }))
    const e = (await runSync(m2.connector, m2.conn, first.cursor).catch((x: unknown) => x)) as ConnectorError
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(whopCurrencyGone('EUR'))
    // Still listed: the next sync runs as before.
    const m3 = make()
    expect(snaps((await runSync(m3.connector, m3.conn, first.cursor)).events).has('whop:2026-10:EUR')).toBe(true)
  })

  it('reads only: anything but GET is refused before it leaves', async () => {
    const sent: string[] = []
    const f = getOnly(async (input) => {
      sent.push(String(input))
      return new Response('{}')
    })
    await expect(f('https://api.whop.com/api/v1/payouts', { method: 'POST' })).rejects.toThrow(/only reads/)
    expect(sent).toEqual([])
  })

  it('amounts are exact: JSON numbers to minor units, strictly', () => {
    expect(amount(1250.5, 'USD')).toBe(1250_50)
    expect(amount(-0.1, 'USD')).toBe(-10)
    expect(amount(5, 'JPY')).toBe(5)
    expect(() => amount(0.5, 'JPY')).toThrow()
    expect(() => amount('1e3', 'USD')).toThrow()
    expect(readReport([{ period: '2024-01', grouping: 'payments', amount: 5 }], 5, 'USD', '2025-11', '2026-10')).toEqual({})
  })
})

describe('whop sign-in', () => {
  it('asks for the balance-read scope only, with PKCE from the state', () => {
    const { connector } = make()
    const u = new URL(connector.authorizationUrl('st_1'))
    expect(u.origin + u.pathname).toBe('https://api.whop.com/oauth/authorize')
    expect(u.searchParams.get('scope')).toBe(WHOP_SCOPE)
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toBeTruthy()
    expect(verifierFor('s', 'a')).not.toBe(verifierFor('s', 'b'))
  })

  it('connects one business and keeps only the tokens and its id', async () => {
    const m = make()
    const r = await m.connector.connect({ code: 'c1', connectState: 'st_1' })
    expect(r.config).toEqual({ accountId: 'biz_SAMPLE000001', displayName: 'Whop · Sample Creator Co' })
    expect(r.secret).toMatchObject({ accountId: 'biz_SAMPLE000001', tokens: { accessToken: 'at_' + 'n'.repeat(24) } })
    const tokenCall = m.calls.find((c) => c.url.endsWith('/oauth/token'))
    const body = tokenCall?.body as Row
    expect(body.code_verifier).toBe(verifierFor(oauth.clientSecret, 'st_1'))
    expect(body.grant_type).toBe('authorization_code')
  })

  it('refuses a wider scope, no business, or more than one business', async () => {
    const wide = make(whop({ token: { scope: `${WHOP_SCOPE} payout:create` } }))
    await expect(wide.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(WHOP_WRONG_SCOPE)
    const same = make(whop({ token: { scope: WHOP_SCOPE } }))
    await expect(same.connector.connect({ code: 'c', connectState: 's' })).resolves.toBeTruthy()
    const none = make(whop({ accounts: { data: [], page_info: { has_next_page: false, end_cursor: null } } }))
    await expect(none.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(WHOP_NO_BUSINESS)
    const two = { data: [{ id: 'biz_A0000001', title: 'A' }, { id: 'biz_B0000001', title: 'B' }], page_info: { has_next_page: false, end_cursor: null } }
    const many = make(whop({ accounts: two }))
    await expect(many.connector.connect({ code: 'c', connectState: 's' })).rejects.toThrow(WHOP_MANY_BUSINESSES)
  })

  it('needs the code and the state', async () => {
    await expect(make().connector.connect({ code: 'c' })).rejects.toThrow(/sign-in only/)
  })

  it('renews an expiring token and saves the rotated pair before reading', async () => {
    const m = make(whop(), { secret: { tokens: { accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: Date.parse('2026-10-09T12:01:00Z') }, accountId: 'biz_SAMPLE000001' } })
    const r = await runSync(m.connector, m.conn, null)
    expect(m.saved[0]).toMatchObject({ accountId: 'biz_SAMPLE000001', tokens: { refreshToken: 'rt_' + 'm'.repeat(24) } })
    expect(r.complete).toBe(true)
    const first = m.calls.findIndex((c) => c.url.endsWith('/oauth/token'))
    const read = m.calls.findIndex((c) => c.url.includes('/financial_reports'))
    expect(first).toBeLessThan(read)
  })

  it('disconnect revokes the refresh token, and says how to remove the app when it can’t', async () => {
    const m = make()
    expect(await m.connector.disconnect!(m.conn)).toBeUndefined()
    const call = m.calls.find((c) => c.url.endsWith('/oauth/revoke'))
    expect(call?.body).toMatchObject({ token: 'rt_' + 'r'.repeat(24), client_id: oauth.clientId })
    const bad = make(whop({ hook: (u) => (u.pathname === '/oauth/revoke' ? { status: 500, json: {} } : undefined) }))
    expect(await bad.connector.disconnect!(bad.conn)).toEqual({ notRevoked: NOT_REVOKED })
  })

  it('health checks the sign-in without renewing it', async () => {
    const m = make()
    expect((await m.connector.health(m.conn)).status).toBe('ok')
    expect(m.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false)
  })
})
