// query_transactions reads every row in one page of 10,000. Categories for that many rows come from one read of the
// whole scope, kept until the next write, instead of a read per 500 ids (staging demo: 16 reads, ~0.9 s).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('categories for many rows', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('match the small-page answer, are reused, and a write shows at once', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const a = await k.account({ entityId: acme, name: 'Checking' })
    const names = ['AWS', 'Gusto', 'Stripe payout', 'Delta Air', 'Uber']
    await k.engine.postBatch(k.ws, Array.from({ length: 600 }, (_, i) => txn(a, `2026-0${1 + (i % 9)}-1${i % 10}`, (i % 2 ? -1 : 1) * (1_000 + i), { counterparty: names[i % 5], rawText: names[i % 5] })))
    const reader = createFinance(k.engine).reader
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const big = await reader.searchTransactions(scope, { limit: 10_000 })
    expect(big.rows).toHaveLength(600)
    const small: typeof big.rows = []
    for (let cursor: string | undefined, p; (p = await reader.searchTransactions(scope, { limit: 50, ...(cursor ? { cursor } : {}) })); ) {
      small.push(...p.rows)
      if (!p.nextCursor) break
      cursor = p.nextCursor
    }
    expect(big.rows.map((r) => [r.id, r.category])).toEqual(small.map((r) => [r.id, r.category]))

    const lines = vi.spyOn(k.engine.store, 'listLines')
    await reader.searchTransactions(scope, { limit: 10_000 })
    expect(lines).not.toHaveBeenCalled()
    lines.mockRestore()

    await k.engine.postBatch(k.ws, [txn(a, '2026-10-10', -4_200, { counterparty: 'AWS', rawText: 'AWS' })])
    const after = await reader.searchTransactions(scope, { limit: 10_000 })
    expect(after.rows).toHaveLength(601)
    expect(after.rows[0]!.category).toBe(big.rows.find((r) => r.counterparty === 'AWS' && r.amount.minor < 0)?.category)
  })
})
