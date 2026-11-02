// RevenueCat's synced subscriptions through the ledger's own MRR (what get_metric and get_mrr_movements answer), checked
// against the answers worked by hand in packages/connectors/revenuecat/src/revenuecat.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createRevenueCatConnector } from '@agfn/connector-revenuecat'
import { readFileSync } from 'node:fs'
import { makeKit, usd, type Kit } from './test-kit.ts'

const fx = JSON.parse(readFileSync(new URL('../../connectors/revenuecat/fixtures/redacted/revenuecat.json', import.meta.url), 'utf8')) as {
  products: unknown
  customerPages: Record<string, unknown>
  subscriptions: Record<string, unknown[]>
  transactions: Record<string, unknown[]>
}
const list = (items: unknown[]) => ({ items, next_page: null })
const BASE = '/v2/projects/proj_demo'

describe('RevenueCat MRR in the ledger', () => {
  let k: Kit
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-13T12:00:00.000Z' })
  })
  afterEach(async () => {
    await k.close()
  })

  it('MRR, and new and churn by month, match the hand-worked totals to the cent', async () => {
    const acme = await k.company('Acme')
    const connectionId = await k.connection({ entityId: acme, key: 'revenuecat' })
    const f = fixtureFetch([
      { match: (u) => u.pathname === `${BASE}/products`, respond: { json: fx.products } },
      { match: (u) => u.pathname === `${BASE}/customers`, respond: (u) => ({ json: fx.customerPages[u.searchParams.get('starting_after') ?? ''] ?? list([]) }) },
      { match: (u) => /\/customers\/[^/]+\/subscriptions$/.test(u.pathname), respond: (u) => ({ json: list(fx.subscriptions[decodeURIComponent(u.pathname.split('/')[5]!)] ?? []) }) },
      { match: (u) => /\/transactions$/.test(u.pathname), respond: (u) => ({ json: list(fx.transactions[u.pathname.split('/')[5]!] ?? []) }) },
    ])
    const connector = createRevenueCatConnector({}, { raw: new MemoryRawSink(), fetch: f.fetch, clock: fakeClock() })
    const { events } = await runSync(connector, { id: connectionId, workspaceId: k.ws, connectorKey: 'revenuecat', secret: { projectId: 'proj_demo', apiKey: 'sk_test_redacted_0001' }, config: {} }, null)
    // USD only here (EUR and JPY are checked in the connector's own test; this kit has no rates for them).
    await k.engine.postBatch(k.ws, events.filter((e) => e.type === 'subscription.upsert' && e.mrr.currency === 'USD'))

    const months = await k.engine.mrrMovements(k.ws, { entityIds: [acme], from: '2026-01', to: '2026-10', currency: 'USD' })
    const at = (m: string) => months.find((x) => x.month === m)!
    // January: sub_app_month's first paid month, not its trial. February: sub_expired's first paid month.
    expect(at('2026-01').new).toEqual(usd(949))
    expect(at('2026-02').new).toEqual(usd(949))
    // March 10: 500 + 1,296 + 833 + 999 + 499 on list prices.
    expect(at('2026-03').new).toEqual(usd(4_127))
    expect(at('2026-04').churn).toEqual(usd(949))
    expect(at('2026-05').new).toEqual(usd(0))
    expect(at('2026-10').end).toEqual(usd(5_076))
    for (const m of months) expect(m.start.minor + m.new.minor + m.expansion.minor + m.reactivation.minor - m.contraction.minor - m.churn.minor).toBe(m.end.minor)
  })
})
