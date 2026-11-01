// QuickBooks sandbox company, replayed: the real QuickBooks connector reads the recorded (minimal, redacted) sandbox
// payloads, its events go through the real server and ledger, and our accrual P&L per month must equal QuickBooks'
// own ProfitAndLoss report for that month, to the cent: net income and each section QuickBooks shows.
// QuickBooks' own numbers: Jul net 412.43, Aug −673.50, Sep 1,481.28.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createQuickBooksConnector } from '@agfn/connector-quickbooks'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

type Qbo = Record<string, unknown>
const FIX = JSON.parse(readFileSync(new URL('../../../../packages/connectors/quickbooks/fixtures/redacted/sandbox-pnl.json', import.meta.url), 'utf8')) as Record<string, Qbo[]>

/** QuickBooks' own report: each top-level section's total and net income, in cents. */
function qboTotals(report: Qbo): Record<string, number> {
  const out: Record<string, number> = {}
  const rows = ((report.Rows as Qbo)?.Row as Qbo[]) ?? []
  for (const r of rows) {
    const g = r.group as string | undefined
    const v = ((r.Summary as Qbo)?.ColData as Array<{ value: string }> | undefined)?.at(-1)?.value
    if (g && v !== undefined && v !== '') out[g] = Math.round(Number(v) * 100)
  }
  return out
}

async function connectorEvents(connectionId: string): Promise<NormalizedEvent[]> {
  const entityOf = (q: string) => Object.keys(FIX).find((e) => new RegExp(`FROM ${e}\\b`).test(q))
  const ff = fixtureFetch([
    {
      match: (url) => url.pathname.endsWith('/query'),
      respond: (url) => {
        const q = url.searchParams.get('query') ?? ''
        const e = entityOf(q)
        const start = Number(/STARTPOSITION (\d+)/.exec(q)?.[1] ?? 1)
        const max = Number(/MAXRESULTS (\d+)/.exec(q)?.[1] ?? 1000)
        const all = (e ? FIX[e] : []) ?? []
        return { json: { QueryResponse: e ? { [e]: all.slice(start - 1, start - 1 + max) } : {} } }
      },
    },
    { match: '/cdc', respond: { json: { CDCResponse: [] } } },
    { match: '/reports/ProfitAndLoss', respond: { json: FIX.ProfitAndLoss?.[0] ?? {} } },
  ])
  const c = createQuickBooksConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-10-10T12:00:00Z')), random: () => 0.5 }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, pageSize: 1000 })
  const conn: ConnectionRef = { id: connectionId, workspaceId: 'ws', connectorKey: 'quickbooks', secret: { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.parse('2026-10-11T00:00:00Z') } }, config: { realmId: '1', environment: 'sandbox', homeCurrency: 'USD', pnlMonths: 0 } }
  return (await runSync(c, conn, null)).events.filter((e) => e.type !== 'report.snapshot')
}

type Report = { sections: Array<{ name: string; total: { amount: string } }>; total: { amount: string } }

/** Our accrual P&L per month next to QuickBooks' own report for that month. */
async function compare(): Promise<Array<{ month: string; ours: Record<string, number>; theirs: Record<string, number> }>> {
  const srv = await startServer()
  try {
    const s = await signIn(srv, 'founder13@example.com', 'Craig’s Design')
    const E = await entities(s)
    const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E['Craig’s Design'], name: 'QuickBooks' })
    const events = await connectorEvents(qb.id)
    qb.push(() => events)
    expect((await qb.sync()).status).toBe('ok')
    const ai = await connectAi(srv, s)
    const out = []
    for (const report of FIX.ProfitAndLoss ?? []) {
      const h = report.Header as { StartPeriod: string; EndPeriod: string; ReportBasis: string }
      if (h.ReportBasis !== 'Accrual' || h.StartPeriod >= '2026-10-01') continue
      const want = qboTotals(report)
      const got = (await ai.call<{ reports: Report[] }>('get_reports', { kind: 'profit_and_loss', company: 'Craig’s Design', from: h.StartPeriod, to: h.EndPeriod, basis: 'accrual' })).reports[0]!
      const sec = (n: string) => minor(got.sections.find((x) => x.name === n)?.total) ?? 0
      out.push({
        month: h.StartPeriod.slice(0, 7),
        ours: { net: minor(got.total) ?? 0, income: sec('Revenue'), cogs: sec('Cost of revenue'), expenses: sec('Operating expenses') },
        // Our "Operating expenses" holds QuickBooks' Expenses and Other Expenses.
        theirs: { net: want.NetIncome ?? 0, income: want.Income ?? 0, cogs: want.COGS ?? 0, expenses: (want.Expenses ?? 0) + (want.OtherExpenses ?? 0) },
      })
    }
    return out
  } finally {
    await srv.close()
  }
}

describe('scenario 13: QuickBooks sandbox P&L equals our accrual P&L', () => {
  // Including inventory: items bought into Inventory, their cost to COGS when sold (from each item's start date).
  it('Jul, Aug and Sep 2026: net income, income, COGS and expenses, to the cent', async () => {
    const rows = await compare()
    expect(rows.map((r) => r.month).sort()).toEqual(['2026-07', '2026-08', '2026-09'])
    for (const r of rows) expect(r.ours, r.month).toEqual(r.theirs)
  })
})
