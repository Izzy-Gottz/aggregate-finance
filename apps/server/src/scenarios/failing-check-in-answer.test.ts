// A failing tie-out reaches the answer it affects: the AI's get_metric says so in the same reply, not only in data_health.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('a failing balance check', () => {
  it('shows in cash and burn, and a clean company stays clean', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder-check@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-03T08:00:00Z', current: usd(1_000_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const ai = await connectAi(srv, s)
      const clean = await ai.try('get_metric', { metric: 'cash', company: 'Acme' })
      expect(clean.data).toMatchObject({ state: 'ok' })
      expect((clean.data?.coverage as { gaps: string[] }).gaps).toEqual([])

      // The bank says $5,000 more than any row explains, for well past the posting lag.
      bank.push((c) => [
        { type: 'balance.snapshot', externalId: 'b1', connectionId: c, accountExternalId: 'chk', at: '2026-10-05T08:00:00Z', current: usd(1_500_000) },
        { type: 'balance.snapshot', externalId: 'b2', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(1_500_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')

      const cash = await ai.try('get_metric', { metric: 'cash', company: 'Acme' })
      const data = cash.data as { state: string; value: { amount: string }; coverage: { gaps: string[] }; unknown_reason: string; checks?: unknown }
      expect(data.value.amount).toBe('15000.00') // the provider's figure stays
      expect(data.state).toBe('stale')
      expect(data.coverage.gaps.join(' ')).toContain('Acme Checking')
      expect(data.unknown_reason).toContain('Acme Checking')
      expect(data.checks).toBeUndefined() // same output shape: no new block on cash
      expect(cash.text).toContain('needs a look')
      expect(cash.text).not.toContain('uses old balances')

      const burn = await ai.try('get_metric', { metric: 'gross_burn', company: 'Acme' })
      expect((burn.data?.coverage as { gaps: string[] }).gaps.join(' ')).toContain('Acme Checking')
      // A connection that can't see balances gets no amount through a flow figure's gap.
      expect((burn.data?.coverage as { gaps: string[] }).gaps.join(' ')).not.toContain('$')
    } finally {
      await srv.close()
    }
  })

  it('a pinned balance that disagrees shows in cash too', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder-pin@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(900_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const ai = await connectAi(srv, s)
      await ai.call('pin_balance', { account: 'Acme Checking', date: '2026-10-09', balance: { amount: '14000.00', currency: 'USD' }, source: 'statement', idempotency_key: 'pin-check-0001' })
      const cash = await ai.try('get_metric', { metric: 'cash', company: 'Acme' })
      expect((cash.data?.coverage as { gaps: string[] }).gaps.join(' ')).toContain('Acme Checking')
      expect(cash.data).toMatchObject({ state: 'stale' })
      expect(cash.text).toContain('needs a look')
    } finally {
      await srv.close()
    }
  })
})
