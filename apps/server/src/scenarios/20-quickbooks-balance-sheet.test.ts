// QuickBooks sandbox company, replayed: its whole history and its own Balance Sheet at three month-ends, recorded in one
// run (2026-11-04). The real connector reads the payloads, its events go through the real server and ledger, and the
// balance sheet lines QuickBooks feeds must equal QuickBooks' own at each month-end, to the cent.
// What it feeds: receivables, payables and sales tax owed (less what the sales tax centre paid, from TransactionList). Bank and card balances come from the bank connection, and
// QuickBooks' opening balances (here $18,495 of Opening Balance Equity: $5,000 checking, the $13,495 truck) aren't in
// any object the API lists, so QuickBooks' total assets and equity are not ours to match.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createQuickBooksConnector } from '@agfn/connector-quickbooks'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

type Qbo = Record<string, unknown>
const FIX = JSON.parse(readFileSync(new URL('../../../../packages/connectors/quickbooks/fixtures/redacted/sandbox-bs.json', import.meta.url), 'utf8')) as Record<string, Qbo[]>

/** A QuickBooks report's group totals, in cents, at every depth. */
function groupTotals(report: Qbo): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (rows: Qbo[]) => {
    for (const r of rows) {
      const g = r.group as string | undefined
      const v = ((r.Summary as Qbo)?.ColData as Array<{ value: string }> | undefined)?.at(-1)?.value
      if (g && v !== undefined && v !== '') out[g] = Math.round(Number(v) * 100)
      const inner = ((r.Rows as Qbo)?.Row as Qbo[]) ?? []
      if (inner.length) walk(inner)
    }
  }
  walk(((report.Rows as Qbo)?.Row as Qbo[]) ?? [])
  return out
}

/** A QuickBooks report's account lines, in cents, by name. */
function lineValues(report: Qbo): Record<string, number> {
  const out: Record<string, number> = {}
  const walk = (rows: Qbo[]) => {
    for (const r of rows) {
      const cd = r.ColData as Array<{ value: string }> | undefined
      if (cd?.[0]?.value && cd.at(-1)?.value) out[cd[0].value] = Math.round(Number(cd.at(-1)!.value) * 100)
      const inner = ((r.Rows as Qbo)?.Row as Qbo[]) ?? []
      if (inner.length) walk(inner)
    }
  }
  walk(((report.Rows as Qbo)?.Row as Qbo[]) ?? [])
  return out
}

async function connectorEvents(connectionId: string, FIX: Record<string, Qbo[]>): Promise<NormalizedEvent[]> {
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
    { match: '/reports/TransactionList', respond: { json: FIX.TransactionList ?? {} } },
  ])
  const c = createQuickBooksConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-11-04T17:00:00Z')), random: () => 0.5 }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, pageSize: 1000 })
  const conn: ConnectionRef = { id: connectionId, workspaceId: 'ws', connectorKey: 'quickbooks', secret: { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.parse('2026-11-05T00:00:00Z') } }, config: { realmId: '1', environment: 'sandbox', homeCurrency: 'USD', pnlMonths: 0 } }
  return (await runSync(c, conn, null)).events.filter((e) => e.type !== 'report.snapshot')
}

type Report = { sections: Array<{ name: string; rows: Array<{ account: string; amount: { amount: string } | null }>; total: { amount: string } }>; total: { amount: string } | null }

async function compare(fix: Record<string, Qbo[]> = FIX) {
  const srv = await startServer()
  try {
    const s = await signIn(srv, 'founder20@example.test', 'Sandbox Co')
    const E = await entities(s)
    const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E['Sandbox Co'], name: 'QuickBooks' })
    const events = await connectorEvents(qb.id, fix)
    qb.push(() => events)
    expect((await qb.sync()).status).toBe('ok')
    const ai = await connectAi(srv, s)
    const out = []
    for (const report of fix.BalanceSheet ?? []) {
      const h = report.Header as { StartPeriod: string; EndPeriod: string }
      const want = groupTotals(report)
      const got = (await ai.call<{ reports: Report[] }>('get_reports', { kind: 'balance_sheet', company: 'Sandbox Co', from: h.StartPeriod, to: h.EndPeriod, basis: 'accrual' })).reports[0]!
      const line = (n: string) => minor(got.sections.flatMap((x) => x.rows).find((x) => x.account === n)?.amount ?? undefined) ?? 0
      const lines = lineValues(report)
      const tax = Object.entries(lines).filter(([k]) => /Payable$/.test(k) && !/^Accounts Payable/.test(k)).reduce((t, [, v]) => t + v, 0)
      out.push({
        date: h.EndPeriod,
        ours: { receivable: line('Accounts receivable'), payable: line('Accounts payable'), salesTax: line('Sales tax payable') },
        theirs: { receivable: want.AR ?? 0, payable: want.AP ?? 0, salesTax: tax },
      })
    }
    return out
  } finally {
    await srv.close()
  }
}

describe('scenario 20: QuickBooks sandbox balance sheet equals ours', { timeout: 120_000 }, () => {
  it('fixture is redacted', () => assertRedacted(FIX))

  it('receivables, payables and sales tax owed at Jul, Aug and Sep month-ends, to the cent', async () => {
    const rows = await compare()
    expect(rows.map((r) => r.date)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30'])
    for (const r of rows) expect(r.ours, r.date).toEqual(r.theirs)
    // August's filing ($38.40 Arizona + $38.50 Board of Equalization, paid 08-24) is what takes sales tax owed down.
    expect(rows.map((r) => r.ours.salesTax)).toEqual([3_250, 640, 23_192])
  })

  // A filing paid by hand next to the sales tax centre's own: a $10.00 check and a $5.00 journal, both on the Board
  // of Equalization's payable account in September. Each lowers what's owed once; the centre's August payments still
  // count once each (they're a different transaction type, so nothing is listed twice).
  it('a hand-paid filing (check or journal on the tax account) lowers sales tax owed too, and nothing counts twice', async () => {
    const fix = structuredClone(FIX)
    const tax = { value: '90', name: 'Board of Equalization Payable' }
    fix.Purchase = [...(fix.Purchase ?? []), { Id: '9001', TxnDate: '2026-09-10', PaymentType: 'Check', AccountRef: { value: '35', name: 'Checking' }, EntityRef: { value: '1', name: 'Board of Equalization', type: 'Vendor' }, TotalAmt: 10, CurrencyRef: { value: 'USD' }, Line: [{ Id: '1', Amount: 10, DetailType: 'AccountBasedExpenseLineDetail', AccountBasedExpenseLineDetail: { AccountRef: tax } }] }]
    fix.JournalEntry = [...(fix.JournalEntry ?? []), { Id: '9002', TxnDate: '2026-09-12', CurrencyRef: { value: 'USD' }, Line: [
      { Id: '0', Amount: 5, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: tax } },
      { Id: '1', Amount: 5, DetailType: 'JournalEntryLineDetail', JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: '26', name: 'Other Portfolio Income' } } },
    ] }]
    const rows = await compare(fix)
    expect(rows.map((r) => r.ours.salesTax)).toEqual([3_250, 640, 23_192 - 1_000 - 500])
  })
})
