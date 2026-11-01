// The accounts an answer lists come by company, then name: never by creation order, which depends on how an import
// was paged (the same demo books listed Harbor's accounts differently after its pages grew, 2026-10-13).
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('account order in answers', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('includedAccounts by company then name, whatever order the accounts were made in', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    const zeta = await k.company('Zeta Co')
    const acme = await k.company('Acme')
    // Made in the reverse of the expected order.
    const z2 = await k.account({ entityId: zeta, name: 'Savings' })
    const z1 = await k.account({ entityId: zeta, name: 'Checking' })
    const a2 = await k.account({ entityId: acme, name: 'Treasury' })
    const a1 = await k.account({ entityId: acme, name: 'Operating' })
    await k.engine.postBatch(k.ws, [z2, z1, a2, a1].map((a, i) => txn(a, '2026-09-01', 10_000 * (i + 1))))
    const fin = createFinance(k.engine)
    const cash = await fin.reader.metric('cash', { workspaceId: k.ws, entityIds: 'all' })
    expect(cash.includedAccounts).toEqual([a1.id, a2.id, z1.id, z2.id])
    const one = await fin.reader.metric('cash', { workspaceId: k.ws, entityIds: [zeta] })
    expect(one.includedAccounts).toEqual([z1.id, z2.id])
  })
})
