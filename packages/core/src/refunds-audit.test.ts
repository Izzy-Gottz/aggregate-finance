// Refunds, disputes and fee reversals from a processor balance (Stripe, Square, PayPal, Shopify, Gumroad, Paddle, Polar,
// Lemon Squeezy all post processor.balance_txn rows): a refund lowers revenue (never an expense), a won dispute nets to
// zero, a returned fee lowers fees, the payout still ties to the bank, and the same refund reported twice counts once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, txn, usd, type Kit } from './test-kit.ts'

describe('refunds, disputes and fee reversals', () => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit('memory')
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })
  const sept = () => ({ workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
  const setup = async () => ({ st: await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' }), bank: await k.account({ entityId: acme, name: 'Mercury' }) })

  it('a refund with its fee returned lowers revenue and fees, and is no expense', async () => {
    const { st } = await setup()
    await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 10_000, 320), stripe(st, '2026-09-02', 'charge', 5_000, 175), stripe(st, '2026-09-05', 'refund', -10_000, -320)])
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(5_000))
    expect(await k.bal(acme, 'processor_fees')).toBe(175)
    expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
    const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
    expect(pl.revenue.total).toEqual(usd(5_000))
    // Opex is the remaining fee only: the refund is in revenue, not a negative cost or an expense.
    expect(pl.operatingExpenses.total).toEqual(usd(175))
  })

  it('a dispute and its reversal (won) net to zero, fee included', async () => {
    const { st } = await setup()
    await k.engine.postBatch(k.ws, [
      stripe(st, '2026-09-01', 'charge', 10_000, 320),
      stripe(st, '2026-09-10', 'dispute', -10_000, 1_500),
      stripe(st, '2026-09-25', 'dispute', 10_000, -1_500),
    ])
    expect(await k.bal(acme, 'refunds')).toBe(0)
    expect(await k.bal(acme, 'processor_fees')).toBe(320)
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(10_000))
    expect(await k.bal(acme, `processor:${st.id}`)).toBe(9_680)
  })

  it('a lost dispute lowers revenue by the sale and costs its fee', async () => {
    const { st } = await setup()
    await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 10_000, 320), stripe(st, '2026-09-10', 'dispute', -10_000, 1_500)])
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(0))
    expect(await k.bal(acme, 'processor_fees')).toBe(1_820)
  })

  it('a payout after a refund in the same window still ties to the bank deposit', async () => {
    const { st, bank } = await setup()
    await k.engine.postBatch(k.ws, [
      stripe(st, '2026-09-01', 'charge', 10_000, 320),
      stripe(st, '2026-09-01', 'charge', 4_000, 146),
      stripe(st, '2026-09-02', 'refund', -4_000, -146),
      stripe(st, '2026-09-03', 'payout', -9_680, 0),
      txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE PAYOUT' }),
    ])
    expect((await k.engine.store.listLinks(k.ws, { types: ['payout'] }))[0]?.status).toBe('confirmed')
    expect(await k.bal(acme, 'clearing_payouts')).toBe(0)
    expect(await k.bal(acme, `processor:${st.id}`)).toBe(0)
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(10_000))
  })

  it('the same refund reported twice (refund object and balance row share its id) counts once', async () => {
    const { st } = await setup()
    const refund = stripe(st, '2026-09-05', 'refund', -4_000, 0, { externalId: 'ref:re_1' })
    await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 10_000, 320), refund])
    await k.engine.postBatch(k.ws, [{ ...refund, at: '2026-09-05T11:00:00Z' }])
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(6_000))
    expect(await k.bal(acme, 'refunds')).toBe(4_000)
  })
  it('a chargeback re-sent at zero once won (Gumroad) replaces the lost one', async () => {
    const { st } = await setup()
    const cb = stripe(st, '2026-09-10', 'dispute', -1_500, -175, { externalId: 's1:chargeback' })
    await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 1_500, 175, { externalId: 's1' }), cb])
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(0))
    await k.engine.postBatch(k.ws, [{ ...cb, gross: usd(0), fee: usd(0), net: usd(0) }])
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(1_500))
    expect(await k.bal(acme, 'processor_fees')).toBe(175)
  })
})
