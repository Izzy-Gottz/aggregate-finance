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
