// Integration (no stubbed coverage reader): the real sources port, through the real ledger. A hand-keyed cash entry
// must date the cash-on-hand source — the bug 43 caught was it always reading "no entries yet" because coverage()
// dropped cash accounts, so they had no dataThrough.
import { describe, expect, it } from 'vitest'
import { connectAi, entities, signIn, startServer } from './scenarios/harness.ts'

type SourceEntry = { source: string; kind: string; data_as_of: string | null }

describe('cash-on-hand freshness (real ledger, real sources port)', () => {
  it('dates the cash source by its latest add_entry, and never reads "no entries yet"', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'cashfresh@example.com', 'Acme')
      const E = await entities(s)
      const ai = await connectAi(srv, s)

      // Two hand-keyed cash entries (SCENARIO_TODAY is 2026-10-10); the latest is the one the line should date by.
      for (const [date, key] of [
        ['2026-09-26', 'cash-entry-0001'],
        ['2026-10-08', 'cash-entry-0002'],
      ] as const) {
        const r = await ai.call<{ status: string }>('add_entry', {
          company: 'Acme',
          kind: 'cash_income',
          amount: { amount: '100.00', currency: 'USD' },
          date,
          paid_by: 'Acme',
          counterparty: 'Walk-in',
          idempotency_key: key,
        })
        expect(r.status).toBe('applied')
      }

      const r = await ai.try('get_overview', { company: 'Acme' })
      expect(r.isError, r.text).toBe(false)
      const sources = (r.data?.sources ?? []) as SourceEntry[]
      const cash = sources.find((e) => e.kind === 'manual')
      expect(cash, `a manual source should be present; got ${JSON.stringify(sources)}`).toBeTruthy()
      // The fix: the cash source is dated by its latest entry (2026-10-08), not left blank.
      expect(cash!.data_as_of).toBe('2026-10-08')
      // The line says so in plain words, and never the old "no entries yet".
      expect(r.text).toMatch(/as of your last entry, Oct 8/)
      expect(r.text).not.toMatch(/no entries yet/)
      void E
    } finally {
      await srv.close()
    }
  })
})
