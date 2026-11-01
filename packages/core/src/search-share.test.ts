// Searches share one parsed copy of the ledger's transaction rows per workspace version, and at most two big ones
// run at once per process: fifty workspaces each reading and parsing ~10k rows at once ran a 512 MB machine out of
// heap (f8's run M).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, stripe, type Kit } from './test-kit.ts'

describe('shared search rows', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('reads the rows once per version, frozen, and again after a write', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [stripe(bal, '2026-09-03', 'charge', 4_000, 146, { counterparty: 'Ana' })])
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const reads = vi.spyOn(k.engine.store, 'listRecords')
    const [a, b] = await Promise.all([f.reader.searchTransactions(scope, { limit: 50 }), f.reader.searchTransactions(scope, { from: '2026-09-04', limit: 50 })])
    await f.reader.searchTransactions(scope, { text: 'ana', limit: 50 })
    expect(reads.mock.calls.filter((c) => c[1]?.eventTypes?.includes('txn.upsert'))).toHaveLength(1)
    expect(a.rows).toHaveLength(2)
    expect(b.rows).toHaveLength(0)
    expect(Object.isFrozen((await k.engine.txnRecords(k.ws, [acme]))[0])).toBe(true)
    await k.engine.postBatch(k.ws, [stripe(bal, '2026-09-05', 'charge', 900, 56, { counterparty: 'Bo' })])
    expect((await f.reader.searchTransactions(scope, { limit: 50 })).rows).toHaveLength(4)
  })

  it('runs every big search, two at a time', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [stripe(bal, '2026-09-03', 'charge', 4_000, 146, { counterparty: 'Ana' })])
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const all = await Promise.all(Array.from({ length: 7 }, () => f.reader.searchTransactions(scope, { limit: 10_000 })))
    expect(all.map((r) => r.totalCount)).toEqual([2, 2, 2, 2, 2, 2, 2])
  })
})
