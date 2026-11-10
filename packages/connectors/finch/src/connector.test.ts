import type { ConnectionRef, PayrollRun } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createFinchConnector } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox.json', import.meta.url), 'utf8')) as {
  payments: Array<Record<string, unknown>>
  statements: Record<string, unknown[]>
  directory: unknown
}
const NOW = Date.parse('2026-10-09T12:00:00Z')

function make(extra: FixtureRoute[] = [], config: Record<string, unknown> = {}) {
  const ff = fixtureFetch([
    ...extra,
    {
      match: '/employer/payment',
      respond: (url) => {
        const from = url.searchParams.get('start_date') as string
        const to = url.searchParams.get('end_date') as string
        return { json: FIX.payments.filter((p) => (p.pay_date as string) >= from && (p.pay_date as string) <= to) }
      },
    },
    {
      method: 'POST',
      match: '/employer/pay-statement',
      respond: (_url, body) => {
        const reqs = (body as { requests: Array<{ payment_id: string }> }).requests
        return { json: { responses: reqs.map((r) => (FIX.statements[r.payment_id] ? { payment_id: r.payment_id, code: 200, body: { paging: { count: 2, offset: 0 }, pay_statements: FIX.statements[r.payment_id] } } : { payment_id: r.payment_id, code: 404, body: {} })) } }
      },
    },
    { match: '/employer/directory', respond: { json: FIX.directory } },
    { match: '/employer/company', respond: { json: { id: 'co_1', legal_name: 'Example Co' } } },
  ])
  const connector = createFinchConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5 },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test' },
  })
  const conn: ConnectionRef = { id: 'conn_finch', workspaceId: 'ws_1', connectorKey: 'finch', secret: { accessToken: 'tok-test' }, config: { providerId: 'gusto', ...config } }
  return { connector, conn, ff }
}

describe('finch connector', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract (two years of 90-day windows)', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 4 })
    expect(r.pages).toBe(9) // 730 days back + 31 ahead, in 90-day windows
  })

  it('maps payments to provider payroll runs with per-person lines (golden)', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(ff.calls.every((c) => c.headers['finch-api-version'] === '2020-09-17' && c.headers.authorization === 'Bearer tok-test')).toBe(true)
    const runs = Object.fromEntries((events as PayrollRun[]).map((r) => [r.externalId, r]))
    expect(Object.keys(runs).sort()).toEqual(['pay_0a', 'pay_0b', 'pay_next', 'pay_old'])
    expect(runs.pay_0a).toMatchObject({
      payDate: '2026-09-15',
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      gross: { minor: 1_200_000, currency: 'USD' },
      net: { minor: 912_000, currency: 'USD' },
      employerTaxes: { minor: 92_500, currency: 'USD' },
      employeeTaxes: { minor: 288_000, currency: 'USD' },
      employerBenefits: { minor: 66_000, currency: 'USD' },
      companyDebit: { minor: 1_402_500, currency: 'USD' },
      employeeCount: 2,
      source: 'provider',
      estimated: false,
      status: 'paid',
      provider: 'gusto',
      lines: [
        { person: 'Ada Example', gross: { minor: 700_000, currency: 'USD' }, net: { minor: 532_000, currency: 'USD' }, kind: 'employee' },
        { person: 'Ben Sample', gross: { minor: 500_000, currency: 'USD' }, net: { minor: 380_000, currency: 'USD' }, kind: 'employee' },
      ],
    })
    expect(runs.pay_0b?.lines).toBeUndefined()
    expect(runs.pay_next?.status).toBe('scheduled')
    expect(runs.pay_old).toMatchObject({ employerTaxes: { minor: 61_200, currency: 'USD' } })
    expect(runs.pay_old?.companyDebit).toBeUndefined()
  })

  it('employer taxes come from the pay statements when the payment says 0 or nothing', async () => {
    // Gusto via Finch: zero at payment level, the real figures on each statement.
    const pay = { id: 'pay_x', pay_date: '2026-09-30', gross_pay: { amount: 100_000, currency: 'usd' }, net_pay: { amount: 75_000, currency: 'usd' }, employer_taxes: { amount: 0, currency: 'usd' }, company_debit: null, individual_ids: ['ind_a'] }
    const stmt = (who: string) => ({
      individual_id: who,
      type: 'regular_payroll',
      gross_pay: { amount: 50_000, currency: 'usd' },
      net_pay: { amount: 37_500, currency: 'usd' },
      taxes: [
        // Finch's statement shape: integer cents and a currency field.
        { type: 'fica', name: 'Social Security', employer: true, amount: 3_100, currency: 'usd' },
        { type: 'fica', name: 'Social Security', employer: false, amount: 3_100, currency: 'usd' },
        { type: 'federal', name: 'FUTA', employer: true, amount: 300, currency: 'usd' },
      ],
      employer_contributions: [],
    })
    const { connector, conn } = make([
      { match: '/employer/payment', respond: (url) => ({ json: (url.searchParams.get('start_date') as string) <= '2026-09-30' && (url.searchParams.get('end_date') as string) >= '2026-09-30' ? [pay] : [] }) },
      { method: 'POST', match: '/employer/pay-statement', respond: { json: { responses: [{ payment_id: 'pay_x', code: 200, body: { pay_statements: [stmt('ind_a'), stmt('ind_b')] } }] } } },
    ])
    const { events } = await runSync(connector, conn, null)
    expect((events as PayrollRun[]).find((r) => r.externalId === 'pay_x')?.employerTaxes).toEqual({ minor: 6_800, currency: 'USD' })
  })

  it('incremental pass re-reads 45 days back for corrections', async () => {
    const { connector, conn, ff } = make()
    const first = await runSync(connector, conn, null)
    ff.calls.length = 0
    await runSync(connector, conn, first.cursor)
    const windows = ff.calls.filter((c) => c.url.includes('/employer/payment')).map((c) => new URL(c.url).searchParams.get('start_date'))
    expect(windows).toEqual(['2026-08-25'])
  })

  it('degrades when the provider has no pay statements; can be turned off', async () => {
    const unsupported = make([{ method: 'POST', match: '/employer/pay-statement', respond: { status: 501, json: { code: 501, name: 'not_implemented_error', message: 'not supported' } } }])
    const a = await runSync(unsupported.connector, unsupported.conn, null)
    expect(a.events).toHaveLength(4)
    expect(a.events.every((e) => !(e as PayrollRun).lines)).toBe(true)
    const off = make([], { individualDetail: false })
    await runSync(off.connector, off.conn, null)
    expect(off.ff.calls.some((c) => c.url.includes('pay-statement'))).toBe(false)
  })

  it('errors: reauth, still-syncing (202) stops without sleeping', async () => {
    const reauth = make([{ match: '/employer/company', respond: { status: 401, json: { code: 401, name: 'reauthenticate_user', finch_code: 'reauthenticate_user', message: 'reconnect' } } }])
    expect((await reauth.connector.health(reauth.conn)).status).toBe('needs_reauth')
    const syncing = make([{ match: '/employer/payment', respond: { status: 202, json: { code: 202, finch_code: 'data_sync_in_progress', message: 'syncing' } } }])
    await expect(syncing.connector.sync(syncing.conn, null)).rejects.toMatchObject({ kind: 'rate_limited', code: 'data_sync_in_progress' })
  })

  it('connect exchanges the code and reads the plan from /introspect (automated → assisted:false)', async () => {
    const { connector } = make([
      // client_type here is the APP environment (sandbox), not the plan — we no longer store it.
      { method: 'POST', match: '/auth/token', respond: { json: { access_token: 'tok-new', connection_id: 'cn_1', company_id: 'co_1', provider_id: 'gusto', client_type: 'sandbox' } } },
      { match: '/introspect', respond: { json: { connection_type: 'provider', authentication_methods: [{ type: 'oauth' }] } } },
    ])
    expect(await connector.connect({ code: 'c1' })).toEqual({ secret: { accessToken: 'tok-new' }, config: { connectionId: 'cn_1', companyId: 'co_1', providerId: 'gusto', assisted: false, connectionType: 'provider' } })
  })

  it('connect marks an assisted connection (authentication_methods[].type === "assisted") so freshness uses the weekly cadence', async () => {
    const { connector } = make([
      { method: 'POST', match: '/auth/token', respond: { json: { access_token: 'tok-new', connection_id: 'cn_2', provider_id: 'adp_run' } } },
      { match: '/introspect', respond: { json: { connection_type: 'finch', authentication_methods: [{ type: 'assisted' }] } } },
    ])
    expect(await connector.connect({ code: 'c1' })).toEqual({ secret: { accessToken: 'tok-new' }, config: { connectionId: 'cn_2', providerId: 'adp_run', assisted: true, connectionType: 'finch' } })
  })

  it('connection_type "finch" alone does NOT mean assisted — only authentication_methods decides', async () => {
    const { connector } = make([
      { method: 'POST', match: '/auth/token', respond: { json: { access_token: 'tok-new', connection_id: 'cn_4', provider_id: 'gusto' } } },
      // Finch docs point only to authentication_methods for assisted; connection_type is recorded but not the signal.
      { match: '/introspect', respond: { json: { connection_type: 'finch', authentication_methods: [{ type: 'credential' }] } } },
    ])
    expect(await connector.connect({ code: 'c1' })).toEqual({ secret: { accessToken: 'tok-new' }, config: { connectionId: 'cn_4', providerId: 'gusto', assisted: false, connectionType: 'finch' } })
  })

  it('connect survives /introspect failing: the plan is simply left unrecorded', async () => {
    const { connector } = make([
      { method: 'POST', match: '/auth/token', respond: { json: { access_token: 'tok-new', connection_id: 'cn_3', provider_id: 'gusto' } } },
      { match: '/introspect', respond: { status: 500, json: { message: 'boom' } } },
    ])
    expect(await connector.connect({ code: 'c1' })).toEqual({ secret: { accessToken: 'tok-new' }, config: { connectionId: 'cn_3', providerId: 'gusto' } })
  })

  it('disconnect ends the connection at Finch, the only call that stops its billing', async () => {
    const { connector, conn, ff } = make([{ method: 'POST', match: '/disconnect', respond: { json: { status: 'success' } } }])
    await expect(connector.disconnect!(conn)).resolves.toBeUndefined()
    const call = ff.calls.find((c) => c.url.endsWith('/disconnect'))
    expect(call?.headers.authorization).toBe('Bearer tok-test')
    expect(call?.headers['finch-api-version']).toBe('2020-09-17')
  })

  it('waits for the last connection of an employer and provider, in any workspace', async () => {
    const { connector, conn, ff } = make([{ method: 'POST', match: '/disconnect', respond: { json: { status: 'success' } } }])
    expect(connector.accountKey!({ companyId: 'co_1', providerId: 'gusto' })).toBe('co_1:gusto')
    expect(connector.accountKey!({ companyId: 'co_1' })).toBeUndefined()
    await expect(connector.disconnect!({ ...conn, config: { ...conn.config, liveElsewhere: true } })).resolves.toEqual({ notRevoked: expect.stringContaining('Another workspace') })
    expect(ff.calls.filter((c) => c.url.endsWith('/disconnect'))).toHaveLength(0)
  })

  it('a token Finch refuses is already gone; any other failure tells the person', async () => {
    const gone = make([{ method: 'POST', match: '/disconnect', respond: { status: 401, json: { message: 'Unauthorized' } } }])
    await expect(gone.connector.disconnect!(gone.conn)).resolves.toBeUndefined()
    const down = make([{ method: 'POST', match: '/disconnect', respond: { status: 400, json: { message: 'nope' } } }])
    await expect(down.connector.disconnect!(down.conn)).resolves.toEqual({ notRevoked: expect.stringContaining('payroll provider') })
  })
})


describe('finch: an unreadable 2xx stops the sync, never a silent $0', () => {
  it('an empty body (e.g. a followed redirect to a sign-in or error page) fails visibly', async () => {
    const { connector, conn } = make([{ match: '/employer/payment', respond: { text: '' } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
  it('a 200 whose body isn’t the expected object fails visibly', async () => {
    const { connector, conn } = make([{ match: '/employer/payment', respond: { json: 5 } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
})
