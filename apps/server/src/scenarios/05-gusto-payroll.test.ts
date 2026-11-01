// Story 5: Acme runs payroll on Gusto (no Gusto connection). The bank shows a NET and a TAX debit every other Friday;
// Aggregate estimates the runs from those rows. Then the founder uploads Gusto's payroll register: the estimates are
// replaced by the real runs (gross, employer taxes, headcount), and payroll cost and burn still count each dollar once.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
type Wire = { amount: string }
type Payroll = { companies: Array<{ company: string; runs: Array<{ pay_date: string; gross: Wire; employer_taxes: Wire; net: Wire; employer_cost: Wire; estimated: boolean }>; next_run: { date: string; estimate: Wire } | null; headcount: number | null }> }
const PAY_DATES = ['2026-09-11', '2026-09-25', '2026-10-09']

describe('story 5: Gusto payroll from bank rows, then the uploaded register', () => {
  it('estimates, then exact runs; cost counted once', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder5@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      // Per run: net pay 6,100 + taxes 2,550 (1,900 withheld from employees + 650 employer) = 8,650 out of the bank.
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(10_000_000) },
        ...PAY_DATES.flatMap((d, i) => [
          { type: 'txn.upsert' as const, externalId: `net${i}`, connectionId: c, accountExternalId: 'chk', date: d, amount: usd(-610_000), status: 'posted' as const, counterparty: 'Gusto', rawText: 'GUSTO NET 8RTF2' },
          { type: 'txn.upsert' as const, externalId: `tax${i}`, connectionId: c, accountExternalId: 'chk', date: d, amount: usd(-255_000), status: 'posted' as const, counterparty: 'Gusto', rawText: 'GUSTO TAX 8RTF2' },
        ]),
      ])
      expect((await bank.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s)
      const payroll = async () => (await ai.call<Payroll>('get_payroll', { company: 'Acme' })).companies.find((c) => c.company === 'Acme')
      const metric = async (m: string, extra: Record<string, unknown> = {}) => minor((await ai.call<{ value: Wire }>('get_metric', { metric: m, company: 'Acme', ...extra })).value)
      const sep = { from: '2026-09-01', to: '2026-09-30' }

      // ---- 1. Estimated from the bank ----
      let p = await payroll()
      expect(p?.runs.map((r) => [r.pay_date, minor(r.employer_cost), minor(r.net), r.estimated])).toEqual(PAY_DATES.map((d) => [d, 865_000, 610_000, true]))
      expect(p?.next_run).toEqual({ date: '2026-10-23', estimate: { amount: '8650.00', currency: 'USD' } })
      expect(await metric('payroll_cost', sep)).toBe(1_730_000)
      expect(await metric('gross_burn', sep)).toBe(1_730_000)
      // The bank rows are payroll now, settled by the runs (not "uncategorized").
      const rows = (await ai.call<{ transactions: Array<{ kind: string; category: string; linked?: number }> }>('search_transactions', { company: 'Acme', query: 'Gusto', limit: 20 })).transactions
      expect(rows).toHaveLength(6)
      for (const r of rows) expect(r).toMatchObject({ kind: 'payroll', linked: 1 })
      expect(rows.map((r) => r.category).sort()).toEqual(['payroll_expense', 'payroll_expense', 'payroll_expense', 'payroll_taxes', 'payroll_taxes', 'payroll_taxes'])
      let drawer = (await s.get<{ payroll: { runs: Array<{ date: string; gross: { minor: number }; provider: string }>; headcount: { employees: number } } }>(`/api/entities/${E.Acme}`)).body.payroll
      expect(drawer.runs.map((r) => r.provider)).toEqual(['Gusto (estimated)', 'Gusto (estimated)', 'Gusto (estimated)'])

      // ---- 2. The founder uploads Gusto's register ----
      const csv =
        'Employee,Check date,Gross pay,Employer taxes,Net pay\n' +
        ['09/11/2026', '09/25/2026', '10/09/2026'].flatMap((d) => [`Ada,${d},"5,000.00",400.00,"3,800.00"`, `Ben,${d},"3,000.00",250.00,"2,300.00"`]).join('\n') +
        '\n'
      const up = await s.post<{ runs: number; issues: unknown[] }>(`/api/entities/${E.Acme}/payroll-register?provider=Gusto`, undefined, { headers: { 'content-type': 'text/csv' }, raw: csv })
      expect(up.status).toBe(201)
      expect(up.body).toEqual({ runs: 3, issues: [] })
      const again = await s.post<{ runs: number }>(`/api/entities/${E.Acme}/payroll-register?provider=Gusto`, undefined, { headers: { 'content-type': 'text/csv' }, raw: csv })
      expect(again.body.runs).toBe(0) // same file twice: nothing new

      p = await payroll()
      expect(p?.runs.map((r) => [r.pay_date, minor(r.gross), minor(r.employer_taxes), minor(r.net), minor(r.employer_cost), r.estimated])).toEqual(PAY_DATES.map((d) => [d, 800_000, 65_000, 610_000, 865_000, false]))
      expect(p?.headcount).toBe(2)
      expect(await metric('payroll_cost', sep)).toBe(1_730_000) // still once: register + bank rows are the same money
      expect(await metric('gross_burn', sep)).toBe(1_730_000)
      expect(await metric('cash')).toBe(10_000_000)
      drawer = (await s.get<typeof drawer extends infer T ? { payroll: T } : never>(`/api/entities/${E.Acme}`)).body.payroll
      expect(drawer.runs.map((r) => [r.date, r.gross.minor, r.provider])).toEqual([...PAY_DATES].reverse().map((d) => [d, 800_000, 'Gusto']))
      expect(drawer.headcount.employees).toBe(2)
      // Nothing about payroll is left waiting for review.
      const review = await ai.call<{ items: Array<{ kind: string }> }>('list_review_items', {})
      expect(review.items).toEqual([])
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
