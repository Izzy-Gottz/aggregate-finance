// Cap table through the real server: the AI records a founder issuance and an option grant, and get_metric
// 'fully_diluted' (S6's provider, registered on the S1 engine) counts both.
import { describe, expect, it } from 'vitest'
import { connectAi, signIn, startServer } from './harness.ts'

describe('equity: fully diluted shares via get_metric', () => {
  it('counts issued shares and granted options', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder8@example.com', 'Acme')
      const ai = await connectAi(srv, s)
      const issued = await ai.call<{ status: string }>('record_equity_event', { company: 'Acme', kind: 'issuance', date: '2026-01-02', stakeholder: 'Founder', shares: 8_000_000, share_class: 'Common', idempotency_key: 'eq-issue-0001' })
      expect(issued.status).toBe('applied')
      const granted = await ai.call<{ status: string }>('record_equity_event', { company: 'Acme', kind: 'option_grant', date: '2026-03-01', stakeholder: 'First engineer', shares: 200_000, vesting: { start: '2026-03-01', months: 48, cliff_months: 12 }, idempotency_key: 'eq-grant-0001' })
      expect(granted.status).toBe('applied')
      const fd = await ai.call<{ value: number; state: string }>('get_metric', { metric: 'fully_diluted', company: 'Acme' })
      expect(fd.value).toBe(8_200_000)
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)

  it('RSUs (grant + release) and a warrant round-trip through record_equity_event → get_cap_table', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder8b@example.com', 'Acme')
      const ai = await connectAi(srv, s)
      const call = (args: Record<string, unknown>) => ai.call<{ status: string }>('record_equity_event', { company: 'Acme', ...args })
      expect((await call({ kind: 'issuance', date: '2024-01-02', stakeholder: 'Founder', shares: 9_000_000, idempotency_key: 'eq-rw-0001' })).status).toBe('applied')
      expect((await call({ kind: 'option_grant', grant_type: 'rsu', date: '2024-01-01', stakeholder: 'Rui', shares: 48_000, vesting: { start: '2024-01-01', months: 48, cliff_months: 12 }, idempotency_key: 'eq-rw-0002' })).status).toBe('applied')
      // 12 months in: a quarter has vested; release it, keeping 3,000 back for tax.
      expect((await call({ kind: 'exercise', grant_type: 'rsu', date: '2025-01-01', stakeholder: 'Rui', shares: 12_000, withheld_shares: 3_000, idempotency_key: 'eq-rw-0003' })).status).toBe('applied')
      expect((await call({ kind: 'option_grant', grant_type: 'warrant', date: '2024-06-01', stakeholder: 'Westlake Bank', shares: 50_000, price_per_share: { amount: '0.6522', currency: 'USD' }, expiration_date: '2031-06-01', idempotency_key: 'eq-rw-0004' })).status).toBe('applied')
      const t = await ai.call<{ companies: Array<{ fully_diluted_shares: number; home_currency: string; rsus: { granted: number; released: number; outstanding: number }; warrants: Array<{ holder: string; shares: number; exercise_price: unknown; expires: string; expired: boolean }>; holders: Array<{ name: string; class: string; shares: number }> }> }>('get_cap_table', { company: 'Acme' })
      const c = t.companies[0]!
      expect(c.home_currency).toBe('USD')
      expect(c.rsus).toMatchObject({ granted: 48_000, released: 12_000, outstanding: 36_000 })
      expect(c.warrants).toEqual([{ holder: 'Westlake Bank', class: 'Common', shares: 50_000, exercise_price: { amount: '0.6522', currency: 'USD' }, expires: '2031-06-01', expired: false }])
      // 9,000,000 + 9,000 released shares + 36,000 RSUs + 50,000 warrant shares (+ the pool the RSU grant created, fully used).
      expect(c.fully_diluted_shares).toBe(9_095_000)
      expect(c.holders).toContainEqual(expect.objectContaining({ name: 'Rui', class: 'RSUs', shares: 36_000 }))
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
