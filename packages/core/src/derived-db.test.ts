// Derived results (an overview answer, the checks run) are also kept in the database, so a process that starts cold
// reads what another one computed instead of rebuilding it (f8's run K). A write moves the version on and they are
// computed again; a fresh process can load the current ones before it takes traffic (prewarm).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFinance } from './finance.ts'
import { LedgerEngine } from './engine.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('derived results in the database', () => {
  let k: Kit
  afterEach(async () => {
    vi.useRealTimers()
    await k.close()
  })

  for (const backend of ['sqlite', 'pglite'] as const) {
    it(`${backend}: reads inside a multi-write transaction (the demo tidy) keep nothing computed from its unfinished writes`, async () => {
      k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
      const acme = await k.company('Acme')
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', 500_000)])
      const scope = { workspaceId: k.ws, entityIds: [acme] }
      const fin = createFinance(k.engine)
      const stored = async () => (await k.engine.store.recentDerived!('2000-01-01T00:00:00.000Z')).filter((r) => r.workspaceId === k.ws)
      // Not through the workspace queue: one engine transaction with several writes and a read between them.
      await k.engine.transaction(async () => {
        await k.engine.postBatch(k.ws, [txn(bank, '2026-09-10', -100_000)])
        await fin.reader.overview(scope)
        await k.engine.postBatch(k.ws, [txn(bank, '2026-09-20', -50_000)])
      })
      // The read between the writes stored nothing (in the database or, below, in memory).
      expect(await stored()).toEqual([])
      // After commit: this process and a fresh one both answer with every write.
      expect((await fin.reader.overview(scope)).entities[0]!.cash).toEqual({ minor: 350_000, currency: 'USD' })
      const other = new LedgerEngine({ store: k.engine.store, directory: k.engine.directory, rates: k.rates, now: () => k.engine.now() })
      expect((await createFinance(other).reader.overview(scope)).entities[0]!.cash).toEqual({ minor: 350_000, currency: 'USD' })
    })
  }

  for (const backend of ['sqlite', 'pglite'] as const) {
    it(`${backend}: a second process reads the first one's overview; a write makes both compute again; prewarm loads them`, async () => {
      k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
      const acme = await k.company('Acme')
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', 500_000), txn(bank, '2026-09-15', -120_000)])
      // Another process on the same database: its own engine, its own memory.
      const other = () => new LedgerEngine({ store: k.engine.store, directory: k.engine.directory, rates: k.rates, now: () => k.engine.now() })
      const scope = { workspaceId: k.ws, entityIds: [acme] }
      const first = await createFinance(k.engine).reader.overview(scope)

      // Computing an overview reads the ledger's lines; reading a stored one doesn't.
      const store = k.engine.store
      let computed = 0
      for (const m of ['listLines', 'accountTotals'] as const) {
        const orig = store[m].bind(store) as (...a: unknown[]) => Promise<unknown>
        ;(store as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => (computed++, orig(...a))
      }
      const b = other()
      expect(await createFinance(b).reader.overview(scope)).toEqual(first)
      expect(computed).toBe(0)

      // A write: the stored answer is for the old version, so it's computed again (and shows the new row).
      await k.engine.postBatch(k.ws, [txn(bank, '2026-10-01', -30_000)])
      const after = await createFinance(b).reader.overview(scope)
      expect(computed).toBeGreaterThan(0)
      expect(after.entities[0]!.cash).toEqual({ minor: 350_000, currency: 'USD' })

      // A process starting now loads what is current before any request.
      const c = other()
      expect(await c.prewarm()).toBeGreaterThan(0)
      computed = 0
      expect(await createFinance(c).reader.overview(scope)).toEqual(after)
      expect(computed).toBe(0)
    })

    it(`${backend}: a stored answer is reused all day when nothing was written (not 30 minutes), and pruned after`, async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-11T08:00:00.000Z'), shouldAdvanceTime: true })
      k = await makeKit(backend, { now: '2026-10-11T08:00:00.000Z' })
      const acme = await k.company('Acme')
      const bank = await k.account({ entityId: acme, name: 'Checking' })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-09-01', 500_000)])
      const other = () => new LedgerEngine({ store: k.engine.store, directory: k.engine.directory, rates: k.rates, now: () => k.engine.now() })
      const scope = { workspaceId: k.ws, entityIds: [acme] }
      const first = await createFinance(k.engine).reader.overview(scope)
      const store = k.engine.store
      let computed = 0
      for (const m of ['listLines', 'accountTotals'] as const) {
        const orig = store[m].bind(store) as (...a: unknown[]) => Promise<unknown>
        ;(store as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => (computed++, orig(...a))
      }
      // Nine hours later, idle: another process (and this one) still reuse it, in memory and from the database.
      vi.setSystemTime(new Date('2026-10-11T17:00:00.000Z'))
      expect(await createFinance(other()).reader.overview(scope)).toEqual(first)
      expect(await createFinance(k.engine).reader.overview(scope)).toEqual(first)
      expect(computed).toBe(0)
      expect(await other().prewarm()).toBeGreaterThan(0)
      // Two days on, a new answer is kept and the old day's rows are pruned.
      vi.setSystemTime(new Date('2026-10-13T09:00:00.000Z'))
      k.setNow('2026-10-13T09:00:00.000Z')
      await createFinance(other()).reader.overview(scope)
      const left = (await store.recentDerived!('2000-01-01T00:00:00.000Z')).filter((r) => r.workspaceId === k.ws)
      expect(left.length).toBeGreaterThan(0)
      expect(left.every((r) => r.at >= '2026-10-12T00:00:00.000Z')).toBe(true)
    })
  }
})
