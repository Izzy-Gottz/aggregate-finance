// Red team 21: a completed full listing (listing.complete) voids only what the provider really deleted. Through the
// real server, sync engine, books route and ledger: unchanged documents count as seen (they used to stop at the books
// store), an empty or mostly-empty listing voids nothing, and a deleted document leaves the ledger and the books
// store together and comes back if the provider sends it again.
import { describe, expect, it } from 'vitest'
import type { InvoiceUpsert, NormalizedEvent } from '@agfn/contracts'
import { withBypass } from '@agfn/db'
import { connectProvider, entities, signIn, startServer } from '../scenarios/harness.ts'

const usd = (minor: number) => ({ minor, currency: 'USD' })
const invoice = (connectionId: string, n: number): InvoiceUpsert => ({
  type: 'invoice.upsert',
  externalId: `inv-${n}`,
  connectionId,
  direction: 'receivable',
  number: `INV-${n}`,
  counterparty: 'Globex',
  issueDate: '2026-09-01',
  dueDate: '2026-10-01',
  total: usd(10_000 + n),
  amountPaid: usd(0),
  status: 'open',
  lines: [{ description: 'Work', amount: usd(10_000 + n), category: 'revenue' }],
})
const listing = (connectionId: string, startedAt: string): NormalizedEvent => ({ type: 'listing.complete', externalId: `listing:${startedAt}`, connectionId, kinds: ['invoice'], startedAt })

describe('red team 21: full listings void only real deletions', () => {
  it('unchanged documents are seen; empty and mostly-empty listings void nothing; a deletion voids ledger and books; a resend revives', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder21@example.com', 'Acme')
      const acme = (await entities(s)).Acme as string
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: acme, name: 'QuickBooks' })
      const db = srv.booted.services.db
      const state = () =>
        withBypass('test:read', async () => {
          const ledger = await (db as never as import('kysely').Kysely<{ ledger_records: { connection_id: string; event_type: string; external_id: string; status: string } }>).selectFrom('ledger_records').select(['external_id', 'status']).where('connection_id', '=', qb.id).where('event_type', '=', 'invoice.upsert').execute()
          const books = await (db as never as import('kysely').Kysely<{ books_documents: { external_id: string; voided_at: string | null; connection_id: string | null } }>)
            .selectFrom('books_documents')
            .select(['external_id', 'voided_at'])
            .where('connection_id', '=', qb.id)
            .execute()
          return {
            ledgerVoid: ledger.filter((r) => r.status === 'void').map((r) => r.external_id).sort(),
            ledgerLive: ledger.filter((r) => r.status !== 'void').length,
            booksVoid: books.filter((r) => r.voided_at !== null).map((r) => r.external_id).sort(),
          }
        })
      const all = (id: string, ns: number[]) => ns.map((n) => invoice(id, n))
      const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
      const now = () => new Date().toISOString()

      // A full backfill of 12 invoices, then its listing: nothing to void.
      let t = now()
      qb.push((id) => [...all(id, range(1, 12)), listing(id, t)])
      await qb.sync()
      expect(await state()).toEqual({ ledgerVoid: [], ledgerLive: 12, booksVoid: [] })

      // The next full pass sends 11 of them unchanged: invoice 12 was deleted in QuickBooks.
      t = now()
      qb.push((id) => [...all(id, range(1, 11)), listing(id, t)])
      await qb.sync()
      expect(await state()).toEqual({ ledgerVoid: ['inv-12'], ledgerLive: 11, booksVoid: ['inv-12'] })

      // A listing that carried nothing (a provider glitch, an empty page) voids nothing.
      t = now()
      qb.push((id) => [listing(id, t)])
      await qb.sync()
      expect((await state()).ledgerLive).toBe(11)

      // Nor one that would void more than half.
      t = now()
      qb.push((id) => [...all(id, range(1, 3)), listing(id, t)])
      await qb.sync()
      expect((await state()).ledgerLive).toBe(11)
      const outcomes = await withBypass('test:read', () => (db as never as import('kysely').Kysely<{ ledger_listings: { connection_id: string; skipped_reason: string | null; voided: number } }>).selectFrom('ledger_listings').select(['skipped_reason', 'voided']).where('connection_id', '=', qb.id).execute())
      expect(outcomes.some((o) => /more than half/.test(o.skipped_reason ?? ''))).toBe(true)

      // QuickBooks sends invoice 12 again (restored): it's back in both.
      qb.push((id) => [invoice(id, 12)])
      await qb.sync()
      expect(await state()).toEqual({ ledgerVoid: [], ledgerLive: 12, booksVoid: [] })
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('a credit note deleted in the provider is voided too; credit notes still listed stay', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder21cn@example.com', 'Acme')
      const acme = (await entities(s)).Acme as string
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: acme, name: 'QuickBooks' })
      const note = (connectionId: string, n: number): NormalizedEvent => ({ type: 'credit_note.upsert', externalId: `cm-${n}`, connectionId, direction: 'receivable', invoiceExternalId: 'inv-1', number: `CM-${n}`, date: '2026-09-05', amount: usd(500), appliedTo: 'invoice', counterparty: 'Globex', status: 'applied' })
      const notes = () => withBypass('test:read', async () => (await (srv.booted.services.db as never as import('kysely').Kysely<{ ledger_records: { connection_id: string; event_type: string; external_id: string; status: string } }>).selectFrom('ledger_records').select(['external_id', 'status']).where('connection_id', '=', qb.id).where('event_type', '=', 'credit_note.upsert').orderBy('external_id').execute()).map((r) => `${r.external_id}:${r.status === 'void' ? 'void' : 'live'}`))
      let t = new Date().toISOString()
      qb.push((id) => [invoice(id, 1), note(id, 1), note(id, 2), { ...listing(id, t), kinds: ['invoice', 'credit_note'] } as NormalizedEvent])
      await qb.sync()
      expect(await notes()).toEqual(['cm-1:live', 'cm-2:live'])
      t = new Date().toISOString()
      qb.push((id) => [invoice(id, 1), note(id, 1), { ...listing(id, t), kinds: ['invoice', 'credit_note'] } as NormalizedEvent])
      await qb.sync()
      expect(await notes()).toEqual(['cm-1:live', 'cm-2:void'])
    } finally {
      await srv.close()
    }
  }, 120_000)
})

