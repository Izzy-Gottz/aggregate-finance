// Some providers' terms (Wefunder: docs/partners/wefunder.md) require the data a person authorized deleted when they
// disconnect. connectionErased: it stops counting as with any removal (the bank side of a match posts on its own
// again), then its records and everything posted from them are gone. What other sources posted stays.
import { afterEach, describe, expect, it } from 'vitest'
import type { InvestmentEvent } from '@agfn/contracts'
import { createFinance } from './finance.ts'
import type { KyselyLedgerStore } from './kysely-store.ts'
import { makeKit, txn, usd, type Kit } from './test-kit.ts'

for (const backend of ['sqlite', 'pglite'] as const) {
  describe(`erasing a connection's data (${backend})`, () => {
    let k: Kit
    afterEach(async () => {
      await k.close()
    })

    it('deletes its records, entries, links and stored results; the bank row stays and the books balance', async () => {
      k = await makeKit(backend, { now: '2026-10-12T12:00:00.000Z' })
      const me = await k.personal('Me')
      const bank = await k.account({ entityId: me, name: 'Checking' })
      const wf = await k.connection({ entityId: me, key: 'wefunder' })
      const ev = (externalId: string, kind: InvestmentEvent['kind'], date: string, minor: number): InvestmentEvent => ({
        type: 'investment.event', externalId, connectionId: wf, kind, positionId: 'tide', issuer: 'Tidewell Health', securityType: 'safe', date, amount: usd(minor),
      })
      await k.engine.postBatch(k.ws, [txn(bank, '2026-03-01', 1_000_000), txn(bank, '2026-03-02', -250_000, { counterparty: 'Tidewell Health' })])
      await k.engine.postBatch(k.ws, [ev('inv-1', 'invest', '2026-03-02', 250_000), ev('mark-1', 'mark', '2026-09-30', 400_000), ev('dist-1', 'distribution', '2026-10-01', 10_000)])
      const fin = createFinance(k.engine)
      const scope = { workspaceId: k.ws, entityIds: [me] }
      const [pos] = await fin.reader.investments!(scope)
      expect(pos).toMatchObject({ issuer: 'Tidewell Health', source: { name: 'Wefunder', url: 'https://wefunder.com/portfolio' } })
      // A position's own page wins when the connector gives one on Wefunder's site; anything else keeps /portfolio.
      await k.engine.postBatch(k.ws, [{ ...ev('inv-2', 'invest', '2026-04-01', 10_000), positionId: 'acme', issuer: 'Acme', sourceUrl: 'https://wefunder.com/acme' }, { ...ev('inv-3', 'invest', '2026-04-01', 10_000), positionId: 'odd', issuer: 'Odd', sourceUrl: 'https://evil.example/x' }])
      const all = await fin.reader.investments!(scope)
      expect(all.find((p) => p.issuer === 'Acme')?.source?.url).toBe('https://wefunder.com/acme')
      expect(all.find((p) => p.issuer === 'Odd')?.source?.url).toBe('https://wefunder.com/portfolio')
      await fin.reader.overview(scope) // leaves a stored result behind

      const db = (k.engine.store as KyselyLedgerStore).scope.db
      const ids = (await db.selectFrom('ledger_records').select('id').where('connection_id', '=', wf).execute()).map((r) => r.id)
      expect(ids.length).toBeGreaterThanOrEqual(3)
      const linked = await db.selectFrom('ledger_links').select('id').where('status', '=', 'confirmed').where((eb) => eb.or([eb('from_id', 'in', ids), eb('to_id', 'in', ids)])).execute()
      expect(linked.length).toBe(1) // the wire matched to the investment

      expect(await k.engine.connectionErased(k.ws, wf)).toBe(ids.length)
      const count = async (q: Promise<unknown[]>) => (await q).length
      expect(await count(db.selectFrom('ledger_records').select('id').where('connection_id', '=', wf).execute())).toBe(0)
      expect(await count(db.selectFrom('journal_entries').select('id').where('source_id', 'in', ids).execute())).toBe(0)
      expect(await count(db.selectFrom('ledger_links').select('id').where((eb) => eb.or([eb('from_id', 'in', ids), eb('to_id', 'in', ids)])).execute())).toBe(0)
      expect(await count(db.selectFrom('ledger_derived').select('key_hash').where('workspace_id', '=', k.ws).execute())).toBe(0)
      // The bank's own rows still count, and the books balance on both bases.
      expect(await k.bal(me, `cash:${bank.id}`)).toBe(750_000)
      expect(await k.tb(me, 'cash')).toBe(0)
      expect(await k.tb(me, 'accrual')).toBe(0)
      expect(await fin.reader.investments!(scope)).toEqual([])
      // Again: nothing left to delete.
      expect(await k.engine.connectionErased(k.ws, wf)).toBe(0)
    })
  })
}
