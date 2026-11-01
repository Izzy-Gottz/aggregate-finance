// Story 1: a founder with three companies and a Personal space connects one bank login (checking accounts for
// each company, a company card, a personal account) and Stripe for Bluebird. Cash and runway must be exact, and a
// Stripe payout must not be counted again when it lands in the bank.
import { describe, expect, it } from 'vitest'
import { connectAi, minor, startServer } from './harness.ts'
import { founderStory } from './stories.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

// Once on SQLite and once on Postgres (PGlite): same numbers to the cent.
describe.each([['sqlite', false], ['postgres (pglite)', true]] as const)('story 1 on %s: founder with three companies — cash, runway, no double counting', (_db, pglite) => {
  it('REST and MCP agree to the cent', async () => {
    const srv = await startServer({ pglite })
    try {
      const { s, E } = await founderStory(srv)

      // The founder tells the AI "Globex payments are customer revenue": one rule, applied to past rows too.
      // (Until then those inflows sit in Review as "What is this money?" and don't count as income.)
      const ai = await connectAi(srv, s)
      const rule = await ai.call<Record<string, unknown>>('create_rule', {
        company: 'Acme',
        match: { counterparty: 'Globex Corp' },
        set: { kind: 'revenue', category: 'revenue' },
        apply_to_existing: true,
        idempotency_key: 'rule-globex-0001',
      })
      expect(rule).toBeTruthy()

      // ---- REST (what the UI shows) ----
      const ws = (await s.get<{ entities: Array<{ id: string; name: string; kind: string; cash: { minor: number } | null; hidden: boolean }> }>('/api/workspace')).body
      const byName = Object.fromEntries(ws.entities.map((e) => [e.kind === 'personal' ? 'Personal' : e.name, e]))
      expect(byName.Acme?.cash?.minor).toBe(10_000_000)
      expect(byName.Bluebird?.cash?.minor).toBe(5_000_000) // bank 50,000 + Stripe balance 0
      expect(byName.Harbor?.cash?.minor).toBe(2_000_000)
      // The founder owns this Personal, so they see its numbers (it stays private to everyone else).
      expect(byName.Personal).toMatchObject({ hidden: false })

      const acme = (await s.get<Record<string, any>>(`/api/entities/${E.Acme}`)).body
      expect(acme.cash.answer.value).toEqual(usd(10_000_000))
      expect(acme.runway.state).toBe('ok')
      expect(acme.runway.months).toBeCloseTo(30.3, 1) // 100,000 ÷ 3,300 per month
      expect(acme.accounts.map((a: { name: string }) => a.name).sort()).toEqual(['Acme Card', 'Acme Checking'])

      // ---- MCP (what an AI gets) ----
      const metric = (m: string, company: string, extra: Record<string, unknown> = {}) => ai.call<{ value: { amount: string } | number | null; state: string }>('get_metric', { metric: m, company, ...extra })

      expect(minor((await metric('cash', 'Acme')).value as { amount: string })).toBe(10_000_000)
      expect(minor((await metric('card_balances', 'Acme')).value as { amount: string })).toBe(30_000)
      // Gross burn counts card purchases (not card payments): 4,000 + 1,000 + 300 = 5,300 a month. Burn is a monthly
      // average, so Q3 answers 5,300 (15,900 over 3 months), and net burn 9,900 over Q3 is 3,300 a month.
      expect(minor((await metric('gross_burn', 'Acme', { from: '2026-07-01', to: '2026-09-30' })).value as { amount: string })).toBe(530_000)
      expect(minor((await metric('net_burn', 'Acme', { from: '2026-07-01', to: '2026-09-30' })).value as { amount: string })).toBe(330_000)
      const acmeRunway = await metric('runway', 'Acme')
      expect(acmeRunway.state).toBe('ok')
      expect(acmeRunway.value as number).toBeCloseTo(30.3, 1)

      // Bluebird: revenue is the Stripe charges only (10,000 a month), never charges + the payout deposit.
      expect(minor((await metric('revenue', 'Bluebird', { from: '2026-09-01', to: '2026-09-30' })).value as { amount: string })).toBe(1_000_000)
      // Net burn: 15,000 Upwork + 290.30 fees − 10,000 revenue = 5,290.30 a month.
      expect(minor((await metric('net_burn', 'Bluebird', { from: '2026-09-01', to: '2026-09-30' })).value as { amount: string })).toBe(529_030)
      const nexRunway = await metric('runway', 'Bluebird')
      expect(nexRunway.state).toBe('ok')
      expect(nexRunway.value as number).toBeCloseTo(9.5, 1) // 50,000 ÷ 5,290.30

      // The deposit is linked to its payout (a transfer from Stripe), not new income.
      const found = await ai.call<{ transactions: Array<{ counterparty: string | null; amount: { amount: string }; kind: string; category: string; linked: number | null }> }>('search_transactions', { company: 'Bluebird', query: '"Stripe Transfer"', limit: 50 })
      const deposits = found.transactions.filter((t) => t.counterparty === 'Stripe Transfer')
      expect(deposits).toHaveLength(3)
      for (const d of deposits) expect(d).toMatchObject({ amount: { amount: '9709.70' }, kind: 'payout', category: 'clearing_payouts', linked: 1 })
      // Nothing about the payouts is left in Review as unexplained money.
      const review = await ai.call<{ items: Array<{ kind: string; company: string }> }>('list_review_items', {})
      expect(review.items.filter((i) => i.company === 'Bluebird' && i.kind === 'whose_money')).toEqual([])

      // Overview across companies matches the per-company answers.
      const ov = await ai.call<{ companies: Array<{ company: string; cash: { amount: string } }> }>('get_overview', {})
      const ovCash = Object.fromEntries(ov.companies.map((c) => [c.company, minor(c.cash)]))
      expect(ovCash).toMatchObject({ Acme: 10_000_000, Bluebird: 5_000_000, Harbor: 2_000_000 })
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
