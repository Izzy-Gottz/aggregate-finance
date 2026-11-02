// A first sync brings years of money in: Review asks about the last 30 days row by row and about older money once
// per account (43's Plaid run: 54 "What is this money?" items, one per old deposit).
import { afterEach, describe, expect, it } from 'vitest'
import type { Provenance, WriteCommand } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

const prov = (): Provenance => ({ writeRequestId: `wr_${Math.random().toString(36).slice(2)}`, actorKind: 'person', personId: 'person-owner', label: 'Owner' })

describe('older unexplained money is one question per account', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('recent rows stay single; older ones collapse; one answer explains them all; undo brings them back', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    // Connected long ago, so none of this is from before the connection (that is one opening-balance question).
    const conn = await k.connection({ entityId: acme, key: 'test', createdAt: '2025-01-01T00:00:00.000Z' })
    const bank = await k.account({ entityId: acme, name: 'Checking', mask: '4242', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-06-03', 872, { rawText: 'SBSI' }),
      txn(bank, '2026-07-03', 1_200, { rawText: 'SBSI' }),
      txn(bank, '2026-08-03', 3_000, { rawText: 'MOBILE DEPOSIT' }),
      txn(bank, '2026-10-05', 5_000, { rawText: 'ZELLE FROM SOMEONE' }),
    ])
    const items = async () => (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'unexplained_money')
    const before = await items()
    expect(before.map((i) => i.detail)).toEqual([expect.stringContaining('Oct 5'), "3 deposits before Sep 11 in Checking ··4242 aren't explained ($50.72)"])
    expect(await k.bal(acme, 'suspense')).toBe(-10_072)
    const batch = before[1]
    const f = createFinance(k.engine)
    const cmd = (payload: Record<string, unknown>): WriteCommand => ({ op: 'resolve_review_item', workspaceId: k.ws, entityId: acme, payload })
    const res = await f.writer.apply(cmd({ reviewItemId: batch?.id, decision: 'edit', edits: batch?.choices?.find((c) => c.label === 'All other income')?.edits }), prov())
    expect(res.summary).toBe('Recorded what 3 deposits are')
    expect(await k.bal(acme, 'suspense')).toBe(-5_000)
    expect(await k.bal(acme, 'other_income')).toBe(-5_072)
    expect((await items()).map((i) => i.detail)).toEqual([expect.stringContaining('Oct 5')])
    await f.writer.revert(k.ws, res.recordId, prov())
    expect(await k.bal(acme, 'suspense')).toBe(-10_072)
  })
})
