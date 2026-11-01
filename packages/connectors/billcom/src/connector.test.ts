import type { ConnectionRef, CreditNoteUpsert, InvoiceUpsert, NormalizedEvent, PaymentApplied } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { docKey, Subledger } from '@agfn/invoices'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyBillError, createBillConnector, type BillSecret } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/sandbox.json', import.meta.url), 'utf8')) as Record<string, unknown[]>
const NOW = Date.parse('2026-10-09T12:00:00Z')
const PATHS: Record<string, string> = {
  customers: '/v3/customers',
  vendors: '/v3/vendors',
  bills: '/v3/bills',
  vendorCredits: '/v3/vendor-credits',
  payments: '/v3/payments',
  invoices: '/v3/invoices',
  receivablePayments: '/v3/receivable-payments',
}

/** Page tokens encode "<key>:<offset>" so pagination follows the request, not call order. */
function list(key: string, size: number): FixtureRoute {
  return {
    method: 'GET',
    match: (url) => url.pathname.endsWith(PATHS[key] as string),
    respond: (url) => {
      const token = url.searchParams.get('page')
      const offset = token ? Number(token.split(':')[1]) : 0
      const all = FIX[key] ?? []
      const results = all.slice(offset, offset + size)
      return { json: { results, ...(offset + size < all.length ? { nextPage: `${key}:${offset + size}` } : {}) } }
    },
  }
}

function make(extra: FixtureRoute[] = []) {
  let logins = 0
  const ff = fixtureFetch([
    ...extra,
    { method: 'POST', match: '/v3/login', respond: () => ({ json: { sessionId: `sess-${++logins}`, organizationId: '00801TEST', organizationName: 'Example Org' } }) },
    ...Object.keys(PATHS).map((k) => list(k, 2)),
  ])
  const connector = createBillConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5 } })
  const secret: BillSecret = { devKey: 'dev-test', username: 'user@example.com', password: 'pw-test', organizationId: '00801TEST' }
  const conn: ConnectionRef = { id: 'conn_bill', workspaceId: 'ws_1', connectorKey: 'billcom', secret, config: { environment: 'sandbox', currency: 'USD' } }
  return { connector, conn, ff, logins: () => logins }
}

const find = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], type: T, id: string) =>
  events.find((e) => e.type === type && e.externalId === id) as Extract<NormalizedEvent, { type: T }> | undefined

describe('bill.com connector', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 10 })
  })

  it('maps bills, payments across bills, vendor credits, AR (golden)', async () => {
    const { connector, conn, ff, logins } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    expect(logins()).toBe(1) // one session reused for every page
    expect(ff.calls.filter((c) => !c.url.includes('/login')).every((c) => c.headers.devkey === 'dev-test' && c.headers.sessionid === 'sess-1')).toBe(true)

    expect(find(events, 'invoice.upsert', '00n01BBB')).toMatchObject({
      direction: 'payable',
      number: 'L-2026-09',
      counterparty: 'Example Legal LLP',
      total: { minor: 300_000, currency: 'USD' },
      amountPaid: { minor: 100_000, currency: 'USD' },
      amountCredited: { minor: 20_000, currency: 'USD' },
      status: 'partially_paid',
    })
    expect(find(events, 'invoice.upsert', '00n01CCC')?.status).toBe('open') // scheduled is not paid
    expect(find(events, 'invoice.upsert', '00n01DDD')?.status).toBe('void') // archived
    expect(find(events, 'payment.applied', 'stp01AAA')).toMatchObject({
      counterparty: 'Example Printing',
      reference: 'BILL-CONF-1',
      applications: [
        { invoiceExternalId: '00n01AAA', amount: { minor: 125_000, currency: 'USD' } },
        { invoiceExternalId: '00n01BBB', amount: { minor: 100_000, currency: 'USD' } },
      ],
    })
    expect(find(events, 'payment.applied', 'stp01BBB')).toBeUndefined()
    expect(find(events, 'payment.applied', 'stp01CCC')).toMatchObject({ status: 'void', applications: [], unapplied: { minor: 9_900, currency: 'USD' } })
    expect(find(events, 'credit_note.upsert', 'vcr01AAA')).toMatchObject({ appliedTo: 'invoice', status: 'applied', counterparty: 'Example Legal LLP' })
    expect(find(events, 'invoice.upsert', '00e01AAA')).toMatchObject({ direction: 'receivable', counterparty: 'Example Clinic', amountPaid: { minor: 300_000, currency: 'USD' } })
    expect(find(events, 'payment.applied', '0rp01AAA')).toMatchObject({ method: 'ach', unapplied: { minor: 20_000, currency: 'USD' } })

    const s = new Subledger()
    const issues = events
      .filter((e): e is InvoiceUpsert | PaymentApplied | CreditNoteUpsert => e.type === 'invoice.upsert' || e.type === 'payment.applied' || e.type === 'credit_note.upsert')
      .flatMap((e) => s.apply(e).issues)
    expect(issues).toEqual([])
    for (const b of [...(FIX.bills as Array<Record<string, unknown>>), ...(FIX.invoices as Array<Record<string, unknown>>)]) {
      if (b.archived) continue
      expect(s.view(docKey(conn.id, String(b.id)), '2026-10-09')?.remaining.minor, String(b.id)).toBe(Math.round(Number(b.dueAmount) * 100))
    }
  })

  it('incremental filters by updatedTime, and page tokens are sent without filters', async () => {
    const { connector, conn, ff } = make()
    const first = await runSync(connector, conn, null)
    ff.calls.length = 0
    await runSync(connector, conn, first.cursor)
    const lists = ff.calls.filter((c) => !c.url.includes('/login')).map((c) => new URL(c.url).searchParams)
    expect(lists.filter((q) => !q.has('page')).every((q) => q.get('filters') === 'updatedTime:gte:"2026-10-09T11:55:00.000Z"')).toBe(true)
    expect(lists.filter((q) => q.has('page')).every((q) => !q.has('filters') && !q.has('sort'))).toBe(true)
  })

  it('logs in again once when the session ends; bad logins need reauth', async () => {
    let bills = 0
    const { connector, conn, logins } = make([
      {
        method: 'GET',
        match: '/v3/customers',
        respond: () => (++bills === 1 ? { status: 401, json: [{ code: 'BDC_1109', message: 'Session is invalid' }] } : { json: { results: [] } }),
      },
    ])
    await connector.sync(conn, null)
    expect(logins()).toBe(2)

    // BDC_1102 is an invalid developer key (BILL docs): the person has to connect again.
    const bad = make([{ method: 'POST', match: '/v3/login', respond: { status: 400, json: [{ code: 'BDC_1102', message: 'Invalid developer key' }] } }])
    expect(await bad.connector.health(bad.conn)).toMatchObject({ status: 'needs_reauth' })
    await expect(bad.connector.connect({ devKey: 'd' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('a rejected sign-in says what to do in words written for people, sync tokens included', () => {
    const e = classifyBillError({ status: 400, body: [{ code: 'BDC_1101', message: 'Sign in failed (provider text)' }] })
    expect(e).toMatchObject({ kind: 'auth', forUser: true })
    expect(e?.message).toContain('sync token')
    expect(e?.message).not.toContain('provider text')
  })

  it('with the partner key, a sync token connects: the partner key signs in and is never stored with the connection', async () => {
    const ff = fixtureFetch([
      { method: 'POST', match: '/v3/login', respond: () => ({ json: { sessionId: 'sess-p', organizationId: '00801TEST', organizationName: 'Example Org' } }) },
      ...Object.keys(PATHS).map((k) => list(k, 50)),
    ])
    const connector = createBillConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW) }, partnerDevKeys: { sandbox: 'partner-sandbox' } })
    const out = await connector.connect({ username: 'aggregate-sync', password: 'sync-token-test', organizationId: '00801TEST', environment: 'sandbox' })
    expect(out.secret).toEqual({ username: 'aggregate-sync', password: 'sync-token-test', organizationId: '00801TEST' })
    expect(ff.calls[0]?.body).toEqual({ devKey: 'partner-sandbox', username: 'aggregate-sync', password: 'sync-token-test', organizationId: '00801TEST' })
    const conn: ConnectionRef = { id: 'conn_p', workspaceId: 'ws_1', connectorKey: 'billcom', secret: out.secret, config: out.config }
    await connector.sync(conn, null)
    const reads = ff.calls.filter((c) => c.method === 'GET')
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((c) => c.headers.devkey === 'partner-sandbox')).toBe(true)
    // No partner key for production: a sync token can't sign in there.
    await expect(connector.connect({ username: 'aggregate-sync', password: 'x', organizationId: '00801TEST', environment: 'production' })).rejects.toMatchObject({ kind: 'invalid_input' })
    // A company's own key still wins when given.
    await connector.connect({ devKey: 'own-key', username: 'user@example.com', password: 'pw', organizationId: '00801TEST', environment: 'sandbox' })
    expect(ff.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v3/login')).at(-1)?.body).toMatchObject({ devKey: 'own-key' })
  })

  it('hourly limit is surfaced as rate_limited, not slept on', async () => {
    const { connector, conn } = make([{ method: 'GET', match: '/v3/customers', respond: { status: 400, json: [{ code: 'BDC_1144', message: 'Max requests per hour exceeded' }] } }])
    // The hourly limit resets at the top of the hour (NOW is 12:00:00): wait the hour, plus a minute.
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 3_660_000 })
  })
})
