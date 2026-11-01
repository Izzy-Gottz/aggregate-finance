// Journals from the books (journal.upsert) and bills that buy things the company owns, golden answers on memory and SQLite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JournalUpsert } from '@agfn/contracts'
import { invoice, makeKit, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

function journal(connectionId: string, lines: Array<[string, number]>, o: Partial<JournalUpsert> = {}): JournalUpsert {
  return {
    type: 'journal.upsert',
    externalId: 'je-1',
    connectionId,
    date: '2026-09-30',
    memo: 'Cost of goods sold',
    lines: lines.map(([role, minor]) => ({ role, amount: usd(minor) })),
    ...o,
  }
}

describe.each(backends)('journals from the books (%s)', (backend) => {
  let k: Kit
  let acme: string
  let books: string

  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
    books = await k.connection({ entityId: acme, key: 'quickbooks' })
  })
  afterEach(async () => {
    await k.close()
  })

  it('posts cost of goods sold out of inventory on both bases, once', async () => {
    const je = journal(books, [['cogs', 13_500], ['inventory', -13_500]])
    const [res] = await k.engine.postBatch(k.ws, [je])
    expect(res?.status).toBe('posted')
    await k.engine.postBatch(k.ws, [je]) // the same journal synced again
    for (const basis of ['cash', 'accrual'] as const) {
      expect(await k.bal(acme, 'cogs', basis)).toBe(13_500)
      expect(await k.bal(acme, 'inventory', basis)).toBe(-13_500)
      expect(await k.tb(acme, basis)).toBe(0)
    }
  })

  it('an edited journal replaces the old one; a voided one comes back out', async () => {
    await k.engine.postBatch(k.ws, [journal(books, [['cogs', 13_500], ['inventory', -13_500]])])
    await k.engine.postBatch(k.ws, [journal(books, [['cogs', 10_000], ['other_expense', 3_500], ['inventory', -13_500]])])
    expect(await k.bal(acme, 'cogs', 'accrual')).toBe(10_000)
    expect(await k.bal(acme, 'other_expense', 'accrual')).toBe(3_500)
    expect(await k.bal(acme, 'inventory', 'accrual')).toBe(-13_500)
    const [res] = await k.engine.postBatch(k.ws, [journal(books, [['cogs', 10_000], ['other_expense', 3_500], ['inventory', -13_500]], { status: 'void' })])
    expect(res?.status).toBe('recorded')
    for (const role of ['cogs', 'other_expense', 'inventory']) expect(await k.bal(acme, role, 'accrual')).toBe(0)
  })

  it("refuses a journal that doesn't balance or that touches money at the bank", async () => {
    await expect(k.engine.postBatch(k.ws, [journal(books, [['cogs', 13_500], ['inventory', -13_000]])])).rejects.toThrow("don't balance in USD (off by 500)")
    await expect(k.engine.postBatch(k.ws, [journal(books, [['rent', 200_000], ['cash_on_hand', -200_000]])])).rejects.toThrow('"cash_on_hand" can\'t be used')
    await expect(k.engine.postBatch(k.ws, [journal(books, [['software', 5_000], ['card:abc', -5_000]])])).rejects.toThrow('"card:abc" can\'t be used')
    await expect(k.engine.postBatch(k.ws, [journal(books, [['software', 5_000], ['clearing_payouts', -5_000]])])).rejects.toThrow('can\'t be used')
    await expect(k.engine.postBatch(k.ws, [journal(books, [['cogs', 0]])])).rejects.toThrow('2 to 500 lines')
    expect(await k.tb(acme, 'accrual')).toBe(0)
  })

  it('waits for a company when the books connection has none', async () => {
    const loose = await k.connection({ entityId: null, key: 'quickbooks' })
    const [res] = await k.engine.postBatch(k.ws, [journal(loose, [['cogs', 13_500], ['inventory', -13_500]], { externalId: 'je-2' })])
    expect(res?.status).toBe('unassigned')
    expect(await k.bal(acme, 'cogs', 'accrual')).toBe(0)
  })

  it('bills can buy inventory, equipment and prepayments, not just expenses', async () => {
    await k.engine.post(
      k.ws,
      invoice(books, {
        direction: 'payable',
        counterparty: 'Supplier',
        total: usd(60_000),
        lines: [
          { description: 'Widgets', amount: usd(30_000), category: 'inventory' },
          { description: 'Laptop', amount: usd(20_000), category: 'fixed_assets' },
          { description: 'Annual insurance', amount: usd(10_000), category: 'prepaid' },
        ] as never,
      }),
    )
    expect(await k.bal(acme, 'inventory', 'accrual')).toBe(30_000)
    expect(await k.bal(acme, 'fixed_assets', 'accrual')).toBe(20_000)
    expect(await k.bal(acme, 'prepaid', 'accrual')).toBe(10_000)
    expect(await k.bal(acme, 'ap', 'accrual')).toBe(-60_000)
  })
})
