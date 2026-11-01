// Contract tests from BILL's public v3 docs (developer.bill.com, read 2026-10-11): login, every list we read,
// pagination with page tokens, and the documented error codes (session, credentials, MFA, permissions, hourly and
// concurrency limits). They stand in for a live organisation until a customer's key arrives.
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBillConnector, type BillSecret } from './connector.ts'

type Errs = 'sessionInvalid' | 'badLogin' | 'untrusted' | 'permission' | 'hourly' | 'concurrent'
const DOC = JSON.parse(readFileSync(new URL('../fixtures/redacted/docs-2026.json', import.meta.url), 'utf8')) as Record<string, unknown> & { errors: Record<Errs, unknown> }
const NOW = Date.parse('2026-10-09T12:20:00Z')
const empty = { results: [], count: 0 }

function routes(over: { login?: FixtureResponse | FixtureResponse[]; bills1?: FixtureResponse | FixtureResponse[]; bills2?: FixtureResponse | FixtureResponse[] } = {}): FixtureRoute[] {
  return [
    { method: 'POST', match: '/v3/login', respond: over.login ?? { json: DOC.login } },
    { match: '/v3/login/session', respond: { json: DOC.session } },
    { match: (u) => u.pathname.endsWith('/v3/vendors'), respond: { json: { results: DOC.vendors, count: 1 } } },
    { match: (u) => u.pathname.endsWith('/v3/customers'), respond: { json: { results: DOC.customers, count: 1 } } },
    { match: (u) => u.pathname.endsWith('/v3/bills') && u.searchParams.get('page') === 'PAGE_BILLS_2', respond: over.bills2 ?? { json: DOC.billsPage2 } },
    { match: (u) => u.pathname.endsWith('/v3/bills'), respond: over.bills1 ?? { json: DOC.billsPage1 } },
    { match: (u) => u.pathname.endsWith('/v3/vendor-credits'), respond: { json: empty } },
    { match: (u) => u.pathname.endsWith('/v3/payments'), respond: { json: DOC.payments } },
    { match: (u) => u.pathname.endsWith('/v3/invoices'), respond: { json: DOC.invoices } },
    { match: (u) => u.pathname.endsWith('/v3/receivable-payments'), respond: { json: empty } },
  ]
}

function make(r: FixtureRoute[]) {
  const ff = fixtureFetch(r)
  const clock = fakeClock(NOW)
  const connector = createBillConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock, random: () => 0.5 } })
  const secret: BillSecret = { devKey: 'dev-test', username: 'user@example.com', password: 'pw-test', organizationId: '00801DOC' }
  const conn: ConnectionRef = { id: 'conn_bill', workspaceId: 'ws_1', connectorKey: 'billcom', secret, config: { environment: 'sandbox', currency: 'USD' } }
  return { connector, conn, ff, clock, secret }
}
const ids = (events: NormalizedEvent[], type: NormalizedEvent['type']) => events.filter((e) => e.type === type).map((e) => e.externalId).sort()

describe('BILL API contract (docs-shaped)', () => {
  it('fixtures are redacted', () => assertRedacted(DOC))

  it('logs in with the documented response (no organisation name) and reads the name from the session', async () => {
    const { connector, ff } = make(routes())
    const out = await connector.connect({ devKey: 'dev-test', username: 'user@example.com', password: 'pw-test', organizationId: '00801DOC', environment: 'sandbox' })
    expect(out.config).toMatchObject({ environment: 'sandbox', organizationName: 'Example Org' })
    const session = ff.calls.find((c) => c.url.includes('/v3/login/session'))!
    expect([session.headers.devkey, session.headers.sessionid]).toEqual(['dev-test', 'sess-doc'])
  })

  it('follows nextPage without resending filters or sort, and maps every documented list', async () => {
    const { connector, conn, ff } = make(routes())
    const first = await runSync(connector, conn, null)
    expect(ids(first.events, 'invoice.upsert')).toEqual(['00e01DOC1', '00n01DOC1', '00n01DOC2'])
    expect(ids(first.events, 'payment.applied')).toEqual(['stp01DOC1'])
    const page2 = ff.calls.find((c) => c.url.includes('page=PAGE_BILLS_2'))!
    expect(new URL(page2.url).searchParams.has('filters') || new URL(page2.url).searchParams.has('sort')).toBe(false)
    expect(ff.calls.filter((c) => c.url.includes('/v3/') && !c.url.includes('/login')).every((c) => Number(new URL(c.url).searchParams.get('max')) <= 100)).toBe(true)
    // The next run asks only for what changed, with BILL's quoted-date filter syntax.
    const again = make(routes())
    await runSync(again.connector, conn, first.cursor)
    const bills = again.ff.calls.find((c) => c.url.includes('/v3/bills'))!
    expect(new URL(bills.url).searchParams.get('filters')).toMatch(/^updatedTime:gte:"\d{4}-\d{2}-\d{2}T/)
  })

  it('a session that ends mid-pagination (BDC_1109) logs in once more and carries on from the same page', async () => {
    const { connector, conn, ff } = make(routes({ bills2: [{ status: 401, json: DOC.errors.sessionInvalid }, { json: DOC.billsPage2 }] }))
    const { events } = await runSync(connector, conn, null)
    expect(ids(events, 'invoice.upsert')).toContain('00n01DOC2')
    expect(ff.calls.filter((c) => c.url.endsWith('/v3/login'))).toHaveLength(2)
  })

  it('wrong password, bad developer key, an untrusted (MFA) session or missing permissions all mean reconnect, with a reason', async () => {
    for (const [err, why] of [['badLogin', /user login or sync token/], ['untrusted', /two-step/], ['permission', /permission/]] as const) {
      const m = make(routes({ login: err === 'permission' ? { json: DOC.login } : { status: 401, json: DOC.errors[err] }, bills1: { status: 403, json: DOC.errors.permission } }))
      expect(await m.connector.health(m.conn), err).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(why) })
      // Never a login loop: at most two logins per attempt.
      expect(m.ff.calls.filter((c) => c.url.endsWith('/v3/login')).length).toBeLessThanOrEqual(2)
    }
  })

  it('the hourly limit (BDC_1144) waits for the next hour; too many concurrent calls (BDC_1322) waits a moment and goes on', async () => {
    const hourly = make(routes({ bills1: { status: 429, json: DOC.errors.hourly } }))
    // Phases before bills succeed; bills hits the limit: 12:20 → wait until 13:00, plus a minute.
    let cursor: string | null = null
    let err: unknown
    for (let i = 0; i < 5 && !err; i++) {
      try {
        cursor = (await hourly.connector.sync(hourly.conn, cursor)).cursor
      } catch (e) {
        err = e
      }
    }
    expect(err).toMatchObject({ kind: 'rate_limited', retryAfterMs: 41 * 60_000 })
    const busy = make(routes({ bills1: [{ status: 429, json: DOC.errors.concurrent }, { json: DOC.billsPage1 }] }))
    const { events } = await runSync(busy.connector, busy.conn, null)
    expect(ids(events, 'invoice.upsert')).toContain('00n01DOC1')
    expect(busy.clock.sleeps).toContain(2_000)
  })
})
