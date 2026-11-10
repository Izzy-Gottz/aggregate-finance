import type { InvoiceUpsert, LinkProposal, NormalizedEvent, PaymentApplied, PayrollRun, Provenance, TxnUpsert } from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { connect, connectPglite, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { describe, expect, it } from 'vitest'
import { createBooks, type BooksTables } from './db.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const WS = 'ws_books'
const ACME = 'ent_acme'
const QBO = 'conn_qbo'
const usd = (minor: number) => ({ minor, currency: 'USD' })
const prov: Provenance = { writeRequestId: 'wr_1', actorKind: 'agent', grantId: 'g_1', label: 'Claude · Example' }

async function seed(h: DbHandle<CoreTables & BooksTables>): Promise<void> {
  await migrateToLatest(h.db)
  const at = new Date(NOW).toISOString()
  await h.db.insertInto('workspaces').values({ id: WS, name: 'W', base_currency: 'USD', created_at: at }).execute()
  await h.db.insertInto('entities').values({ id: ACME, workspace_id: WS, kind: 'company', name: 'Acme', base_currency: 'USD', created_at: at } as never).execute()
  await h.db
    .insertInto('connections')
    .values({ id: QBO, workspace_id: WS, connector_key: 'quickbooks', entity_id: ACME, display_name: 'QuickBooks · Acme', status: 'active', config_json: '{}', created_at: at } as never)
    .execute()
}

/** Like the S1 engine: every posted event gets a ledger record (by connection + external id), links name record ids. */
function fakeLedger(h?: { db: unknown }) {
  const posted: NormalizedEvent[] = []
  const links: LinkProposal[] = []
  const db = h?.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>> | undefined
  return {
    posted,
    links,
    ledger: {
      async post(_ws: string, e: NormalizedEvent) {
        posted.push(e)
        const at = '2026-10-01T00:00:00Z'
        await db
          ?.insertInto('ledger_records')
          .values({ id: `lr_${posted.length}`, workspace_id: WS, connection_id: e.connectionId, event_type: e.type, external_id: e.externalId, content_hash: `h${posted.length}`, event_json: JSON.stringify(e), origin: 'connector', status: 'posted', date: '2026-10-01', entity_id: ACME, amount_minor: 0, currency: 'USD', created_at: at, updated_at: at })
          .onConflict((oc) => oc.doNothing())
          .execute()
        return { journalEntryId: `je_${posted.length}`, status: 'posted' as const }
      },
      async link(_ws: string, l: LinkProposal) {
        if (!/^(lr_|rec_)/.test(l.fromId) || !/^(lr_|rec_)/.test(l.toId)) throw Object.assign(new Error('Both records must exist in this workspace'), { name: 'LinkError' })
        links.push(l)
        return { linkId: `ln_${links.length}`, status: 'confirmed' as const }
      },
    },
  }
}

function inv(id: string, o: Partial<InvoiceUpsert> = {}): InvoiceUpsert {
  return {
    type: 'invoice.upsert',
    externalId: id,
    connectionId: QBO,
    direction: 'receivable',
    number: `INV-${id}`,
    counterparty: 'Globex Corp',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    total: usd(100_000),
    amountPaid: usd(0),
    status: 'open',
    ...o,
  }
}

let t = 0
const txn = (date: string, minor: number, rawText: string): TxnUpsert => ({
  type: 'txn.upsert',
  externalId: `bank_${++t}`,
  connectionId: 'conn_bank',
  accountExternalId: 'chk',
  date,
  amount: usd(minor),
  status: 'posted',
  rawText,
})

const backends: Array<[string, () => Promise<DbHandle<CoreTables & BooksTables>>]> = [
  ['sqlite', async () => connect<CoreTables & BooksTables>('sqlite::memory:')],
  ['postgres (pglite)', async () => connectPglite<CoreTables & BooksTables>()],
]

describe.each(backends)('books store on %s', (_name, open) => {
  it('ingests synced documents idempotently and posts each change once', async () => {
    const h = await open()
    try {
      await seed(h)
      const L = fakeLedger(h)
      const books = createBooks(h.db, { ledger: L.ledger, clock: { now: () => NOW } })
      const a = await books.ingest(WS, ACME, inv('1'))
      expect(a).toMatchObject({ changed: true, posted: true })
      expect(await books.ingest(WS, ACME, { ...inv('1'), rawRef: 'raw_other' })).toEqual({ recordId: a.recordId, changed: false, posted: false })
      expect((await books.ingest(WS, ACME, inv('1', { amountPaid: usd(40_000), status: 'partially_paid' }))).recordId).toBe(a.recordId)
      expect(L.posted).toHaveLength(2)

      await books.ingest(WS, ACME, inv('2', { direction: 'payable', counterparty: 'Example Cloud', total: usd(30_000), dueDate: '2026-10-12', issueDate: '2026-10-01' }))
      const pay: PaymentApplied = { type: 'payment.applied', externalId: 'p1', connectionId: QBO, direction: 'receivable', date: '2026-09-10', amount: usd(40_000), applications: [{ invoiceExternalId: '1', amount: usd(40_000) }] }
      await books.ingest(WS, ACME, pay)

      const res = await books.reader.searchInvoices({ workspaceId: WS, entityIds: [ACME] }, { direction: 'receivable', limit: 10 })
      expect(res.rows).toHaveLength(1)
      expect(res.rows[0]).toMatchObject({
        id: a.recordId,
        status: 'overdue',
        daysOverdue: 39,
        amountPaid: usd(40_000),
        source: 'QuickBooks',
        addedBy: { kind: 'sync', name: 'QuickBooks · Acme' },
      })
      expect(res.totals).toEqual([{ direction: 'receivable', open: usd(60_000), overdue: usd(60_000) }])
      expect(res.aging[0]).toMatchObject({ direction: 'receivable', d31_60: usd(60_000) })
      expect(await books.reader.dataAvailability({ workspaceId: WS, entityIds: [ACME] })).toEqual(['invoices', 'bills'])
      const up = await books.reader.upcoming({ workspaceId: WS, entityIds: [ACME] }, 7)
      expect(up).toMatchObject([{ kind: 'bill', date: '2026-10-12', amount: usd(30_000), confidence: 'scheduled' }])
    } finally {
      await h.close()
    }
  }, 30_000)

  it('ingestMany writes and posts exactly what one-at-a-time ingest does, an update to a document earlier in the page included', async () => {
    const page: NormalizedEvent[] = [
      inv('1'),
      inv('2', { direction: 'payable', counterparty: 'Example Cloud', total: usd(30_000) }),
      inv('1', { amountPaid: usd(40_000), status: 'partially_paid' }),
      { type: 'payment.applied', externalId: 'p1', connectionId: QBO, direction: 'receivable', date: '2026-09-10', amount: usd(40_000), applications: [{ invoiceExternalId: '1', amount: usd(40_000) }] },
      inv('2', { direction: 'payable', counterparty: 'Example Cloud', total: usd(30_000) }),
    ]
    const run = async (batched: boolean) => {
      const h = await open()
      try {
        await seed(h)
        const L = fakeLedger(h)
        const books = createBooks(h.db, { ledger: L.ledger, clock: { now: () => NOW } })
        const res = batched ? await books.ingestMany(WS, ACME, page as never) : await (async () => { const r = []; for (const e of page) r.push(await books.ingest(WS, ACME, e as never)); return r })()
        const rows = await (h.db as any).selectFrom('books_documents').selectAll().orderBy('external_id').orderBy('doc_type').execute()
        return { res: res.map((r) => ({ changed: r.changed, posted: r.posted })), ids: res.map((r) => res.findIndex((x) => x.recordId === r.recordId)), rows: rows.map(({ id: _id, ...r }: Record<string, unknown>) => r), posted: L.posted.map((e) => e.externalId) }
      } finally {
        await h.close()
      }
    }
    const one = await run(false)
    expect(one.rows).toHaveLength(3)
    expect(await run(true)).toEqual(one)
  }, 30_000)

  it('add_invoice and record_payment through the writer; overpayment rejected; revert voids', async () => {
    const h = await open()
    try {
      await seed(h)
      const L = fakeLedger(h)
      const books = createBooks(h.db, { ledger: L.ledger, clock: { now: () => NOW } })
      const synced = await books.ingest(WS, ACME, inv('9', { total: usd(50_000) }))
      const added = await books.writer.apply(
        {
          op: 'add_invoice',
          workspaceId: WS,
          entityId: ACME,
          payload: {
            direction: 'receivable',
            counterparty: 'Initech',
            number: 'P-1',
            issueDate: '2026-10-01',
            dueDate: '2026-10-31',
            currency: 'USD',
            lines: [{ description: 'Consulting', quantity: 2, unitPriceMinor: 50_000, amountMinor: 100_000 }],
            taxMinor: 0,
            totalMinor: 100_000,
            linesMismatchMinor: 0,
            status: 'open',
            note: 'paper invoice',
          },
        },
        prov,
      )
      expect(added).toMatchObject({ recordType: 'invoice', cashImpact: [], possibleDuplicates: [] })
      const dup = await books.writer.apply({ op: 'add_invoice', workspaceId: WS, entityId: ACME, payload: { direction: 'receivable', counterparty: 'Initech Inc.', number: 'P-1', issueDate: '2026-10-02', dueDate: null, currency: 'USD', lines: [], taxMinor: 0, totalMinor: 100_000, linesMismatchMinor: -100_000, status: 'open', note: null } }, { ...prov, writeRequestId: 'wr_dup' })
      expect(dup.possibleDuplicates).toEqual([added.recordId])

      // One payment across a synced QuickBooks invoice and a hand-added one: split per connection.
      const payment = (amountMinor: number, apps: Array<[string, number]>, id = 'wr_pay') =>
        books.writer.apply(
          {
            op: 'record_payment',
            workspaceId: WS,
            entityId: ACME,
            payload: {
              direction: 'receivable',
              amountMinor,
              currency: 'USD',
              date: '2026-10-05',
              applications: apps.map(([invoiceId, a]) => ({ invoiceId, amountMinor: a })),
              unappliedMinor: amountMinor - apps.reduce((s, [, a]) => s + a, 0),
              bankTransactionId: 'bank_row_77',
              method: 'wire',
              counterparty: null,
            },
          },
          { ...prov, writeRequestId: id },
        )
      await expect(payment(200_000, [[synced.recordId, 60_000]])).rejects.toBeInstanceOf(WriteRejected)
      await expect(payment(10, [['nope', 10]])).rejects.toMatchObject({ code: 'unknown_invoice' })
      const paid = await payment(160_000, [[synced.recordId, 50_000], [added.recordId, 100_000]])
      expect(paid.suggestedLinks).toEqual([{ type: 'invoice_payment', fromId: paid.recordId, toId: 'bank_row_77', amount: usd(160_000), confidence: 1, method: 'agent' }])
      const payEvents = L.posted.filter((e): e is PaymentApplied => e.type === 'payment.applied')
      expect(payEvents.map((e) => [e.connectionId, e.applications.map((a) => a.amount.minor), e.unapplied?.minor ?? 0, e.bankTxnRef])).toEqual([
        [QBO, [50_000], 10_000, 'bank_row_77'],
        [`manual:${ACME}`, [100_000], 0, 'bank_row_77'],
      ])
      let open = await books.reader.searchInvoices({ workspaceId: WS, entityIds: [ACME] }, { limit: 10 })
      expect(open.rows.filter((r) => r.status === 'paid').map((r) => r.id).sort()).toEqual([added.recordId, synced.recordId].sort())

      expect(await books.writer.owns(WS, paid.recordId)).toBe(true)
      await books.writer.revert(WS, paid.recordId, prov)
      expect(L.posted.filter((e) => e.type === 'payment.applied' && e.status === 'void')).toHaveLength(2)
      open = await books.reader.searchInvoices({ workspaceId: WS, entityIds: [ACME] }, { status: 'open', limit: 10 })
      expect(open.rows.map((r) => r.id)).toContain(added.recordId)
      await expect(books.writer.revert(WS, synced.recordId, prov)).rejects.toMatchObject({ code: 'synced' })

      const rec = await books.reader.getRecord(WS, added.recordId)
      expect(rec).toMatchObject({ type: 'invoice', dataType: 'invoices', addedBy: { kind: 'agent', name: 'Claude · Example', grantId: 'g_1' }, data: { note: 'paper invoice' } })
    } finally {
      await h.close()
    }
  }, 30_000)

  it('payroll: provider runs, bank estimates superseded by reports, next run, drawer shapes', async () => {
    const h = await open()
    try {
      await seed(h)
      const L = fakeLedger(h)
      t = 0
      const bank = [
        txn('2026-08-14', -900_000, 'GUSTO NET 0814'),
        txn('2026-08-14', -300_000, 'GUSTO TAX 0814'),
        txn('2026-08-28', -900_000, 'GUSTO NET 0828'),
        txn('2026-08-28', -300_000, 'GUSTO TAX 0828'),
        txn('2026-09-11', -900_000, 'GUSTO NET 0911'),
        txn('2026-09-11', -300_000, 'GUSTO TAX 0911'),
        txn('2026-09-25', -900_000, 'GUSTO NET 0925'),
        txn('2026-09-25', -300_000, 'GUSTO TAX 0925'),
      ]
      const books = createBooks(h.db, { ledger: L.ledger, clock: { now: () => NOW }, bankRows: async () => bank.map((b) => ({ ...b, recordId: `rec_${b.externalId}` })) })
      expect(await books.detectForEntity(WS, ACME)).toEqual({ runs: 4, voided: 0 })
      expect(L.links.filter((l) => l.type === 'payroll_settlement')).toHaveLength(8)
      expect(await books.detectForEntity(WS, ACME)).toEqual({ runs: 0, voided: 0 }) // idempotent

      // A register upload for 09/25 replaces the bank estimate for that run.
      const csv = 'Check date,Gross pay,Employer taxes,Net pay\n09/25/2026,11000.00,850.00,9000.00\n'
      expect(await books.ingestRegister(WS, ACME, csv, { currency: 'USD', provider: 'Gusto' })).toMatchObject({ runs: 1, issues: [] })
      // The register run is settled by that date's bank rows, linked by ledger record id.
      const reg = L.posted.findIndex((e) => e.externalId.startsWith('register:2026-09-25'))
      expect(L.links.filter((l) => l.fromId === `lr_${reg + 1}`).map((l) => l.toId)).toEqual(['rec_bank_7', 'rec_bank_8'])
      const [view] = await books.reader.payroll({ workspaceId: WS, entityIds: [ACME] }, { people: false })
      expect(view?.runs.map((r) => [r.payDate, r.estimated, r.employerCost.minor])).toEqual([
        ['2026-08-14', true, 1_200_000],
        ['2026-08-28', true, 1_200_000],
        ['2026-09-11', true, 1_200_000],
        ['2026-09-25', false, 1_185_000],
      ])
      // Biweekly cadence → next run 10/09, estimated from the last run's cost.
      expect(view?.nextRun).toEqual({ date: '2026-10-09', estimate: usd(1_185_000) })
      const up = await books.reader.upcoming({ workspaceId: WS, entityIds: [ACME] }, 14, ['payroll'])
      expect(up).toMatchObject([{ kind: 'payroll', date: '2026-10-09', confidence: 'estimated' }])

      const provider: PayrollRun = {
        type: 'payroll.run',
        externalId: 'fin_1',
        connectionId: QBO,
        payDate: '2026-10-23',
        gross: usd(1_100_000),
        employerTaxes: usd(85_000),
        net: usd(900_000),
        source: 'provider',
        status: 'scheduled',
        companyDebit: usd(1_250_000),
        provider: 'Gusto',
        employeeCount: 3,
      }
      await books.ingest(WS, ACME, provider)
      const d = await books.reader.drawer(WS, ACME)
      expect(d.payroll).toMatchObject({ nextRun: { date: '2026-10-23', amount: usd(1_250_000), provider: 'Gusto' }, headcount: { employees: 0, contractors: 0 } })
      expect(d.payroll?.runs[0]).toMatchObject({ date: '2026-09-25', provider: 'Gusto' })
      expect(d.payroll?.runs[1]?.provider).toBe('Gusto (estimated)')
      expect(d.owedToYou).toBeNull()
      expect(await books.reader.dataAvailability({ workspaceId: WS, entityIds: [ACME] })).toEqual(['payroll'])
    } finally {
      await h.close()
    }
  }, 30_000)

  it('dates a payroll run that carries an instant by the workspace business day, not the UTC slice', async () => {
    const h = await open()
    try {
      await seed(h)
      const L = fakeLedger(h)
      const books = createBooks(h.db, { ledger: L.ledger, clock: { now: () => NOW }, timeZone: async () => 'America/New_York' })
      // 03:30Z on the 1st is 23:30 the evening before in New York, so the run belongs to 2026-09-30 — the same date the
      // ledger uses. The old code stored the UTC slice (2026-10-01), splitting the run from its journal entry.
      const run: PayrollRun = {
        type: 'payroll.run', externalId: 'run_at', connectionId: QBO,
        payDate: '2026-10-01', at: '2026-10-01T03:30:00Z',
        gross: usd(1_000_000), employerTaxes: usd(80_000), net: usd(800_000), source: 'provider', status: 'paid', provider: 'Gusto',
      }
      await books.ingest(WS, ACME, run)
      const payDateOf = async (ext: string) => (await h.db.selectFrom('payroll_runs').select('pay_date').where('workspace_id', '=', WS).where('external_id', '=', ext).executeTakeFirstOrThrow()).pay_date
      expect(await payDateOf('run_at')).toBe('2026-09-30')
      const [view] = await books.reader.payroll({ workspaceId: WS, entityIds: [ACME] }, { people: false })
      expect(view?.runs.map((r) => r.payDate)).toContain('2026-09-30')
      // Re-ingesting the identical run changes nothing (idempotent).
      expect((await books.ingest(WS, ACME, run)).changed).toBe(false)
      // A run without an instant keeps the provider's own pay date.
      const plain: PayrollRun = { ...run, externalId: 'run_plain', at: undefined }
      await books.ingest(WS, ACME, plain)
      expect(await payDateOf('run_plain')).toBe('2026-10-01')
      // A run first booked before the at-dating fix (no instant, UTC-slice pay date) is re-ingested once the connector
      // learns to send `at`: gaining the instant counts as a change, and the row re-dates to the business day. This is
      // the re-import's whole job for existing rows — without it payroll_runs keeps the pre-fix date while the ledger
      // moves (staging's Deel split runs: ledger on the 10th, payroll_runs stuck on the 11th).
      const prefix: PayrollRun = { type: 'payroll.run', externalId: 'run_gained', connectionId: QBO, payDate: '2026-10-01', gross: usd(1_000_000), employerTaxes: usd(80_000), net: usd(800_000), source: 'provider', status: 'paid', provider: 'Gusto' }
      await books.ingest(WS, ACME, prefix)
      expect(await payDateOf('run_gained')).toBe('2026-10-01')
      const gained = await books.ingest(WS, ACME, { ...prefix, at: '2026-10-01T03:30:00Z' })
      expect(gained.changed).toBe(true)
      expect(await payDateOf('run_gained')).toBe('2026-09-30')
      // The staging case: a row whose event ALREADY carries `at` but whose pay_date is stale, because it was booked by
      // the old code (pay_date = r.payDate) before the localDate(at, tz) rule. The event is byte-identical, so the
      // content check alone would skip it forever — a re-import could never re-date it. Re-deriving pay_date catches it.
      const withAt: PayrollRun = { type: 'payroll.run', externalId: 'run_stale', connectionId: QBO, payDate: '2026-10-01', at: '2026-10-01T03:30:00Z', gross: usd(1_000_000), employerTaxes: usd(80_000), net: usd(800_000), source: 'provider', status: 'paid', provider: 'Gusto' }
      await books.ingest(WS, ACME, withAt)
      // Simulate the pre-fix row: same event JSON, but pay_date left on the UTC slice.
      await h.db.updateTable('payroll_runs').set({ pay_date: '2026-10-01' }).where('workspace_id', '=', WS).where('external_id', '=', 'run_stale').execute()
      const redated = await books.ingest(WS, ACME, withAt)
      expect(redated.changed).toBe(true)
      expect(await payDateOf('run_stale')).toBe('2026-09-30')
    } finally {
      await h.close()
    }
  }, 30_000)
})

describe('amounts in messages', () => {
  it('use the currency’s own decimals: never 100× off for yen or 10× for dinars', async () => {
    const { amountIn } = await import('./db.ts')
    expect([amountIn(10_000, 'USD'), amountIn(10_000, 'JPY'), amountIn(1_250, 'KWD'), amountIn(5, 'USD')]).toEqual(['100.00', '10000', '1.250', '0.05'])
  })
})
