// Chargebee's synced subscriptions through the ledger's own MRR (what get_metric and get_mrr_movements answer), checked
// against the answers worked by hand in packages/connectors/chargebee/src/chargebee.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createChargebeeConnector } from '@agfn/connector-chargebee'
import { readFileSync } from 'node:fs'
import { makeKit, usd, type Kit } from './test-kit.ts'

const fx = JSON.parse(readFileSync(new URL('../../connectors/chargebee/fixtures/redacted/chargebee.json', import.meta.url), 'utf8')) as {
  pages: Record<string, unknown>
  coupons: Record<string, unknown>
}

describe('Chargebee MRR in the ledger', () => {
  let k: Kit
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-13T12:00:00.000Z' })
  })
  afterEach(async () => {
    await k.close()
  })

  it('MRR, and new and churn by month, match the hand-worked totals to the cent', async () => {
    const acme = await k.company('Acme')
    const connectionId = await k.connection({ entityId: acme, key: 'chargebee' })
    const f = fixtureFetch([
      { match: (u) => u.pathname === '/api/v2/subscriptions', respond: (u) => ({ json: fx.pages[u.searchParams.get('offset') ?? ''] ?? { list: [] } }) },
      { match: (u) => u.pathname.startsWith('/api/v2/coupons/'), respond: (u) => ({ json: fx.coupons[decodeURIComponent(u.pathname.split('/').pop()!)] }) },
    ])
    const connector = createChargebeeConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    const { events } = await runSync(connector, { id: connectionId, workspaceId: k.ws, connectorKey: 'chargebee', secret: { site: 'acme', apiKey: 'test_cb_key_redacted_01' }, config: {} }, null)
    // USD only here (the EUR subscription is checked in the connector's own test; this kit has no EUR rates).
    await k.engine.postBatch(k.ws, events.filter((e) => e.type === 'subscription.upsert' && e.mrr.currency === 'USD'))

    const months = await k.engine.mrrMovements(k.ws, { entityIds: [acme], from: '2026-01', to: '2026-10', currency: 'USD' })
    const at = (m: string) => months.find((x) => x.month === m)!
    // January: every USD subscription that counts starts (717.67 live today + 25.00 cancelled in March).
    expect(at('2026-01').new).toEqual(usd(74_267))
    expect(at('2026-03').churn).toEqual(usd(2_500))
    expect(at('2026-10').end).toEqual(usd(71_767))
    for (const m of months) expect(m.start.minor + m.new.minor + m.expansion.minor + m.reactivation.minor - m.contraction.minor - m.churn.minor).toBe(m.end.minor)
  })
})
