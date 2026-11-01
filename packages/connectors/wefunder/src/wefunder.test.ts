import { readFileSync } from 'node:fs'
import type { ConnectionRef, InvestmentEvent, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AUTHORIZE, createWefunderConnector, verifierFor, type WefunderSecret } from './connector.ts'
import { companyUrl, mapPosition, percent, securityType } from './map.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/wefunder.json', import.meta.url), 'utf8')) as {
  pages: Record<string, unknown>
  token: unknown
  refreshed: unknown
  errors: { unauthorized: unknown; invalid_grant: unknown }
}
const NOW = Date.parse('2026-10-13T12:00:00Z')
const routes: FixtureRoute[] = [
  { match: (u) => u.pathname === '/portfolio/positions', respond: (u) => ({ json: fx.pages[u.searchParams.get('per_page') === '1' ? '' : (u.searchParams.get('cursor') ?? '')] ?? { data: [], meta: { has_more: false } } }) },
  { match: (u) => u.pathname === '/oauth/token', respond: (_u, body) => ({ json: (body as Record<string, string>).grant_type === 'refresh_token' ? fx.refreshed : fx.token }) },
]
function make(o: { tokens?: Partial<WefunderSecret['tokens']>; saved?: unknown[]; extra?: FixtureRoute[]; clientId?: string } = {}) {
  const ff = fixtureFetch([...(o.extra ?? []), ...routes])
  const connector = createWefunderConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id, s) => void o.saved?.push(s) },
    oauth: { clientId: o.clientId ?? 'pk_test_redacted', clientSecret: 'sk_test_redacted_secret', redirectUri: 'https://app.example.com/api/connectors/wefunder/callback' },
  })
  const conn: ConnectionRef = {
    id: 'conn_wf',
    workspaceId: 'ws',
    connectorKey: 'wefunder',
    secret: { tokens: { accessToken: 'at_test_1', refreshToken: 'rt_test_1', expiresAt: NOW + 3_600_000, ...o.tokens } } satisfies WefunderSecret,
    config: {},
  }
  return { connector, conn, ff }
}
const inv = (events: NormalizedEvent[]) => events.filter((e): e is InvestmentEvent => e.type === 'investment.event')
const at = (events: NormalizedEvent[], offering: string) => inv(events).filter((e) => e.positionId === `wefunder:${offering}`)

describe('wefunder contract', () => {
  it('passes the connector contract', async () => {
    const r = await runConnectorContract({ make: () => make(), minEvents: 9 })
    expect(r.pages).toBe(2)
  })
  it('fixture is redacted', () => assertRedacted(fx))
})

describe("wefunder: an investor's positions as investment events (hand-checked, to the cent)", () => {
  it('a SAFE bought in two tiers is two invests with their own cap and discount, marked at Wefunder’s value', async () => {
    const acme = at((await runSync(make().connector, make().conn, null)).events, 'ofr_safe1')
    expect(acme.map((e) => [e.kind, e.date, e.amount?.minor, e.series, e.valuationCap?.minor, e.discountPct, e.securityType])).toEqual([
      ['invest', '2025-03-01', 50_000, 'SAFE (early bird)', 800_000_000, 20, 'safe'],
      ['invest', '2025-04-15', 100_000, 'SAFE', 1_000_000_000, 20, 'safe'], // "0.2" read as 20%
      ['mark', '2026-10-12', 210_000, undefined, undefined, undefined, 'safe'],
    ])
    expect(acme[2]?.markSource).toBe('Wefunder current value as of 2026-10-12')
    expect(acme.every((e) => e.issuer === 'Acme Robotics')).toBe(true)
  })

  it('priced shares at cost (no mark when value = cost), an exit for cost + realized gain, a failure written off', async () => {
    const ev = (await runSync(make().connector, make().conn, null)).events
    expect(at(ev, 'ofr_pref1').map((e) => [e.kind, e.amount?.minor, e.shares, e.securityType])).toEqual([['invest', 215_000, 200, 'preferred_stock']])
    expect(at(ev, 'ofr_exit1').map((e) => [e.kind, e.date, e.amount?.minor])).toEqual([
      ['invest', '2023-02-10', 100_000],
      ['exit', '2026-10-12', 164_920], // 1,000.00 cost + 649.20 realized gain
    ])
    expect(at(ev, 'ofr_fail1').map((e) => [e.kind, e.date, e.amount?.minor, e.securityType])).toEqual([
      ['invest', '2022-06-01', 25_000, 'convertible_note'],
      ['write_off', '2026-10-12', undefined, 'convertible_note'],
    ])
    // No current value from Wefunder: stays at cost, no mark.
    expect(at(ev, 'ofr_rev1').map((e) => [e.kind, e.amount?.minor, e.securityType])).toEqual([['invest', 30_000, 'other']])
    // Totals: 5,700.00 invested across five positions.
    expect(inv(ev).filter((e) => e.kind === 'invest').reduce((t, e) => t + (e.amount?.minor ?? 0), 0)).toBe(520_000)
    const done = ev.filter((e) => e.type === 'listing.complete')
    expect(done).toEqual([expect.objectContaining({ kinds: ['investment'], scope: 'wefunder:' })])
  })

  it('re-syncing gives the same ids (nothing doubles)', async () => {
    const a = inv((await runSync(make().connector, make().conn, null)).events).map((e) => e.externalId)
    const b = inv((await runSync(make().connector, make().conn, null)).events).map((e) => e.externalId)
    expect(b).toEqual(a)
    expect(new Set(a).size).toBe(a.length)
  })
})

describe('wefunder OAuth', () => {
  it('test clients authorize at the sandbox host with PKCE S256 and only read:investments', () => {
    const { connector } = make()
    const u = new URL(connector.authorizationUrl('state-abc'))
    expect(`${u.origin}${u.pathname}`).toBe(AUTHORIZE.test)
    expect(u.searchParams.get('scope')).toBe('read:investments')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifierFor('sk_test_redacted_secret', 'state-abc')).digest('base64url'))
    expect(new URL(make({ clientId: 'pk_live_redacted' }).connector.authorizationUrl('s')).origin).toBe('https://wefunder.com')
  })

  it('the callback exchanges the code with the same verifier and the secret in the body', async () => {
    const { connector, ff } = make()
    const r = await connector.connect({ code: 'code-1', state: 'state-abc' })
    expect((r.secret as WefunderSecret).tokens.accessToken).toBe('at_test_redacted_access')
    const body = ff.calls.find((c) => c.url.endsWith('/oauth/token'))!.body as Record<string, string>
    expect(body.code_verifier).toBe(verifierFor('sk_test_redacted_secret', 'state-abc'))
    expect(body.client_secret).toBe('sk_test_redacted_secret')
    expect(body.grant_type).toBe('authorization_code')
    await expect(connector.connect({ code: 'code-1' })).rejects.toMatchObject({ kind: 'invalid_input' })
    // How the server calls it: the attempt's state as connectState, never the provider's `state` param.
    await connector.connect({ code: 'code-2', connectState: 'state-xyz', redirectUri: 'x' })
    const last = ff.calls.filter((c) => c.url.endsWith('/oauth/token')).at(-1)!.body as Record<string, string>
    expect(last.code_verifier).toBe(verifierFor('sk_test_redacted_secret', 'state-xyz'))
  })

  it('an expired token refreshes first and the rotated pair is saved before any read', async () => {
    const saved: unknown[] = []
    const { connector, conn, ff } = make({ tokens: { expiresAt: NOW - 1 }, saved })
    const res = await connector.sync(conn, null)
    expect((saved[0] as WefunderSecret).tokens.refreshToken).toBe('rt_test_redacted_refresh2')
    expect((res.updatedSecret as WefunderSecret).tokens.accessToken).toBe('at_test_redacted_access2')
    expect(ff.calls[0]!.url).toContain('/oauth/token')
  })

  it('revoked on wefunder.com: a 401 read, then a refused refresh token, fails as code "revoked" (the server erases)', async () => {
    const { connector, conn, ff } = make({
      extra: [
        { match: (u) => u.pathname === '/portfolio/positions', respond: { status: 401, json: fx.errors.unauthorized } },
        { match: (u) => u.pathname === '/oauth/token', respond: { status: 400, json: fx.errors.invalid_grant } },
      ],
    })
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ kind: 'auth', code: 'revoked', forUser: true })
    expect(ff.calls.filter((c) => c.url.includes('/oauth/token'))).toHaveLength(1)
  })

  it('an expired refresh token refused up front is a revoke too', async () => {
    const { connector, conn } = make({ tokens: { expiresAt: NOW - 1 }, extra: [{ match: (u) => u.pathname === '/oauth/token', respond: { status: 400, json: fx.errors.invalid_grant } }] })
    await expect(connector.sync(conn, null)).rejects.toMatchObject({ code: 'revoked' })
  })

  it('a 401 that a refresh fixes is not a revoke: the new pair is saved and the read goes through', async () => {
    const saved: unknown[] = []
    const { connector, conn } = make({ saved, extra: [{ match: (u) => u.pathname === '/portfolio/positions' && u.searchParams.get('per_page') !== '1', respond: [{ status: 401, json: fx.errors.unauthorized }, { json: fx.pages[''] }] }] })
    const res = await connector.sync(conn, null)
    expect((saved[0] as WefunderSecret).tokens.accessToken).toBe('at_test_redacted_access2')
    expect(res.events.length).toBeGreaterThan(0)
  })

  it('a revoked token reads as needs-reauth; disconnect says how to remove access on wefunder.com', async () => {
    const { connector, conn } = make({ extra: [{ match: (u) => u.pathname === '/portfolio/positions', respond: { status: 401, json: fx.errors.unauthorized } }] })
    expect((await connector.health(conn)).status).toBe('needs_reauth')
    await expect(connector.disconnect!(conn)).rejects.toMatchObject({ forUser: true, message: expect.stringMatching(/deleted from Aggregate/) })
  })
})

describe('wefunder mapping helpers', () => {
  it('security types and discounts', () => {
    expect(['safe', 'crowd_safe', 'convertible_note', 'preferred_equity', 'common_equity', 'revenue_share', 'debt'].map(securityType)).toEqual(['safe', 'safe', 'convertible_note', 'preferred_stock', 'common_stock', 'other', 'other'])
    expect([percent('20'), percent('0.2'), percent('0'), percent('x')]).toEqual([20, 20, undefined, undefined])
  })

  it("each position links to the company's Wefunder page: company.url when it's on wefunder.com, else the slug", () => {
    expect(companyUrl({ url: 'https://wefunder.com/acmerobotics', slug: 'acme-robotics' })).toBe('https://wefunder.com/acmerobotics')
    expect(companyUrl({ url: 'https://www.wefunder.com/acme' })).toBe('https://wefunder.com/acme')
    expect(companyUrl({ url: 'https://evil.example/wefunder.com', slug: 'acme-robotics' })).toBe('https://wefunder.com/acme-robotics')
    expect(companyUrl({ url: 'http://wefunder.com/acme', slug: 'acme' })).toBe('https://wefunder.com/acme')
    expect(companyUrl({ slug: '../portfolio' })).toBeUndefined()
    expect(companyUrl({})).toBeUndefined()
  })

  it('both shapes of the API: exited_on and failed_on when sent (else as_of); SAFE terms null or "0.0", uncapped', () => {
    const pos = (a: Record<string, unknown>) => mapPosition({ offering_id: 'o1', company: { name: 'Acme', slug: 'acme' }, currency: 'USD', security: { type: 'safe' }, cost_basis_cents: 50_000, invested_at: '2025-01-10', as_of: '2026-10-13', ...a }, 'conn')
    const exit = pos({ status: 'exited', exited_on: '2026-06-01', realized_gain_cents: 25_000 }).find((e) => e.kind === 'exit')
    expect(exit).toMatchObject({ date: '2026-06-01', amount: { minor: 75_000, currency: 'USD' }, sourceUrl: 'https://wefunder.com/acme' })
    expect(pos({ status: 'exited', exited_on: null }).find((e) => e.kind === 'exit')?.date).toBe('2026-10-13')
    expect(pos({ status: 'failed', exit_reason: 'failed', exited_on: '2026-02-03' }).find((e) => e.kind === 'write_off')?.date).toBe('2026-02-03')
    expect(pos({ status: 'failed', exited_on: null }).find((e) => e.kind === 'write_off')?.date).toBe('2026-10-13')
    const terms = (t: Record<string, unknown>) => pos({ securities: [{ security: { type: 'safe' }, cost_basis_cents: 50_000, invested_at: '2025-01-10', terms: t }] })[0]
    expect(terms({ note_discount: '0.0', note_cap_cents: null })).not.toHaveProperty('valuationCap')
    expect(terms({ note_discount: '0.0', note_cap_cents: null })).not.toHaveProperty('discountPct')
    expect(terms({ note_discount: null, note_cap_cents: null, uncapped: true })).not.toHaveProperty('valuationCap')
    expect(terms({ note_discount: '0.2', note_cap_cents: 800_000_000, uncapped: false })).toMatchObject({ discountPct: 20, valuationCap: { minor: 800_000_000 } })
    // Value equal to cost (Wefunder's value before a priced event) is no mark.
    expect(pos({ status: 'active', current_value_cents: 50_000 }).map((e) => e.kind)).toEqual(['invest'])
  })
})
