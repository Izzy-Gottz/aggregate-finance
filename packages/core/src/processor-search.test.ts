// A processor row's own description (Stripe: "Bean Club (Ana): Subscription update") is searchable: the benchmark's
// Haiku found 0 Bean Club charges because search saw only the row's kind ("charge").
// A charge with a fee lists as two rows (gross, then the fee) that add up to its net, as the P&L counts them.
import { WriteRejected } from '@agfn/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, stripe, type Kit } from './test-kit.ts'

describe('searching processor rows', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('matches the description, not just the kind', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      stripe(bal, '2026-09-03', 'charge', 4_000, 146, { customer: 'cus_ana', counterparty: 'Ana', description: 'Bean Club (Ana): Subscription update' }),
      stripe(bal, '2026-09-04', 'charge', 900, 56, { customer: 'cus_bo', counterparty: 'Bo', description: 'Espresso, in store' }),
    ])
    const f = createFinance(k.engine)
    const found = await f.reader.searchTransactions({ workspaceId: k.ws, entityIds: [acme] }, { text: 'bean club', limit: 50 })
    expect(found.rows.map((r) => r.counterparty)).toEqual(['Ana'])
  })

  // Benchmark fees-07: "fees on Bean Club charges". The words find the charges; their fee rows are named for Stripe,
  // so only a query for fees also finds them by the charge's words (a plain word query stays at gross).
  it('finds the fees of the charges a word matches, when the query asks for fees', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      stripe(bal, '2026-09-03', 'charge', 4_000, 146, { customer: 'cus_ana', counterparty: 'Ana', description: 'Bean Club (Ana): Subscription update' }),
      stripe(bal, '2026-09-04', 'charge', 900, 56, { customer: 'cus_bo', counterparty: 'Bo', description: 'Espresso, in store' }),
    ])
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    expect((await f.reader.searchTransactions(scope, { q: '"Bean Club"', limit: 50 })).sums).toEqual([{ minor: 4_000, currency: 'USD' }])
    const fees = await f.reader.searchTransactions(scope, { q: '"Bean Club" category:processor_fees', limit: 50 })
    expect(fees.rows.map((r) => [r.kind, r.amount.minor])).toEqual([['fee', -146]])
    expect((await f.reader.searchTransactions(scope, { text: 'bean', category: 'processor_fees', limit: 50 })).sums).toEqual([{ minor: -146, currency: 'USD' }])
    expect((await f.reader.searchTransactions(scope, { q: 'stripe category:processor_fees', limit: 50 })).rows).toHaveLength(2)
  })

  it('lists a charge at gross and its fee as its own row, together, adding up to net', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      stripe(bal, '2026-09-03', 'charge', 4_000, 146, { counterparty: 'Ana', payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-04', 'charge', 900, 56, { counterparty: 'Bo', payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-04', 'refund', -900, 0, { counterparty: 'Bo', payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-06', 'payout', -3_798, 0, { payoutExternalId: 'po_1' }),
    ])
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const all = await f.reader.searchTransactions(scope, { limit: 50 })
    expect(all.rows.map((r) => [r.date, r.amount.minor, r.kind === 'fee' ? 'fee' : r.counterparty ?? ''])).toEqual([
      ['2026-09-06', -3_798, ''],
      ['2026-09-04', -900, 'Bo'],
      ['2026-09-04', 900, 'Bo'],
      ['2026-09-04', -56, 'fee'],
      ['2026-09-03', 4_000, 'Ana'],
      ['2026-09-03', -146, 'fee'],
    ])
    // The fee follows its charge, and everything still adds up to what moved (net).
    const ana = all.rows.findIndex((r) => r.counterparty === 'Ana')
    expect(all.rows[ana + 1]).toMatchObject({ id: `${all.rows[ana]?.id}:fee`, amount: { minor: -146 }, kind: 'fee', category: 'processor_fees', counterparty: 'Stripe' })
    expect(all.sums).toEqual([{ minor: 0, currency: 'USD' }])
    // Money in is gross sales; fees are found by name.
    expect((await f.reader.searchTransactions(scope, { direction: 'in', limit: 50 })).sums).toEqual([{ minor: 4_900, currency: 'USD' }])
    expect((await f.reader.searchTransactions(scope, { q: 'out fee', limit: 50 })).sums).toEqual([{ minor: -202, currency: 'USD' }])
    expect((await f.reader.searchTransactions(scope, { category: 'processor_fees', limit: 50 })).rows).toHaveLength(2)
    // A page never ends between a charge and its fee.
    const first = await f.reader.searchTransactions(scope, { limit: 5 })
    expect(first.rows.at(-1)?.kind).toBe('fee')
    expect(first.rows).toHaveLength(6)
    // The fee row opens its charge; writes to it are refused in plain words.
    const feeId = all.rows[ana + 1]?.id as string
    expect((await f.reader.getRecord(k.ws, feeId))?.id).toBe(all.rows[ana]?.id)
    await expect(f.writer.revert(k.ws, feeId, { kind: 'person', personId: 'p', via: 'ui' } as never)).rejects.toThrow(WriteRejected)
    await expect(f.writer.revert(k.ws, feeId, { kind: 'person', personId: 'p', via: 'ui' } as never)).rejects.toThrow(/follows its charge/)
  })

  it('shows what a payout paid out', async () => {
    k = await makeKit('memory', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const bal = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      stripe(bal, '2026-09-03', 'charge', 4_000, 146, { payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-04', 'charge', 900, 56, { payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-04', 'refund', -500, 0, { payoutExternalId: 'po_1' }),
      stripe(bal, '2026-09-05', 'charge', 700, 50, { payoutExternalId: 'po_2' }),
      stripe(bal, '2026-09-06', 'payout', -4_198, 0, { payoutExternalId: 'po_1' }),
    ])
    const f = createFinance(k.engine)
    const payout = (await f.reader.searchTransactions({ workspaceId: k.ws, entityIds: [acme] }, { q: 'payout', limit: 5 })).rows[0]
    const rec = await f.reader.getRecord(k.ws, payout?.id as string)
    const usd = (minor: number) => ({ minor, currency: 'USD' })
    expect(rec?.data['payout']).toMatchObject({ charges: 2, gross: usd(4_900), refunds: usd(500), fees: usd(202), other: usd(0), net: usd(4_198) })
    expect((rec?.data['payout'] as { chargeIds: string[] }).chargeIds).toHaveLength(2)
  })
})
