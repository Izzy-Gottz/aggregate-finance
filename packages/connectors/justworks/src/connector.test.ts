import type { ConnectionRef, PayrollRun } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createJustworksConnector, withExpiry, type JustworksSecret } from './connector.ts'

const FIX = JSON.parse(readFileSync(new URL('../fixtures/redacted/partner-docs.json', import.meta.url), 'utf8')) as {
  payrolls: Array<Record<string, unknown>>
  paystubs: Record<string, unknown[]>
  members: unknown[]
  company: unknown
  errors: Record<'forbidden' | 'unauthorized' | 'rateLimited', unknown>
}
const NOW = Date.parse('2026-10-09T12:00:00Z')

function make(extra: FixtureRoute[] = [], tokens: Partial<JustworksSecret['tokens']> = {}, saved: unknown[] = []) {
  const ff = fixtureFetch([
    ...extra,
    {
      match: (u) => u.pathname === '/v1/payrolls',
      respond: (url) => {
        const from = url.searchParams.get('start_date') as string
        const to = url.searchParams.get('end_date') as string
        // end_date is sent as the day after the window; treat it as exclusive here (if it is inclusive, the overlap is deduplicated).
        const inWindow = FIX.payrolls.filter((p) => (p.pay_date as string) >= from && (p.pay_date as string) < to)
        // Page size 2 inside a window, to exercise next_cursor.
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        const data = inWindow.slice(offset, offset + 2)
        return { json: { items: data, ...(offset + 2 < inWindow.length ? { next_cursor: String(offset + 2) } : {}) } }
      },
    },
    { match: /\/v1\/payrolls\/[^/]+\/paystubs/, respond: (url) => ({ json: { items: FIX.paystubs[url.pathname.split('/')[3] as string] ?? [] } }) },
    { match: '/v1/members', respond: { json: { items: FIX.members } } },
    { match: '/v1/company', respond: { json: FIX.company } },
  ])
  const connector = createJustworksConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id: string, s: unknown) => void saved.push(s) },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test', redirectUri: 'https://app.example.com/oauth/justworks' },
    plan: { backfillDays: 120 },
  })
  const secret: JustworksSecret = { tokens: { accessToken: 'at-test', refreshToken: 'rt-test', expiresAt: NOW + 3_600_000, ...tokens } }
  const conn: ConnectionRef = { id: 'conn_jw', workspaceId: 'ws_1', connectorKey: 'justworks', secret, config: {} }
  return { connector, conn, ff }
}
const tokenRoute: FixtureRoute = { method: 'POST', match: '/oauth/token', respond: { json: { access_token: 'at-new', refresh_token: 'rt-new', expires_at: Math.floor(NOW / 1000) + 86_400, token_type: 'Bearer' } } }

describe('justworks connector (partner API, doc-shaped fixtures)', () => {
  it('fixtures are redacted', () => assertRedacted(FIX))

  it('passes the connector contract', async () => {
    await runConnectorContract({ make: () => make(), minEvents: 3 })
  })

  it('maps company totals and paystub lines (golden)', async () => {
    const { connector, conn } = make()
    const { events } = await runSync(connector, conn, null)
    assertValidEvents(events, { connectionId: conn.id })
    const runs = Object.fromEntries((events as PayrollRun[]).map((r) => [r.externalId, r]))
    expect(runs.pr_01).toMatchObject({
      payDate: '2026-09-15',
      gross: { minor: 1_500_000, currency: 'USD' },
      net: { minor: 1_110_000, currency: 'USD' },
      employerTaxes: { minor: 118_500, currency: 'USD' },
      employeeTaxes: { minor: 315_000, currency: 'USD' },
      companyDebit: { minor: 1_890_000, currency: 'USD' },
      periodStart: '2026-09-01',
      periodEnd: '2026-09-15',
      employeeCount: 2,
      provider: 'Justworks',
      status: 'paid',
      lines: [
        { person: 'Ada Example', gross: { minor: 900_000, currency: 'USD' }, kind: 'employee' },
        { person: 'Ben Sample', gross: { minor: 600_000, currency: 'USD' } },
      ],
    })
    expect(runs.pr_03?.status).toBe('scheduled')
  })

  it('refreshes using expires_at, and once more on a 401', async () => {
    expect(withExpiry({ accessToken: 'x', extra: { expires_at: 1_790_000_000 } }).expiresAt).toBe(1_790_000_000_000)
    expect(withExpiry({ accessToken: 'x', extra: { expires_at: '2026-10-10T12:00:00Z' } }).expiresAt).toBe(Date.parse('2026-10-10T12:00:00Z'))

    const saved: unknown[] = []
    // The rotated token is saved before the first page, so a page that fails can't lose it.
    const expired = make([tokenRoute, { match: (u) => u.pathname === '/v1/payrolls', respond: { status: 500, json: {} } }], { expiresAt: undefined, extra: { expires_at: Math.floor(NOW / 1000) - 10 } }, saved)
    await expect(expired.connector.sync(expired.conn, null)).rejects.toMatchObject({ kind: 'transient' })
    expect(saved).toEqual([{ tokens: expect.objectContaining({ accessToken: 'at-new', refreshToken: 'rt-new' }) }])
    const fresh = make([tokenRoute], { expiresAt: undefined, extra: { expires_at: Math.floor(NOW / 1000) - 10 } })
    const r = await fresh.connector.sync(fresh.conn, null)
    expect((r as { updatedSecret?: JustworksSecret }).updatedSecret?.tokens).toMatchObject({ accessToken: 'at-new', expiresAt: NOW + 86_400_000 })

    let n = 0
    const revokedOnce = make([tokenRoute, { match: (u) => u.pathname === '/v1/payrolls', respond: () => (++n === 1 ? { status: 401, json: FIX.errors.unauthorized } : { json: { items: [] } }) }])
    const r2 = await revokedOnce.connector.sync(revokedOnce.conn, null)
    expect((r2 as { updatedSecret?: JustworksSecret }).updatedSecret?.tokens.accessToken).toBe('at-new')
  })

  it('syncs totals without paystub scope', async () => {
    const { connector, conn } = make([{ match: /\/paystubs/, respond: { status: 403, json: FIX.errors.forbidden } }])
    const { events } = await runSync(connector, conn, null)
    expect(events).toHaveLength(3)
    expect((events as PayrollRun[]).every((r) => !r.lines)).toBe(true)
  })

  it('asks for the documented scopes (company.basic:read, member.basic:read; no made-up *.profile:read)', () => {
    const scope = new URL(make().connector.authorizationUrl('st')).searchParams.get('scope')!.split(' ')
    expect(scope.sort()).toEqual(['company.basic:read', 'member.basic:read', 'payroll:read', 'paystub:read'])
  })

  it('connects with the company display name, from the flat /v1/company body', async () => {
    const { connector } = make([tokenRoute])
    expect(await connector.connect({ code: 'code-1' })).toMatchObject({ config: { companyName: 'Example Co', companyId: 'co_9' } })
  })

  it('reads list rows from items, and asks for one day past each window (inclusivity is undocumented)', async () => {
    const { connector, conn, ff } = make()
    const { events } = await runSync(connector, conn, null)
    expect(new Set(events.map((e) => e.externalId))).toEqual(new Set(['pr_01', 'pr_02', 'pr_03']))
    for (const c of ff.calls.filter((c) => new URL(c.url).pathname === '/v1/payrolls')) {
      const u = new URL(c.url)
      expect(Date.parse(u.searchParams.get('end_date')!)).toBeGreaterThan(Date.parse(u.searchParams.get('start_date')!))
    }
  })

  it('keeps the reason from { code, error, reason }; a missing scope says to reconnect and approve every permission', async () => {
    const { connector, conn } = make([{ match: '/v1/company', respond: { status: 403, json: FIX.errors.forbidden } }])
    expect(await connector.health(conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/company\.basic:read.*Connect again/s) })
    const expired = make([{ match: '/v1/company', respond: { status: 401, json: FIX.errors.unauthorized } }], { refreshToken: undefined })
    expect(await expired.connector.health(expired.conn)).toMatchObject({ status: 'needs_reauth', message: expect.stringMatching(/Access token has expired/) })
  })

  it('a member without full_preferred_name falls back to given and family name', async () => {
    const { connector, conn } = make([{ match: /\/paystubs/, respond: { json: { items: [{ member_id: 'mem_c', gross_pay: 100, net_pay: 80, pay_period_start: '2026-09-01', pay_period_end: '2026-09-15' }] } } }])
    const { events } = await runSync(connector, conn, null)
    expect((events as PayrollRun[]).find((r) => r.externalId === 'pr_01')?.lines?.[0]?.person).toBe('Cy Test')
  })

  it('health never refreshes: an expired access token is fine until the next sync', async () => {
    const { connector, conn, ff } = make([tokenRoute], { expiresAt: NOW - 1 })
    expect(await connector.health(conn)).toMatchObject({ status: 'ok', message: expect.stringMatching(/next sync/) })
    expect(ff.calls).toHaveLength(0)
  })

  it('disconnect revokes both tokens at Justworks, form-encoded with a type hint', async () => {
    const { connector, conn, ff } = make([{ method: 'POST', match: '/v1/oauth/revoke', respond: { json: {} } }])
    await expect(connector.disconnect!(conn)).resolves.toBeUndefined()
    const revokes = ff.calls.filter((c) => c.url.endsWith('/v1/oauth/revoke'))
    expect(revokes.map((c) => c.headers['content-type'])).toEqual(['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'])
    expect(revokes[0]?.body).toEqual({ client_id: 'client-test', client_secret: 'secret-test', token: 'rt-test', token_type_hint: 'refresh_token' })
    expect(revokes[1]?.body).toMatchObject({ token: 'at-test', token_type_hint: 'access_token' })
  })

  it('a token Justworks no longer knows is already gone', async () => {
    for (const status of [401, 404]) {
      const { connector, conn } = make([{ method: 'POST', match: '/v1/oauth/revoke', respond: { status, json: {} } }])
      await expect(connector.disconnect!(conn)).resolves.toBeUndefined()
    }
  })

  it('a refused revoke tells the person what to finish at Justworks', async () => {
    const { connector, conn } = make([{ method: 'POST', match: '/v1/oauth/revoke', respond: { status: 500, json: {} } }])
    await expect(connector.disconnect!(conn)).resolves.toEqual({ notRevoked: expect.stringContaining('Justworks') })
  })
})


describe('justworks: an unreadable 2xx stops the sync, never a silent $0', () => {
  it('an empty body (e.g. a followed redirect to a sign-in or error page) fails visibly', async () => {
    const { connector, conn } = make([{ match: (u) => u.pathname === '/v1/payrolls', respond: { text: '' } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
  it('a 200 whose body isn’t the expected object fails visibly', async () => {
    const { connector, conn } = make([{ match: (u) => u.pathname === '/v1/payrolls', respond: { json: 5 } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow()
  })
})


describe('justworks pagination completeness: a partial list is never summed as complete', () => {
  it('a paystub list that never stops paging fails visibly instead of summing a partial payroll', async () => {
    const { connector, conn } = make([{ match: /\/v1\/payrolls\/[^/]+\/paystubs/, respond: { json: { items: [], next_cursor: 'c' } } }])
    await expect(runSync(connector, conn, null)).rejects.toThrow(/page through/)
  })
})
