// Confirming a suggested match is undoable by the record the answer returns (the deposit), pairs included
// (43's run: undo on that id answered "Nothing to undo").
import { afterEach, describe, expect, it } from 'vitest'
import type { Provenance, WriteCommand } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import { invoice, makeKit, txn, usd, type Kit } from './test-kit.ts'

const prov = (): Provenance => ({ writeRequestId: `wr_${Math.random().toString(36).slice(2)}`, actorKind: 'person', personId: 'person-owner', label: 'Owner' })

describe('undo a confirmed match', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a two-invoice match confirmed in Review goes back to a question, AR owed again', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const bank = await k.account({ entityId: acme })
    const inv = (n: string, minor: number, who: string) => invoice(qb, { externalId: n, number: n, counterparty: who, total: usd(minor), issueDate: '2026-09-01', dueDate: '2026-10-01' })
    await k.engine.postBatch(k.ws, [inv('1035', 31_428, 'Mark Cho'), inv('1034', 7_860, 'Rondonuwu Fruit and Vegi'), txn(bank, '2026-10-10', 39_288, { rawText: 'MOBILE DEPOSIT 2 CHECKS' })])
    await k.engine.reconcile(k.ws)
    const f = createFinance(k.engine)
    const item = (await k.engine.reviewItems(k.ws)).find((i) => i.kind === 'suggested_match')
    const cmd: WriteCommand = { op: 'resolve_review_item', workspaceId: k.ws, entityId: acme, payload: { reviewItemId: item?.id, decision: 'confirm', edits: null } }
    const res = await f.writer.apply(cmd, prov())
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(0)
    await f.writer.revert(k.ws, res.recordId, prov())
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(39_288)
    expect((await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })).map((l) => l.status)).toEqual(['proposed', 'proposed'])
    expect((await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match')).toHaveLength(1)
  })
})
