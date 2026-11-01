// A deposit the provider files under a kind of spending (Plaid TRAVEL_FLIGHTS: a flight refund) lowers that spending
// instead of being asked about; one that may be someone's income (rent) is still asked.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('refunds the provider names', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a flight refund lowers travel; rent coming in is still a question', async () => {
    k = await makeKit('memory')
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-10-01', -60_000, { counterparty: 'United Airlines', categoryHint: 'TRAVEL_FLIGHTS' }),
      txn(bank, '2026-10-09', 50_000, { counterparty: 'United Airlines', categoryHint: 'TRAVEL_FLIGHTS' }),
      txn(bank, '2026-10-05', 120_000, { counterparty: 'Tenant', categoryHint: 'RENT_AND_UTILITIES_RENT' }),
    ])
    const items = await k.engine.reviewItems(k.ws)
    const asked = items.filter((i) => i.kind === 'unexplained_money').flatMap((i) => i.recordIds)
    const [refund, rent] = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })).filter((r) => (r.amount?.minor ?? 0) > 0).sort((a, b) => (a.date < b.date ? 1 : -1))
    expect(asked).not.toContain(refund!.id)
    expect(asked).toContain(rent!.id)
    const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-10-01', to: '2026-10-31', basis: 'cash' })
    const travel = JSON.stringify(pl).match(/"role":"travel"[^}]*"minor":(-?\d+)/)
    expect(travel?.[1]).toBe('10000') // 600 out, 500 back
  })
})
