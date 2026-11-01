// Each invoice lists the payments matched to it, with what each applied to it, so "bills paid in two payments" is
// one read (benchmark bills-09), and the payments always add up to amountPaid when they cover the invoice.
import { afterEach, describe, expect, it } from 'vitest'
import type { PaymentApplied } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('invoice payments (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('lists each payment with what it applied, adding up to amountPaid; [] when unpaid', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    const inv = (n: string, minor: number, counterparty: string, o: Partial<Parameters<typeof invoice>[1]> = {}) =>
      invoice(qb, { externalId: n, number: n, counterparty, total: usd(minor), issueDate: '2026-09-01', dueDate: '2026-10-01', ...o })
    // 1007: part paid in the books (P-1), the rest by a bank row. 2001 and 2002: one payment settles both.
    const partial: PaymentApplied = { type: 'payment.applied', externalId: 'P-1', connectionId: qb, direction: 'receivable', date: '2026-09-05', amount: usd(30_000), applications: [{ invoiceExternalId: '1007', amount: usd(30_000) }] }
    const both: PaymentApplied = {
      type: 'payment.applied', externalId: 'P-2', connectionId: qb, direction: 'receivable', date: '2026-09-10', amount: usd(5_000),
      applications: [{ invoiceExternalId: '2001', amount: usd(2_000) }, { invoiceExternalId: '2002', amount: usd(3_000) }],
    }
    await k.engine.postBatch(k.ws, [
      inv('1007', 75_000, 'John Melton', { status: 'partially_paid', amountPaid: usd(30_000) }),
      partial,
      txn(bank, '2026-09-21', 45_000, { externalId: 'b1', rawText: 'JOHN MELTON ZELLE' }),
      inv('2001', 2_000, 'Globex Corp', { status: 'paid', amountPaid: usd(2_000) }),
      inv('2002', 3_000, 'Globex Corp', { status: 'paid', amountPaid: usd(3_000) }),
      both,
      inv('3001', 9_900, 'Initech'),
    ])
    await k.engine.reconcile(k.ws)
    for (const l of await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'], statuses: ['proposed'] })) await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person')

    const f = createFinance(k.engine)
    const res = await f.reader.searchInvoices({ workspaceId: k.ws, entityIds: [acme] }, { limit: 50 })
    const by = new Map(res.rows.map((v) => [v.number, v]))
    expect(by.get('1007')?.payments?.map((p) => [p.date, p.amount.minor])).toEqual([['2026-09-05', 30_000], ['2026-09-21', 45_000]])
    expect(by.get('2001')?.payments?.map((p) => p.amount.minor)).toEqual([2_000])
    expect(by.get('2002')?.payments?.map((p) => p.amount.minor)).toEqual([3_000])
    expect(by.get('3001')?.payments).toEqual([])
    // Payments that cover an invoice add up to what it says was paid.
    for (const v of res.rows) if (v.payments?.length) expect(v.payments.reduce((a, p) => a + p.amount.minor, 0)).toBe(v.amountPaid.minor)
  })
})
