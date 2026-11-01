import type { Actor, DataType, FinanceReader, InvoiceSearchResult, InvoiceUpsert, LinkProposal, NormalizedEvent, Provenance, RecordWriter } from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { connect, connectPglite, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import type { Books } from '@agfn/invoices/db'
import type { SyncEngineDeps } from '@agfn/sync'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { describe, expect, it } from 'vitest'
import type { RequestPerson } from './app.ts'
import { composeFinance, financeFor } from './finance.ts'
import { financeRoutes } from './routes/finance.ts'

const WS = 'ws_fin'
const ACME = 'ent_acme'
const OTHER = 'ent_other'
const PERSON = 'per_1'
const QBO = 'conn_qbo'
const BANK = 'conn_bank'
const usd = (minor: number) => ({ minor, currency: 'USD' })
const prov: Provenance = { writeRequestId: 'wr_1', actorKind: 'agent', label: 'Claude' }

// ---------- composition rules (no database) ----------

describe('composeFinance', () => {
  it('passes the ledger reader’s coverage through, so MCP can list get_coverage', async () => {
    const view = [{ accountId: 'a1' }] as never
    const withIt = composeFinance({ core: { reader: { coverage: async () => view } as never, writer: {} as never, owns: async () => false } })
    expect(await withIt.reader.coverage?.({ workspaceId: 'w', entityIds: [] })).toBe(view)
    const without = composeFinance({ core: { reader: {} as never, writer: {} as never, owns: async () => false } })
    expect(without.reader.coverage).toBeUndefined()
  })
  it('passes every optional ledger read and the dry-run preview through (MCP lists tools by them)', async () => {
    const marker = Symbol('m')
    const optional = ['coverage', 'periodLocks', 'mrrMovements', 'investments'] as const
    const reader = Object.fromEntries(optional.map((k) => [k, async () => marker])) as never
    const writer = { apply: async () => ({}), revert: async () => {}, preview: async () => marker } as never
    const f = composeFinance({ core: { reader, writer, owns: async () => false } })
    for (const k of optional) expect(await (f.reader[k] as unknown as (() => Promise<unknown>) | undefined)?.(), k).toBe(marker)
    expect(await f.writer.preview?.({ op: 'add_entry', workspaceId: 'w', entityId: 'e', payload: {} }, {} as never)).toBe(marker)
  })
  const emptyInv: InvoiceSearchResult = { rows: [], totalCount: 0, nextCursor: null, totals: [], aging: [] }
  function fakeBooks(owned: string[] = []): Books & { calls: string[] } {
    const calls: string[] = []
    const b = {
      calls,
      reader: {
        dataAvailability: async () => ['payroll', 'invoices'] as DataType[],
        searchInvoices: async () => (calls.push('books.searchInvoices'), emptyInv),
        payroll: async () => (calls.push('books.payroll'), []),
        upcoming: async () => [
          { date: '2026-10-20', entityId: ACME, kind: 'payroll' as const, what: 'Gusto payroll', amount: usd(1), confidence: 'estimated' as const },
          { date: '2026-10-11', entityId: ACME, kind: 'bill' as const, what: 'books bill', amount: usd(2), confidence: 'scheduled' as const, recordId: 'b1' },
        ],
        getRecord: async (_ws: string, id: string) => (id === 'run_1' ? ({ id, type: 'payroll_run' } as never) : null),
        drawer: async () => ({ owedToYou: null, bills: null, payroll: null }),
      },
      writer: {
        handles: (op: string) => op === 'add_invoice' || op === 'record_payment',
        apply: async () => (calls.push('books.apply'), { recordId: 'bk', recordType: 'invoice', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: '' }) as never,
        owns: async (_ws: string, id: string) => owned.includes(id),
        revert: async (_ws: string, id: string) => void calls.push(`books.revert:${id}`),
      },
    }
    return b as unknown as Books & { calls: string[] }
  }

  it('core is canonical for invoices and writes; books for payroll; upcoming merges by kind', async () => {
    const calls: string[] = []
    const core: Partial<FinanceReader> = {
      dataAvailability: async () => ['balances', 'transactions'],
      searchInvoices: async () => (calls.push('core.searchInvoices'), emptyInv),
      payroll: async () => (calls.push('core.payroll'), []),
      getRecord: async (_ws, id) => (id === 'rec_1' ? ({ id, type: 'invoice' } as never) : null),
      upcoming: async () => [
        { date: '2026-10-12', entityId: ACME, kind: 'bill', what: 'core bill', amount: usd(3), confidence: 'scheduled', recordId: 'r9' },
        { date: '2026-10-15', entityId: ACME, kind: 'payroll', what: 'core payroll guess', amount: usd(4), confidence: 'estimated' },
      ],
    }
    const writer: RecordWriter = {
      apply: async (cmd) => (calls.push(`core.apply:${cmd.op}`), { recordId: 'c', recordType: 'entry', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: '' }),
      revert: async (_ws, id) => void calls.push(`core.revert:${id}`),
    }
    const books = fakeBooks(['bk_rec'])
    const f = composeFinance({ core: { reader: core, writer, owns: async (_ws, id) => id === 'rec_1' }, books })
    const scope = { workspaceId: WS, entityIds: [ACME] }

    expect((await f.reader.dataAvailability(scope)).sort()).toEqual(['balances', 'invoices', 'payroll', 'transactions'])
    await f.reader.searchInvoices(scope, { limit: 5 })
    await f.reader.payroll(scope, { people: false })
    expect(calls).toEqual(['core.searchInvoices'])
    expect(books.calls).toEqual(['books.payroll'])
    expect((await f.reader.upcoming(scope, 30)).map((u) => u.what)).toEqual(['core bill', 'Gusto payroll'])
    expect(await f.reader.getRecord(WS, 'rec_1')).toMatchObject({ type: 'invoice' })
    expect(await f.reader.getRecord(WS, 'run_1')).toMatchObject({ type: 'payroll_run' })
    expect(await f.reader.getRecord(WS, 'nope')).toBeNull()

    await f.writer.apply({ op: 'record_payment', workspaceId: WS, entityId: ACME, payload: {} }, prov)
    expect(calls).toContain('core.apply:record_payment')
    await f.writer.revert(WS, 'rec_1', prov)
    await f.writer.revert(WS, 'bk_rec', prov)
    expect(calls).toContain('core.revert:rec_1')
    expect(books.calls).toContain('books.revert:bk_rec')
    await expect(f.writer.revert(WS, 'ghost', prov)).rejects.toBeInstanceOf(WriteRejected)
  })

  it('upcoming has one sign whatever the source: money out negative, money in positive (23: payroll read as income)', async () => {
    const core: Partial<FinanceReader> = {
      upcoming: async () => [
        { date: '2026-10-12', entityId: ACME, kind: 'bill', what: 'rent', amount: usd(3), confidence: 'scheduled', recordId: 'r1' },
        { date: '2026-10-13', entityId: ACME, kind: 'expected_income', what: 'invoice 12', amount: usd(5), confidence: 'scheduled', recordId: 'r2' },
        { date: '2026-10-14', entityId: ACME, kind: 'tax', what: 'sales tax', amount: usd(6), confidence: 'estimated' },
        { date: '2026-10-16', entityId: ACME, kind: 'bucket_schedule', what: 'savings in', amount: usd(7), confidence: 'scheduled', recordId: 'k1' },
        { date: '2026-10-17', entityId: ACME, kind: 'bucket_schedule', what: 'rent fund out', amount: usd(-8), confidence: 'scheduled', recordId: 'k2' },
      ],
    }
    const f = composeFinance({ core: { reader: core, writer: { apply: async () => ({}) as never, revert: async () => undefined }, owns: async () => false }, books: fakeBooks() })
    const by = Object.fromEntries((await f.reader.upcoming({ workspaceId: WS, entityIds: [ACME] }, 30)).map((u) => [u.what, u.amount.minor]))
    // Books' payroll estimate came back positive (+16,241.23 in 23's run) next to negative subscriptions.
    expect(by['Gusto payroll']).toBeLessThan(0)
    expect(by.rent).toBeLessThan(0)
    expect(by['sales tax']).toBeLessThan(0)
    expect(by['invoice 12']).toBeGreaterThan(0)
    // A bucket schedule keeps its own direction.
    expect(by['savings in']).toBeGreaterThan(0)
    expect(by['rent fund out']).toBeLessThan(0)
    expect(Math.abs(by['Gusto payroll']!)).toBe(Math.abs(usd(1).minor))
  })

  it('a detected series paying a bucket schedule is that payment, listed once (Northwind rent: Rent bucket and Commonspace)', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10)
    const next = day(10)
    const txn = (id: string, back: number, counterparty: string, minor: number) =>
      ({ id, entityId: ACME, date: day(10 - back), amount: usd(minor), status: 'posted', counterparty, links: [], needsReview: false }) as never
    const rows = [1, 2, 3].flatMap((m) => [txn(`r${m}`, 30 * m, 'Commonspace', -850_000), txn(`s${m}`, 30 * m, 'Slack', -20_000)])
    const reader = {
      searchTransactions: async () => ({ rows, sums: [] }),
      searchInvoices: async () => emptyInv,
      upcoming: async () => [{ date: next, entityId: ACME, kind: 'bucket_schedule' as const, what: 'Rent', amount: usd(-850_000), confidence: 'scheduled' as const, recordId: 'bkt_rent' }],
    } as never
    const f = composeFinance({ core: { reader, writer: {} as never, owns: async () => false } })
    const up = await f.reader.upcoming({ workspaceId: WS, entityIds: [ACME] }, 30)
    expect(up.map((u) => [u.kind, u.what])).toEqual([['bucket_schedule', 'Rent'], ['subscription', 'Slack']])
  })

  it('without core: books serves invoices and its own writes; other reads say unavailable', async () => {
    const books = fakeBooks()
    const f = composeFinance({ books, entities: async () => [] })
    const scope = { workspaceId: WS, entityIds: [ACME] }
    await f.reader.searchInvoices(scope, { limit: 5 })
    expect(books.calls).toEqual(['books.searchInvoices'])
    expect((await f.reader.upcoming(scope, 30)).map((u) => u.kind).sort()).toEqual(['bill', 'payroll'])
    await f.writer.apply({ op: 'add_invoice', workspaceId: WS, entityId: ACME, payload: {} }, prov)
    expect(books.calls).toContain('books.apply')
    await expect(f.reader.metric('cash', { workspaceId: WS, entityIds: [ACME] })).rejects.toMatchObject({ code: 'unavailable' })
    await expect(f.writer.apply({ op: 'add_entry', workspaceId: WS, entityId: ACME, payload: {} }, prov)).rejects.toMatchObject({ code: 'unavailable' })
  })
})

// ---------- wiring + routes on a real database ----------

type Db = CoreTables & Record<string, never>

async function setup(open: () => Promise<DbHandle<Db>>) {
  const h = await open()
  await migrateToLatest(h.db)
  const at = '2026-10-09T12:00:00.000Z'
  const db = h.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await db.insertInto('workspaces').values({ id: WS, name: 'W', base_currency: 'USD', created_at: at }).execute()
  for (const [id, name] of [[ACME, 'Acme'], [OTHER, 'Other Co']]) await db.insertInto('entities').values({ id, workspace_id: WS, kind: 'company', name, base_currency: 'USD', created_at: at }).execute()
  for (const [id, key, entity] of [[QBO, 'quickbooks', ACME], [BANK, 'plaid', null]] as const) {
    await db.insertInto('connections').values({ id, workspace_id: WS, connector_key: key, entity_id: entity, display_name: key, status: 'active', config_json: '{}', created_at: at }).execute()
  }
  const posted: NormalizedEvent[] = []
  const links: LinkProposal[] = []
  // Like the S1 engine: every posted event gets a ledger record, and links name record ids.
  let n = 0
  const ledger = {
    post: async (_ws: string, e: NormalizedEvent) => {
      posted.push(e)
      await db
        .insertInto('ledger_records')
        .values({ id: `lp${++n}`, workspace_id: WS, connection_id: e.connectionId, event_type: e.type, external_id: e.externalId, content_hash: `p${n}`, event_json: JSON.stringify(e), origin: 'connector', status: 'recorded', date: '2026-10-01', entity_id: ACME, amount_minor: 0, currency: 'USD', created_at: at, updated_at: at })
        .onConflict((oc) => oc.doNothing())
        .execute()
      return { journalEntryId: null, status: 'recorded' as const }
    },
    link: async (_ws: string, l: LinkProposal) => {
      const ids = (await db.selectFrom('ledger_records').select('id').where('id', 'in', [l.fromId, l.toId]).execute()).length
      if (ids !== 2) throw Object.assign(new Error('Both records must exist in this workspace'), { name: 'LinkError' })
      links.push(l)
      return { linkId: 'l', status: 'confirmed' as const }
    },
    suggestLinks: async () => [],
    metric: async () => {
      throw new Error('not used')
    },
  }
  const denied = new Set<string>()
  const permissions = {
    entitiesFor: async () => [{ id: ACME, name: 'Acme', kind: 'company' as const }],
    can: async (_a: Actor, action: string, entityId: string, dt: DataType) => entityId === ACME && !denied.has(`${action}:${dt}`),
    canManageWorkspace: async () => false,
  }
  const syncDeps = { afterSync: [] } as unknown as SyncEngineDeps
  const s = { db: h.db as never, ledger: ledger as never, syncDeps, permissions: permissions as never }
  const app = new Hono<{ Variables: { person: RequestPerson } }>()
  app.onError((err) => (err instanceof HTTPException ? err.getResponse() : new Response(String(err), { status: 500 })))
  app.use('/api/*', async (c, next) => {
    c.set('person', { personId: PERSON, name: 'Y', email: 'y@example.test', sessionId: 's', workspaceId: WS })
    await next()
  })
  app.route('/api', financeRoutes(s))
  return { h, db, s, app, posted, links, denied, syncDeps }
}

const invoice = (id: string, o: Partial<InvoiceUpsert> = {}): InvoiceUpsert => ({
  type: 'invoice.upsert',
  externalId: id,
  connectionId: QBO,
  direction: 'receivable',
  number: `INV-${id}`,
  counterparty: 'Globex',
  issueDate: '2026-08-01',
  dueDate: '2026-09-01',
  total: usd(120_000),
  amountPaid: usd(20_000),
  status: 'partially_paid',
  ...o,
})

const backends: Array<[string, () => Promise<DbHandle<Db>>]> = [
  ['sqlite', async () => connect<Db>('sqlite::memory:')],
  ['postgres (pglite)', async () => connectPglite<Db>()],
]

describe.each(backends)('finance wiring and routes on %s', (_name, open) => {
  it('sync engine hooks: book events go to books, others fall through; afterSync detects payroll', async () => {
    const { h, db, s, posted, links, syncDeps } = await setup(open)
    try {
      const fin = financeFor(s)
      expect(financeFor(s)).toBe(fin) // one per database; hooks registered once
      expect(syncDeps.afterSync).toHaveLength(2)
      // A new or changed document is kept by books, then handed back (null) so the ledger gets it in the page batch.
      expect(await syncDeps.route?.(WS, ACME, invoice('1'))).toBeNull()
      expect((await db.selectFrom('books_documents' as never).select('external_id' as never).execute()).map((r) => (r as { external_id: string }).external_id)).toEqual(['1'])
      // Unchanged too: the ledger dedupes it, and so counts it as seen by a full listing.
      expect(await syncDeps.route?.(WS, ACME, invoice('1'))).toBeNull()
      expect(await syncDeps.route?.(WS, null, invoice('2'))).toBeNull() // no company yet: the engine holds it
      expect(await syncDeps.route?.(WS, ACME, { type: 'account.upsert', externalId: 'a', connectionId: BANK, name: 'Chk', accountType: 'depository', currency: 'USD' })).toBeNull()
      expect(posted.map((e) => e.externalId)).toEqual([])

      // Bank rows the ledger accepted for Acme (read-only from ledger_records) → estimated payroll after sync.
      await db.insertInto('accounts').values({ id: 'acct_1', workspace_id: WS, connection_id: BANK, external_id: 'chk', entity_id: ACME, name: 'Checking', account_type: 'depository', currency: 'USD', created_at: '2026-10-01T00:00:00Z' } as never).execute()
      let n = 0
      for (const [date, minor, text] of [['2026-09-11', -900_000, 'GUSTO NET'], ['2026-09-11', -300_000, 'GUSTO TAX'], ['2026-09-25', -900_000, 'GUSTO NET'], ['2026-09-25', -300_000, 'GUSTO TAX']] as const) {
        const e = { type: 'txn.upsert', externalId: `t${++n}`, connectionId: BANK, accountExternalId: 'chk', date, amount: usd(minor), status: 'posted', rawText: text }
        await db
          .insertInto('ledger_records')
          .values({ id: `lr${n}`, workspace_id: WS, connection_id: BANK, event_type: 'txn.upsert', external_id: e.externalId, content_hash: `h${n}`, event_json: JSON.stringify(e), origin: 'connector', status: 'posted', date, entity_id: ACME, amount_minor: minor, currency: 'USD', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } as never)
          .execute()
      }
      for (const hook of syncDeps.afterSync ?? []) await hook(WS, BANK)
      expect(links.filter((l) => l.type === 'payroll_settlement')).toHaveLength(4)
      const [view] = await fin.reader.payroll({ workspaceId: WS, entityIds: [ACME] }, { people: false })
      expect(view?.runs.map((r) => [r.payDate, r.estimated])).toEqual([
        ['2026-09-11', true],
        ['2026-09-25', true],
      ])
    } finally {
      await h.close()
    }
  }, 60_000)

  it('a document a completed listing voided in the ledger leaves the books store too; one sent again comes back', async () => {
    const { h, db, s, syncDeps } = await setup(open)
    try {
      financeFor(s)
      expect(await syncDeps.route?.(WS, ACME, invoice('1'))).toBeNull()
      expect(await syncDeps.route?.(WS, ACME, invoice('2'))).toBeNull()
      // The ledger voided invoice 1 (QuickBooks deleted it; the full listing didn't have it).
      await db
        .insertInto('ledger_records')
        .values({ id: 'lr-gone', workspace_id: WS, connection_id: QBO, event_type: 'invoice.upsert', external_id: '1', content_hash: 'gone:h1', event_json: JSON.stringify(invoice('1')), origin: 'connector', status: 'void', date: '2026-09-01', entity_id: ACME, amount_minor: 0, currency: 'USD', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' } as never)
        .execute()
      for (const hook of syncDeps.afterSync ?? []) await hook(WS, QBO)
      const docs = async () => (await db.selectFrom('books_documents' as never).select(['external_id', 'status', 'voided_at'] as never).orderBy('external_id' as never).execute()) as Array<{ external_id: string; status: string; voided_at: string | null }>
      expect((await docs()).map((d) => [d.external_id, d.status, d.voided_at !== null])).toEqual([['1', 'void', true], ['2', invoice('2').status, false]])
      // QuickBooks sends it again: it differs from the voided copy, so it's kept as sent.
      expect(await syncDeps.route?.(WS, ACME, invoice('1'))).toBeNull()
      expect((await docs())[0]).toMatchObject({ status: invoice('1').status, voided_at: null })
    } finally {
      await h.close()
    }
  }, 60_000)

  it('GET /api/entities/:id builds CompanyDetail from what is installed, gated per data type', async () => {
    const { h, s, app, denied } = await setup(open)
    try {
      const fin = financeFor(s)
      await fin.books.ingest(WS, ACME, invoice('10'))
      await fin.books.ingest(WS, ACME, invoice('11', { direction: 'payable', counterparty: 'Example Cloud', number: 'B-11', total: usd(5_000), amountPaid: usd(0), status: 'open', dueDate: '2099-01-01', issueDate: '2026-10-01' }))

      const res = await app.request(`/api/entities/${ACME}`)
      expect(res.status).toBe(200)
      const d = (await res.json()) as Record<string, any>
      expect(d.entity).toMatchObject({ id: ACME, name: 'Acme', currency: 'USD', cash: null })
      expect(d.cash).toBeNull() // no ledger reader installed in this test
      expect(d.owedToYou).toMatchObject({ total: usd(100_000), invoices: [{ counterparty: 'Globex', number: 'INV-10', total: usd(120_000), open: usd(100_000), dueDate: '2026-09-01', source: 'QuickBooks' }] })
      // Due Sep 1 and aged from the real today: one overdue bucket holds it, whichever the day of the run.
      expect(d.owedToYou.aging).toEqual([{ label: expect.stringMatching(/^(1–30|31–60|61–90) days$|^Over 90 days$/), amount: usd(100_000) }])
      expect(d.bills).toMatchObject({ dueSoon: usd(0), rows: [{ name: 'Example Cloud', amount: usd(5_000), detail: 'B-11' }] })
      // What needs a look comes from the sections already read (no workspace-wide overview): here the overdue invoice.
      expect(d).toMatchObject({ payroll: null, equity: null, buckets: [], whoseMoney: [], odd: [{ label: 'Overdue invoice', detail: expect.stringMatching(/^INV-10 to Globex is \d+ days overdue$/), tone: 'amber' }], hasTransactions: false, trend: [] })

      denied.add('view:invoices')
      const limited = (await (await app.request(`/api/entities/${ACME}`)).json()) as Record<string, unknown>
      expect(limited.owedToYou).toBeNull()
      expect(limited.bills).not.toBeNull()

      expect((await app.request(`/api/entities/${OTHER}`)).status).toBe(404)
      expect((await app.request('/api/entities/ent_nope')).status).toBe(404)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('transactions and payroll register routes', async () => {
    const { h, app, denied } = await setup(open)
    try {
      expect(await (await app.request(`/api/entities/${ACME}/transactions?q=figma`)).json()).toEqual([])

      const csv = 'Employee,Check date,Gross pay,Employer taxes,Net pay\nAda,10/03/2026,"5,000.00",400.00,"3,800.00"\nBen,10/03/2026,"3,000.00",250.00,"2,300.00"\n'
      const form = new FormData()
      form.set('file', new File([csv], 'register.csv', { type: 'text/csv' }))
      form.set('provider', 'Gusto')
      const up = await app.request(`/api/entities/${ACME}/payroll-register`, { method: 'POST', body: form })
      expect(up.status).toBe(201)
      expect(await up.json()).toEqual({ runs: 1, issues: [] })
      // Same file again: nothing new.
      const again = await app.request(`/api/entities/${ACME}/payroll-register?provider=Gusto`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv })
      expect(await again.json()).toEqual({ runs: 0, issues: [] })

      const d = (await (await app.request(`/api/entities/${ACME}`)).json()) as { payroll: { runs: Array<{ date: string; gross: unknown; provider: string }>; headcount: unknown } }
      expect(d.payroll.runs).toEqual([{ id: expect.any(String), date: '2026-10-03', gross: usd(800_000), net: usd(610_000), provider: 'Gusto' }])
      expect(d.payroll.headcount).toEqual({ employees: 2, contractors: 0 })

      expect((await app.request(`/api/entities/${ACME}/payroll-register`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: 'Name,Amount\nx,1\n' })).status).toBe(422)
      expect((await app.request(`/api/entities/${ACME}/payroll-register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(415)
      expect((await app.request(`/api/entities/${ACME}/payroll-register?currency=dollars`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv })).status).toBe(400)

      denied.add('add:payroll')
      expect((await app.request(`/api/entities/${ACME}/payroll-register`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: csv })).status).toBe(403)
      denied.add('view:transactions')
      expect((await app.request(`/api/entities/${ACME}/transactions`)).status).toBe(403)
      denied.add('view:payroll')
      expect(((await (await app.request(`/api/entities/${ACME}`)).json()) as { payroll: unknown }).payroll).toBeNull()
    } finally {
      await h.close()
    }
  }, 60_000)
})
