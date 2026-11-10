// The money-out rows behind "bills due" are read once per ledger version when a cache is given, not on every call.
import type { FinanceReader, TxnView } from '@agfn/contracts'
import { describe, expect, it } from 'vitest'
import { createRecurring } from './index.ts'

const scope = { workspaceId: 'ws_1', entityIds: ['ent_b', 'ent_a'] }
const row = (id: string, date: string): TxnView =>
  ({ id, entityId: 'ent_a', date, amount: { minor: -1_500, currency: 'USD' }, status: 'posted', counterparty: 'Figma', links: [], needsReview: false }) as unknown as TxnView

function reader() {
  let reads = 0
  const r: Pick<FinanceReader, 'searchTransactions' | 'searchInvoices'> = {
    searchTransactions: (async () => {
      reads++
      return { rows: ['2026-07-03', '2026-08-03', '2026-09-03'].map((d, i) => row(`t${i}`, d)), sums: [] }
    }) as never,
    searchInvoices: (async () => ({ rows: [], sums: [] })) as never,
  }
  return { r, reads: () => reads }
}

describe('recurring', () => {
  it('without a cache, every call reads the rows again', async () => {
    const { r, reads } = reader()
    const rec = createRecurring(r)
    await rec.list(scope, { asOf: '2026-10-11' })
    await rec.due(scope, '2026-10-11', 30)
    expect(reads()).toBe(2)
  })

  it('with a cache, the rows are read once per key (companies in any order, the same day) and the answer is the same', async () => {
    const { r, reads } = reader()
    const store = new Map<string, Promise<unknown>>()
    const keys: string[] = []
    const cacheFor = (ws: string) => <T,>(key: string, fn: () => Promise<T>) => {
      keys.push(`${ws}|${key}`)
      if (!store.has(`${ws}|${key}`)) store.set(`${ws}|${key}`, fn())
      return store.get(`${ws}|${key}`) as Promise<T>
    }
    const cached = createRecurring(r, { cacheFor })
    const first = await cached.list(scope, { asOf: '2026-10-11' })
    const again = await cached.list({ ...scope, entityIds: ['ent_a', 'ent_b'] }, { asOf: '2026-10-11' })
    await cached.due(scope, '2026-10-11', 30)
    expect(reads()).toBe(1)
    expect(again).toEqual(first)
    expect(new Set(keys)).toEqual(new Set(['ws_1|recurring:rows|ent_a,ent_b|2026-10-11']))
    expect(first).toEqual(await createRecurring(reader().r).list(scope, { asOf: '2026-10-11' }))
    // Another day is another key.
    await cached.list(scope, { asOf: '2026-10-12' })
    expect(reads()).toBe(2)
  })

  it('a yearly bill paid twice is read back far enough to be seen twice, and is confirmed', async () => {
    const asked: string[] = []
    const all = [row('y1', '2024-11-01'), row('y2', '2025-11-01')].map((t) => ({ ...t, counterparty: 'Domain Registrar' }))
    const r: Pick<FinanceReader, 'searchTransactions' | 'searchInvoices'> = {
      searchTransactions: (async (_s: unknown, q: { from: string; to: string }) => {
        asked.push(q.from)
        return { rows: all.filter((t) => t.date >= q.from && t.date <= q.to), sums: [] }
      }) as never,
      searchInvoices: (async () => ({ rows: [], sums: [] })) as never,
    }
    const list = await createRecurring(r).list(scope, { asOf: '2026-10-11' })
    expect(asked[0]).toBe('2024-09-11')
    expect(list).toEqual([expect.objectContaining({ counterparty: 'Domain Registrar', cadence: 'yearly', status: 'active', nextDue: '2026-11-01' })])
  })

  it("Stripe's fee on a customer's yearly charge is not a yearly Stripe bill", async () => {
    const fees = [row('ch1:fee', '2024-11-01'), row('ch2:fee', '2025-11-01')].map((t) => ({ ...t, counterparty: 'Stripe', kind: 'fee', category: 'processor_fees' }))
    const r: Pick<FinanceReader, 'searchTransactions' | 'searchInvoices'> = {
      searchTransactions: (async () => ({ rows: fees, sums: [] })) as never,
      searchInvoices: (async () => ({ rows: [], sums: [] })) as never,
    }
    expect(await createRecurring(r).list(scope, { asOf: '2026-10-11' })).toEqual([])
  })
})
