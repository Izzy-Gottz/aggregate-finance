// Concurrent ledger work in one workspace never deadlocks: a transaction that already holds the workspace (a writer
// apply making several ledger writes) must not wait in the in-process queue behind work that waits for it.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('ledger concurrency (sqlite: one connection, so a wait on it is a wait on the holder)', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a second write inside an open transaction goes ahead while a batch queued behind it waits', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Chase' })
    const card = await k.account({ entityId: acme, name: 'Amex', type: 'credit_card' })

    // A batch started outside the transaction (its own context), released from inside it.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const page = gate.then(() => k.engine.postBatch(k.ws, Array.from({ length: 20 }, (_, i) => txn(card, '2026-09-10', -100 - i, { counterparty: `Shop ${i}` }))))

    const outer = k.engine.transaction(async () => {
      await k.engine.post(k.ws, txn(bank, '2026-09-01', 50_000, { counterparty: 'Globex' }))
      release()
      await new Promise((r) => setTimeout(r, 50)) // the batch is now queued, waiting for the connection this holds
      await k.engine.post(k.ws, txn(bank, '2026-09-02', -1_000, { counterparty: 'Staples' }))
    })
    const done = await Promise.race([Promise.all([outer, page]).then(() => 'done'), new Promise((r) => setTimeout(() => r('deadlock'), 5_000))])
    expect(done).toBe('done')
    expect(await k.bal(acme, `cash:${bank.id}`)).toBe(49_000)
    expect(await k.tb(acme)).toBe(0)
  }, 15_000)

  it('many batches for one workspace at once end with the same books as one after another', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const accounts = await Promise.all([0, 1, 2, 3].map((i) => k.account({ entityId: acme, name: `Bank ${i}` })))
    const pages = accounts.map((a, i) => Array.from({ length: 40 }, (_, d) => txn(a, `2026-09-${String((d % 28) + 1).padStart(2, '0')}`, (i + 1) * 100 - d, { counterparty: `P${i}-${d}` })))
    await Promise.all(pages.map((p) => k.engine.postBatch(k.ws, p)))
    const expected = pages.flat().reduce((s, e) => s + (e.amount as { minor: number }).minor, 0)
    let total = 0
    for (const a of accounts) total += await k.bal(acme, `cash:${a.id}`)
    expect(total).toBe(expected)
    expect(await k.tb(acme)).toBe(0)
  })
})

describe('a ledger transaction never waits on shared work running elsewhere (staging stall, 2026-10-13)', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a shared read inside a transaction computes in place instead of joining one in flight on the pool', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    await k.company('Acme')
    // Another request's shared read, stuck (on a real pool: waiting for a connection the transaction holds).
    let release!: (v: string) => void
    const outside = k.engine.metricContext(k.ws).shared!('probe', () => new Promise<string>((r) => (release = r)))
    await new Promise((r) => setTimeout(r, 10))
    let ranInside = false
    const inside = k.engine.transaction(() =>
      k.engine.metricContext(k.ws).shared!('probe', async () => {
        ranInside = true
        return 'inside'
      }),
    )
    const first = await Promise.race([inside, new Promise((r) => setTimeout(() => r('waited'), 2_000))])
    expect(first).toBe('inside')
    expect(ranInside).toBe(true)
    // And the outside read is not fed the transaction's (uncommitted) value either.
    release('outside')
    expect(await outside).toBe('outside')
  }, 10_000)
})
