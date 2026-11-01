// "What is this money?" offers the company's open invoices: a match rejected by mistake can still be told as the
// invoice payment it is (seen on the local recon run: Barnett $274.50, rejected, then only Revenue was offered).
import { afterEach, describe, expect, it } from 'vitest'
import type { Provenance, WriteCommand } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import { invoice, makeKit, txn, usd, type Kit } from './test-kit.ts'

const prov = (): Provenance => ({ writeRequestId: `wr_${Math.random().toString(36).slice(2)}`, actorKind: 'person', personId: 'person-owner', label: 'Owner' })

describe('pays an invoice, from "What is this money?"', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a rejected match comes back as an answer; choosing it settles the invoice; undo puts it back', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    await k.engine.postBatch(k.ws, [
      invoice(qb, { externalId: '1012', number: '1012', counterparty: 'Barnett Design', total: usd(27_450), issueDate: '2026-09-15', dueDate: '2026-10-15' }),
      invoice(qb, { externalId: '1020', number: '1020', counterparty: 'Someone Else', total: usd(90_000), issueDate: '2026-09-15', dueDate: '2026-10-15' }),
      txn(bank, '2026-10-02', 27_450, { externalId: 'b', rawText: 'BARNETT DESIGN ACH CREDIT' }),
    ])
    await k.engine.reconcile(k.ws)
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const cmd = (payload: Record<string, unknown>): WriteCommand => ({ op: 'resolve_review_item', workspaceId: k.ws, entityId: acme, payload })
    const match = (await f.reader.reviewItems(scope)).find((i) => i.kind === 'suggested_match')
    await f.writer.apply(cmd({ reviewItemId: match?.id, decision: 'reject', edits: null }), prov())
    const what = (await k.engine.reviewItems(k.ws)).find((i) => i.kind === 'unexplained_money')
    expect(what?.choices?.slice(0, 2).map((c) => c.label)).toEqual(['Pays invoice 1012 to Barnett Design · $274.50 open', 'Pays invoice 1020 to Someone Else · $900.00 open'])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(117_450)
    const res = await f.writer.apply(cmd({ reviewItemId: what?.id, decision: 'edit', edits: what?.choices?.[0]?.edits }), prov())
    expect(res.summary).toBe('Linked: pays invoice 1012 ($274.50)')
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(90_000)
    expect(await k.bal(acme, 'suspense', 'accrual')).toBe(0)
    expect(await k.tb(acme, 'accrual')).toBe(0)
    expect((await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'unexplained_money')).toEqual([])
    // Undo by the money's record (the id the answer returns): owed again.
    await f.writer.revert(k.ws, res.recordId, prov())
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(117_450)
  })
})
