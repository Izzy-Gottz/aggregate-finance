// Google Play passes some sales tax to the developer as its own rows (Tax, Tax rebill, Tax refund). That money is owed
// to the tax authority: sales tax payable, not suspense (money in) or uncategorized expense (a refund of tax).
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, type Kit } from './test-kit.ts'

describe('processor tax rows', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('post to sales tax payable, either sign; other adjustments stay unexplained', async () => {
    k = await makeKit('sqlite', { now: '2026-10-09T12:00:00.000Z' })
    const app = await k.company('Appco')
    const play = await k.account({ entityId: app, name: 'Google Play earnings (USD)', type: 'processor_balance' as never })
    await k.engine.postBatch(k.ws, [
      stripe(play, '2026-08-03', 'charge', 999, 150),
      stripe(play, '2026-08-03', 'adjustment', 80, 0, { salesTax: true }),
      stripe(play, '2026-08-20', 'adjustment', -30, 0, { salesTax: true }),
      stripe(play, '2026-08-21', 'adjustment', 100, 0),
    ])
    // Stored and read back as sent: the marker on the tax rows only.
    const rows = await k.engine.store.listRecords(k.ws, { eventTypes: ['processor.balance_txn'] })
    expect(rows.map((r) => (r.event as { salesTax?: true }).salesTax ?? null).sort()).toEqual([null, null, true, true].sort())
    for (const basis of ['cash', 'accrual'] as const) {
      expect(await k.bal(app, 'sales_tax_payable', basis)).toBe(-50)
      expect(await k.bal(app, 'revenue', basis)).toBe(-999)
      expect(await k.bal(app, 'suspense', basis)).toBe(-100)
      expect(await k.bal(app, 'uncategorized_expense', basis)).toBe(0)
      expect(await k.tb(app, basis)).toBe(0)
    }
  })
})
