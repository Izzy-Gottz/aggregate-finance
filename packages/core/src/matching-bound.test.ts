// A statement of 1,000 identical same-day rows (a user's upload can be anything) can't stall matching: each row is
// offered at most a few nearest equal amounts, none is paired on its own, and no row is dropped.
import { expect, it } from 'vitest'
import { listReviewItems } from './review.ts'
import { MANY_NOTE, MAX_TRANSFER_CANDIDATES } from './matching.ts'
import { makeKit, txn } from './test-kit.ts'

it('1,000 × 1,000 same-amount rows finish in seconds, bounded, unpaired and all kept', async () => {
  const k = await makeKit('memory')
  try {
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const card = await k.account({ entityId: acme, name: 'Card', type: 'credit_card' })
    const rows = Array.from({ length: 1_000 }, (_, i) => [txn(bank, '2026-09-15', 10, { counterparty: 'Client', externalId: `in-${i}` }), txn(card, '2026-09-15', -10, { counterparty: 'Vending', externalId: `out-${i}` })]).flat()
    const t = Date.now()
    await k.engine.postBatch(k.ws, rows)
    expect(Date.now() - t).toBeLessThan(20_000)
    expect(await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'], statuses: ['posted'] })).toHaveLength(2_000)
    const links = await k.engine.store.listLinks(k.ws, {})
    expect(links.every((l) => l.status === 'proposed')).toBe(true)
    const per = new Map<string, number>()
    for (const l of links) for (const id of [l.fromId, l.toId]) per.set(id, (per.get(id) ?? 0) + 1)
    expect(Math.max(...per.values())).toBeLessThanOrEqual(MAX_TRANSFER_CANDIDATES)
    expect(links.every((l) => l.scores?.['many'] === 1)).toBe(true)
    // Review says why it only offers a few.
    const items = await listReviewItems(k.engine.metricContext(k.ws), { entityIds: [acme] })
    expect(items.find((i) => i.kind === 'suggested_match')?.detail).toContain(MANY_NOTE)
  } finally {
    await k.close()
  }
}, 60_000)
