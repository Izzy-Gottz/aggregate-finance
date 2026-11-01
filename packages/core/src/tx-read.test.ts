// Reads inside a ledger transaction see its own writes, also when several run at once. The overview's reads run
// together: the first emptied the write-behind buffer and was still writing it when the second read the books, so on
// Postgres the second missed the transaction's own entries (the demo tidy reads between its writes). SQLite's
// synchronous driver hid it.
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('reads inside a ledger transaction see its own writes', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })
  for (const backend of ['sqlite', 'pglite'] as const) {
    it(`${backend}: an overview, and reads started together`, async () => {
      k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
      const acme = await k.company('Acme')
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', 500_000)])
      const fin = createFinance(k.engine)
      const store = k.engine.store
      const net = (m: Map<string, number>) => m.get(acme) ?? 0
      const seen = await k.engine.transaction(async () => {
        await k.engine.postBatch(k.ws, [txn(bank, '2026-09-10', -100_000)])
        const cash = (await fin.reader.overview({ workspaceId: k.ws, entityIds: [acme] })).entities[0]!.cash.minor
        await k.engine.postBatch(k.ws, [txn(bank, '2026-09-20', -50_000)])
        const both = await Promise.all([store.entityNets!(k.ws, { basis: 'cash' }), store.entityNets!(k.ws, { basis: 'cash' })])
        return { cash, nets: both.map(net) }
      })
      expect(seen.cash).toBe(400_000)
      // Both reads see the second write: the one that didn't do the flush waited for it.
      expect(seen.nets[0]).toBe(seen.nets[1])
      expect(seen.nets[0]).toBe(await k.engine.transaction(async () => net(await store.entityNets!(k.ws, { basis: 'cash' }))))
    })
  }
})
