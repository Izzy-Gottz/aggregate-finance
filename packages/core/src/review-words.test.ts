// Review says bill for a bill and names the document (seen on the local recon run: bills read "invoice payment").
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, txn, usd, type Kit } from './test-kit.ts'

describe('match wording in Review', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a bill paid from the bank is a bill payment, an invoice paid into it an invoice payment', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    await k.engine.postBatch(k.ws, [
      invoice(qb, { externalId: 'b78', number: '78', direction: 'payable', counterparty: 'PG&E', total: usd(8_644), issueDate: '2026-08-20', dueDate: '2026-09-05' }),
      invoice(qb, { externalId: 'i1024', number: '1024', counterparty: 'Red Rock Diner', total: usd(15_600), issueDate: '2026-08-01', dueDate: '2026-08-31' }),
      txn(bank, '2026-09-01', -8_644, { rawText: 'PG&E WEB ONLINE PAYMENT' }),
      txn(bank, '2026-08-10', 15_600, { rawText: 'RED ROCK DINER PAYMENT' }),
    ])
    await k.engine.reconcile(k.ws)
    const items = (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match').map((i) => [i.title, i.confirmLabel]).sort()
    expect(items).toEqual([
      ['Same money? (bill payment)', 'Confirm: payment of bill 78'],
      ['Same money? (invoice payment)', 'Confirm: payment of invoice 1024'],
    ])
  })
})
