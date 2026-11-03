// A sale in both a processor and QuickBooks or Xero. Proposed on amount and customer name, never automatic; once
// confirmed it counts once.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CreditNoteUpsert, PaymentApplied } from '@agfn/contracts'
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
    const scope = { workspaceId: k.ws, entityIds: [acme], from: '2026-08-01', to: '2026-08-31' }
    const waiting = '$10,000.00 in sales that may also be in your books is waiting in Review and is counted twice until confirmed'
    expect((await k.engine.metric('revenue', scope)).coverage?.gaps).toContain(waiting)
    await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
    expect((await k.engine.metric('revenue', scope)).coverage?.gaps).not.toContain(waiting)
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

  it('a taxed refund matches on what left, and the card says who and which note', async () => {
    const { qbo, acct } = await setup()
    const note: CreditNoteUpsert = { type: 'credit_note.upsert', connectionId: qbo, externalId: 'RR-1042', number: '1042', direction: 'receivable', date: '2026-08-21', amount: usd(1_080), tax: usd(80), appliedTo: 'refund', counterparty: 'Globex Corp' }
    await k.engine.postBatch(k.ws, [note, stripe(acct, '2026-08-22', 'refund', -1_080, 0, { counterparty: 'Globex Corp' })])
    await k.engine.reconcile(k.ws)
    const card = (await k.engine.reviewItems(k.ws)).find((i) => i.kind === 'suggested_match')
    expect(card?.question).toContain('Globex Corp was refunded on credit note 1042 ($10.80). Same money as the $10.80 refund in ')
    expect(card?.detail).not.toContain('credit_note.upsert')
    expect(card?.detail).not.toContain('balance_txn')
    await k.engine.decideLink(k.ws, card?.linkId as string, 'confirmed', 'person-1')
    expect(await k.bal(acme, 'sales_tax_payable', 'accrual')).toBe(80)
    expect(await k.bal(acme, 'clearing_unmatched_receipts', 'accrual')).toBe(0)
    expect(await k.tb(acme, 'accrual')).toBe(0)
  })

  it('a refund in the books and in the processor is proposed, then counts once', async () => {
    const { qbo, acct } = await setup()
    const note: CreditNoteUpsert = { type: 'credit_note.upsert', connectionId: qbo, externalId: 'CN-1', direction: 'receivable', date: '2026-08-21', amount: usd(100_000), appliedTo: 'refund', counterparty: 'Initech' }
    await k.engine.postBatch(k.ws, [
      invoice(qbo, { externalId: 'INV-4', total: usd(1_000_000), counterparty: 'Initech', issueDate: '2026-08-01', status: 'paid', amountPaid: usd(1_000_000) }),
      note,
      stripe(acct, '2026-08-22', 'refund', -100_000, 0, { counterparty: 'Initech LLC' }),
    ])
    const [link] = await k.engine.store.listLinks(k.ws, { types: ['refund'] })
    expect(link?.status).toBe('proposed')
    expect(await revenue('accrual') + await k.bal(acme, 'refunds', 'accrual')).toBe(-800_000)
    const waiting = '$1,000.00 in refunds that may also be in your books is waiting in Review and is counted twice until confirmed'
    const scope = { workspaceId: k.ws, entityIds: [acme], from: '2026-08-01', to: '2026-08-31' }
    expect((await k.engine.metric('revenue', { ...scope, basis: 'accrual' })).coverage?.gaps).toContain(waiting)
    expect((await k.engine.metric('revenue', { ...scope, basis: 'cash' })).coverage?.gaps).not.toContain(waiting)
    await k.engine.decideLink(k.ws, link?.id as string, 'confirmed', 'person-1')
    expect(await revenue('accrual') + await k.bal(acme, 'refunds', 'accrual')).toBe(-900_000)
    expect(await k.bal(acme, 'clearing_unmatched_receipts', 'accrual')).toBe(0)
  })

  it('a charge with its tax stated keeps the tax out of revenue; one without says it may hold some', async () => {
    const paypal = await k.connection({ entityId: acme, key: 'paypal' })
    const pp = await k.account({ entityId: acme, name: 'PayPal', type: 'processor_balance', connectionId: paypal })
    const co = await k.connection({ entityId: acme, key: 'stripe' })
    const st = await k.account({ entityId: acme, name: 'Stripe', type: 'processor_balance', connectionId: co })
    await k.engine.postBatch(k.ws, [stripe(pp, '2026-08-20', 'charge', 10_800, 0, { taxIncluded: usd(800) }), stripe(st, '2026-08-21', 'charge', 5_000, 0, {})])
    expect(await revenue('cash')).toBe(-15_000)
    expect(await k.bal(acme, 'sales_tax_payable', 'cash')).toBe(-800)
    expect(await k.tb(acme, 'cash')).toBe(0)
    const answer = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-08-01', to: '2026-08-31' })
    expect(answer.state).toBe('ok')
    expect(answer.coverage?.gaps).toContain('May include sales tax collected on 1 Stripe charge without an invoice')
    await k.engine.post(k.ws, stripe(st, '2026-08-22', 'charge', 2_000, 0, { taxIncluded: usd(200) }))
    expect((await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-08-01', to: '2026-08-31' })).coverage?.gaps).toContain('May include sales tax collected on 1 Stripe charge without an invoice')
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
