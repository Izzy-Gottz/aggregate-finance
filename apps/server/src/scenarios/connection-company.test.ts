// Moving a connection to another company (also under Postgres RLS with AGFN_TEST_PG_RLS=1): its records re-post there.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { withBypass } from '@agfn/db'
import { connectProvider, entities, signIn, startServer } from './harness.ts'

describe('a connection moves to another company', () => {
  it('re-posts its invoice and account there', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'mover14@example.com', 'Demo Company')
      const E = await entities(s)
      const other = await s.post<{ id: string }>('/api/entities', { name: 'Side Project LLC' })
      const books = await connectProvider(srv, s, 'quickbooks', { entityId: E['Demo Company'], name: 'Books' })
      books.push((connectionId) => [
        { type: 'account.upsert', externalId: 'chk', name: 'Checking', accountType: 'depository', currency: 'USD', connectionId },
        { type: 'invoice.upsert', externalId: 'i1', direction: 'receivable', number: 'SP-1', counterparty: 'Globex', issueDate: '2026-09-01', dueDate: '2026-10-01', total: { minor: 50_000, currency: 'USD' }, amountPaid: { minor: 0, currency: 'USD' }, status: 'open', connectionId },
      ] as NormalizedEvent[])
      expect((await books.sync()).status).toBe('ok')
      const res = await s.post<{ moved: number }>(`/api/connections/${books.id}/company`, { entityId: other.body.id })
      expect([res.status, res.body.moved]).toEqual([200, 1])
      const db = srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
      const rec = await withBypass('test:read', () => db.selectFrom('ledger_records').select(['entity_id', 'status']).where('connection_id', '=', books.id).where('event_type', '=', 'invoice.upsert').executeTakeFirstOrThrow())
      expect(rec).toEqual({ entity_id: other.body.id, status: 'posted' })
      const acct = await withBypass('test:read', () => db.selectFrom('accounts').select('entity_id').where('connection_id', '=', books.id).executeTakeFirstOrThrow())
      expect(acct.entity_id).toBe(other.body.id)
    } finally {
      await srv.close()
    }
  })
})
