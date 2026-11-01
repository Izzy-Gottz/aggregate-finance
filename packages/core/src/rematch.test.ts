// A newer matcher looks again at history once: rows that came in before it (still waiting in Review) get its answers
// on the next settle, even when that sync changed nothing. Seen on the local recon run after an upgrade.
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'
import { MATCHER_VERSION } from './matching.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('re-matching after a matcher upgrade (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function unmatchedHistory() {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    // Posted, never matched (as if an older matcher had seen them and found nothing).
    await k.engine.postBatch(k.ws, [invoice(qb, { externalId: '1032', number: '1032', counterparty: 'Travis Waldron', total: usd(41_472), issueDate: '2026-09-20', dueDate: '2026-10-20' }), txn(bank, '2026-10-10', 41_471, { rawText: 'TRAVIS WALDRON PAYMENT' })], { settleLater: true })
    for (const c of [qb, bank.connectionId as string]) await k.engine.store.clearUnsettled(k.ws, c)
    return { qb }
  }
  const proposals = async () => (await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })).length

  it('a workspace matched by an older version is re-matched once on the next settle', async () => {
    const { qb } = await unmatchedHistory()
    await k.engine.store.setMatchedWith(k.ws, MATCHER_VERSION - 1, '2026-10-01T00:00:00.000Z')
    await k.engine.settle(k.ws, qb)
    expect(await proposals()).toBe(1)
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
  })

  it('a current workspace with nothing waiting does no matching work', async () => {
    const { qb } = await unmatchedHistory()
    await k.engine.settle(k.ws, qb)
    expect(await proposals()).toBe(0)
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
  })
})
