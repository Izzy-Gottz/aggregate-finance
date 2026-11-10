import type { ConnectionRef, PayrollRun } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createRipplingConnector } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/docs-shaped.json', import.meta.url), 'utf8')) as { runs: unknown[]; records: Record<string, unknown[]> }
const NOW = Date.parse('2026-10-09T12:00:00Z')
const BASE = 'https://rest.ripplingapis.com'

function make(extra: FixtureRoute[] = []) {
  const ff = fixtureFetch([
    ...extra,
    {
      match: (u) => u.pathname === '/payroll-runs/',
      respond: (url) => {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        const limit = Number(url.searchParams.get('limit') ?? 2)
        const page = 2 // two runs per page regardless of limit, to exercise next_link
        const results = FIX.runs.slice(offset, offset + Math.min(page, limit))
        const more = offset + page < FIX.runs.length && limit > 1
        return { json: { results, ...(more ? { next_link: `${BASE}/payroll-runs/?order_by=check_date+desc&limit=${limit}&offset=${offset + page}` } : {}) } }
      },
    },
    { match: /worker-payroll-records/, respond: (url) => ({ json: { results: FIX.records[url.pathname.split('/')[2] as string] ?? [] } }) },
  ])
  const connector = createRipplingConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5 } })
  const conn: ConnectionRef = { id: 'conn_rip', workspaceId: 'ws_1', connectorKey: 'rippling', secret: { apiToken: 'tok-test' }, config: {} }
  return { connector, conn, ff }
}

describe('rippling connector (docs-shaped fixtures)', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 3 })
  })

  it('sums worker records into one run per currency (golden)', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(ff.calls.every((c) => c.headers.authorization === 'Bearer tok-test' && c.headers['rippling-api-version'] === '2024-08-01')).toBe(true)
    const runs = Object.fromEntries((events as PayrollRun[]).map((r) => [r.externalId, r]))
    expect(Object.keys(runs).sort()).toEqual(['run_a:GBP', 'run_a:USD', 'run_b'])
    expect(runs['run_a:USD']).toMatchObject({
      payDate: '2026-09-26',
      periodStart: '2026-09-12',
      gross: { minor: 1_000_000, currency: 'USD' },
      net: { minor: 741_075, currency: 'USD' },
      employerTaxes: { minor: 76_500, currency: 'USD' },
      employeeTaxes: { minor: 210_000, currency: 'USD' },
      employerBenefits: { minor: 45_000, currency: 'USD' },
      employeeCount: 2,
      status: 'paid',
      provider: 'Rippling',
    })
    expect(runs['run_a:GBP']).toMatchObject({ gross: { minor: 350_000, currency: 'GBP' }, employerTaxes: { minor: 38_010, currency: 'GBP' } })
    expect(runs.run_b?.status).toBe('scheduled') // approved, check date tomorrow
    // Drafts are skipped; runs older than two years end the listing.
    expect(ff.calls.some((c) => c.url.includes('run_c') || c.url.includes('run_old'))).toBe(false)
  })

  it('needs a token; 401 → reauth, 403 → reauth that says which access is missing', async () => {
    const { connector } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    const a = make([{ match: (u) => u.pathname === '/payroll-runs/', respond: { status: 401, json: { detail: 'Invalid token' } } }])
    expect((await a.connector.health(a.conn)).status).toBe('needs_reauth')
    const b = make([{ match: (u) => u.pathname === '/payroll-runs/', respond: { status: 403, json: { detail: 'Global Payroll not enabled' } } }])
    expect(await b.connector.health(b.conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/Global Payroll not enabled.*payroll scopes/s) })
  })

  it("sorts with Rippling's `field desc` syntax and keeps order_by and limit on a next_link that drops them", async () => {
    const { connector, conn, ff } = make([
      {
        match: (u) => u.pathname === '/payroll-runs/' && u.searchParams.get('offset') === '2',
        respond: { json: { results: (FIX.runs as Array<Record<string, unknown>>).slice(2) } },
      },
      {
        match: (u) => u.pathname === '/payroll-runs/' && !u.searchParams.has('offset'),
        respond: { json: { results: FIX.runs.slice(0, 2), next_link: `${BASE}/payroll-runs/?offset=2` } },
      },
    ])
    await runSync(connector, conn, null)
    const lists = ff.calls.map((c) => new URL(c.url)).filter((u) => u.pathname === '/payroll-runs/')
    expect(lists.length).toBe(2)
    for (const u of lists) expect([u.searchParams.get('order_by'), u.searchParams.get('limit')]).toEqual(['check_date desc', '25'])
  })

  it('a run_state the docs never listed is skipped with a warning, not guessed at', async () => {
    const odd = { ...(FIX.runs[2] as Record<string, unknown>), id: 'run_x', run_state: 'COMPLETED' }
    const { connector, conn } = make([{ match: (u) => u.pathname === '/payroll-runs/', respond: { json: { results: [odd] } } }])
    const r = await connector.sync(conn, null)
    expect(r.events).toHaveLength(0)
    expect(r.warnings?.[0]).toMatch(/COMPLETED/)
  })

  it('a worker whose pay can’t be read leaves the run out with a warning, never $0', async () => {
    const run = FIX.runs[2] as Record<string, unknown>
    const recs = (FIX.records[run.id as string] ?? []) as Array<Record<string, unknown>>
    expect(recs.length).toBeGreaterThan(0)
    const odd = recs.map((w, i) => (i === 0 ? { ...w, gross_pay: { amount: 350000 } } : w))
    const { connector, conn } = make([
      { match: (u) => u.pathname === '/payroll-runs/', respond: { json: { results: [run] } } },
      { match: /worker-payroll-records/, respond: { json: { results: odd } } },
    ])
    const r = await connector.sync(conn, null)
    expect(r.events).toHaveLength(0)
    expect(r.warnings?.[0]).toMatch(/unknown, not \$0/)
  })
})


describe('rippling: an unreadable 2xx stops the sync, never a silent $0', () => {
  it('an empty body (e.g. a followed redirect to a sign-in or error page) fails visibly', async () => {
    const { connector, conn } = make([{ match: (u) => u.pathname === '/payroll-runs/', respond: { text: '' } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
  it('a 200 whose body isn’t the expected object fails visibly', async () => {
    const { connector, conn } = make([{ match: (u) => u.pathname === '/payroll-runs/', respond: { json: 5 } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
})


describe('rippling pagination completeness: a partial run is never summed as complete', () => {
  it('worker-payroll-records that never stop paging fail visibly instead of summing a partial run', async () => {
    const { connector, conn } = make([{ match: /worker-payroll-records/, respond: { json: { results: [], next_link: 'https://rest.ripplingapis.com/payroll-runs/r/worker-payroll-records/?limit=100&offset=1' } } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow(/page through/)
  })
})
