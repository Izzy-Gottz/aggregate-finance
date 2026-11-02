// Filed for you, through the real sync and the app's routes: a sync files what's obvious, the person sees the count,
// undo puts it back in Review, and Confirm all answers a group. Made-up companies and amounts.
import { describe, expect, it } from 'vitest'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('review: filed for you', () => {
  it('filed, undone, then confirmed together', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'filed@example.com', 'Acme')
      expect((await s.post('/api/entities', { name: 'Beta', kind: 'company', baseCurrency: 'USD' })).status).toBeLessThan(300)
      const E = await entities(s)
      for (const [company, name, sign] of [['Acme', 'Ally', -1], ['Beta', 'Northbank', 1]] as const) {
        const bank = await connectProvider(srv, s, 'plaid', { entityId: E[company], name })
        bank.push((c) => [
          { type: 'account.upsert', externalId: name, connectionId: c, name, accountType: 'depository', currency: 'USD', institution: name },
          { type: 'txn.upsert', externalId: `${name}1`, connectionId: c, accountExternalId: name, date: '2026-10-02', amount: usd(sign * 15_000), status: 'posted', rawText: 'ONLINE TRANSFER' },
          { type: 'txn.upsert', externalId: `${name}2`, connectionId: c, accountExternalId: name, date: '2026-10-05', amount: usd(sign * 20_000), status: 'posted', rawText: 'ONLINE TRANSFER' },
        ])
        expect((await bank.sync()).status).toBe('ok')
      }
      expect(SCENARIO_TODAY > '2026-10-05').toBe(true)

      const filed = (await s.get<{ count: number; items: Array<{ id: string; text: string }> }>('/api/review/filed')).body
      expect(filed.count).toBe(2)
      expect(filed.items.map((i) => i.text).sort()).toEqual(['$150.00 moved from Ally to Northbank on Oct 2', '$200.00 moved from Ally to Northbank on Oct 5'])
      expect((await s.get<unknown[]>('/api/review')).body).toEqual([])

      for (const i of filed.items) expect((await s.post(`/api/review/filed/${encodeURIComponent(i.id)}/undo`, {})).status).toBe(200)
      expect((await s.post(`/api/review/filed/${encodeURIComponent(filed.items[0]!.id)}/undo`, {})).status).toBe(404)
      const open = (await s.get<Array<{ id: string; question?: string; group?: { key: string; label: string } }>>('/api/review')).body
      expect(open).toHaveLength(2)
      expect(open[0]!.group).toEqual({ key: 'moves:companies', label: '2 moves between your companies' })

      // Only what the screen showed: an id that isn't in the group is ignored.
      const done = await s.post<{ ok: boolean; count: number }>(`/api/review/group/moves:companies`, { action: 'confirm', ids: [open[0]!.id, 'suggested_match:gone'] })
      expect(done.body).toEqual({ ok: true, count: 1 })
      expect((await s.get<unknown[]>('/api/review')).body).toHaveLength(1)
      expect((await s.post('/api/review/group/moves:companies', { action: 'edit', ids: [] })).status).toBe(400)
    } finally {
      await srv.close()
    }
  }, 120_000)
})
