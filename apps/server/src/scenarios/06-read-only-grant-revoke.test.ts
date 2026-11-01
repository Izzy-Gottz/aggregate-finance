// Story 6: the founder gives a bookkeeper's AI a read-only key for Acme with balances + transactions only. It can
// answer cash questions, but can't see payroll, invoices or other companies, can't write, and stops working the
// moment the key is revoked — even mid-session.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, READ_WRITE_ALL, signIn, startServer, type Server, type Session } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

async function world(srv: Server): Promise<{ s: Session; E: Record<string, string> }> {
  const s = await signIn(srv, 'founder6@example.com', 'Acme')
  expect((await s.post('/api/entities', { name: 'Bluebird', kind: 'company' })).status).toBe(201)
  const E = await entities(s)
  const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
  bank.push((c) => [
    { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
    { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(10_000_000) },
    { type: 'txn.upsert', externalId: 'aws', connectionId: c, accountExternalId: 'chk', date: '2026-09-03', amount: usd(-100_000), status: 'posted', counterparty: 'AWS', rawText: 'AWS EMEA' },
    ...['2026-09-11', '2026-09-25'].map((d, i) => ({ type: 'txn.upsert' as const, externalId: `net${i}`, connectionId: c, accountExternalId: 'chk', date: d, amount: usd(-610_000), status: 'posted' as const, counterparty: 'Gusto', rawText: 'GUSTO NET 8RTF2' })),
  ])
  expect((await bank.sync()).status).toBe('ok')
  const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
  qb.push((c) => [
    { type: 'invoice.upsert', externalId: 'i7', connectionId: c, direction: 'receivable', number: '7', counterparty: 'Initech', issueDate: '2026-09-01', dueDate: '2026-09-15', total: usd(250_000), amountPaid: usd(0), status: 'open' },
    { type: 'invoice.upsert', externalId: 'b7', connectionId: c, direction: 'payable', number: 'B7', counterparty: 'Landlord', issueDate: '2026-10-01', dueDate: '2026-10-20', total: usd(400_000), amountPaid: usd(0), status: 'open' },
  ] as never)
  expect((await qb.sync()).status).toBe('ok')
  const nex = await connectProvider(srv, s, 'plaid', { entityId: E.Bluebird, name: 'Mercury' })
  nex.push((c) => [
    { type: 'account.upsert', externalId: 'nchk', connectionId: c, name: 'Bluebird Checking', accountType: 'depository', currency: 'USD', institution: 'Mercury' },
    { type: 'balance.snapshot', externalId: 'nb0', connectionId: c, accountExternalId: 'nchk', at: '2026-10-09T08:00:00Z', current: usd(5_000_000) },
  ])
  expect((await nex.sync()).status).toBe('ok')
  return { s, E }
}

const readOnly = (acme: string) => ({ entityIds: [acme], dataTypes: ['balances', 'transactions'] as const, write: false, reviewMode: 'instant' as const, expiresAt: READ_WRITE_ALL.expiresAt })

describe('story 6: read-only grant, then revoke mid-session', () => {
  it('sees cash, not payroll or other companies; cannot write; revoked key stops at once', async () => {
    const srv = await startServer()
    try {
      const { s, E } = await world(srv)
      const ro = await connectAi(srv, s, { ...readOnly(E.Acme as string), dataTypes: ['balances', 'transactions'] }, 'Bookkeeper bot')

      // Every connection sees the same tool list (directories snapshot it); what the grant doesn't cover is refused.
      const tools = await ro.tools()
      for (const t of ['get_metric', 'get_overview', 'search_transactions', 'list_accounts', 'get_payroll', 'add_entry']) expect(tools).toContain(t)
      // Calling outside the grant fails, without data, and says why.
      expect(await ro.try('get_payroll', { company: 'Acme' })).toMatchObject({ isError: true, data: { error: 'forbidden' } })
      const write = await ro.try('add_entry', { company: 'Acme', kind: 'expense', amount: { amount: '5.00', currency: 'USD' }, date: '2026-10-01', paid_by: 'Acme', reason: 'test', idempotency_key: 'ro-write-0001' })
      expect(write).toMatchObject({ isError: true, data: { error: 'forbidden' } })
      expect(JSON.stringify(write)).toMatch(/read-only/)
      for (const m of ['payroll_cost', 'ar_open', 'ap_due']) {
        const r = await ro.try('get_metric', { metric: m, company: 'Acme' })
        expect(r).toMatchObject({ isError: true, data: { error: 'forbidden' } })
      }
      // Other companies don't exist for this key.
      expect((await ro.try('get_metric', { metric: 'cash', company: 'Bluebird' })).isError).toBe(true)
      expect((await ro.try('search_transactions', { company: 'Bluebird' })).isError).toBe(true)
      expect(await ro.call<{ companies: Array<{ company: string }> }>('get_overview', {}).then((o) => o.companies.map((c) => c.company))).toEqual(['Acme'])
      expect(JSON.stringify(await ro.call('get_overview', {}))).not.toContain('Bluebird')

      // What it can see is exact.
      expect(minor((await ro.call<{ value: { amount: string } }>('get_metric', { metric: 'cash', company: 'Acme' })).value)).toBe(10_000_000)
      expect((await ro.call<{ items: unknown[] }>('list_upcoming', {})).items).toEqual([]) // payroll + bills are hidden
      // Nothing it tried changed the books.
      const full = await connectAi(srv, s, READ_WRITE_ALL, 'Owner bot')
      expect(minor((await full.call<{ value: { amount: string } }>('get_metric', { metric: 'gross_burn', company: 'Acme', from: '2026-09-01', to: '2026-09-30' })).value)).toBe(1_320_000)

      // Revoked from the UI while the AI session is still open: the very next call is refused.
      expect((await s.post(`/api/ai/${ro.grantId}/revoke`, {})).status).toBe(200)
      await expect(ro.call('get_metric', { metric: 'cash', company: 'Acme' })).rejects.toThrow(/revoked|invalid_token/)
      await expect(connectAi(srv, s).then((a) => a.close())).resolves.toBeUndefined() // other keys unaffected
      expect((await full.call<{ value: unknown }>('get_metric', { metric: 'cash', company: 'Acme' })).value).toBeTruthy()
      await full.close()
    } finally {
      await srv.close()
    }
  }, 120_000)

  // get_overview gates each field by the grant's data types (fixed 2026-10-10 after this scenario caught the leak).
  it('get_overview hides invoices, bills and payroll from a balances + transactions key', async () => {
    const srv = await startServer()
    try {
      const { s, E } = await world(srv)
      const ro = await connectAi(srv, s, { ...readOnly(E.Acme as string), dataTypes: ['balances', 'transactions'] }, 'Bookkeeper bot')
      const ov = await ro.call<{ companies: Array<Record<string, unknown>>; attention: Array<{ kind: string }> }>('get_overview', {})
      const acme = ov.companies[0] as Record<string, any>
      expect(acme.owed_to_you?.total?.amount ?? null).toBeNull()
      expect(acme.bills_due_30d ?? null).toBeNull()
      expect(acme.next_payroll ?? null).toBeNull()
      expect(ov.attention.filter((a) => /invoice|bill|payroll/.test(a.kind))).toEqual([])
      await ro.close()
    } finally {
      await srv.close()
    }
  }, 120_000)

  // f8 decision: a key without 'payroll' sees payroll bank rows only as "Payroll" with no amount, and no sum, record,
  // counterparty total or report reveals what payroll cost. Cash stays true.
  it('masks payroll amounts from a key without payroll, everywhere', async () => {
    const srv = await startServer()
    try {
      const { s, E } = await world(srv)
      const ro = await connectAi(srv, s, { ...readOnly(E.Acme as string), dataTypes: ['balances', 'transactions', 'reports'] }, 'Bookkeeper bot')
      const leaks = (x: unknown) => /6100|12200|-6,100/.test(JSON.stringify(x))

      const gusto = await ro.call<{ transactions: Array<Record<string, unknown>>; sums: Array<{ amount: string }> }>('search_transactions', { company: 'Acme', query: 'Gusto', include_raw_text: true, response_format: 'detailed' })
      expect(gusto.transactions).toHaveLength(2)
      for (const t of gusto.transactions) expect(t).toMatchObject({ counterparty: 'Payroll', amount: null, kind: 'payroll', redacted: 'payroll' })
      expect(leaks(gusto)).toBe(false)
      const all = await ro.call<{ transactions: unknown[]; sums: Array<{ amount: string }> }>('search_transactions', { company: 'Acme' })
      expect(all.transactions).toHaveLength(3)
      expect(all.sums.map((m) => m.amount)).toEqual(['-1000.00']) // AWS only: payroll is out of the sum

      const id = (gusto.transactions[0] as { id: string }).id
      const rec = await ro.call<Record<string, unknown>>('get_record', { id, response_format: 'detailed' })
      expect(rec).toMatchObject({ redacted: 'payroll', fields: { counterparty: 'Payroll', amount: null } })
      expect(leaks(rec)).toBe(false)

      const cp = await ro.try('get_counterparty', { name_or_id: 'Gusto', company: 'Acme' })
      expect(cp.isError, cp.text).toBe(false)
      expect(cp.data).toMatchObject({ redacted: 'payroll' })
      expect(cp.data).not.toHaveProperty('paid_to_them_ytd')
      expect(leaks(cp.data)).toBe(false)

      // Grouped totals (query_transactions) leave payroll out the same way, however it is asked for.
      for (const args of [{ group_by: ['counterparty'] }, { query: 'Gusto' }, { group_by: ['kind', 'month'], measures: ['sum', 'min', 'max', 'avg', 'money_out'] }]) {
        const q = await ro.call<{ totals: Array<{ sum: { amount: string } }>; notes?: string[] }>('query_transactions', { company: 'Acme', ...args })
        expect(leaks(q) || /Gusto/.test(JSON.stringify(q)), JSON.stringify(args)).toBe(false)
        expect(q.notes?.[0]).toMatch(/Payroll rows of Acme are left out/)
      }
      expect((await ro.call<{ totals: Array<{ sum: { amount: string } }> }>('query_transactions', { company: 'Acme' })).totals.map((t) => t.sum.amount)).toEqual(['-1000.00'])

      const pl = await ro.call<{ reports: Array<{ total: unknown; redacted?: string; sections: Array<{ rows: Array<{ account: string; amount: unknown }> }> }> }>('get_reports', { kind: 'profit_and_loss', company: 'Acme', from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
      expect(pl.reports[0]).toMatchObject({ total: null, redacted: 'payroll' })
      expect(pl.reports[0]?.sections.flatMap((x) => x.rows)).toContainEqual(expect.objectContaining({ account: 'Payroll', amount: null }))
      expect(leaks(pl)).toBe(false)
      expect(JSON.stringify(pl)).toContain('1000.00') // the rest of the P&L is still there

      expect(minor((await ro.call<{ value: { amount: string } }>('get_metric', { metric: 'cash', company: 'Acme' })).value)).toBe(10_000_000)

      // The owner's key (with payroll) sees the real rows.
      const full = await connectAi(srv, s, READ_WRITE_ALL, 'Owner bot')
      const real = await full.call<{ transactions: Array<{ amount: { amount: string } | null }>; sums: Array<{ amount: string }> }>('search_transactions', { company: 'Acme', query: 'Gusto' })
      expect(real.transactions.map((t) => t.amount?.amount)).toEqual(['-6100.00', '-6100.00'])
      expect(real.sums.map((m) => m.amount)).toEqual(['-12200.00'])
      // The activity log through MCP (activity_log is a workspace table under row-level security too).
      const act = await full.call<{ activity: Array<{ action: string; this_connection: boolean; who: string }> }>('get_activity', {})
      expect(act.activity.some((a) => a.this_connection && a.action === 'tool.search_transactions')).toBe(true)
      expect(act.activity.some((a) => !a.this_connection && a.who.includes('Bookkeeper bot'))).toBe(true)
      const grouped = await full.call<{ groups: Array<{ counterparty: string; count: number; sum: { amount: string } }> }>('query_transactions', { company: 'Acme', group_by: ['counterparty'] })
      expect(grouped.groups.find((g) => g.counterparty === 'Gusto')).toMatchObject({ count: 2, sum: { amount: '-12200.00' } })
      await full.close()
      await ro.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
