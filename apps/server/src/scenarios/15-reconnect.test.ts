// Scenario 15: a source never counts twice. Disconnecting with "delete its data" takes its entries out (closed
// periods stay as reported); reconnecting the same provider company or bank accounts after a plain disconnect retires
// the old connection's overlap. Also under Postgres RLS (AGFN_TEST_PG_RLS=1).
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { withBypass, withWorkspace } from '@agfn/db'
import { connectProvider, entities, signIn, startServer, type Server, type Session } from './harness.ts'

const usd = (minor: number) => ({ minor, currency: 'USD' })

/** The same books twice: an invoice and a bill in September, and a sale in October. */
const books = (connectionId: string): NormalizedEvent[] =>
  [
    { type: 'invoice.upsert', externalId: 'inv-1', direction: 'receivable', number: 'INV-1', counterparty: 'Globex', issueDate: '2026-09-05', dueDate: '2026-10-05', total: usd(100_000), amountPaid: usd(0), status: 'open' },
    { type: 'invoice.upsert', externalId: 'bill-1', direction: 'payable', number: 'B-1', counterparty: 'Initech', issueDate: '2026-09-10', dueDate: '2026-10-10', total: usd(30_000), amountPaid: usd(0), status: 'open' },
    { type: 'invoice.upsert', externalId: 'inv-2', direction: 'receivable', number: 'INV-2', counterparty: 'Globex', issueDate: '2026-10-02', dueDate: '2026-11-02', total: usd(20_000), amountPaid: usd(0), status: 'open' },
  ].map((e) => ({ ...e, connectionId })) as NormalizedEvent[]

async function world(email: string) {
  const srv = await startServer({ scripted: ['xero'] })
  const s = await signIn(srv, email, 'Acme')
  const acme = (await entities(s)).Acme as string
  const ledger = srv.booted.services.ledger as unknown as {
    profitAndLoss(ws: string, o: { entityIds: string[]; from: string; to: string; basis: 'accrual' }): Promise<{ netIncome: { minor: number } }>
    lockPeriod(ws: string, o: { entityId: string; through: string }): Promise<unknown>
  }
  const net = async (from: string, to: string) => (await withWorkspace(s.workspaceId, () => ledger.profitAndLoss(s.workspaceId, { entityIds: [acme], from, to, basis: 'accrual' }))).netIncome.minor
  const owed = async () => ((await s.get<{ owedToYou: { total?: { minor: number } } | null; bills: { rows?: Array<{ amount: { minor: number } }> } | null }>(`/api/entities/${acme}`)).body)
  const totals = async () => {
    const o = await owed()
    return { sep: await net('2026-09-01', '2026-09-30'), oct: await net('2026-10-01', '2026-10-31'), ar: o.owedToYou?.total?.minor ?? 0, ap: (o.bills?.rows ?? []).reduce((t, r) => t + r.amount.minor, 0) }
  }
  const xero = async (tenantId: string) => {
    const c = await connectProvider(srv, s, 'xero', { entityId: acme, name: 'Xero · Acme', config: { tenantId } })
    c.push(books)
    expect((await c.sync()).status).toBe('ok')
    return c
  }
  return { srv, s, acme, ledger, totals, xero }
}

const disconnect = (s: Session, id: string, deleteData: boolean) => s.post(`/api/connections/${id}/disconnect`, { deleteData })

async function activity(srv: Server, ws: string, action = 'connection.retired'): Promise<string[]> {
  const db = srv.booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  return (await withBypass('test:read', () => db.selectFrom('activity_log').select('detail').where('workspace_id', '=', ws).where('action', '=', action).execute())).map((r) => String(r.detail))
}

describe('scenario 15: reconnecting never counts a source twice', () => {
  it('disconnect + delete its data, then reconnect: the same totals as one connection', async () => {
    const w = await world('reconnect15a@example.com')
    try {
      const old = await w.xero('t-1')
      const once = await w.totals()
      expect(once).toEqual({ sep: 70_000, oct: 20_000, ar: 120_000, ap: 30_000 })
      expect((await disconnect(w.s, old.id, true)).status).toBe(200)
      expect(await w.totals()).toEqual({ sep: 0, oct: 0, ar: 0, ap: 0 })
      await w.xero('t-1')
      expect(await w.totals()).toEqual(once)
      expect((await activity(w.srv, w.s.workspaceId)).join(' ')).toMatch(/removed with its data: 3 records no longer count/)
    } finally {
      await w.srv.close()
    }
  })

  it('disconnect without deleting keeps the history; reconnecting the same Xero organisation retires the overlap', async () => {
    const w = await world('reconnect15b@example.com')
    try {
      const old = await w.xero('t-1')
      const once = await w.totals()
      expect((await disconnect(w.s, old.id, false)).status).toBe(200)
      expect(await w.totals()).toEqual(once) // still visible as of the disconnect
      // A different organisation from the same provider doesn't touch it.
      const other = await connectProvider(w.srv, w.s, 'xero', { entityId: w.acme, name: 'Xero · Side', config: { tenantId: 't-2' } })
      other.push(() => [])
      await other.sync()
      expect(await w.totals()).toEqual(once)
      await w.xero('t-1')
      expect(await w.totals()).toEqual(once)
      expect((await activity(w.srv, w.s.workspaceId)).join(' ')).toMatch(/Xero · Acme was connected again, so the earlier, disconnected one stopped counting 3 records from 2026-09-05 on/)
      // Connecting and disconnecting are re-checked actions: each leaves a row with who did it.
      const log = (await activity(w.srv, w.s.workspaceId, 'connection.disconnected')).join(' ')
      expect(log).toMatch(/Disconnected Xero · Acme; its data until now still counts/)
    } finally {
      await w.srv.close()
    }
  })

  it('an accounting connection (no bank accounts) shows the company it belongs to and that its records came in', async () => {
    const w = await world('acct-owner@example.com')
    try {
      const c = await w.xero('t-9')
      const detail = (await w.s.get<{ entityNames: string[]; needsCompany?: number; accounts: unknown[]; records?: number }>(`/api/connections/${c.id}`)).body
      expect(detail).toMatchObject({ entityNames: ['Acme'], accounts: [], records: 3 })
      expect(detail.needsCompany).toBeUndefined()
    } finally {
      await w.srv.close()
    }
  })

  it('a closed period stays as reported: the reversal lands in the open period', async () => {
    const w = await world('reconnect15c@example.com')
    try {
      const old = await w.xero('t-1')
      await withWorkspace(w.s.workspaceId, () => w.ledger.lockPeriod(w.s.workspaceId, { entityId: w.acme, through: '2026-09-30' }))
      expect((await disconnect(w.s, old.id, true)).status).toBe(200)
      const t = await w.totals()
      expect(t.sep).toBe(70_000) // September was closed with these numbers
      expect(t.oct).toBe(-70_000) // its reversal, and October's own sale, are in October
    } finally {
      await w.srv.close()
    }
  })

  it('a bank reconnected as a new Item: the old accounts it also reads stop counting, others stay', async () => {
    const w = await world('reconnect15d@example.com')
    try {
      const bank = (c: string, rows: Array<[string, string, number]>, balance: number): NormalizedEvent[] =>
        [
          { type: 'account.upsert', externalId: 'chk', name: 'Checking', accountType: 'depository', currency: 'USD', mask: '1234', institution: 'First Platypus' },
          { type: 'account.upsert', externalId: 'sav', name: 'Savings', accountType: 'depository', currency: 'USD', mask: '9876', institution: 'First Platypus' },
          { type: 'balance.snapshot', externalId: 'chk@1', accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(balance) },
          { type: 'balance.snapshot', externalId: 'sav@1', accountExternalId: 'sav', at: '2026-10-09T08:00:00Z', current: usd(5_000) },
          ...rows.map(([id, date, minor]) => ({ type: 'txn.upsert', externalId: id, accountExternalId: 'chk', date, amount: usd(minor), status: 'posted', counterparty: 'Shop' })),
        ].map((e) => ({ ...e, connectionId: c })) as NormalizedEvent[]
      const old = await connectProvider(w.srv, w.s, 'plaid', { entityId: w.acme, name: 'First Platypus' })
      old.push((c) => bank(c, [['a', '2026-08-03', -1_000], ['b', '2026-09-03', -2_000]], 100_000))
      await old.sync()
      const cash = async () => {
        const v = (await withWorkspace(w.s.workspaceId, () => w.srv.booted.services.ledger.metric('cash', { workspaceId: w.s.workspaceId, entityIds: [w.acme] }))).value
        return v && typeof v === 'object' && 'minor' in v ? v.minor : null
      }
      expect(await cash()).toBe(105_000)
      expect((await disconnect(w.s, old.id, false)).status).toBe(200)
      // The new Item only reads checking, from September on.
      const fresh = await connectProvider(w.srv, w.s, 'plaid', { entityId: w.acme, name: 'First Platypus (new)' })
      fresh.push((c) => bank(c, [['b2', '2026-09-03', -2_000], ['c2', '2026-10-03', -3_000]], 97_000).filter((e) => !('externalId' in e && /^sav/.test(e.externalId))))
      await fresh.sync()
      // Checking counts once (the new Item's balance); savings, which only the old Item reads, still counts.
      expect(await cash()).toBe(102_000)
      const sep = await withWorkspace(w.s.workspaceId, () => w.srv.booted.services.ledger.metric('net_burn', { workspaceId: w.s.workspaceId, entityIds: [w.acme], from: '2026-09-01', to: '2026-09-30' }))
      expect(sep.value).toEqual(usd(2_000))
    } finally {
      await w.srv.close()
    }
  })

  it("one workspace's reconnect or disconnect never touches another's records", async () => {
    const a = await world('reconnect15e@example.com')
    try {
      const old = await a.xero('t-1')
      expect((await disconnect(a.s, old.id, false)).status).toBe(200)
      const once = await a.totals()
      const b = await signIn(a.srv, 'reconnect15f@example.com', 'Beta')
      const beta = (await entities(b)).Beta as string
      const theirs = await connectProvider(a.srv, b, 'xero', { entityId: beta, name: 'Xero · Beta', config: { tenantId: 't-1' } })
      theirs.push(books)
      await theirs.sync()
      expect(await a.totals()).toEqual(once)
      expect((await disconnect(b, old.id, true)).status).toBe(404)
      expect(await a.totals()).toEqual(once)
    } finally {
      await a.srv.close()
    }
  })
})
