// MetricScope.figureOnly (the write pipeline's large-change alert): the figure without the workspace-wide checks and
// review. A full read right after, on the same engine and scope, still gets them: nothing serves one for the other.
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, snapshot, txn, type Kit } from './test-kit.ts'

describe('figure-only metric answers', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('same figure, no checks, review or stale sources; a full read after still has them', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    // A connection last synced three days ago (stale), a balance that doesn't match the rows (a failed check), and an
    // unexplained deposit (review).
    const conn = await k.connection({ entityId: acme, lastSuccessAt: '2026-10-08T00:00:00.000Z' })
    const a = await k.account({ entityId: acme, name: 'Checking', connectionId: conn })
    await k.engine.postBatch(k.ws, [txn(a, '2026-10-01', 500_000, { counterparty: 'Unknown', rawText: 'DEPOSIT' }), snapshot(a, '2026-10-09T08:00:00.000Z', 900_000)])
    const reader = createFinance(k.engine).reader
    const scope = { workspaceId: k.ws, entityIds: [acme] }

    const figure = await reader.metric('cash', { ...scope, figureOnly: true })
    const full = await reader.metric('cash', scope)
    expect(figure.value).toEqual(full.value)
    expect(figure).toMatchObject({ staleSources: [], pendingReviewCount: 0, failedChecks: [] })
    expect(full.staleSources.length + full.pendingReviewCount + (full as { failedChecks?: unknown[] }).failedChecks!.length).toBeGreaterThan(0)
    expect(full.staleSources).toEqual([conn])
  })
})
