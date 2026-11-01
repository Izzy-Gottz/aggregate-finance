// Money in clearing warns once it has waited over a week, counted from when the account last stood at zero, and says
// what is waiting: book payments not seen at the bank aren't transfers.
import { afterEach, describe, expect, it } from 'vitest'
import type { PaymentApplied } from '@agfn/contracts'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('clearing age and wording (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('old cleared history does not make a new payment overdue; the health line names book payments', async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    const pay = (externalId: string, date: string, minor: number, inv: string, bankTxnRef?: string): PaymentApplied => ({
      type: 'payment.applied', externalId, connectionId: qb, direction: 'receivable', date, amount: usd(minor), applications: [{ invoiceExternalId: inv, amount: usd(minor) }], ...(bankTxnRef ? { bankTxnRef } : {}),
    })
    await k.engine.postBatch(k.ws, [
      invoice(qb, { externalId: 'INV-1', total: usd(50_000), issueDate: '2026-05-20', dueDate: '2026-06-20' }),
      invoice(qb, { externalId: 'INV-2', total: usd(20_000), issueDate: '2026-09-20', dueDate: '2026-10-20' }),
      pay('P-1', '2026-06-01', 50_000, 'INV-1', 'bank-1'),
      txn(bank, '2026-06-01', 50_000, { externalId: 'bank-1' }),
      pay('P-2', '2026-10-06', 20_000, 'INV-2'),
    ])
    const clearing = async () => (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.name === 'clearing')
    expect(await clearing()).toEqual([])
    k.setNow('2026-10-20T12:00:00.000Z')
    expect(await clearing()).toMatchObject([{ status: 'warn', message: 'Acme: payments in the books, $200.00 net in, not seen at the bank for over a week' }])
    const health = await k.engine.dataHealth(k.ws, [acme])
    expect(health.line).toContain('payments in the books not seen at the bank')
    expect(health.line).not.toContain('transfer')
  })
})
