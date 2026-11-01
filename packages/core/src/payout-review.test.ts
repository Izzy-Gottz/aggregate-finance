// "What is this money?" for a company with a processor connected: a deposit the bank says came from Stripe is a payout
// (its sales are already revenue from Stripe's charges), so Revenue isn't offered for it; other deposits still offer
// Revenue, with the payout answer first.
import { afterEach, describe, expect, it } from 'vitest'
import type { Provenance, WriteCommand } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

const prov = (): Provenance => ({ writeRequestId: `wr_${Math.random().toString(36).slice(2)}`, actorKind: 'person', personId: 'person-owner', label: 'Owner' })

describe('unmatched payout deposits in review', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('a deposit naming the processor offers its payout, not Revenue; answering it books a payout, not sales', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-10-02', 150_000, { externalId: 'p', rawText: 'STRIPE TRANSFER ST-8812' }), txn(bank, '2026-10-03', 40_000, { externalId: 'c', rawText: 'GLOBEX ACH CREDIT' })])
    await k.engine.reconcile(k.ws)
    const items = (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'unexplained_money')
    const stripe = items.find((i) => i.detail.includes('STRIPE'))
    const other = items.find((i) => i.detail.includes('GLOBEX'))
    expect(stripe?.choices?.map((c) => c.edits.kind)).not.toContain('revenue')
    expect(stripe?.choices?.[0]).toEqual({ label: 'A Stripe payout (its sales are already counted)', edits: { kind: 'payout' } })
    // Not named: the payout answer comes first, Revenue stays (a customer may have paid by bank).
    expect(other?.choices?.slice(0, 2).map((c) => c.edits.kind)).toEqual(['payout', 'revenue'])

    const f = createFinance(k.engine)
    const cmd: WriteCommand = { op: 'resolve_review_item', workspaceId: k.ws, entityId: acme, payload: { reviewItemId: stripe?.id, decision: 'edit', edits: { kind: 'payout' } } }
    await f.writer.apply(cmd, prov())
    expect(await k.bal(acme, 'revenue')).toBe(0)
    expect(await k.bal(acme, 'clearing_payouts')).toBe(-150_000)
    expect(await k.tb(acme, 'cash')).toBe(0)
  })
})
