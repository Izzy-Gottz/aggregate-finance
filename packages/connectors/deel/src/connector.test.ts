import type { ConnectionRef, PayrollRun } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDeelConnector } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/docs-shaped.json', import.meta.url), 'utf8')) as { payments: Array<Record<string, unknown>>; breakdown: Record<string, unknown[]> }
const NOW = Date.parse('2026-10-09T12:00:00Z')

function make(extra: FixtureRoute[] = []) {
  const ff = fixtureFetch([
    ...extra,
    {
      match: (u) => u.pathname.endsWith('/payments'),
      respond: (url) => {
        const from = url.searchParams.get('date_from') as string
        const to = url.searchParams.get('date_to') as string
        return { json: { data: FIX.payments.filter((p) => (p.created_at as string).slice(0, 10) >= from && (p.created_at as string).slice(0, 10) < to) } } // date_to is exclusive
      },
    },
    { match: /\/payments\/[^/]+\/breakdown/, respond: (url) => ({ json: { data: FIX.breakdown[url.pathname.split('/')[4] as string] ?? [] } }) },
    { match: '/contracts', respond: { json: { data: [], page: { total_rows: 0 } } } },
  ])
  const connector = createDeelConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5 } })
  const conn: ConnectionRef = { id: 'conn_deel', workspaceId: 'ws_1', connectorKey: 'deel', secret: { token: 'tok-test' }, config: { environment: 'sandbox' } }
  return { connector, conn, ff }
}

describe('deel connector (docs-shaped fixtures)', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 1 })
  })

  it('turns a paid receipt into a run; Deel fees stay out of payroll cost (golden)', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(ff.calls.every((c) => c.url.startsWith('https://api-staging.letsdeel.com/rest/v2'))).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0] as PayrollRun).toMatchObject({
      externalId: 'pmt_01',
      payDate: '2026-09-30',
      gross: { minor: 1_015_000, currency: 'USD' },
      net: { minor: 1_015_000, currency: 'USD' },
      employerTaxes: { minor: 0, currency: 'USD' },
      companyDebit: { minor: 1_045_000, currency: 'USD' },
      employeeCount: 1,
      provider: 'Deel',
      status: 'paid',
      lines: [
        { person: 'Chen Example', gross: { minor: 625_000, currency: 'USD' }, kind: 'contractor' },
        { person: 'Dana Sample', gross: { minor: 390_000, currency: 'USD' }, kind: 'employee' },
      ],
    })
    // paid_at is a real instant, carried as `at` so the engine dates the run in the workspace tz.
    expect((events[0] as PayrollRun).at).toMatch(/^2026-09-30T\d\d:\d\d/)
  })

  it('a paid receipt of zero with no worker lines is not a run', async () => {
    const zero = { ...FIX.payments[0], id: 'pmt_zero', total: '0.00', paid_at: '2026-10-01T00:00:00Z', created_at: FIX.payments[0]!.created_at }
    const { connector, conn } = make([
      { match: (u) => u.pathname.endsWith('/payments'), respond: { json: { data: [zero] } } },
      { match: /\/payments\/pmt_zero\/breakdown/, respond: { json: { data: [] } } },
    ])
    const { events } = await runSync(connector, conn, null)
    expect(events).toHaveLength(0)
  })

  it('token checks and scope errors', async () => {
    const { connector } = make()
    await expect(connector.connect({ token: ' ' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(await connector.connect({ token: 'tok-1', environment: 'sandbox' })).toEqual({ secret: { token: 'tok-1' }, config: { environment: 'sandbox' } })
    const noScope = make([{ match: (u) => u.pathname.endsWith('/payments'), respond: { status: 403, json: { errors: [{ message: 'Forbidden' }] } } }])
    expect((await noScope.connector.health(noScope.conn)).status).toBe('needs_reauth')
  })
})

const call = (ff: { calls: Array<{ url: string; headers: Record<string, string> }> }, pick: (u: URL) => boolean) => ff.calls.find((c) => pick(new URL(c.url)))!

describe('deel one-click sign-in (Aggregate’s Deel app)', () => {
  const oauth = { clientId: 'app-client-id', clientSecret: 'app-secret==', redirectUri: 'https://app.example.com/api/connectors/deel/callback', environment: 'sandbox' as const }
  function makeApp(tokenReplies: unknown[], saved: unknown[] = []) {
    const ff = fixtureFetch([
      { match: (u) => u.pathname === '/oauth2/tokens', respond: () => ({ json: tokenReplies.shift() }) },
      { match: (u) => u.pathname.endsWith('/payments'), respond: { json: { data: [] } } },
    ])
    const connector = createDeelConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id, s) => void saved.push(s) }, oauth })
    return { connector, ff }
  }

  it('signs in at Deel’s sandbox with accounting:read only, and describes itself as one-click', () => {
    const { connector } = makeApp([])
    const url = new URL(connector.authorizationUrl!('st_1'))
    expect(url.origin + url.pathname).toBe('https://app.demo.deel.com/oauth2/authorize')
    expect(url.searchParams.get('scope')).toBe('accounting:read')
    expect(url.searchParams.get('state')).toBe('st_1')
    expect(url.searchParams.get('client_id')).toBe('app-client-id')
    expect(connector.describe().auth).toBe('oauth')
  })

  it('the callback trades the code for tokens and checks one read with the token and x-client-id', async () => {
    const { connector, ff } = makeApp([{ access_token: 'at_1', refresh_token: 'rt_1', expires_in: 2_592_000, token_type: 'Bearer', scope: 'accounting:read' }])
    const { secret, config } = await connector.connect({ code: 'code_1', connectState: 'st_1' })
    expect(secret).toMatchObject({ tokens: { accessToken: 'at_1', refreshToken: 'rt_1' } })
    expect(config).toMatchObject({ environment: 'sandbox' })
    const read = call(ff, (u) => u.pathname.endsWith('/payments'))
    expect(new URL(read.url).origin).toBe('https://api-staging.letsdeel.com')
    expect(read.headers.authorization).toBe('Bearer at_1')
    expect(read.headers['x-client-id']).toBe('app-client-id')
    const token = call(ff, (u) => u.pathname === '/oauth2/tokens')
    expect(new URL(token.url).origin).toBe('https://app.demo.deel.com')
    expect(token.headers.authorization).toBe(`Basic ${Buffer.from('app-client-id:app-secret==').toString('base64')}`)
  })

  it('renews 5 days early and saves the new single-use refresh token before reading', async () => {
    const saved: unknown[] = []
    const { connector, ff } = makeApp([{ access_token: 'at_2', refresh_token: 'rt_2', expires_in: 2_592_000 }], saved)
    const conn: ConnectionRef = { id: 'conn_app', workspaceId: 'ws_1', connectorKey: 'deel', secret: { tokens: { accessToken: 'at_1', refreshToken: 'rt_1', expiresAt: NOW + 3 * 86_400_000 } }, config: { environment: 'sandbox' } }
    const page = await connector.sync(conn, null)
    expect(saved).toEqual([{ tokens: expect.objectContaining({ accessToken: 'at_2', refreshToken: 'rt_2' }) }])
    expect(page.updatedSecret).toEqual(saved[0])
    const reads = ff.calls.filter((c) => new URL(c.url).pathname.endsWith('/payments'))
    expect(reads.length > 0 && reads.every((c) => c.headers.authorization === 'Bearer at_2')).toBe(true)
  })

  it('a pasted-token connection keeps syncing with the app configured (no x-client-id)', async () => {
    const { connector, ff } = makeApp([])
    const conn: ConnectionRef = { id: 'conn_tok', workspaceId: 'ws_1', connectorKey: 'deel', secret: { token: 'tok-test' }, config: { environment: 'sandbox' } }
    await connector.sync(conn, null)
    const read = call(ff, (u) => u.pathname.endsWith('/payments'))
    expect(read.headers.authorization).toBe('Bearer tok-test')
    expect(read.headers['x-client-id']).toBeUndefined()
    expect(ff.calls.some((c) => new URL(c.url).pathname === '/oauth2/tokens')).toBe(false)
  })
})

const SANDBOX = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox-2026-11.json', import.meta.url), 'utf8')) as { payments: Array<Record<string, unknown>>; breakdown: Record<string, Array<Record<string, unknown>>> }

function sandbox(payments = SANDBOX.payments, breakdown = SANDBOX.breakdown) {
  const ff = fixtureFetch([
    { match: (u) => u.pathname.endsWith('/payments'), respond: (url) => ({ json: { data: payments.filter((p) => (p.created_at as string).slice(0, 10) >= (url.searchParams.get('date_from') as string) && (p.created_at as string).slice(0, 10) < (url.searchParams.get('date_to') as string)) } }) },
    { match: /\/payments\/[^/]+\/breakdown/, respond: (url) => ({ json: { data: breakdown[url.pathname.split('/')[4] as string] ?? [] } }) },
  ])
  const connector = createDeelConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-11-03T12:00:00Z')), random: () => 0.5 } })
  const conn: ConnectionRef = { id: 'conn_deel', workspaceId: 'ws_1', connectorKey: 'deel', secret: { token: 'tok-test' }, config: { environment: 'sandbox' } }
  return { connector, conn }
}

/** Sync to the end, keeping every page's warnings (runSync only returns the events). */
async function syncAll(connector: ReturnType<typeof sandbox>['connector'], conn: ConnectionRef) {
  const warnings: string[] = []
  const { events } = await runSync(connector, conn, null, { onPage: async (page) => void warnings.push(...(page.warnings ?? [])) })
  return { events, warnings }
}

describe('deel connector (sandbox-shaped: contract_id null, total_payment_currency "")', () => {
  it('fixtures are redacted', () => assertRedacted(SANDBOX))

  it('each receipt becomes a run whose worker cost is the receipt total, to the cent', async () => {
    const { connector, conn } = sandbox()
    const runs = (await runSync(connector, conn, null)).events as PayrollRun[]
    assertValidEvents(runs, { connectionId: conn.id })
    const byId = Object.fromEntries(runs.map((r) => [r.externalId, [r.payDate, r.gross.minor, r.net.minor, r.companyDebit?.minor, r.lines?.length, r.lines?.[0]?.kind]]))
    expect(byId).toEqual({
      rcpt_s37: ['2026-10-11', 950_000, 950_000, 950_000, 1, 'contractor'],
      rcpt_s41: ['2026-09-01', 580_000, 580_000, 580_000, 1, 'contractor'],
      rcpt_s27: ['2026-07-11', 1_153_800, 1_153_800, 1_153_800, 1, 'contractor'],
      rcpt_s05: ['2026-06-11', 9_000, 9_000, 9_000, 1, 'contractor'],
    })
  })

  it("a receipt whose lines don't add up is skipped with a warning; it never becomes a $0 run", async () => {
    const p = SANDBOX.payments[0]!
    const line = { ...SANDBOX.breakdown[p.id as string]![0]!, total: '9000.00' }
    const { connector, conn } = sandbox([p], { [p.id as string]: [line] })
    const out = await syncAll(connector, conn)
    expect(out.events).toHaveLength(0)
    expect(out.warnings).toEqual(['Deel receipt REC-2026-37 was skipped: its lines add up to 9000.00 and the receipt to 9500.00.'])
  })

  it("a receipt with no readable lines is skipped with a warning too (it used to read as $0)", async () => {
    const p = SANDBOX.payments[0]!
    const { connector, conn } = sandbox([p], { [p.id as string]: [] })
    const out = await syncAll(connector, conn)
    expect(out.events).toHaveLength(0)
    expect(out.warnings[0]).toMatch(/REC-2026-37 was skipped: its lines add up to 0\.00 and the receipt to 9500\.00/)
  })

  it('a line in another currency than the receipt is no longer dropped silently: the receipt is skipped with a warning', async () => {
    const p = SANDBOX.payments[0]!
    const line = { ...SANDBOX.breakdown[p.id as string]![0]!, payment_currency: 'EUR' }
    const { connector, conn } = sandbox([p], { [p.id as string]: [line] })
    const out = await syncAll(connector, conn)
    expect(out.events).toHaveLength(0)
    expect(out.warnings).toEqual(['Deel receipt REC-2026-37 was skipped: a line is in EUR, the receipt in USD.'])
  })
})

describe('deel non-pay lines', () => {
  it.each(['prepaid_billing', 'expense_card', 'contractor_standalone_payment', 'deel_it_order_statement', 'prepaid_funding_statement'])('a %s line with a contract_id is not worker pay', async (type) => {
    const p: Record<string, unknown> = { ...SANDBOX.payments[0]!, total: '9600.00' }
    const work = SANDBOX.breakdown[p.id as string]![0]!
    const other = { ...work, contract_id: 'ctr_x', contract_type: type, total: '100.00', contractor_unique_identifier: null }
    const { connector, conn } = sandbox([p], { [p.id as string]: [work, other] })
    const { events } = await syncAll(connector, conn)
    expect((events as PayrollRun[]).map((r) => [r.gross.minor, r.companyDebit?.minor])).toEqual([[950_000, 960_000]])
  })
})

describe('deel worker vs fee lines (by contract type)', () => {
  it('a pay-type line with no contract_id and no worker id is still worker pay', async () => {
    const p = SANDBOX.payments[0]!
    const line = { ...SANDBOX.breakdown[p.id as string]![0]!, contract_id: null, contractor_unique_identifier: '' }
    const { connector, conn } = sandbox([p], { [p.id as string]: [line] })
    const { events } = await syncAll(connector, conn)
    expect((events as PayrollRun[]).map((r) => [r.gross.minor, r.companyDebit?.minor])).toEqual([[950_000, 950_000]])
  })

  it('a receipt of only Deel fees is not a payroll run', async () => {
    const p: Record<string, unknown> = { ...SANDBOX.payments[0]!, total: '49.00' }
    const fee = { ...SANDBOX.breakdown[p.id as string]![0]!, contract_type: 'deel_percentage_fee', total: '49.00', contractor_unique_identifier: null }
    const { connector, conn } = sandbox([p], { [p.id as string]: [fee] })
    const out = await syncAll(connector, conn)
    expect(out.events).toHaveLength(0)
    expect(out.warnings).toEqual([])
  })
})

describe('deel: unreadable responses stop the sync; a real empty period still succeeds (risk: silent $0)', () => {
  const payments = (respond: FixtureRoute['respond']): FixtureRoute => ({ match: (u) => u.pathname.endsWith('/payments'), respond })

  it('an empty payments list is a clean zero-row success, not a failure', async () => {
    const { connector, conn } = make([payments({ json: { data: [] } })])
    const { events } = await runSync(connector, conn, null)
    expect(events).toEqual([])
  })

  it('an empty body (a followed-redirect sign-in or error page) fails visibly, never reads as zero receipts', async () => {
    const { connector, conn } = make([payments({ text: '' })])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })

  it('a 200 whose body isn’t the expected object fails visibly', async () => {
    const { connector, conn } = make([payments({ json: 5 })])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
})
