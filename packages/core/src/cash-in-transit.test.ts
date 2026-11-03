// A payout that has left Stripe and hasn't reached the bank is in neither balance: cash says how much (audit P7).
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, txn, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('cash with money in transit (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('names the payout in transit until the deposit arrives', async () => {
    k = await makeKit(backend, { now: '2026-09-04T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
    const bank = await k.account({ entityId: acme, name: 'Mercury' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-08-20', 5_000), stripe(st, '2026-09-01', 'charge', 10_000, 320), stripe(st, '2026-09-03', 'payout', -9_680, 0)])
    const gaps = async () => (await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })).coverage?.gaps ?? []
    expect(await gaps()).toContain("$96.80 in payouts or transfers has left one account and hasn't been seen arriving yet, so it isn't in this figure")
    expect((await k.engine.metric('card_balances', { workspaceId: k.ws, entityIds: [acme] })).coverage?.gaps.join(' ') ?? '').not.toContain('payouts or transfers')
    k.setNow('2026-09-05T12:00:00.000Z')
    await k.engine.post(k.ws, txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE PAYOUT' }))
    expect((await gaps()).join(' ')).not.toContain('payouts or transfers')
  })
})
