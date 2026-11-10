// An Amazon settlement's or Etsy deposit's payout row (dated when it's sent, arrivalDate the same day) matches the bank
// deposit that names it, as confidently as the other processors, and still when ACH takes 5 business days over a holiday.
import { expect, it } from 'vitest'
import { makeKit, stripe, txn } from './test-kit.ts'

async function payoutTo(deposit: { date: string; counterparty?: string; rawText?: string; amount?: number }) {
  const k = await makeKit('memory')
  try {
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const amz = await k.account({ entityId: acme, type: 'processor_balance', name: 'Amazon balance (USD)' })
    const payout = stripe(amz, '2026-11-25T08:00:00Z', 'payout', -123456, 0, { externalId: 'g1#payout', payoutExternalId: 'g1', arrivalDate: '2026-11-25' })
    const dep = txn(bank, deposit.date, deposit.amount ?? 123456, { counterparty: deposit.counterparty, rawText: deposit.rawText })
    await k.engine.postBatch(k.ws, [payout, dep])
    return (await k.engine.store.listLinks(k.ws, {})).filter((l) => l.type === 'payout')
  } finally {
    await k.close()
  }
}

it('a deposit naming Amazon confirms at 0.97', async () => {
  for (const rawText of ['AMAZON.COM SERVICES ACH CREDIT', 'AMZN MKTP SELLER DEPOSIT', 'AMAZON PAYMENTS TRANSFER']) {
    const [l] = await payoutTo({ date: '2026-11-30', rawText })
    expect(l?.confidence).toBe(0.97)
    expect(l?.status).toBe('confirmed')
  }
})

it('5 business days over Thanksgiving (8 calendar days) still matches when the deposit names Amazon', async () => {
  // Wed 11-25 transfer; Thu 11-26 holiday; Fri, Mon, Tue, Wed, Thu: lands Thu 12-03.
  expect((await payoutTo({ date: '2026-12-03', rawText: 'AMAZON.COM SERVICES' }))[0]?.confidence).toBe(0.97)
  // An unnamed deposit keeps the 7-day window, and nothing is matched past 10 days.
  expect(await payoutTo({ date: '2026-12-03', rawText: 'ACH CREDIT' })).toHaveLength(0)
  // The longer window is Amazon's alone: a deposit naming another processor keeps 7 days.
  expect(await payoutTo({ date: '2026-12-03', rawText: 'SHOPIFY PAYMENTS PAYOUT' })).toHaveLength(0)
  expect((await payoutTo({ date: '2026-12-02', rawText: 'SHOPIFY PAYMENTS PAYOUT' }))[0]?.confidence).toBe(0.97)
  expect(await payoutTo({ date: '2026-12-06', rawText: 'AMAZON.COM SERVICES' })).toHaveLength(0)
  // Before the transfer, or a cent off: no match.
  expect(await payoutTo({ date: '2026-11-24', rawText: 'AMAZON.COM SERVICES' })).toHaveLength(0)
  expect(await payoutTo({ date: '2026-11-30', rawText: 'AMAZON.COM SERVICES', amount: 123455 })).toHaveLength(0)
})

it('Etsy: a deposit naming Etsy confirms at 0.97, up to 10 days out; "Betsy" is not Etsy', async () => {
  for (const rawText of ['ETSY, INC. PAYOUT', 'ETSY PAYOUT 8473625']) expect((await payoutTo({ date: '2026-12-04', rawText }))[0]?.confidence).toBe(0.97)
  expect(await payoutTo({ date: '2026-12-06', rawText: 'ETSY PAYOUT' })).toHaveLength(0)
  // A person named Betsy: not named, so 0.85 inside 7 days and nothing at 8.
  expect((await payoutTo({ date: '2026-11-30', rawText: 'ZELLE FROM BETSY ROSS' }))[0]?.confidence).toBe(0.85)
  expect(await payoutTo({ date: '2026-12-03', rawText: 'ZELLE FROM BETSY ROSS' })).toHaveLength(0)
})
