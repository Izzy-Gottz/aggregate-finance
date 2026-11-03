import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { ConnectorError, MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createMollieConnector, getOnly, money, MOLLIE_NO_BALANCE, MOLLIE_REFUSED, MOLLIE_SCOPES, MOLLIE_WRONG_SCOPE, mollieCurrencyGone, NOT_REVOKED, readTotals, REPORT_ROW_CLOSE, REPORT_ROW_NET_SALES } from './index.ts'

type Row = Record<string, unknown>
const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/mollie.json', import.meta.url), 'utf8')) as { balances: Row; eurSeptember: Row & { totals: Row } }

const oauth = { clientId: 'app_12345', clientSecret: 's_secret', redirectUri: 'https://app.example.com/api/connectors/mollie/callback' }
const FAR = Date.parse('2030-01-01T00:00:00Z')
const conn: ConnectionRef = { id: 'conn_m', workspaceId: 'ws1', connectorKey: 'mollie', secret: { tokens: { accessToken: 'at_' + 'a'.repeat(24), refreshToken: 'rt_' + 'r'.repeat(24), expiresAt: FAR } }, config: {} }
const tokenBody = (o: Row = {}) => ({ access_token: 'at_' + 'n'.repeat(24), token_type: 'bearer', refresh_token: 'rt_' + 'm'.repeat(24), expires_in: 3600, scope: 'balances.read balance-reports.read', ...o })

const amt = (currency: string, value: string) => ({ amount: { currency, value } })
/** An empty month for a balance whose opening and closing balance are `bal`. */
const quiet = (currency: string, bal = '0.00') => ({ resource: 'balance-report', timeZone: 'Europe/Amsterdam', grouping: 'transaction-categories', totals: { open: { pending: amt(currency, '0.00'), available: amt(currency, bal) }, close: { pending: amt(currency, '0.00'), available: amt(currency, bal) } } })

interface Data {
  report?: (balance: string, from: string, until: string) => Row | undefined
  balances?: Row
  token?: Row
  hook?: (u: URL) => FixtureResponse | undefined
}

function mollie(data: Data = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: (u) => u.href === 'https://api.mollie.com/oauth2/tokens', respond: () => ({ json: tokenBody(data.token) }) },
    { method: 'DELETE', match: (u) => u.href === 'https://api.mollie.com/oauth2/tokens', respond: (u) => data.hook?.(u) ?? { status: 200, json: {} } },
    { method: 'GET', match: (u) => u.pathname === '/v2/balances', respond: (u) => data.hook?.(u) ?? { json: data.balances ?? fx.balances } },
    {
      method: 'GET',
      match: (u) => /^\/v2\/balances\/bal_[A-Za-z0-9]+\/report$/.test(u.pathname),
      respond: (u) => {
        const hooked = data.hook?.(u)
        if (hooked) return hooked
        const balance = u.pathname.split('/')[3]!
        const from = u.searchParams.get('from')!
        const until = u.searchParams.get('until')!
        const custom = data.report?.(balance, from, until)
        if (custom) return { json: custom }
        if (balance === 'bal_SAMPLEEUR01' && from === '2026-09-01') return { json: fx.eurSeptember }
        return { json: balance === 'bal_SAMPLEEUR01' ? quiet('EUR') : quiet('GBP') }
      },
    },
  ]
}

function make(routes: FixtureRoute[] = mollie(), over: Partial<ConnectionRef> = {}) {
  const f = fixtureFetch(routes)
  const clock = fakeClock()
  const raw = new MemoryRawSink()
  const saved: unknown[] = []
  const connector = createMollieConnector({ oauth }, { raw, fetch: f.fetch, clock, saveSecret: async (_id, s) => void saved.push(s) })
  return { connector, conn: { ...conn, ...over }, calls: f.calls, clock, raw, saved }
}

const snaps = (events: NormalizedEvent[]) => new Map(events.filter((e): e is ReportSnapshot => e.type === 'report.snapshot').map((e) => [e.externalId, e]))
const rows = (s: ReportSnapshot | undefined) => Object.fromEntries((s?.rows ?? []).map((r) => [r.account, r.amount.minor]))
const sync = async (routes?: FixtureRoute[]) => {
  const m = make(routes)
  return { ...m, r: await runSync(m.connector, m.conn, null) }
}
const failsWith = async (data: Data) => {
  const m = make(mollie(data))
  return (await runSync(m.connector, m.conn, null).catch((e: unknown) => e)) as ConnectorError
}
const sept = (edit: (t: Row) => void) => {
  const copy = JSON.parse(JSON.stringify(fx.eurSeptember)) as Row & { totals: Row }
  edit(copy.totals)
  return { report: (b: string, from: string) => (b === 'bal_SAMPLEEUR01' && from === '2026-09-01' ? copy : undefined) }
}

describe('mollie connector', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 24 })
    expect(r.pages).toBeGreaterThan(1)
  })
  it('fixture is redacted', () => assertRedacted(fx))

  it('reports each kind as pending plus immediately available, never the move between them', async () => {
    const { r } = await sync()
    expect(rows(snaps(r.events).get('mollie:2026-09:EUR'))).toEqual({
      Payments: 4382_75,
      Refunds: -12,
      Chargebacks: 0,
      'Mollie fees': -3_24,
      [REPORT_ROW_NET_SALES]: 4379_39,
      Corrections: 0,
      'Mollie Capital': 0,
      'Top-ups': 0,
      'Paid out to your bank': -1077_62,
      [REPORT_ROW_CLOSE]: 3309_23,
    })
    expect(snaps(r.events).size).toBe(24)
    expect(snaps(r.events).get('mollie:2026-10:EUR')?.to).toBe('2026-10-09')
  })

  it('reads twelve Amsterdam months per balance, this one only to tomorrow, live data only', async () => {
    const { calls } = await sync()
    const reads = calls.filter((c) => c.url.includes('/report')).map((c) => new URL(c.url))
    expect(reads).toHaveLength(24)
    expect(reads[0]!.searchParams.get('from')).toBe('2025-11-01')
    expect(reads[0]!.searchParams.get('until')).toBe('2025-12-01')
    expect(reads[11]!.searchParams.get('from')).toBe('2026-10-01')
    expect(reads[11]!.searchParams.get('until')).toBe('2026-10-10')
    for (const u of reads) {
      expect(u.searchParams.get('grouping')).toBe('transaction-categories')
      expect(u.searchParams.get('testmode')).toBeNull()
    }
  })

  it('stops when a month doesn’t add up from opening to closing balance', async () => {
    const e = await failsWith(sept((t) => ((t.close as Row).available = amt('EUR', '3.83'))))
    expect(e.kind).toBe('permanent')
    expect(e.message).toMatch(/doesn’t add up/)
  })

  it('stops on an unknown kind, a wrong currency, or too many decimals', async () => {
    expect((await failsWith(sept((t) => (t['new-thing'] = { pending: amt('EUR', '1.00') })))).message).toMatch(/can’t read/)
    expect((await failsWith(sept((t) => ((t.refunds as Row).immediatelyAvailable = amt('USD', '-0.12'))))).message).toMatch(/can’t read/)
    expect((await failsWith(sept((t) => ((t.refunds as Row).immediatelyAvailable = amt('EUR', '-0.125'))))).message).toMatch(/can’t read/)
    expect((await failsWith(sept((t) => delete t.close))).message).toMatch(/can’t read/)
  })

  it('a refused read is an error, never €0', async () => {
    expect((await failsWith({ hook: (u) => (u.pathname.endsWith('/report') ? { status: 403, json: {} } : undefined) })).message).toBe(MOLLIE_REFUSED)
  })

  it('balances in the same currency add up', async () => {
    const two = { _embedded: { balances: [{ id: 'bal_EURA', currency: 'EUR' }, { id: 'bal_EURB', currency: 'EUR' }] }, _links: { next: null } }
    const { r } = await sync(mollie({ balances: two, report: (_b, from) => (from === '2026-09-01' ? quiet('EUR', '5.00') : quiet('EUR')) }))
    expect(rows(snaps(r.events).get('mollie:2026-09:EUR'))[REPORT_ROW_CLOSE]).toBe(10_00)
    expect(snaps(r.events).size).toBe(12)
  })

  it('a currency gone from the account stops the sync, and its months are never rewritten as zero', async () => {
    const m = make()
    const first = await runSync(m.connector, m.conn, null)
    const eurOnly = { _embedded: { balances: [{ id: 'bal_SAMPLEEUR01', currency: 'EUR' }] }, _links: { next: null } }
    const m2 = make(mollie({ balances: eurOnly }))
    const e = (await runSync(m2.connector, m2.conn, first.cursor).catch((x: unknown) => x)) as ConnectorError
    expect(e).toBeInstanceOf(ConnectorError)
    expect(e.kind).toBe('permanent')
    expect(e.message).toBe(mollieCurrencyGone('GBP'))
    // Nothing read past the balance list: no month was fetched.
    expect(m2.calls.some((c) => new URL(c.url).pathname.includes('/report'))).toBe(false)
  })

  it('follows a next page only on Mollie’s own balances path', async () => {
    const evil = { _embedded: { balances: [{ id: 'bal_X', currency: 'EUR' }] }, _links: { next: { href: 'https://evil.example.com/v2/balances?from=bal_Y' } } }
    expect((await failsWith({ balances: evil })).message).toMatch(/won’t follow/)
  })

  it('reads only: anything but GET is refused before it leaves', async () => {
    const sent: string[] = []
    const f = getOnly(async (input) => {
      sent.push(String(input))
      return new Response('{}')
    })
    await expect(f('https://api.mollie.com/v2/payments', { method: 'POST' })).rejects.toThrow(/only reads/)
    expect(sent).toEqual([])
  })

  it('amounts are exact decimal strings in the balance’s currency', () => {
    expect(money({ currency: 'EUR', value: '4382.75' }, 'EUR')).toBe(4382_75)
    expect(() => money({ currency: 'EUR', value: 4.5 }, 'EUR')).toThrow()
    expect(() => readTotals({ open: {}, close: {}, payments: { pending: amt('EUR', '1.00') } }, 'EUR')).toThrow(/doesn’t add up/)
  })
})

describe('mollie sign-in', () => {
  it('asks for the two read scopes only', () => {
    const u = new URL(make().connector.authorizationUrl('st_1'))
    expect(u.origin + u.pathname).toBe('https://my.mollie.com/oauth2/authorize')
    expect(u.searchParams.get('scope')).toBe(MOLLIE_SCOPES.join(' '))
    expect(u.searchParams.get('response_type')).toBe('code')
  })

  it('connects with the read scopes, and keeps only the tokens', async () => {
    const m = make()
    const r = await m.connector.connect({ code: 'c1' })
    expect(r.config).toEqual({ displayName: 'Mollie' })
    expect(r.secret).toEqual({ tokens: expect.objectContaining({ accessToken: 'at_' + 'n'.repeat(24), refreshToken: 'rt_' + 'm'.repeat(24) }) })
    const tokenCall = m.calls.find((c) => c.url.endsWith('/oauth2/tokens'))
    expect(tokenCall?.headers.authorization).toMatch(/^Basic /)
  })

  it('refuses a wider grant, and an account with no balances', async () => {
    await expect(make(mollie({ token: { scope: 'balances.read balance-reports.read payments.write' } })).connector.connect({ code: 'c' })).rejects.toThrow(MOLLIE_WRONG_SCOPE)
    await expect(make(mollie({ token: { scope: 'balance-reports.read balances.read' } })).connector.connect({ code: 'c' })).resolves.toBeTruthy()
    await expect(make(mollie({ balances: { _embedded: { balances: [] }, _links: { next: null } } })).connector.connect({ code: 'c' })).rejects.toThrow(MOLLIE_NO_BALANCE)
  })

  it('renews an expiring token and saves it before reading', async () => {
    const m = make(mollie(), { secret: { tokens: { accessToken: 'at_old', refreshToken: 'rt_old', expiresAt: Date.parse('2026-10-09T12:01:00Z') } } })
    const r = await runSync(m.connector, m.conn, null)
    expect(r.complete).toBe(true)
    expect(m.saved[0]).toMatchObject({ tokens: { accessToken: 'at_' + 'n'.repeat(24) } })
    expect(m.calls.findIndex((c) => c.url.endsWith('/oauth2/tokens'))).toBeLessThan(m.calls.findIndex((c) => c.url.includes('/balances')))
  })

  it('disconnect revokes the refresh token, and says how to remove the app when it can’t', async () => {
    const m = make()
    expect(await m.connector.disconnect!(m.conn)).toBeUndefined()
    const call = m.calls.find((c) => c.method === 'DELETE')
    expect(call?.body).toMatchObject({ token_type_hint: 'refresh_token', token: 'rt_' + 'r'.repeat(24) })
    const bad = make(mollie({ hook: (u) => (u.pathname === '/oauth2/tokens' ? { status: 500, json: {} } : undefined) }))
    expect(await bad.connector.disconnect!(bad.conn)).toEqual({ notRevoked: NOT_REVOKED })
  })

  it('health checks the sign-in without renewing it', async () => {
    const m = make()
    expect((await m.connector.health(m.conn)).status).toBe('ok')
    expect(m.calls.some((c) => c.url.endsWith('/oauth2/tokens'))).toBe(false)
  })
})
