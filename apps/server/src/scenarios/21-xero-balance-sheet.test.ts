// Xero Demo Company (US), replayed: its whole history recorded on 2026-11-04 (staging, GETs only), next to Xero's own
// Balance Sheet read off Xero's website at the same minute (the app has no balance-sheet scope). The real connector
// reads the payloads, its events go through the real server and ledger, and the balance sheet lines Xero feeds must
// equal Xero's own at each month-end, to the cent: receivables, payables and sales tax owed.
// Bank balances come from the bank connection, and Xero's "Historical Adjustment" (opening balances) isn't in any
// object the API lists, so Xero's total assets and equity are not ours to match.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createXeroConnector } from '@agfn/connector-xero'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

type Lines = { receivable: number; payable: number; salesTax: number }
const FIX = JSON.parse(readFileSync(new URL('../../../../packages/connectors/xero/fixtures/redacted/demo-us-bs.json', import.meta.url), 'utf8')) as Record<string, unknown> & { BalanceSheet: Record<string, Lines> }
const LISTS = ['Invoices', 'CreditNotes', 'Payments', 'Overpayments', 'Prepayments', 'BankTransactions', 'ManualJournals']

async function connectorEvents(connectionId: string): Promise<NormalizedEvent[]> {
  const ff = fixtureFetch([
    { match: '/connections', respond: { json: [] } },
    { match: '/Organisation', respond: { json: { Organisations: FIX.Organisations } } },
    { match: '/Accounts', respond: { json: { Accounts: FIX.Accounts } } },
    ...LISTS.map((key) => ({
      match: (url: URL) => url.pathname.endsWith(`/${key}`),
      respond: (url: URL) => {
        const page = Number(url.searchParams.get('page') ?? 1)
        const size = Number(url.searchParams.get('pageSize') ?? 100)
        return { json: { [key]: ((FIX[key] as unknown[]) ?? []).slice((page - 1) * size, page * size) } }
      },
    })),
    { match: '/Reports/ProfitAndLoss', respond: { json: { Reports: [] } } },
  ])
  const c = createXeroConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-11-04T21:00:00Z')), random: () => 0.5 }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, pageSize: 100 })
  const conn: ConnectionRef = { id: connectionId, workspaceId: 'ws', connectorKey: 'xero', secret: { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.parse('2026-11-05T00:00:00Z') } }, config: { tenantId: 't', baseCurrency: 'USD', pnlMonths: 0 } }
  return (await runSync(c, conn, null)).events.filter((e) => e.type !== 'report.snapshot')
}

type Report = { sections: Array<{ rows: Array<{ account: string; amount: { amount: string } | null }> }> }

async function compare(): Promise<Array<{ date: string; ours: Lines; theirs: Lines }>> {
  const srv = await startServer()
  try {
    const s = await signIn(srv, 'founder21@example.test', 'Demo Company')
    const E = await entities(s)
    // A scripted accounting connection carries the real Xero connector's events.
    const xero = await connectProvider(srv, s, 'quickbooks', { entityId: E['Demo Company'], name: 'Xero' })
    const events = await connectorEvents(xero.id)
    xero.push(() => events)
    expect((await xero.sync()).status).toBe('ok')
    const ai = await connectAi(srv, s)
    const out = []
    for (const [date, want] of Object.entries(FIX.BalanceSheet)) {
      const got = (await ai.call<{ reports: Report[] }>('get_reports', { kind: 'balance_sheet', company: 'Demo Company', from: `${date.slice(0, 4)}-01-01`, to: date, basis: 'accrual' })).reports[0]!
      const line = (n: string) => minor(got.sections.flatMap((x) => x.rows).find((x) => x.account === n)?.amount ?? undefined) ?? 0
      out.push({
        date,
        ours: { receivable: line('Accounts receivable'), payable: line('Accounts payable'), salesTax: line('Sales tax payable') },
        theirs: { receivable: Math.round(want.receivable * 100), payable: Math.round(want.payable * 100), salesTax: Math.round(want.salesTax * 100) },
      })
    }
    return out
  } finally {
    await srv.close()
  }
}

describe('scenario 21: Xero Demo Company balance sheet equals ours', { timeout: 120_000 }, () => {
  // (Xero's "/Date(1791692028906)/" timestamps are epoch milliseconds, not account numbers.)
  it('fixture is redacted', () => assertRedacted(FIX, [/^1[6-9]\d{11}$/]))

  // Sales tax owed nets the tax on bills, as Xero's tax account does: the May computer bill's $160.87 and July's
  // supplier credit ($22.89 back) included.
  it('receivables and sales tax owed at Jul to Oct month-ends, payables Jul to Sep, to the cent', async () => {
    const rows = await compare()
    expect(rows.map((r) => r.date)).toEqual(['2026-07-31', '2026-08-31', '2026-09-30', '2026-10-31'])
    for (const r of rows) expect(r.date < '2026-10-01' ? r.ours : { ...r.ours, payable: r.theirs.payable }, r.date).toEqual(r.theirs)
  })

  // Xero Payroll posts its tax liabilities as bills on Accounts Payable ("Wage Payable Invoice": Oct 3, $2,889.98,
  // unpaid at Oct 31; September's were paid within the month). They aren't in GET /Invoices, the same Xero Payroll gap
  // as scenario 14's wages (NOT_COVERED).
  it.fails('payables at Oct 31 (Xero Payroll tax bills)', async () => {
    const oct = (await compare()).find((r) => r.date === '2026-10-31')!
    expect(oct.ours.payable).toBe(oct.theirs.payable)
  })
})
