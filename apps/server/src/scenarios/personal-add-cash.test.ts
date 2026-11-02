// Someone with only a Personal space adds cash in the app. Cash out comes off their Cash on hand.
import { describe, expect, it } from 'vitest'
import { connectProvider, entities, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('Add cash on Personal', () => {
  it('cash out comes off Personal Cash on hand', async () => {
    const srv = await startServer()
    try {
      const first = await signIn(srv, 'personal-only@example.com')
      expect((await first.post('/api/workspaces', {})).status).toBeLessThan(300)
      const s = await signIn(srv, 'personal-only@example.com')
      const E = await entities(s)
      expect(Object.keys(E)).toEqual(['Personal'])
      const pocket = await connectProvider(srv, s, 'plaid', { entityId: E.Personal, name: 'Pocket' })
      pocket.push((c) => [
        { type: 'account.upsert', externalId: 'hand', connectionId: c, name: 'Cash on hand', accountType: 'cash_on_hand', currency: 'USD' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'hand', at: '2026-10-01T08:00:00Z', current: usd(10_000) },
      ])
      expect((await pocket.sync()).status).toBe('ok')
      const add = (direction: string, idempotencyKey: string) =>
        s.post<{ status: string }>('/api/entries/cash', { entityId: E.Personal, direction, amount: usd(4_000), date: '2026-10-05', counterparty: 'Corner store', paidBy: 'company', idempotencyKey })
      const out = await add('out', 'personal-cash-out')
      expect(out).toMatchObject({ status: 201, body: { status: 'applied' } })
      const rows = await s.get<Array<{ account: string; amount: { minor: number } }>>(`/api/entities/${E.Personal}/transactions`)
      expect(rows.body).toMatchObject([{ account: 'Cash on hand', amount: { minor: -4_000 } }])
    } finally {
      await srv.close()
    }
  })

  it('cash in raises Cash on hand, and cash out lowers it', async () => {
    const srv = await startServer()
    try {
      const first = await signIn(srv, 'personal-hand@example.com')
      expect((await first.post('/api/workspaces', {})).status).toBeLessThan(300)
      const s = await signIn(srv, 'personal-hand@example.com')
      const { Personal } = await entities(s)
      const add = (direction: string, minor: number, idempotencyKey: string) =>
        s.post<{ status: string; summary?: string }>('/api/entries/cash', { entityId: Personal, direction, amount: usd(minor), date: '2026-10-05', counterparty: 'Corner store', paidBy: 'company', idempotencyKey })
      const cash = async () => (await s.get<{ entity: { cash: { minor: number } } }>(`/api/entities/${Personal}`)).body.entity.cash.minor
      const inn = await add('in', 10_000, 'personal-cash-in')
      expect(inn.body.summary).toContain('added to Cash on hand, not counted as income')
      expect(await cash()).toBe(10_000)
      expect((await add('out', 4_000, 'personal-cash-out')).body.status).toBe('applied')
      expect(await cash()).toBe(6_000)
    } finally {
      await srv.close()
    }
  })
})
