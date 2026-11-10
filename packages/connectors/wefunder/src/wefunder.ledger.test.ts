// Wefunder through the real ledger: what get_investments and the Investments page show for the fixture investor,
// worked by hand. None of it is cash or spending.
import { readFileSync } from 'node:fs'
import type { ConnectionRef } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from '../../../core/src/finance.ts'
import { makeKit, usd, type Kit } from '../../../core/src/test-kit.ts'
import { createWefunderConnector, type WefunderSecret } from './connector.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/wefunder.json', import.meta.url), 'utf8')) as { pages: Record<string, unknown> }
const NOW = Date.parse('2026-10-13T12:00:00Z')

describe.each(['memory', 'sqlite'] as const)('wefunder into the ledger (%s)', (backend) => {
  let k: Kit
  afterEach(async () => k.close())

  it('cost, Wefunder’s value, the exit and the write-off, to the cent', async () => {
    k = await makeKit(backend, { now: '2026-10-13T12:00:00.000Z' })
    const me = await k.personal('Test Investor')
    const connId = await k.connection({ entityId: me, key: 'wefunder' })
    const wf = createWefunderConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch([{ match: (u) => u.pathname === '/portfolio/positions', respond: (u) => ({ json: fx.pages[u.searchParams.get('cursor') ?? ''] }) }]).fetch, clock: fakeClock(NOW), random: () => 0.5 },
      oauth: { clientId: 'pk_test_x', clientSecret: 'sk_test_x', redirectUri: 'https://app.example.com/api/connectors/wefunder/callback' },
    })
    const conn: ConnectionRef = { id: connId, workspaceId: k.ws, connectorKey: 'wefunder', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW + 3_600_000 } } satisfies WefunderSecret, config: {} }
    await k.engine.postBatch(k.ws, (await runSync(wf, conn, null)).events)

    const f = createFinance(k.engine)
    const views = new Map(((await f.reader.investments?.({ workspaceId: k.ws, entityIds: [me] })) ?? []).map((v) => [v.positionId, v]))
    expect(views.get('wefunder:ofr_safe1')).toMatchObject({ issuer: 'Acme Robotics', securityType: 'safe', invested: usd(1_500_00), value: usd(2_100_00), valueSource: 'mark', markedAt: '2026-10-12', firstInvested: '2025-03-01', status: 'active' })
    expect(views.get('wefunder:ofr_pref1')).toMatchObject({ invested: usd(2_150_00), value: usd(2_150_00), valueSource: 'cost', shares: 200 })
    expect(views.get('wefunder:ofr_exit1')).toMatchObject({ invested: usd(1_000_00), distributed: usd(1_649_20), value: usd(0), valueSource: 'exited', status: 'exited' })
    expect(views.get('wefunder:ofr_fail1')).toMatchObject({ invested: usd(250_00), value: usd(0), valueSource: 'written_off', status: 'written_off' })
    expect(views.get('wefunder:ofr_rev1')).toMatchObject({ invested: usd(300_00), valueSource: 'cost' })
    // MOIC on the exit: 1,649.20 back on 1,000.00.
    expect(views.get('wefunder:ofr_exit1')?.moic).toBe(1.65) // 1,649.20 back on 1,000.00, to 2 places
    const cash = (await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [me] })).value
    expect(typeof cash === 'object' && cash ? cash.minor : (cash ?? 0)).toBe(0) // no cash from Wefunder
  })
})


describe('wefunder: an unreadable 2xx stops the sync, never a silent $0', () => {
  const NOW_U = Date.parse('2026-10-14T12:00:00Z')
  const build = (respond: { text: string } | { json: unknown }) =>
    createWefunderConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch([{ match: (u) => u.pathname === '/portfolio/positions', respond }]).fetch, clock: fakeClock(NOW_U), random: () => 0.5 },
      oauth: { clientId: 'pk_test_x', clientSecret: 'sk_test_x', redirectUri: 'https://app.example.com/api/connectors/wefunder/callback' },
    })
  const c: ConnectionRef = { id: 'c', workspaceId: 'w', connectorKey: 'wefunder', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_U + 3_600_000 } } satisfies WefunderSecret, config: {} }
  it('an empty body fails visibly', async () => { await expect(runSync(build({ text: '' }), c, null)).rejects.toThrow() })
  it('a non-object body fails visibly', async () => { await expect(runSync(build({ json: 5 }), c, null)).rejects.toThrow() })
})


describe('wefunder pagination completeness: a truncated listing must not void real positions', () => {
  const NOW_P = Date.parse('2026-10-13T12:00:00Z')
  it('a positions list that never stops paging fails visibly and emits no listing.complete', async () => {
    const wf = createWefunderConnector({
      deps: { raw: new MemoryRawSink(), fetch: fixtureFetch([{ match: (u) => u.pathname === '/portfolio/positions', respond: (u) => { const n = Number(u.searchParams.get('cursor') ?? '0') || 0; return { json: { data: [{ id: 'p' + n, type: 'position', attributes: { offering_id: 'o' + n } }], meta: { has_more: true, next_cursor: n + 1 } } } } }]).fetch, clock: fakeClock(NOW_P), random: () => 0.5 },
      oauth: { clientId: 'pk_test_x', clientSecret: 'sk_test_x', redirectUri: 'https://app.example.com/api/connectors/wefunder/callback' },
    })
    const conn: ConnectionRef = { id: 'c', workspaceId: 'w', connectorKey: 'wefunder', secret: { tokens: { accessToken: 'at', refreshToken: 'rt', expiresAt: NOW_P + 3_600_000 } } satisfies WefunderSecret, config: {} }
    // The cap throw fires before the terminal listing.complete, so no pass with unfetched pages can void positions.
    await expect(runSync(wf, conn, null)).rejects.toThrow(/page through/)
  })
})
