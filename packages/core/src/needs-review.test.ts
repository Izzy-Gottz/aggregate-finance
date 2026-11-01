// A deposit matched to one of two alike invoices: once confirmed it no longer "needs review", though the other
// invoice's suggestion is still on file (seen on the local recon run: Sushi $80 → 1018, 1019 left proposed).
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { invoice, makeKit, txn, usd, type Kit } from './test-kit.ts'

describe('needs review after a confirmed match', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('the leftover alternative does not keep the row in review', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    const inv = (n: string, due: string) => invoice(qb, { externalId: n, number: n, counterparty: 'Sushi by Katsuyuki', total: usd(8_000), issueDate: '2026-09-20', dueDate: due })
    await k.engine.postBatch(k.ws, [inv('1018', '2026-10-05'), inv('1019', '2026-10-12'), txn(bank, '2026-10-06', 8_000, { externalId: 'b', rawText: 'SUSHI BY KATSUYUKI' })])
    await k.engine.reconcile(k.ws)
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const row = async () => (await f.reader.searchTransactions(scope, { limit: 50 })).rows.find((r) => r.amount.minor === 8_000)
    expect((await row())?.needsReview).toBe(true)
    const links = await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })
    const docs = await k.engine.store.getRecords(k.ws, links.map((l) => l.fromId))
    const to1018 = links.find((l) => docs.find((d) => d.id === l.fromId)?.externalId === '1018')
    await k.engine.decideLink(k.ws, to1018?.id as string, 'confirmed', 'person')
    expect((await row())?.needsReview).toBe(false)
  })
})
