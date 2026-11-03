// Patreon's synced members through the ledger's own MRR (what get_metric and get_mrr_movements answer), checked against
// the answers worked by hand in packages/connectors/patreon/src/patreon.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createPatreonConnector } from '@agfn/connector-patreon'
import { readFileSync } from 'node:fs'
import { makeKit, usd, type Kit } from './test-kit.ts'

const fx = JSON.parse(readFileSync(new URL('../../connectors/patreon/fixtures/redacted/patreon.json', import.meta.url), 'utf8')) as {
  campaigns: Record<string, unknown>
  members: Record<string, Record<string, unknown>>
}

describe('Patreon MRR in the ledger', () => {
  let k: Kit
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-11-01T12:00:00.000Z' })
  })
  afterEach(async () => {
    await k.close()
  })

  it('MRR, and new and churn by month, match the hand-worked totals to the cent', async () => {
    const acme = await k.company('Acme')
    const connectionId = await k.connection({ entityId: acme, key: 'patreon' })
    const f = fixtureFetch([
      { match: (u) => u.pathname === '/api/oauth2/v2/campaigns', respond: (u) => ({ json: fx.campaigns[u.searchParams.get('page[cursor]') ?? ''] }) },
      { match: (u) => u.pathname.endsWith('/members'), respond: (u) => ({ json: fx.members[u.pathname.split('/')[5]!]![u.searchParams.get('page[cursor]') ?? ''] }) },
    ])
    const connector = createPatreonConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock(Date.parse('2026-11-01T12:00:00Z')) })
    const { events } = await runSync(connector, { id: connectionId, workspaceId: k.ws, connectorKey: 'patreon', secret: { token: 'creator_token_redacted_01' }, config: {} }, null)
    // USD only here (EUR is checked in the connector's own test; this kit has no EUR rates).
    await k.engine.postBatch(k.ws, events.filter((e) => e.type === 'subscription.upsert' && e.mrr.currency === 'USD'))

    const months = await k.engine.mrrMovements(k.ws, { entityIds: [acme], from: '2026-01', to: '2026-11', currency: 'USD' })
    const at = (m: string) => months.find((x) => x.month === m)!
    // January: 500 (m-monthly) + 500 (m-former-paid-up, gone since its last charge in October).
    expect(at('2026-01').new).toEqual(usd(1_000))
    // February: 833 (annual 9999/12) + 700 + 300 (declined). March: 1000 (annual 12000/12) + 1000 (quarterly 3000/3).
    expect(at('2026-02').new).toEqual(usd(1_833))
    expect(at('2026-03').new).toEqual(usd(2_000))
    expect(at('2026-10').churn).toEqual(usd(500))
    // 500 + 1000 + 833 + 700 + 300 + 1000.
    expect(at('2026-11').end).toEqual(usd(4_333))
    for (const m of months) expect(m.start.minor + m.new.minor + m.expansion.minor + m.reactivation.minor - m.contraction.minor - m.churn.minor).toBe(m.end.minor)
  })
})
