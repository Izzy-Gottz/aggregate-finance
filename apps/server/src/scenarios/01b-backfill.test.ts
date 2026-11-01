// Story 1b: data created before the account-entity fix. A Stripe account of a single-company connection had
// entity_id null, so the ledger held its events. Migration 0301 + the boot step must repair it to the cent.
import { applyPendingReassignments } from '@agfn/sync'
import { withBypass } from '@agfn/db'
import { describe, expect, it } from 'vitest'
import { up as backfill } from '../../../../packages/db/migrations/0301_account_entity_backfill.ts'
import { founderStory } from './stories.ts'
import { connectAi, minor, startServer } from './harness.ts'

describe('story 1b: backfill for accounts created before the fix', () => {
  it('migration 0301 + boot reassignment restore Stripe revenue and payout links', async () => {
    const srv = await startServer()
    try {
      const { s, stripe } = await founderStory(srv)
      const sv = srv.booted.services
      // Make it look like old data: the Stripe account lost its company and the ledger re-holds its events.
      // Direct database surgery, a migration replay and the boot step run outside any request, as they do in
      // production: under a named row-level-security bypass (a no-op unless AGFN_PG_RLS=1).
      await withBypass('test:make-old-data', async () => {
        const acct = await sv.db.selectFrom('accounts').select('id').where('connection_id', '=', stripe.id).executeTakeFirstOrThrow()
        await sv.db.updateTable('accounts').set({ entity_id: null }).where('id', '=', acct.id).execute()
        await sv.ledger.accountChanged?.(s.workspaceId, acct.id)
      })

      const ai = await connectAi(srv, s)
      const revenueSep = async () => minor((await ai.call<{ value: { amount: string } | null }>('get_metric', { metric: 'revenue', company: 'Bluebird', from: '2026-09-01', to: '2026-09-30' })).value)
      expect(await revenueSep()).not.toBe(1_000_000) // broken state: the charges are held

      await withBypass('migrate', () => backfill(sv.db as never))
      expect(await withBypass('migrate', () => applyPendingReassignments(sv.db, sv.ledger))).toBe(1)
      expect(await withBypass('migrate', () => applyPendingReassignments(sv.db, sv.ledger))).toBe(0) // once only

      expect(await revenueSep()).toBe(1_000_000)
      const found = await ai.call<{ transactions: Array<{ counterparty: string | null; linked: number | null; kind: string }> }>('search_transactions', { company: 'Bluebird', query: '"Stripe Transfer"', limit: 50 })
      const deposits = found.transactions.filter((t) => t.counterparty === 'Stripe Transfer')
      expect(deposits.every((d) => d.kind === 'payout' && d.linked === 1)).toBe(true)
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
