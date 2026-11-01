// Xero Demo Company (US), replayed: the real Xero connector reads the recorded (minimal, redacted) payloads, its
// events go through the real server and ledger, and our accrual P&L per month must equal Xero's own ProfitAndLoss
// report for that month, to the cent: net income, revenue, cost of sales and operating expenses.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ReportSnapshot } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertRedacted, fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { NOT_COVERED, createXeroConnector, mapProfitAndLoss } from '@agfn/connector-xero'

import { withBypass } from '@agfn/db'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

type X = Record<string, unknown>
const FIX = JSON.parse(readFileSync(new URL('../../../../packages/connectors/xero/fixtures/redacted/demo-us-pnl.json', import.meta.url), 'utf8')) as Record<string, unknown> & { ProfitAndLoss: Record<string, X> }
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
  const c = createXeroConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-10-10T12:00:00Z')), random: () => 0.5 }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' }, pageSize: 100 })
  const conn: ConnectionRef = { id: connectionId, workspaceId: 'ws', connectorKey: 'xero', secret: { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.parse('2026-10-11T00:00:00Z') } }, config: { tenantId: 't', baseCurrency: 'USD', pnlMonths: 0 } }
  return (await runSync(c, conn, null)).events.filter((e) => e.type !== 'report.snapshot')
}

type Report = { sections: Array<{ name: string; total: { amount: string } }>; total: { amount: string } }

function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).toISOString().slice(0, 10) }
}

async function compare(): Promise<Array<{ month: string; ours: Record<string, number>; theirs: Record<string, number> }> & { review?: Array<{ label: string; detail: string }> }> {
    const srv = await startServer()
  try {
    const s = await signIn(srv, 'founder14@example.com', 'Demo Company')
    const E = await entities(s)
    // A scripted accounting connection carries the real Xero connector's events.
    const xero = await connectProvider(srv, s, 'quickbooks', { entityId: E['Demo Company'], name: 'Xero' })
    // Xero's own monthly P&Ls ride along as report snapshots, so the provider_report check compares them too.
    const events = [...(await connectorEvents(xero.id)), ...Object.entries(FIX.ProfitAndLoss).map(([month, report]) => mapProfitAndLoss(report, { connectionId: xero.id, baseCurrency: 'USD' }, monthRange(month)) as ReportSnapshot)]
    xero.push(() => events)
    expect((await xero.sync()).status).toBe('ok')
    const ai = await connectAi(srv, s)
    const rows: Array<{ month: string; ours: Record<string, number>; theirs: Record<string, number> }> = []
    for (const [month, report] of Object.entries(FIX.ProfitAndLoss)) {
      const { from, to } = monthRange(month)
      const t = (mapProfitAndLoss(report, { connectionId: 'x', baseCurrency: 'USD' }, { from, to }) as ReportSnapshot).totals!
      const got = (await ai.call<{ reports: Report[] }>('get_reports', { kind: 'profit_and_loss', company: 'Demo Company', from, to, basis: 'accrual' })).reports[0]!
      const sec = (n: string) => minor(got.sections.find((x) => x.name === n)?.total) ?? 0
      rows.push({
        month,
        ours: { net: minor(got.total) ?? 0, income: sec('Revenue'), cogs: sec('Cost of revenue'), expenses: sec('Operating expenses') },
        theirs: { net: t.netIncome.minor, income: t.income?.minor ?? 0, cogs: t.cogs?.minor ?? 0, expenses: (t.expenses?.minor ?? 0) + (t.otherExpenses?.minor ?? 0) },
      })
    }
    const drawer = await s.get<{ odd: Array<{ label: string; detail: string }> }>(`/api/entities/${E['Demo Company']}`)
    return Object.assign(rows, { review: drawer.body.odd })
  } finally {
    await srv.close()
  }
}

// A full Xero sync plus the P&L in each test: a few seconds alone, past the 30 s default when the gate runs everything.
describe('scenario 14: Xero Demo Company P&L equals our accrual P&L', { timeout: 120_000 }, () => {
  // (Xero's "/Date(1791692028906)/" timestamps are epoch milliseconds, not account numbers.)
  it('fixture is redacted', () => assertRedacted(FIX, [/^1[6-9]\d{11}$/]))

  it('Jul in full; Aug and Sep revenue and cost of sales, to the cent', async () => {
    const rows = await compare()
    expect(rows.map((r) => r.month).sort()).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(rows.find((r) => r.month === '2026-07')!.ours).toEqual(rows.find((r) => r.month === '2026-07')!.theirs)
    for (const r of rows) expect([r.ours.income, r.ours.cogs], r.month).toEqual([r.theirs.income, r.theirs.cogs])
    // The months that differ say why, so nobody hunts for a missing wage bill.
    const flagged = rows.review!.filter((c) => c.detail.includes(NOT_COVERED.text))
    expect([...new Set(flagged.map((c) => c.detail.match(/(\d{4}-\d{2})-01 to/)?.[1]))].sort()).toEqual(['2026-08', '2026-09'])
  })

  // Xero Payroll's wages and payroll tax (Sep $8,797.00 + $652.50) and expense claims (Aug Travel $34.90, Sep Printing
  // $29.50) aren't in invoices, bank transactions or manual journals: they need GET /Journals
  // (accounting.journals.read), pending f8. Everything the accounting objects carry matches Xero per account.
  it.fails('Aug and Sep operating expenses and net income (payroll and expense claims)', async () => {
    for (const r of (await compare()).filter((x) => x.month !== '2026-07')) expect(r.ours, r.month).toEqual(r.theirs)
  })

  it('moving the Xero connection to another company moves its receivables, payables and documents (bank links stay)', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'mover14b@example.com', 'Demo Company')
      const E = await entities(s)
      const xero = await connectProvider(srv, s, 'quickbooks', { entityId: E['Demo Company'], name: 'Xero' })
      const events = await connectorEvents(xero.id)
      xero.push(() => events)
      expect((await xero.sync()).status).toBe('ok')
      // The company's bank (Plaid) received the INV-0001..3 payments, so Xero's payments link to bank rows that stay put.
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E['Demo Company'], name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Checking', accountType: 'depository', currency: 'USD' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: { minor: 1_000_000, currency: 'USD' } },
        ...['2025-09-24', '2025-10-24', '2025-11-24'].map((date, i) => ({ type: 'txn.upsert', externalId: `p${i}`, connectionId: c, accountExternalId: 'chk', date, amount: { minor: 50_000, currency: 'USD' }, status: 'posted', counterparty: 'City Limousines', rawText: 'DEPOSIT CITY LIMOUSINES' })),
      ] as NormalizedEvent[])
      expect((await bank.sync()).status).toBe('ok')
      const ledger = srv.booted.services.ledger as unknown as { decideLink(ws: string, id: string, d: 'confirmed', by: null): Promise<unknown> }
      const proposed = await withBypass('test:read', () => (srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>).selectFrom('ledger_links').select('id').where('status', '=', 'proposed').execute())
      expect(proposed.length).toBe(3)
      for (const l of proposed) await withBypass('test:link', () => ledger.decideLink(s.workspaceId, l.id as string, 'confirmed', null))
      const other = (await s.post<{ id: string }>('/api/entities', { name: 'Xero Move Co' })).body.id
      const db = srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
      const byEntity = async () => {
        const rows = await withBypass('test:read', () => db.selectFrom('journal_lines as l').innerJoin('ledger_accounts as a', 'a.id', 'l.ledger_account_id').innerJoin('journal_entries as e', 'e.id', 'l.entry_id').select(['a.entity_id', 'a.role', 'e.basis']).select((eb) => eb.fn.sum<number>(eb.ref('l.base_debit_minor')).as('dr')).select((eb) => eb.fn.sum<number>(eb.ref('l.base_credit_minor')).as('cr')).where('a.role', 'in', ['ar', 'ap']).where('e.basis', '=', 'accrual').groupBy(['a.entity_id', 'a.role', 'e.basis']).execute())
        return Object.fromEntries(rows.map((r) => [`${r.entity_id === other ? 'new' : 'old'}:${r.role}`, Number(r.dr) - Number(r.cr)]))
      }
      const owed = async (id: string) => {
        const d = (await s.get<{ owedToYou: { total?: { minor: number } } | null; bills: unknown }>(`/api/entities/${id}`)).body
        return { owed: d.owedToYou?.total?.minor ?? 0, bills: JSON.stringify(d.bills ?? null) }
      }
      const drawerBefore = await owed(E['Demo Company']!)
      expect(drawerBefore.owed).toBeGreaterThan(0)
      const before = await byEntity()
      expect((await s.post(`/api/connections/${xero.id}/company`, { entityId: other })).status).toBe(200)
      // What the company drawers and the AI's invoice search say is owed moves with it, also after the next sync.
      xero.push(() => events)
      expect((await xero.sync()).status).toBe('ok')
      expect((await owed(E['Demo Company']!)).owed).toBe(0)
      expect(await owed(other)).toEqual(drawerBefore)
      const ai = await connectAi(srv, s)
      type Side = { total_count: number }
      const count = async (company: string) => {
        const r = await ai.call<{ owed_to_you?: Side; you_owe?: Side }>('search_invoices', { company, side: 'both' })
        return (r.owed_to_you?.total_count ?? 0) + (r.you_owe?.total_count ?? 0)
      }
      expect(await count('Demo Company')).toBe(0)
      expect(await count('Xero Move Co')).toBeGreaterThan(0)
      // The books store's own copies (invoices, bills, payments) follow the connection too.
      const docs = await withBypass('test:read', () => db.selectFrom('books_documents').select('entity_id').where('connection_id', '=', xero.id).execute())
      expect(docs.length).toBeGreaterThan(0)
      expect(new Set(docs.map((d) => d.entity_id))).toEqual(new Set([other]))
      const after = await byEntity()
      expect({ oldAr: after['old:ar'] ?? 0, oldAp: after['old:ap'] ?? 0, newAr: after['new:ar'], newAp: after['new:ap'] }).toEqual({ oldAr: 0, oldAp: 0, newAr: before['old:ar'], newAp: before['old:ap'] })
    } finally {
      await srv.close()
    }
  })
})
