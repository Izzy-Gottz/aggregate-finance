// Reserves, advances and topups move money the company still owns or owes: never burn, revenue or an open question.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, txn, usd, type Kit } from './test-kit.ts'

describe('processor rows that stay on the balance sheet', () => {
  let k: Kit
  let acme: string
  const metric = (name: 'gross_burn' | 'net_burn' | 'revenue') => k.engine.metric(name, { workspaceId: k.ws, entityIds: [acme], from: '2026-08-01', to: '2026-08-31' })
  afterEach(async () => {
    await k.close()
  })
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })

  it('a reserve held and released is an asset, not spending and suspense', async () => {
    const acct = await k.account({ entityId: acme, name: 'Stripe', type: 'processor_balance' })
    await k.engine.postBatch(k.ws, [
      stripe(acct, '2026-08-03', 'other', -25_000, 0, { balanceRole: 'other_assets' }),
      stripe(acct, '2026-08-20', 'other', 10_000, 0, { balanceRole: 'other_assets' }),
    ])
    expect(await k.bal(acme, 'other_assets')).toBe(15_000)
    expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
    expect(await k.bal(acme, 'suspense')).toBe(0)
    expect((await metric('gross_burn')).value).toEqual(usd(0))
  })

  it('a processor advance is owed, and repaying it is not burn', async () => {
    const acct = await k.account({ entityId: acme, name: 'Shopify', type: 'processor_balance' })
    await k.engine.postBatch(k.ws, [
      stripe(acct, '2026-08-03', 'adjustment', 100_000, 0, { balanceRole: 'other_liabilities' }),
      stripe(acct, '2026-08-20', 'adjustment', -5_000, 0, { balanceRole: 'other_liabilities' }),
    ])
    expect(await k.bal(acme, 'other_liabilities')).toBe(-95_000)
    expect((await metric('net_burn')).value).toEqual(usd(0))
    expect((await metric('revenue')).value).toEqual(usd(0))
  })

  it('a topup links to the bank debit, so the bank row is not spending', async () => {
    const acct = await k.account({ entityId: acme, name: 'Stripe', type: 'processor_balance' })
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    await k.engine.postBatch(k.ws, [stripe(acct, '2026-08-03', 'transfer', 500_000, 0, { balanceRole: 'clearing_payouts' }), txn(bank, '2026-08-04', -500_000, { rawText: 'STRIPE TOPUP' })])
    expect((await k.engine.store.listLinks(k.ws, { types: ['payout'] }))[0]?.status).toBe('confirmed')
    expect(await k.bal(acme, 'clearing_payouts')).toBe(0)
    expect((await metric('gross_burn')).value).toEqual(usd(0))
  })
})
