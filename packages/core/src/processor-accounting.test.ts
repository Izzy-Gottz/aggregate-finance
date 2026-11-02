// A sale in both a processor and QuickBooks or Xero. Proposed on amount and customer name, never automatic; once
// confirmed it counts once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PaymentApplied } from '@agfn/contracts'
import { invoice, makeKit, stripe, usd, type Kit } from './test-kit.ts'

const payment = (connectionId: string, o: Pick<PaymentApplied, 'externalId' | 'date' | 'amount' | 'counterparty' | 'applications'>): PaymentApplied => ({ type: 'payment.applied', connectionId, direction: 'receivable', ...o })

describe('a processor charge and accounting books', () => {
  let k: Kit
  let acme: string
  const revenue = (basis: 'cash' | 'accrual') => k.bal(acme, 'revenue', basis)
  const links = () => k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })
  afterEach(async () => {
    await k.close()
  })
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  const setup = async () => {
    const qbo = await k.connection({ entityId: acme, key: 'quickbooks' })
    const acct = await k.account({ entityId: acme, name: 'Stripe', type: 'processor_balance' })
    return { qbo, acct }
  }

  it('a payment recorded in the books is proposed against the charge, then counts once', async () => {
    const { qbo, acct } = await setup()
    await k.engine.postBatch(k.ws, [
      invoice(qbo, { externalId: 'INV-1', total: usd(1_000_000), counterparty: 'Globex Corp', issueDate: '2026-08-01', status: 'paid', amountPaid: usd(1_000_000) }),
      payment(qbo, { externalId: 'PAY-1', date: '2026-08-05', amount: usd(1_000_000), counterparty: 'Globex Corp', applications: [{ invoiceExternalId: 'INV-1', amount: usd(1_000_000) }] }),
      stripe(acct, '2026-08-06', 'charge', 1_000_000, 0, { counterparty: 'Globex Corp' }),
    ])
    const [link] = await links()
    expect(link?.status).toBe('proposed')
    expect(await revenue('cash')).toBe(-2_000_000)
    await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
    expect(await revenue('cash')).toBe(-1_000_000)
    expect(await revenue('accrual')).toBe(-1_000_000)
    expect(await k.bal(acme, 'clearing_unmatched_receipts')).toBe(0)
    expect(await k.tb(acme, 'cash')).toBe(0)
  })

  it('an open invoice in the books is proposed against the charge, then counts once', async () => {
    const { qbo, acct } = await setup()
    await k.engine.postBatch(k.ws, [
      invoice(qbo, { externalId: 'INV-2', total: usd(500_000), counterparty: 'Initech', issueDate: '2026-08-01' }),
      stripe(acct, '2026-08-20', 'charge', 500_000, 0, { counterparty: 'Initech LLC' }),
    ])
    const [link] = await links()
    expect(link?.status).toBe('proposed')
    await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
    expect(await revenue('accrual')).toBe(-500_000)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
  })

  it('the same amount from a different customer is left alone', async () => {
    const { qbo, acct } = await setup()
    await k.engine.postBatch(k.ws, [
      invoice(qbo, { externalId: 'INV-3', total: usd(500_000), counterparty: 'Initech', issueDate: '2026-08-01' }),
      stripe(acct, '2026-08-20', 'charge', 500_000, 0, { counterparty: 'Umbrella' }),
    ])
    expect(await links()).toHaveLength(0)
  })
})
