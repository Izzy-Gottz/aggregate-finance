import { describe, expect, it } from 'vitest'
import type { AccountUpsert, BalanceSnapshot, ConnectionRef, NormalizedEvent, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { claimUrlOf, createSimplefinConnector, guessType, parseAccessUrl, sanitize, type SimplefinConnectorOptions } from './index.ts'
import type { SfAccount, SfAccountSet } from './types.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z') / 1000
const day = (n: number) => NOW - n * 86_400
const ACCESS = 'https://user123:pass456@beta-bridge.simplefin.org/simplefin'
const CLAIM = 'https://beta-bridge.simplefin.org/simplefin/claim/demo-claim-token'
const SETUP = Buffer.from(CLAIM).toString('base64')

const accounts = (): SfAccount[] => [
  {
    id: 'ACT-1',
    conn_id: 'CON-1',
    name: 'Harbor Coffee Checking 1234',
    currency: 'USD',
    balance: '1520.10',
    'available-balance': '1500.00',
    'balance-date': day(0),
    transactions: [
      { id: 'T1', posted: day(400), amount: '-9.99', description: 'Too old for the backfill' },
      { id: 'T2', posted: day(200), amount: '2500.00', description: 'Stripe payout' },
      { id: 'T3', posted: day(10), amount: '-42.50', description: 'Bluebird Supplies <b>Inc</b>' },
      { id: 'T4', posted: 0, transacted_at: day(1), amount: '-5.00', description: 'Pending coffee', pending: true },
    ],
  },
  {
    id: 'ACT-2',
    conn_id: 'CON-1',
    name: 'Northwind Visa Card',
    currency: 'USD',
    balance: '-310.00',
    'balance-date': day(0),
    transactions: [{ id: 'T9', posted: day(3), amount: '-310.00', description: 'Office chairs' }],
  },
]

function accountsRoute(extra: Partial<SfAccountSet> = {}): FixtureRoute {
  return {
    match: (u) => u.pathname === '/simplefin/accounts',
    respond: (u) => {
      const s = Number(u.searchParams.get('start-date') ?? 0)
      const e = Number(u.searchParams.get('end-date') ?? Infinity)
      const only = u.searchParams.get('balances-only') === '1'
      const accts = accounts().map((a) => {
        const { transactions, ...rest } = a
        return only ? rest : { ...rest, transactions: (transactions ?? []).filter((t) => (t.posted || (t.transacted_at ?? 0)) >= s && (t.posted || (t.transacted_at ?? 0)) < e) }
      })
      return { json: { errlist: [], connections: [{ conn_id: 'CON-1', name: 'Harbor Bank', org_id: 'O1' }], accounts: accts, ...extra } }
    },
  }
}

function make(routes: FixtureRoute[] = [accountsRoute()], opts: SimplefinConnectorOptions = {}) {
  const f = fixtureFetch([{ method: 'POST', match: (u) => u.pathname === '/simplefin/claim/demo-claim-token', respond: { text: ACCESS } }, ...routes])
  const clock = fakeClock()
  const connector = createSimplefinConnector(opts, { raw: new MemoryRawSink(), fetch: f.fetch, clock })
  const conn: ConnectionRef = { id: 'conn_sf', workspaceId: 'ws1', connectorKey: 'simplefin', secret: { accessUrl: ACCESS }, config: {} }
  return { connector, conn, calls: f.calls, clock }
}

const txns = (ev: NormalizedEvent[]) => ev.filter((e): e is TxnUpsert => e.type === 'txn.upsert')

describe('simplefin contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), signs: { 'CON-1:ACT-1:T2': '+', 'CON-1:ACT-1:T3': '-', 'CON-1:ACT-2:T9': '-' }, minEvents: 6 })
    // 365 days of backfill in windows of at most 44 days.
    expect(r.pages).toBe(9)
  })
})

describe('simplefin connect', () => {
  it('claims the Setup Token once, stores the Access URL and names the connection after the bank', async () => {
    const { connector, calls } = make()
    const r = await connector.connect({ apiKey: SETUP })
    expect(r.secret).toEqual({ accessUrl: ACCESS })
    expect(r.config).toMatchObject({ accountIds: ['CON-1:ACT-1', 'CON-1:ACT-2'], institutions: ['Harbor Bank'], displayName: 'SimpleFIN · Harbor Bank' })
    expect(calls[0]?.method).toBe('POST')
    const get = calls[1]
    expect(get?.url).not.toContain('pass456')
    expect(get?.headers.authorization).toBe(`Basic ${Buffer.from('user123:pass456').toString('base64')}`)
    expect(get?.url).toContain('balances-only=1')
    expect(get?.url).toContain('version=2')
  })

  it('rejects junk, non-Bridge hosts and http', async () => {
    expect(() => claimUrlOf('not a token')).toThrow(/Setup Token/)
    expect(() => claimUrlOf(Buffer.from('https://evil.example/claim/x').toString('base64'))).toThrow(/SimpleFIN Bridge/)
    expect(() => claimUrlOf(Buffer.from('http://beta-bridge.simplefin.org/claim/x').toString('base64'))).toThrow(/https/)
    expect(claimUrlOf(Buffer.from('https://sf.self.example/claim/x').toString('base64'), true).hostname).toBe('sf.self.example')
    expect(() => parseAccessUrl('https://beta-bridge.simplefin.org/simplefin')).toThrow(/without credentials/)
  })

  it('a used token says so', async () => {
    const f = fixtureFetch([{ method: 'POST', match: '/claim/', respond: { status: 403, text: 'Forbidden' } }])
    const c = createSimplefinConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    await expect(c.connect({ apiKey: SETUP })).rejects.toThrow(/already used/)
  })
})

describe('simplefin sync', () => {
  it('maps accounts, balances and posted transactions; skips pending; liabilities negative', async () => {
    const { connector, conn } = make()
    const r = await runSync(connector, conn, null)
    const accts = r.events.filter((e): e is AccountUpsert => e.type === 'account.upsert')
    expect(accts.find((a) => a.externalId === 'CON-1:ACT-1')).toMatchObject({ accountType: 'depository', mask: '1234', institution: 'Harbor Bank', currency: 'USD' })
    expect(accts.find((a) => a.externalId === 'CON-1:ACT-2')).toMatchObject({ accountType: 'credit_card', liability: { kind: 'credit' } })
    const bals = r.events.filter((e): e is BalanceSnapshot => e.type === 'balance.snapshot')
    expect(bals.find((b) => b.accountExternalId === 'CON-1:ACT-1')).toMatchObject({ current: { minor: 152010 }, available: { minor: 150000 } })
    expect(bals.find((b) => b.accountExternalId === 'CON-1:ACT-2')?.current.minor).toBe(-31000)
    const t = txns(r.events)
    expect(t.map((x) => x.externalId).sort()).toEqual(['CON-1:ACT-1:T2', 'CON-1:ACT-1:T3', 'CON-1:ACT-2:T9'])
    expect(t.find((x) => x.externalId === 'CON-1:ACT-1:T3')).toMatchObject({ counterparty: 'Bluebird Supplies Inc', status: 'posted' })
  })

  it('later cycles re-read 5 days, and a cycle within 4 hours of the last is skipped', async () => {
    const { connector, conn, calls, clock } = make()
    const first = await runSync(connector, conn, null)
    const n = calls.length
    const again = await runSync(connector, conn, first.cursor)
    expect(calls.length).toBe(n)
    expect(again.events).toEqual([])
    clock.t += 5 * 3_600_000
    await runSync(connector, conn, first.cursor)
    expect(calls.length).toBe(n + 1)
    const start = Number(new URL(calls[n]?.url ?? '').searchParams.get('start-date'))
    expect(start).toBe(NOW - 5 * 86_400)
  })

  it('shows Bridge errors as warnings, sanitized', async () => {
    const { connector, conn } = make([
      accountsRoute({ errlist: [{ code: 'con.auth', msg: 'Harbor Bank needs <i>attention</i>\u0007', conn_id: 'CON-1' }], errors: ['You are close to your daily request limit'] }),
    ])
    const r = await connector.sync(conn, null)
    const w = r.warnings ?? []
    expect(w).toContain('SimpleFIN: Harbor Bank needs attention')
    expect(w).toContain('SimpleFIN: You are close to your daily request limit')
    expect(w.some((x) => /reconnected inside SimpleFIN Bridge/.test(x))).toBe(true)
  })

  it('402 and 403 are auth problems with a next step', async () => {
    for (const [status, re] of [[402, /needs a payment/], [403, /revoked/]] as const) {
      const { connector, conn } = make([{ match: '/accounts', respond: { status, text: '' } }])
      await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(re) })
    }
  })
})

describe('simplefin helpers', () => {
  it('guesses types and sanitizes', () => {
    expect(guessType('Chase Sapphire Credit Card')).toBe('credit_card')
    expect(guessType('Auto Loan')).toBe('loan')
    expect(guessType('Vanguard Roth IRA')).toBe('investment')
    expect(guessType('Everyday Checking')).toBe('depository')
    expect(sanitize('a\n<script>x</script>b')).toBe('a xb')
  })
})

describe('simplefin red team', () => {
  it('the Setup Token works once: a second claim is refused with what to do', async () => {
    let claims = 0
    const f = fixtureFetch([{ method: 'POST', match: '/claim/', respond: () => (++claims === 1 ? { text: ACCESS } : { status: 403, text: 'Forbidden' }) }, accountsRoute()])
    const c = createSimplefinConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    await c.connect({ apiKey: SETUP })
    await expect(c.connect({ apiKey: SETUP })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/already used.*disable the old access/) })
  })

  it('a failed claim is never retried (a retry could burn the token), and nothing secret leaks into config, raw or errors', async () => {
    const f = fixtureFetch([{ method: 'POST', match: '/claim/', respond: { status: 503, text: 'busy' } }])
    const c = createSimplefinConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    const err = (await c.connect({ apiKey: SETUP }).then(() => new Error("connected"), (e: unknown) => e)) as Error
    expect(f.calls.filter((x) => x.method === 'POST')).toHaveLength(1)
    expect(String(err.message)).not.toMatch(/demo-claim-token|pass456/)
    const raw = new MemoryRawSink()
    const ok = createSimplefinConnector({}, { raw, fetch: fixtureFetch([{ method: 'POST', match: '/claim/', respond: { text: ACCESS } }, accountsRoute()]).fetch, clock: fakeClock() })
    const r = await ok.connect({ apiKey: SETUP })
    expect(JSON.stringify(r.config)).not.toMatch(/pass456|user123|demo-claim-token/)
    const { events } = await runSync(ok, { id: 'c', workspaceId: 'w', connectorKey: 'simplefin', secret: r.secret, config: r.config }, null)
    expect(JSON.stringify(events) + JSON.stringify([...raw.records.values()])).not.toMatch(/pass456|user123/)
  })

  it('an Access URL pointing anywhere but SimpleFIN Bridge is refused (no credential forwarding to another host)', async () => {
    const f = fixtureFetch([{ method: 'POST', match: '/claim/', respond: { text: 'https://user:pw@evil.example/simplefin' } }])
    const c = createSimplefinConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    await expect(c.connect({ apiKey: SETUP })).rejects.toThrow(/must point at SimpleFIN Bridge/)
    expect(f.calls.some((x) => x.url.includes('evil.example'))).toBe(false)
  })

  it('a huge response is refused, not stored', async () => {
    const many = Array.from({ length: 100_001 }, (_, i) => ({ id: `T${i}`, posted: day(1), amount: '-1.00', description: 'x' }))
    const route: FixtureRoute = { match: (u) => u.pathname === '/simplefin/accounts', respond: { json: { errlist: [], accounts: [{ ...accounts()[0]!, transactions: many }] } } }
    const { connector, conn } = make([route])
    await expect(connector.sync(conn, null)).rejects.toThrow(/more than Aggregate accepts/)
  })

  it('only https to the SimpleFIN Bridge hosts: look-alikes, userinfo tricks, IPs, other schemes and ports are refused', () => {
    const tok = (u: string) => Buffer.from(u).toString('base64')
    for (const u of [
      'https://bridge.simplefin.org.evil.example/claim/x',
      'https://evil.example/bridge.simplefin.org/claim/x',
      'https://bridge.simplefin.org@evil.example/claim/x',
      'https://127.0.0.1/claim/x',
      'https://[::1]/claim/x',
      'https://169.254.169.254/latest/meta-data',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://bridge.simplefin.org/claim/x',
      'https://bridge.simplefin.org:8443/claim/x',
    ]) expect(() => claimUrlOf(tok(u)), u).toThrow()
    expect(() => claimUrlOf(tok('https://bridge.simplefin.org:443/simplefin/claim/x'))).not.toThrow()
    for (const u of ['http://u:p@bridge.simplefin.org/simplefin', 'https://u:p@127.0.0.1/simplefin', 'https://u:p@bridge.simplefin.org.evil.example/s']) expect(() => parseAccessUrl(u), u).toThrow()
  })

  it('windows stay within the Bridge’s 45-day advice, failing requests are tried twice at most, and a quota warning pauses syncing for 12 hours', async () => {
    const { connector, conn, calls, clock } = make()
    await runSync(connector, conn, null)
    for (const c of calls.filter((x) => x.url.includes('start-date'))) {
      const u = new URL(c.url)
      expect(Number(u.searchParams.get('end-date')) - Number(u.searchParams.get('start-date'))).toBeLessThanOrEqual(44 * 86_400)
    }
    // A Bridge having a bad hour: two tries, then the error (each try spends the daily quota).
    const down = make([{ match: (u) => u.pathname === '/simplefin/accounts', respond: { status: 503, text: 'down' } }])
    await expect(down.connector.sync(down.conn, null)).rejects.toMatchObject({ kind: 'transient' })
    expect(down.calls.filter((c) => c.url.includes('/accounts'))).toHaveLength(2)
    // "Too many requests" in errors[]: stop now and ask nothing for 12 hours.
    const warned = make([accountsRoute({ errors: ['You have made too many requests today. Please reduce your request rate.'] })])
    const page = await warned.connector.sync(warned.conn, null)
    expect(page.hasMore).toBe(false)
    expect(page.warnings?.join(' ')).toMatch(/12 hours/)
    const n = warned.calls.length
    warned.clock.t += 6 * 3_600_000
    expect((await warned.connector.sync(warned.conn, page.cursor)).events).toEqual([])
    expect(warned.calls.length).toBe(n)
    warned.clock.t += 7 * 3_600_000
    await warned.connector.sync(warned.conn, page.cursor)
    expect(warned.calls.length).toBe(n + 1)
    void clock
  })

  it('the Bridge’s date-range advice is not a quota warning and is not shown to the person', async () => {
    const advised = make([accountsRoute({ errors: ['Requested date range exceeds recommended range of 45 days. In the future, this may be capped.'] })])
    const page = await advised.connector.sync(advised.conn, null)
    expect(page.hasMore).toBe(true)
    expect(page.warnings ?? []).toEqual([])
  })

  it('v2 payee names the counterparty, memo joins the raw text, and plain bank words become category hints', async () => {
    const t = (over: Partial<SfAccount['transactions'] extends Array<infer T> | undefined ? T : never>) => ({ id: 'X', posted: day(5), amount: '-1.00', description: '', ...over })
    const set: SfAccount[] = [{
      id: 'ACT-9', name: 'Everyday Checking', currency: 'USD', balance: '10', 'balance-date': day(0),
      transactions: [
        t({ id: 'P1', amount: '2564.48', description: 'Pay day!', payee: 'You', memo: 'ACME CORP PAYROLL' }),
        t({ id: 'P2', amount: '4.22', description: 'INTRST PYMNT' }),
        t({ id: 'P3', amount: '-12.00', description: 'MONTHLY MAINTENANCE FEE' }),
        t({ id: 'P4', amount: '-85.50', description: 'Fishing bait', payee: "John's Fishin Shack", memo: 'JOHNS FISHIN SHACK BAIT' }),
        t({ id: 'P5', amount: '1200.00', description: 'Mobile deposit' }),
      ],
    }]
    const { connector, conn } = make([{ match: (u) => u.pathname === '/simplefin/accounts', respond: { json: { errlist: [], accounts: set } } }])
    const out = txns((await connector.sync(conn, null)).events)
    const by = (id: string) => out.find((x) => x.externalId.endsWith(id))!
    expect(by('P1')).toMatchObject({ counterparty: 'You', rawText: 'Pay day! · ACME CORP PAYROLL', categoryHint: 'INCOME_WAGES' })
    expect(by('P2').categoryHint).toBe('INCOME_INTEREST_EARNED')
    expect(by('P3').categoryHint).toBe('BANK_FEES')
    expect(by('P4')).toMatchObject({ counterparty: "John's Fishin Shack", rawText: 'Fishing bait · JOHNS FISHIN SHACK BAIT' })
    expect(by('P4').categoryHint).toBeUndefined()
    expect(by('P5').categoryHint).toBeUndefined()
  })
})

describe('custom currencies (points, crypto)', () => {
  it("a URL currency is 'XXX' and an ISO code is kept", async () => {
    const { currencyOf } = await import('./map.ts')
    expect(currencyOf({ currency: 'https://www.example.com/flight-miles' } as SfAccount)).toBe('XXX')
    expect(currencyOf({ currency: 'USD' } as SfAccount)).toBe('USD')
  })
})
