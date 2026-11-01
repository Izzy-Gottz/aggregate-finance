// Contract tests from Deel's public API docs (developer.deel.com, read 2026-10-11): every endpoint we call, as the
// docs say it answers, including pagination, rate limits, bad or expired tokens and pages that fail halfway. These
// stand in for a live account until a customer's token arrives, so the first real sync isn't the first test.
import type { ConnectionRef, PayrollRun } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, type FixtureResponse, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDeelConnector } from './connector.ts'

const DOC = JSON.parse(readFileSync(new URL('../fixtures/redacted/docs-2026.json', import.meta.url), 'utf8')) as {
  receiptsPage1: unknown
  receiptsPage2: unknown
  breakdown: Record<string, unknown[]>
  errors: Record<'unauthorized' | 'rateLimited' | 'server', unknown>
}
const NOW = Date.parse('2026-10-09T12:00:00Z')

/** Receipts answer by cursor: no cursor = page 1, the documented next_cursor = page 2. */
function receipts(over: Partial<Record<'page1' | 'page2', FixtureResponse | FixtureResponse[]>> = {}): FixtureRoute[] {
  return [
    { match: (u) => u.pathname.endsWith('/payments') && u.searchParams.get('cursor') === 'CURSOR_PAGE_2', respond: over.page2 ?? { json: DOC.receiptsPage2 } },
    { match: (u) => u.pathname.endsWith('/payments') && !u.searchParams.has('cursor'), respond: over.page1 ?? { json: DOC.receiptsPage1 } },
    { match: /\/payments\/[^/]+\/breakdown$/, respond: (url) => ({ json: { data: DOC.breakdown[url.pathname.split('/').at(-2) as string] ?? [] } }) },
  ]
}

function make(routes: FixtureRoute[]) {
  const ff = fixtureFetch(routes)
  const clock = fakeClock(NOW)
  // One window covering the fixtures: the plan isn't what's under test here.
  const connector = createDeelConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock, random: () => 0.5 }, plan: { backfillDays: 30, windowDays: 90 } })
  const conn: ConnectionRef = { id: 'conn_deel', workspaceId: 'ws_1', connectorKey: 'deel', secret: { token: 'tok-test' }, config: { environment: 'sandbox' } }
  return { connector, conn, ff, clock }
}

describe('Deel API contract (docs-shaped)', () => {
  it('fixtures are redacted', () => assertRedacted(DOC))

  it('follows next_cursor while has_more is "true" (a string, as in the docs), and only paid receipts become runs', async () => {
    const { connector, conn, ff } = make(receipts())
    const { events } = await runSync(connector, conn, null)
    const runs = events as PayrollRun[]
    expect(runs.map((r) => r.externalId).sort()).toEqual(['rcpt_A1', 'rcpt_A3'])
    const a1 = runs.find((r) => r.externalId === 'rcpt_A1')!
    expect([a1.payDate, a1.gross.minor, a1.companyDebit?.minor, a1.employeeCount]).toEqual(['2026-09-29', 500_000, 515_000, 1])
    const a3 = runs.find((r) => r.externalId === 'rcpt_A3')!
    expect([a3.gross.currency, a3.gross.minor, a3.companyDebit?.minor]).toEqual(['EUR', 196_000, 204_000])
    // Every receipts call is authenticated, and date_to is the day after the window (it is exclusive).
    const calls = ff.calls.filter((c) => /\/payments(\?|$)/.test(c.url))
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok-test')).toBe(true)
    const first = new URL(calls[0]!.url)
    expect(first.searchParams.get('date_to')! > first.searchParams.get('date_from')!).toBe(true)
    expect(calls.some((c) => new URL(c.url).searchParams.get('cursor') === 'CURSOR_PAGE_2')).toBe(true)
  })

  it('a 429 (Deel sends no Retry-After) waits out the 1-second window and goes on; a Retry-After, if sent, wins', async () => {
    const { connector, conn, clock } = make(receipts({ page1: [{ status: 429, json: DOC.errors.rateLimited }, { json: DOC.receiptsPage1 }] }))
    const { events } = await runSync(connector, conn, null)
    expect(events.length).toBe(2)
    expect(clock.sleeps).toContain(1_500)
    const withHeader = make(receipts({ page1: [{ status: 429, json: DOC.errors.rateLimited, headers: { 'retry-after': '4' } }, { json: DOC.receiptsPage1 }] }))
    await runSync(withHeader.connector, withHeader.conn, null)
    expect(withHeader.clock.sleeps).toContain(4_000)
  })

  it('an expired or revoked token (401) means reconnect; a token without accounting:read (403) says which scope', async () => {
    const expired = make([{ match: '/payments', respond: { status: 401, json: DOC.errors.unauthorized } }])
    await expect(expired.connector.sync(expired.conn, null)).rejects.toMatchObject({ kind: 'auth' })
    expect(await expired.connector.health(expired.conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/Invalid or expired token/) })
    await expect(expired.connector.connect({ token: 'tok-old' })).rejects.toMatchObject({ kind: 'auth' })
    const scope = make([{ match: '/payments', respond: { status: 403, json: { errors: [{ message: 'Token lacks required scopes', path: '' }] } } }])
    expect(await scope.connector.health(scope.conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/accounting:read/) })
  })

  it('the token is checked with what sync needs (accounting:read), not /contracts', async () => {
    const { connector, ff } = make([...receipts(), { match: '/contracts', respond: { status: 403, json: { errors: [{ message: 'needs contracts:read' }] } } }])
    expect(await connector.connect({ token: 'tok-1', environment: 'sandbox' })).toMatchObject({ secret: { token: 'tok-1' } })
    expect(ff.calls.some((c) => c.url.includes('/contracts'))).toBe(false)
  })

  it('a page that fails halfway resumes from its cursor: nothing is lost or counted twice', async () => {
    // Page 2 fails with a 500 every time this run; the run keeps page 1 and its cursor.
    const broken = make(receipts({ page2: { status: 500, json: DOC.errors.server } }))
    const first = await broken.connector.sync(broken.conn, null)
    expect((first.events as PayrollRun[]).map((r) => r.externalId)).toEqual(['rcpt_A1'])
    expect(first.hasMore).toBe(true)
    await expect(broken.connector.sync(broken.conn, first.cursor)).rejects.toMatchObject({ kind: 'transient' })
    // Next run, Deel is back: the same cursor picks up page 2 only.
    const healed = make(receipts())
    const second = await healed.connector.sync(healed.conn, first.cursor)
    expect((second.events as PayrollRun[]).map((r) => r.externalId)).toEqual(['rcpt_A3'])
  })
})
