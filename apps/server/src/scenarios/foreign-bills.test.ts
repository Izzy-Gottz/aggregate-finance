// Bills due in another currency: a euro subscription paid from Wise and a euro bill in QuickBooks count in bills due
// at the day's rate (never left out, never added as dollars), the app doesn't call the foreign bill "recurring", and
// the Monday note counts the subscription too.
import { describe, expect, it } from 'vitest'
import { withBypass } from '@agfn/db'
import type { Kysely } from 'kysely'
import { digestWithRecurring } from '../digest.ts'
import { financeFor } from '../finance.ts'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
const eur = (m: number) => ({ minor: m, currency: 'EUR' })

describe('foreign-currency bills', () => {
  it('a euro subscription and a euro bill count at the day rate in bills due, the app and the Monday note', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder-fx@example.com', 'Acme')
      const E = await entities(s)
      // Fixed rates (no live fetch): €1 = $1.10 every day from June.
      const db = srv.booted.services.db as unknown as Kysely<Record<string, Record<string, unknown>>>
      const rates: Array<Record<string, unknown>> = []
      for (let d = new Date('2026-06-01T00:00:00Z'); d <= new Date('2026-11-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
        rates.push({ date: d.toISOString().slice(0, 10), from_currency: 'EUR', to_currency: 'USD', rate: '1.1', source: 'fixture', created_at: '2026-10-01T00:00:00Z' })
      }
      await withBypass('test:rates', () => db.insertInto('fx_rates').values(rates).execute())

      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(10_000_000) },
        { type: 'account.upsert', externalId: 'eur', connectionId: c, name: 'Wise EUR', accountType: 'depository', currency: 'EUR', institution: 'Wise' },
        { type: 'balance.snapshot', externalId: 'eb', connectionId: c, accountExternalId: 'eur', at: '2026-10-09T08:00:00Z', current: eur(500_000) },
        ...['2026-06-14', '2026-07-14', '2026-08-14', '2026-09-14'].map((date, i) => ({ type: 'txn.upsert' as const, externalId: `h${i}`, connectionId: c, accountExternalId: 'eur', date, amount: eur(-4_900), status: 'posted' as const, counterparty: 'Hetzner Online', rawText: 'HETZNER ONLINE' })),
      ])
      expect((await bank.sync()).status).toBe('ok')
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
      qb.push((c) => [{ type: 'invoice.upsert', externalId: 'b1', connectionId: c, direction: 'payable', number: 'DE-7', counterparty: 'Berlin Studio', issueDate: '2026-10-01', dueDate: '2026-10-16', total: eur(10_000), amountPaid: eur(0), status: 'open' }] as never)
      expect((await qb.sync()).status).toBe('ok')

      // €100 bill ($110) + €49 Hetzner on Oct 14 ($53.90).
      const ai = await connectAi(srv, s)
      const ov = await ai.call<{ companies: Array<{ company: string; bills_due_30d: { amount: string } }> }>('get_overview', {})
      expect(minor(ov.companies.find((c) => c.company === 'Acme')?.bills_due_30d)).toBe(11_000 + 5_390)
      // The app shows the same total and doesn't call the euro bill "recurring".
      const bills = (await s.get<{ bills: { dueSoon: { minor: number }; breakdown?: unknown } }>(`/api/entities/${E.Acme}`)).body.bills
      expect(bills.dueSoon.minor).toBe(16_390)
      expect(bills.breakdown).toBeUndefined()

      // The Monday note (week of Oct 12–18) counts Hetzner at the day rate.
      const sv = srv.booted.services
      const digest = digestWithRecurring(sv.ledger as never, sv.db, () => financeFor(sv).reader)
      const note = await withBypass('test:digest', () => digest?.(s.workspaceId, new Date('2026-10-12T08:00:00Z')))
      expect(note?.lines[3]).toMatch(/1 recurring: Hetzner Online/)
    } finally {
      await srv.close()
    }
  })
})
