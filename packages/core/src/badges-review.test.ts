// "Verified by Aggregate" means the same as the company's "All reconciled": an open question (here, money in nobody
// has explained) keeps the badges from verifying, and says so in plain words.
import { afterEach, describe, expect, it } from 'vitest'
import { verifiedBadges } from './badges.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('verified badges and review', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('an open review item keeps a company from verifying, and verified matches its data health', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09']
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-05-01', 5_000_000, { counterparty: 'Opening deposit', categoryHint: 'TRANSFER_IN_DEPOSIT' }),
      ...months.map((m) => txn(bank, `${m}-15`, -200_000, { counterparty: 'Landlord', categoryHint: 'RENT_AND_UTILITIES_RENT' })),
      txn(bank, '2026-09-20', 75_000, { counterparty: 'J SMITH' }),
    ])
    const review = await k.engine.reviewItems(k.ws, { entityIds: [acme] })
    expect(review.length).toBeGreaterThan(0)
    const v = await verifiedBadges(k.engine, k.ws, acme, { today: '2026-10-09' })
    expect(v.verified).toBe(false)
    expect(v.reasons).toContain(`${review.length} question${review.length === 1 ? '' : 's'} waiting for review`)
    const health = await k.engine.dataHealth(k.ws, [acme])
    expect(v.reasons.length === 0).toBe(health.status === 'ok')
  })
})
