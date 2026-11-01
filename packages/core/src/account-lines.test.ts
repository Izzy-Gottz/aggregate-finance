// Lines on Postgres are read as plain statements joined here: any SQL join of entries and lines let a new workspace's
// 1-row estimate pick a nested loop (staging: 13.6 s after a write; 9.4 s for a company's lines under load). Same rows,
// in the same order, as the joined query.
import { afterEach, describe, expect, it } from 'vitest'
import type { KyselyLedgerStore } from './kysely-store.ts'
import type { LineFilter } from './store.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('lines on Postgres', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('match the joined query, for every filter', async () => {
    k = await makeKit('pglite', { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const beta = await k.company('Beta')
    const a = await k.account({ entityId: acme, name: 'Checking' })
    const b = await k.account({ entityId: acme, name: 'Card', type: 'credit_card' })
    const c = await k.account({ entityId: beta, name: 'Checking' })
    await k.engine.postBatch(k.ws, [
      ...Array.from({ length: 40 }, (_, i) => txn(a, `2026-0${1 + (i % 9)}-1${i % 10}`, (i % 2 ? -1 : 1) * (1_000 + i))),
      ...Array.from({ length: 10 }, (_, i) => txn(b, `2026-0${1 + (i % 9)}-2${i % 8}`, -(500 + i))),
      ...Array.from({ length: 15 }, (_, i) => txn(c, `2026-0${1 + (i % 9)}-0${1 + (i % 9)}`, 700 + i)),
    ])
    const store = k.engine.store as KyselyLedgerStore
    // The joined query, as SQLite still runs it.
    const joined = async (f: LineFilter) => {
      let q = store.scope
        .q()
        .selectFrom('journal_lines as l')
        .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
        .selectAll('l')
        .select(['e.entity_id', 'e.date', 'e.basis', 'e.kind', 'e.source_id'])
        .where('e.workspace_id', '=', k.ws)
        .where('e.basis', 'in', [f.basis, 'both'])
      if (f.entityIds) q = q.where('e.entity_id', 'in', f.entityIds)
      if (f.fromDate) q = q.where('e.date', '>=', f.fromDate)
      if (f.toDate) q = q.where('e.date', '<=', f.toDate)
      if (f.ledgerAccountIds) q = q.where('l.ledger_account_id', 'in', f.ledgerAccountIds)
      if (f.excludeSourceId) q = q.where('e.source_id', '!=', f.excludeSourceId)
      if (f.sourceIds) q = q.where('e.source_id', 'in', f.sourceIds)
      return (await q.orderBy('e.date').orderBy('l.id').execute()).map((r) => r.id)
    }
    const accounts = (await store.listLedgerAccounts(k.ws)).map((x) => x.id)
    const one = (await store.listLines(k.ws, { basis: 'cash', entityIds: [acme] }))[0]!
    const filters: LineFilter[] = [
      { basis: 'cash' },
      { basis: 'accrual' },
      { basis: 'cash', entityIds: [acme] },
      { basis: 'cash', entityIds: [acme, beta], fromDate: '2026-03-01', toDate: '2026-07-31' },
      { basis: 'cash', ledgerAccountIds: accounts },
      { basis: 'cash', ledgerAccountIds: accounts, entityIds: [beta] },
      { basis: 'cash', ledgerAccountIds: accounts, fromDate: '2026-03-01', toDate: '2026-07-31' },
      { basis: 'cash', sourceIds: [one.sourceId] },
      { basis: 'cash', entityIds: [acme], excludeSourceId: one.sourceId },
    ]
    for (const f of filters) {
      const ids = await joined(f)
      if (f.basis === 'cash') expect(ids.length, JSON.stringify(f)).toBeGreaterThan(0)
      expect((await store.listLines(k.ws, f)).map((l) => l.id), JSON.stringify(f)).toEqual(ids)
    }
    const full = await store.listLines(k.ws, { basis: 'cash', entityIds: [acme] })
    expect(full[0]).toMatchObject({ entityId: acme, sourceId: expect.any(String), date: expect.any(String) })
    for (const f of [{ entityIds: [] }, { ledgerAccountIds: [] }, { sourceIds: [] }]) expect(await store.listLines(k.ws, { basis: 'cash', ...f })).toEqual([])
  })
})
