import type { ConnectionRef, InvestmentEvent, ListingComplete, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { describe, expect, it } from 'vitest'
import { path, ROUTES } from './carta.fixture.ts'
import { createCartaConnector, type CartaSecret } from './connector.ts'
import { percent } from './map.ts'

const NOW = Date.parse('2026-10-12T12:00:00Z')
function make(opts: { tokens?: Partial<CartaSecret['tokens']>; saved?: unknown[]; extra?: FixtureRoute[]; portfolioId?: string } = {}) {
  const ff = fixtureFetch([...(opts.extra ?? []), ...ROUTES])
  const connector = createCartaConnector({
    deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(NOW), random: () => 0.5, saveSecret: async (_id, s) => void opts.saved?.push(s) },
    oauth: { clientId: 'client-test', clientSecret: 'secret-test', redirectUri: 'https://app.example.com/api/connectors/carta/callback' },
  })
  const conn: ConnectionRef = {
    id: 'conn_carta',
    workspaceId: 'ws',
    connectorKey: 'carta',
    secret: { tokens: { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: NOW + 3_600_000, ...opts.tokens } } satisfies CartaSecret,
    config: { portfolioId: opts.portfolioId ?? '501' },
  }
  return { connector, conn, ff }
}

async function syncAll(o = make()): Promise<NormalizedEvent[]> {
  return (await runSync(o.connector, o.conn, null)).events
}
const inv = (events: NormalizedEvent[]) => events.filter((e): e is InvestmentEvent => e.type === 'investment.event')
const at = (events: NormalizedEvent[], positionId: string) => inv(events).filter((e) => e.positionId === positionId)

describe("carta: a holder's private stakes as investment events", () => {
  it('one position per company: reissues keep their cost, an exercise is booked at its strike, and only held shares count', async () => {
    const lumen = at(await syncAll(), 'carta:501:11').filter((e) => e.kind === 'invest')
    expect(lumen.map((e) => [e.externalId, e.amount?.minor, e.shares])).toEqual([
      // Founder certificate, canceled by the split: its cost stays, its shares moved to the reissued one.
      ['carta:501:11:cert:101', 3000000, undefined],
      // The 119,998 still held, reissued at pps 0 on the split day: no new cost.
      ['carta:501:11:cert:102', 0, 119998],
      // (The 2-share piece reissued and sold the same day added nothing: not an invest.)
      // The exercise: its certificate says $3.00 a share, the holder paid the $0.15 strike.
      ['carta:501:11:cert:104', 45000, 3000],
      ['carta:501:11:rsa:105', 10000, 10000],
    ])
    expect(new Set(lumen.map((e) => e.securityType))).toEqual(new Set(['common_stock']))
  })

  it('a sale at a price is money back; zero-price "sales" (reissues, exchanges) are not', async () => {
    const ev = await syncAll()
    expect(at(ev, 'carta:501:11').filter((e) => e.kind === 'distribution' || e.kind === 'exit').map((e) => [e.kind, e.date, e.amount?.minor])).toEqual([['distribution', '2021-07-15', 3000]])
    // Northpeak: Series B exchanged into Series A (cost kept), then sold in two pieces; the last one is the exit.
    const northpeak = at(ev, 'carta:501:12')
    expect(northpeak.filter((e) => e.kind === 'invest').map((e) => [e.externalId, e.amount?.minor, e.shares])).toEqual([['carta:501:12:cert:301', 6000000, undefined]])
    expect(northpeak.filter((e) => e.kind !== 'invest').map((e) => [e.kind, e.date, e.amount?.minor])).toEqual([
      ['distribution', '2026-03-10', 8500000],
      ['exit', '2026-08-25', 12500000],
    ])
  })

  it('the 409A marks a company held only in common stock; never preferred, never without a price', async () => {
    const marks = inv(await syncAll()).filter((e) => e.kind === 'mark')
    // Lumen held: 119,998 + 3,000 + 10,000 common × $18.40.
    expect(marks.map((e) => [e.positionId, e.amount?.minor, e.date, e.markSource])).toEqual([['carta:501:11', 244716320, '2026-10-12', '409A as of 2026-10-12']])
  })

  it('a company held in two currencies is two positions, one currency each', async () => {
    const tidewater = inv(await syncAll()).filter((e) => e.positionId.startsWith('carta:501:13'))
    expect(tidewater.map((e) => [e.positionId, e.amount?.currency, e.securityType])).toEqual([
      ['carta:501:13', 'USD', 'preferred_stock'],
      ['carta:501:13:AUD', 'AUD', 'common_stock'],
    ])
  })

  it('shares that left with nothing sold at a price exit with no amount (at cost: no gain, no loss)', async () => {
    const gone = at(await syncAll(), 'carta:501:14')
    expect(gone.map((e) => e.kind)).toEqual(['invest', 'exit'])
    expect(gone[1]).toMatchObject({ date: '2025-11-30' })
    expect(gone[1]).not.toHaveProperty('amount')
  })

  it('shares distributed in kind, then a few sold: the sale is a distribution and the position leaves at cost', async () => {
    const kind = at(await syncAll(), 'carta:501:15')
    expect(kind.map((e) => [e.kind, e.amount?.minor])).toEqual([['invest', 1000000], ['distribution', 3000], ['exit', undefined]])
  })

  it('open executed SAFEs and notes are positions at cost; converted and draft ones are not', async () => {
    const notes = inv(await syncAll()).filter((e) => e.positionId.includes(':note:'))
    expect(notes.map((e) => e.positionId)).toEqual(['carta:501:note:1', 'carta:501:note:2'])
    expect(notes[0]).toMatchObject({ securityType: 'safe', date: '2025-04-14', amount: { minor: 3000000 }, valuationCap: { minor: 900000000 }, discountPct: 15 })
    expect(notes[0]).not.toHaveProperty('interestPct')
    expect(notes[1]).toMatchObject({ securityType: 'convertible_note', amount: { minor: 1200000 }, interestPct: 5, maturityDate: '2026-03-01' })
  })

  it("a full pass ends with listing.complete for this portfolio's records, so a note that converts is voided", async () => {
    const ev = await syncAll()
    const done = ev.filter((e): e is ListingComplete => e.type === 'listing.complete')
    expect(done).toEqual([expect.objectContaining({ kinds: ['investment'], scope: 'carta:501:', startedAt: '2026-10-12T12:00:00.000Z' })])
    expect(ev.at(-1)?.type).toBe('listing.complete')
    expect(inv(ev).every((e) => e.externalId.startsWith('carta:501:'))).toBe(true)
  })

  it('emits no accounts, balances or cash rows; a re-sync gives the same ids', async () => {
    const a = await syncAll()
    expect(new Set(a.map((e) => e.type))).toEqual(new Set(['investment.event', 'listing.complete']))
    const ids = inv(a).map((e) => e.externalId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(inv(await syncAll()).map((e) => e.externalId)).toEqual(ids)
  })

  it('a sign-in with several portfolios makes one connection each, sharing the rotating token', async () => {
    const o = make({ extra: [{ method: 'POST', match: '/o/access_token/', respond: { json: { access_token: 'at-9', refresh_token: 'rt-9', expires_in: 3600, token_type: 'Bearer' } } }] })
    const r = (await o.connector.connect({ code: 'c0de' })) as { config: Record<string, unknown>; additional?: Array<{ config: Record<string, unknown> }> }
    expect([r.config, ...(r.additional ?? []).map((a) => a.config)].map((c) => [c.portfolioId, c.displayName])).toEqual([
      ['501', "Carta · Alex Rivera's Portfolio"],
      ['502', 'Carta · Example Ventures Fund I, L.P.'],
    ])
    expect(r.config.sharedSecretKey).toBeDefined()
    expect(r.additional?.[0]?.config.sharedSecretKey).toBe(r.config.sharedSecretKey)
  })

  it('an expired access token refreshes first and the rotated pair is saved before any read', async () => {
    const saved: unknown[] = []
    const o = make({ saved, tokens: { expiresAt: NOW - 1000 }, extra: [{ method: 'POST', match: '/o/access_token/', respond: { json: { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, token_type: 'Bearer' } } }] })
    await runSync(o.connector, o.conn, null)
    expect(saved[0]).toMatchObject({ tokens: { accessToken: 'at-2', refreshToken: 'rt-2' } })
    expect(o.ff.calls.findIndex((c) => c.url.includes('/o/access_token/'))).toBeLessThan(o.ff.calls.findIndex((c) => c.url.includes('/portfolios')))
  })

  it('a 401 is a broken sign-in; health says so', async () => {
    const o = make({ extra: [{ match: path(/\/portfolios$/), respond: { status: 401, json: { message: 'token expired' } } }] })
    expect((await o.connector.health(o.conn)).status).not.toBe('ok')
  })

  it('the sign-in asks for read-only portfolio scopes only; the playground has its own hosts', () => {
    const url = new URL(make().connector.authorizationUrl('st'))
    expect(url.origin + url.pathname).toBe('https://login.app.carta.com/o/authorize/')
    expect((url.searchParams.get('scope') ?? '').split(' ').every((s) => s.startsWith('read_'))).toBe(true)
    const pg = createCartaConnector({ deps: { raw: new MemoryRawSink() }, env: 'playground', oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' } })
    expect(new URL(pg.authorizationUrl('st')).origin).toBe('https://login.playground.carta.team')
  })

  it('discounts written as a fraction or a percent read as percent', () => {
    expect(percent({ value: '0.2' })).toBe(20)
    expect(percent({ value: '15' })).toBe(15)
    expect(percent({ value: '-1' })).toBeUndefined()
  })
})
