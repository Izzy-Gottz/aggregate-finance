// The overview's whole answer is reused until the next write (staging: a fresh demo's first overview took 2.3 s, a
// repeat 0.6 s, though the warm had just computed the same thing). A connection's state or last good sync changes
// without a write, so it is part of the key.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFinance } from './finance.ts'
import type { MemoryDirectory } from './memory-store.ts'
import { makeKit, snapshot, txn, type Kit } from './test-kit.ts'

describe('overview reuse', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const a = await k.account({ entityId: acme, name: 'Checking' })
    await k.engine.postBatch(k.ws, [snapshot(a, '2026-10-10T20:00:00.000Z', 10_000), txn(a, '2026-10-10', 10_000)])
    const reader = createFinance(k.engine).reader
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    return { acme, a, reader, scope, dir: (k.engine as unknown as { directory: MemoryDirectory }).directory }
  }

  it('a repeat reads nothing from the ledger, and says when it was asked', async () => {
    const { reader, scope } = await setup()
    const first = await reader.overview(scope)
    const lines = vi.spyOn(k.engine.store, 'listLines')
    const records = vi.spyOn(k.engine.store, 'listRecords')
    k.setNow('2026-10-11T12:05:00.000Z')
    const again = await reader.overview(scope)
    expect(lines).not.toHaveBeenCalled()
    expect(records).not.toHaveBeenCalled()
    expect(again).toEqual({ ...first, asOf: '2026-10-11T12:05:00.000Z' })
  })

  it('a write shows at once', async () => {
    const { a, reader, scope } = await setup()
    expect((await reader.overview(scope)).entities[0]!.cash.minor).toBe(10_000)
    await k.engine.postBatch(k.ws, [snapshot(a, '2026-10-11T09:00:00.000Z', 12_500)])
    expect((await reader.overview(scope)).entities[0]!.cash.minor).toBe(12_500)
  })

  it('a connection that needs signing in again shows at once, without a write', async () => {
    const { a, reader, scope, dir } = await setup()
    expect((await reader.overview(scope)).attention.filter((x) => x.kind === 'stale_source')).toEqual([])
    dir.setConnectionStatus(a.connectionId as string, 'needs_reauth')
    expect((await reader.overview(scope)).attention.filter((x) => x.kind === 'stale_source')).toHaveLength(1)
  })

  it('another day is another answer', async () => {
    const { reader, scope } = await setup()
    await reader.overview(scope)
    const lines = vi.spyOn(k.engine.store, 'listLines')
    k.setNow('2026-10-12T12:00:00.000Z')
    await reader.overview(scope)
    expect(lines).toHaveBeenCalled()
  })
})
