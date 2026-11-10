// Carta through the real ledger: a holder's stakes book at cost, marks value them, sales return cost first, and none
// of it is cash, spending or an account balance.
import type { ConnectionRef } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from '../../../core/src/finance.ts'
import { makeKit, usd, type Kit } from '../../../core/src/test-kit.ts'
import { ROUTES } from './carta.fixture.ts'
import { createCartaConnector, type CartaSecret } from './connector.ts'

const NOW = Date.parse('2026-10-12T12:00:00Z')

describe.each(['memory', 'sqlite'] as const)('carta into the ledger (%s)', (backend) => {
  let k: Kit
  afterEach(async () => k.close())

  it('positions at cost, 409A marks on common, a full sale exits and a partial one returns cost first', async () => {
    // One fixed AUD→USD rate: the fixture's AUD certificate (Tidewater Cloud) books in USD like any foreign position.
    k = await makeKit(backend, { now: '2026-10-12T12:00:00.000Z', rates: () => ({ rate: async (_d, from, to) => (from === to ? '1' : from === 'AUD' && to === 'USD' ? '0.65' : '1') }) })
    const alex = await k.personal('Alex Rivera')
    const connId = await k.connection({ entityId: alex, key: 'carta' })
    const carta = createCartaConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch(ROUTES).fetch, clock: fakeClock(NOW), random: () => 0.5 },
      oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example.com/api/connectors/carta/callback' },
    })
    const conn: ConnectionRef = { id: connId, workspaceId: k.ws, connectorKey: 'carta', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000 } } satisfies CartaSecret, config: { portfolioId: '501' } }
    const { events } = await runSync(carta, conn, null)
    await k.engine.postBatch(k.ws, events)

    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [alex] }
    const views = new Map(((await f.reader.investments?.(scope)) ?? []).map((v) => [v.positionId, v]))
    // Lumen (common): founder cost carried through the split, the exercise at its strike, the RSA; $30 back from the
    // 2-share sale; what's held marked at the $18.40 409A.
    expect(views.get('carta:501:11')).toMatchObject({ issuer: 'Lumen', invested: usd(30_550_00), distributed: usd(30_00), value: usd(2_447_163_20), valueSource: 'mark', markedAt: '2026-10-12' })
    // Northpeak (preferred): exchanged, then sold in two pieces; the second sale closed it.
    expect(views.get('carta:501:12')).toMatchObject({ securityType: 'preferred_stock', invested: usd(60_000_00), distributed: usd(210_000_00), valueSource: 'exited' })
    // Gone Co: transferred away with nothing sold: out at cost, no gain or loss.
    expect(views.get('carta:501:14')).toMatchObject({ invested: usd(500_00), valueSource: 'exited' })
    // Only Northpeak gained: Lumen's $30 is cost coming back first.
    expect(await k.bal(alex, 'investment_gains')).toBe(-(210_000_00 - 60_000_00))
    // Open SAFE and note at cost; the converted and draft ones aren't positions.
    expect(views.get('carta:501:note:1')).toMatchObject({ securityType: 'safe', invested: usd(30_000_00), valueSource: 'cost', discountPct: 15 })
    expect(views.get('carta:501:note:2')).toMatchObject({ securityType: 'convertible_note', invested: usd(12_000_00), valueSource: 'cost' })
    expect([...views.keys()].filter((id) => /note:(3|4)$/.test(id))).toEqual([])

    // None of it is cash, spending or a balance.
    const sept = { workspaceId: k.ws, entityIds: [alex], from: '2026-09-01', to: '2026-09-30' }
    expect(((await k.engine.metric('gross_burn', sept)).value as { minor: number } | null)?.minor ?? 0).toBe(0)
    const cash = (await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [alex] })).value as { minor: number } | null
    expect(cash?.minor ?? 0).toBe(0)
    expect(await k.tb(alex, 'cash')).toBe(0)
    expect(await k.tb(alex, 'accrual')).toBe(0)
  })
})


describe('carta: an unreadable 2xx stops the sync, never a silent $0', () => {
  const NOW_U = Date.parse('2026-10-14T12:00:00Z')
  const build = (respond: { text: string } | { json: unknown }) =>
    createCartaConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch([{ match: () => true, respond }]).fetch, clock: fakeClock(NOW_U), random: () => 0.5 },
      oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example.com/api/connectors/carta/callback' },
    })
  const c: ConnectionRef = { id: 'c', workspaceId: 'w', connectorKey: 'carta', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_U + 3_600_000 } } satisfies CartaSecret, config: { portfolioId: '501' } }
  it('an empty body fails visibly', async () => { await expect(runSync(build({ text: '' }), c, null)).rejects.toThrow() })
  it('a non-object body fails visibly', async () => { await expect(runSync(build({ json: 5 }), c, null)).rejects.toThrow() })
})


describe('carta pagination completeness: a truncated listing must not void real holdings', () => {
  const NOW_P = Date.parse('2026-10-12T12:00:00Z')
  it('an issuer list that never stops paging fails visibly and emits no listing.complete', async () => {
    const carta = createCartaConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch([{ match: (u) => u.pathname.endsWith('/issuers'), respond: (u) => { const n = Number((u.searchParams.get('pageToken') ?? '0').replace(/\D/g, '')) || 0; return { json: { issuers: [{ id: 'iss' + n }], nextPageToken: 'p' + (n + 1) } } } }]).fetch, clock: fakeClock(NOW_P), random: () => 0.5 },
      oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://app.example.com/api/connectors/carta/callback' },
    })
    const conn: ConnectionRef = { id: 'c', workspaceId: 'w', connectorKey: 'carta', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_P + 3_600_000 } } satisfies CartaSecret, config: { portfolioId: '501' } }
    // The throw happens inside listIssuers, before any listing.complete can be pushed — so a partial listing can never void holdings.
    await expect(runSync(carta, conn, null)).rejects.toThrow(/page through/)
  })
})
