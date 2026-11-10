// @agfn/invoices/db: the S4/S5 store (migration 0300) and the invoice/payroll parts of the read and write ports.
//
//   const books = createBooks(db, { ledger, bankRows, clock })
//   books.ingest(ws, entityId, event)       // from the sync engine: invoice/payment/credit note/payroll events
//   books.detectForEntity(ws, entityId)      // after bank rows sync: estimated payroll runs from bank debits
//   books.ingestRegister(ws, entityId, csv)  // payroll register upload
//   books.reader / books.writer              // merged into FinanceReader / RecordWriter by apps/server
//
// Every money-moving change goes through ledger.post (packages/core); these tables hold the documents.
import type {
  AddedBy,
  AppliedWrite,
  CreditNoteUpsert,
  DataType,
  EntityId,
  Id,
  InvoiceQuery,
  InvoiceSearchResult,
  InvoiceUpsert,
  InvoiceView as PortInvoiceView,
  IsoDate,
  Ledger,
  NormalizedEvent,
  PostResult,
  LinkProposal,
  Money,
  PaymentApplied,
  PayrollRun,
  PayrollView,
  Provenance,
  ReadScope,
  RecordView,
  TxnUpsert,
  UpcomingItem,
  WorkspaceId,
  WriteCommand,
} from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { detectPayroll, parsePayrollRegister, type RegisterIssue } from '@agfn/connector-payroll-detect'
import { DEFAULT_TIME_ZONE, localDate } from '@agfn/core'
import { newId } from '@agfn/db'
import type { Kysely } from 'kysely'
import { aging, AGING_BUCKETS } from './aging.ts'
import { addDays, daysBetween } from './dates.ts'
import { docKey, normalizeName, Subledger, type InvoiceView as SubView } from './subledger.ts'

// ---------- tables ----------

export interface BooksDocumentsTable {
  id: string
  workspace_id: string
  entity_id: string
  connection_id: string | null
  source_key: string
  doc_type: 'invoice' | 'payment' | 'credit_note'
  external_id: string
  direction: 'receivable' | 'payable'
  number: string | null
  counterparty: string | null
  doc_date: string
  due_date: string | null
  total_minor: number | string | bigint
  currency: string
  status: string
  event_json: string
  added_by_json: string
  write_request_id: string | null
  note: string | null
  document_id: string | null
  voided_at: string | null
  created_at: string
  updated_at: string
}

export interface PayrollRunsTable {
  id: string
  workspace_id: string
  entity_id: string
  connection_id: string | null
  source_key: string
  external_id: string
  source: 'provider' | 'bank_detected' | 'register_upload'
  provider: string | null
  pay_date: string
  status: string
  estimated: number
  gross_minor: number | string | bigint
  employer_taxes_minor: number | string | bigint
  net_minor: number | string | bigint
  company_debit_minor: number | string | bigint | null
  currency: string
  employee_count: number | null
  event_json: string
  voided_at: string | null
  created_at: string
  updated_at: string
}

export interface BooksTables {
  books_documents: BooksDocumentsTable
  payroll_runs: PayrollRunsTable
  /** Read-only here: for the source label ("QuickBooks") on invoices. */
  connections: { id: string; workspace_id: string; connector_key: string; display_name: string }
}

// ---------- deps ----------

export interface BooksDeps {
  /** `entityId`: the company a record belongs to when its connection has none (manual entries, registers, estimates). */
  ledger: { post(workspaceId: WorkspaceId, event: NormalizedEvent, opts?: { entityId?: EntityId }): Promise<PostResult>; link: Ledger['link']; transaction?: Ledger['transaction'] }
  /**
   * Posted bank/card rows of one entity since a date, for payroll detection (wired from the ledger's store).
   * `recordId` is the ledger record id; settlement links need it (looked up by connection + external id if absent).
   */
  bankRows?: (workspaceId: WorkspaceId, entityId: EntityId, since: IsoDate) => Promise<Array<TxnUpsert & { recordId?: string }>>
  /** The workspace's IANA time zone (null = America/New_York). A payroll run's stored pay_date is its business date in
   *  this zone, so it matches the ledger (which dates the run the same way); see planRun. */
  timeZone?: (workspaceId: WorkspaceId) => Promise<string | null>
  clock?: { now(): number }
  /** Connector key → display name for "source" labels. */
  sourceNames?: Record<string, string>
}

type BookEvent = InvoiceUpsert | PaymentApplied | CreditNoteUpsert

const DOC_TYPE: Record<BookEvent['type'], BooksDocumentsTable['doc_type']> = {
  'invoice.upsert': 'invoice',
  'payment.applied': 'payment',
  'credit_note.upsert': 'credit_note',
}

const SOURCE_NAMES: Record<string, string> = {
  quickbooks: 'QuickBooks',
  xero: 'Xero',
  billcom: 'BILL',
  stripe: 'Stripe',
  manual: 'Added by hand',
}

const n = (v: number | string | bigint | null): number => (v === null ? 0 : Number(v))
/** Minor units as a plain amount in the currency's own decimals: 10000 USD → "100.00", 10000 JPY → "10000", 1250 KWD → "1.250". */
export const amountIn = (minor: number, currency: string): string => {
  const exp = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  return (minor / 10 ** exp).toFixed(exp)
}
const stable = (e: object): string => {
  const { rawRef: _r, ...rest } = e as { rawRef?: unknown }
  return JSON.stringify(rest)
}

export interface IngestResult {
  recordId: Id
  changed: boolean
  posted: boolean
}

export interface Books {
  ingest(workspaceId: WorkspaceId, entityId: EntityId, event: BookEvent | PayrollRun, opts?: { post?: boolean }): Promise<IngestResult>
  /**
   * A sync page's events at once, the same as ingesting each in turn: one read of the existing rows per connection and
   * kind, new rows in multi-row inserts. Results in the events' order.
   */
  ingestMany(workspaceId: WorkspaceId, entityId: EntityId, events: Array<BookEvent | PayrollRun>, opts?: { post?: boolean }): Promise<IngestResult[]>
  detectForEntity(workspaceId: WorkspaceId, entityId: EntityId, opts?: { sinceDays?: number }): Promise<{ runs: number; voided: number }>
  /** A retired connection's documents and payroll runs (from a date on, when given) stop showing; see Ledger.retireRecords. */
  retireConnection(workspaceId: WorkspaceId, connectionId: Id, from?: IsoDate): Promise<number>
  /**
   * Documents the ledger voided because a completed full listing no longer had them (deleted at the provider): the
   * books copies are voided too, without posting (the ledger already did). A document the provider sends again comes
   * back through ingest, as its event differs from the voided copy.
   */
  followListingVoids(workspaceId: WorkspaceId, connectionId: Id, gone: Array<{ eventType: string; externalId: string }>): Promise<number>
  ingestRegister(
    workspaceId: WorkspaceId,
    entityId: EntityId,
    csv: string,
    opts: { currency: string; provider?: string; rawRef?: Id; dateOrder?: 'mdy' | 'dmy'; decimal?: '.' | ',' },
  ): Promise<{ runs: number; issues: RegisterIssue[] }>
  /** A connection now belongs to another company: its documents and payroll runs follow (the ledger re-posts itself). */
  connectionMoved(workspaceId: WorkspaceId, connectionId: Id, entityId: EntityId): Promise<number>
  /** The AR/AP subledger for some entities, rebuilt from stored events. */
  subledger(scope: ReadScope): Promise<{ ledger: Subledger; recordIdOf(key: string): Id | undefined }>
  reader: {
    dataAvailability(scope: ReadScope): Promise<DataType[]>
    searchInvoices(scope: ReadScope, q: InvoiceQuery): Promise<InvoiceSearchResult>
    payroll(scope: ReadScope, opts: { from?: IsoDate; to?: IsoDate; people: boolean }): Promise<PayrollView[]>
    upcoming(scope: ReadScope, days: number, kinds?: UpcomingItem['kind'][]): Promise<UpcomingItem[]>
    getRecord(workspaceId: WorkspaceId, id: Id): Promise<RecordView | null>
    drawer(workspaceId: WorkspaceId, entityId: EntityId): Promise<DrawerBooks>
  }
  writer: {
    /** Handles ops add_invoice and record_payment; anything else is not this writer's. */
    handles(op: WriteCommand['op']): boolean
    apply(cmd: WriteCommand, provenance: Provenance): Promise<AppliedWrite>
    /** True when this writer owns the record (so apps/server can route revert). */
    owns(workspaceId: WorkspaceId, recordId: Id): Promise<boolean>
    revert(workspaceId: WorkspaceId, recordId: Id, provenance: Provenance): Promise<void>
  }
}

/** Shapes the company drawer reads (apps/web/src/api/types.ts CompanyDetail). */
export interface DrawerBooks {
  owedToYou: { total: Money; overdue: Money; aging: Array<{ label: string; amount: Money }>; invoices: Array<{ id: Id; counterparty: string; number?: string; total: Money; open: Money; dueDate: IsoDate; source: string }> } | null
  bills: { dueSoon: Money; rows: Array<{ id: Id; name: string; amount: Money; dueDate: IsoDate; detail: string }> } | null
  payroll: {
    nextRun?: { date: IsoDate; amount: Money; provider: string }
    last3Months: Money
    headcount: { employees: number; contractors: number }
    runs: Array<{ id: Id; date: IsoDate; gross: Money; net: Money; provider: string }>
  } | null
}

export function createBooks<DB extends BooksTables>(database: Kysely<DB>, deps: BooksDeps): Books {
  const db = database as unknown as Kysely<BooksTables>
  const clock = deps.clock ?? { now: () => Date.now() }
  const now = (): string => new Date(clock.now()).toISOString()
  const today = (): IsoDate => now().slice(0, 10)
  const names = { ...SOURCE_NAMES, ...deps.sourceNames }
  const zoneOf = async (ws: WorkspaceId): Promise<string> => (deps.timeZone ? (await deps.timeZone(ws)) ?? DEFAULT_TIME_ZONE : DEFAULT_TIME_ZONE)

  // ---------- ingest ----------

  /** The ledger's record id for an event it was given (by connection + external id). */
  async function ledgerRecordId(ws: WorkspaceId, connectionId: string, externalId: string): Promise<string | null> {
    const q = database as unknown as Kysely<{ ledger_records: { id: string; workspace_id: string; connection_id: string; external_id: string } }>
    const row = await q.selectFrom('ledger_records').select('id').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('external_id', '=', externalId).executeTakeFirst()
    return row?.id ?? null
  }

  type DocRow = { id: string; event_json: string; voided_at: string | null }
  type DocExtra = { sourceKey?: string; writeRequestId?: string; note?: string }

  /**
   * What ingesting one document does, given the row already kept for it (if any): nothing (unchanged), an update, or a
   * new row. Shared by ingest (one document) and ingestMany (a sync page), so both write exactly the same.
   */
  function planDoc(ws: WorkspaceId, entityId: EntityId, e: BookEvent, addedBy: AddedBy, extra: DocExtra, existing: DocRow | undefined) {
    const sourceKey = extra.sourceKey ?? e.connectionId
    if (existing && stable(JSON.parse(existing.event_json) as object) === stable(e)) return { id: existing.id, changed: false as const }
    const json = JSON.stringify(e)
    const cols = docColumns(e)
    const at = now()
    const id = existing?.id ?? newId()
    if (existing) {
      // Voided because a full listing no longer had it (followListingVoids: voided_at and a void copy), now sent
      // again: it's back. A retired connection's documents keep their own event, so they stay hidden.
      const back = existing.voided_at !== null && !sourceKey.startsWith('manual:') && (JSON.parse(existing.event_json) as { status?: string }).status === 'void' && e.status !== 'void'
      return { id, changed: true as const, update: { ...cols, event_json: json, updated_at: at, ...(back ? { voided_at: null } : {}) }, kept: { id, event_json: json, voided_at: back ? null : existing.voided_at } }
    }
    const insert = {
      id,
      workspace_id: ws,
      entity_id: entityId,
      connection_id: sourceKey.startsWith('manual:') ? null : e.connectionId,
      source_key: sourceKey,
      doc_type: DOC_TYPE[e.type],
      external_id: e.externalId,
      ...cols,
      event_json: json,
      added_by_json: JSON.stringify(addedBy),
      write_request_id: extra.writeRequestId ?? null,
      note: extra.note ?? null,
      document_id: null,
      voided_at: null,
      created_at: at,
      updated_at: at,
    }
    return { id, changed: true as const, insert, kept: { id, event_json: json, voided_at: null } }
  }

  async function ingestDoc(ws: WorkspaceId, entityId: EntityId, e: BookEvent, addedBy: AddedBy, extra: DocExtra = {}, post = true): Promise<IngestResult> {
    const sourceKey = extra.sourceKey ?? e.connectionId
    const existing = await db
      .selectFrom('books_documents')
      .select(['id', 'event_json', 'voided_at'])
      .where('workspace_id', '=', ws)
      .where('source_key', '=', sourceKey)
      .where('doc_type', '=', DOC_TYPE[e.type])
      .where('external_id', '=', e.externalId)
      .executeTakeFirst()
    const plan = planDoc(ws, entityId, e, addedBy, extra, existing)
    if (!plan.changed) return { recordId: plan.id, changed: false, posted: false }
    if (plan.update) await db.updateTable('books_documents').set(plan.update).where('id', '=', plan.id).execute()
    else await db.insertInto('books_documents').values(plan.insert).execute()
    if (post) await deps.ledger.post(ws, e, { entityId })
    return { recordId: plan.id, changed: true, posted: post }
  }

  /** What ingesting one payroll run does, given the row already kept for it (see planDoc). */
  function planRun(ws: WorkspaceId, entityId: EntityId, r: PayrollRun, sourceKey: string, existing: { id: string; event_json: string; pay_date: string } | undefined, tz: string) {
    // Date the run by its business date in the workspace's zone when the provider gave a real instant, exactly as the
    // ledger dates it (core eventDate). Without an instant the provider's pay date stands. Keeps every reader — the
    // payroll screen, get_payroll, the bank-payroll estimate — on the one date the ledger uses.
    const payDate = r.at ? localDate(r.at, tz) : r.payDate
    // Skip only when nothing a reader sees would change. The event alone isn't enough: pay_date is derived from `at` and
    // the workspace zone, so a row booked before this dating rule (or before a zone change) can hold the same event yet a
    // stale pay_date. Re-deriving here is what lets a re-import re-date those rows (staging's Deel split runs: the event
    // already carried `at`, but pay_date stuck on the UTC slice because the old code stored r.payDate).
    if (existing && existing.pay_date === payDate && stable(JSON.parse(existing.event_json) as object) === stable(r)) return { id: existing.id, changed: false as const }
    const at = now()
    const cols = {
      source: r.source ?? 'provider',
      provider: r.provider ?? null,
      pay_date: payDate,
      status: r.status ?? 'paid',
      estimated: r.estimated ? 1 : 0,
      gross_minor: r.gross.minor,
      employer_taxes_minor: r.employerTaxes.minor,
      net_minor: r.net.minor,
      company_debit_minor: r.companyDebit?.minor ?? null,
      currency: r.gross.currency,
      employee_count: r.employeeCount ?? null,
      event_json: JSON.stringify(r),
      voided_at: r.status === 'void' ? at : null,
      updated_at: at,
    }
    const id = existing?.id ?? newId()
    const kept = { id, event_json: cols.event_json, pay_date: cols.pay_date }
    if (existing) return { id, changed: true as const, update: cols, kept }
    return { id, changed: true as const, insert: { id, workspace_id: ws, entity_id: entityId, connection_id: /^(detect|register):/.test(sourceKey) ? null : r.connectionId, source_key: sourceKey, external_id: r.externalId, ...cols, created_at: at }, kept }
  }

  async function ingestRun(ws: WorkspaceId, entityId: EntityId, r: PayrollRun, sourceKey: string, post = true): Promise<IngestResult> {
    const existing = await db
      .selectFrom('payroll_runs')
      .select(['id', 'event_json', 'pay_date'])
      .where('workspace_id', '=', ws)
      .where('source_key', '=', sourceKey)
      .where('external_id', '=', r.externalId)
      .executeTakeFirst()
    const plan = planRun(ws, entityId, r, sourceKey, existing, await zoneOf(ws))
    if (!plan.changed) return { recordId: plan.id, changed: false, posted: false }
    if (plan.update) await db.updateTable('payroll_runs').set(plan.update).where('id', '=', plan.id).execute()
    else await db.insertInto('payroll_runs').values(plan.insert).execute()
    if (post) await deps.ledger.post(ws, r, { entityId })
    return { recordId: plan.id, changed: true, posted: post }
  }

  /** Rows per multi-row insert and ids per IN list: well under SQLite's and Postgres's bound-parameter limits. */
  const CHUNK = 100
  const chunks = <T,>(xs: T[]): T[][] => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK))

  async function ingestMany(ws: WorkspaceId, entityId: EntityId, events: Array<BookEvent | PayrollRun>, post: boolean): Promise<IngestResult[]> {
    const results: IngestResult[] = new Array(events.length)
    const changedAt: number[] = []
    // Documents: the rows kept for each (connection, kind), read once; then each event in turn, as ingest would.
    const docs = events.flatMap((e, i) => (e.type === 'payroll.run' ? [] : [[e as BookEvent, i] as const]))
    const keptDocs = new Map<string, DocRow>()
    const docKey = (source: string, type: string, ext: string) => `${source}\0${type}\0${ext}`
    const groups = new Map<string, { source: string; type: BooksDocumentsTable['doc_type']; ids: Set<string> }>()
    for (const [e] of docs) {
      const g = `${e.connectionId}\0${DOC_TYPE[e.type]}`
      const grp = groups.get(g) ?? { source: e.connectionId, type: DOC_TYPE[e.type], ids: new Set<string>() }
      grp.ids.add(e.externalId)
      groups.set(g, grp)
    }
    for (const g of groups.values()) {
      for (const part of chunks([...g.ids])) {
        const rows = await db
          .selectFrom('books_documents')
          .select(['id', 'event_json', 'voided_at', 'external_id'])
          .where('workspace_id', '=', ws)
          .where('source_key', '=', g.source)
          .where('doc_type', '=', g.type)
          .where('external_id', 'in', part)
          .execute()
        for (const r of rows) keptDocs.set(docKey(g.source, g.type, r.external_id), { id: r.id, event_json: r.event_json, voided_at: r.voided_at })
      }
    }
    const docInserts: Array<NonNullable<ReturnType<typeof planDoc>['insert']>> = []
    for (const [e, i] of docs) {
      const key = docKey(e.connectionId, DOC_TYPE[e.type], e.externalId)
      const plan = planDoc(ws, entityId, e, { kind: 'sync', name: await connectionName(e.connectionId) }, {}, keptDocs.get(key))
      results[i] = { recordId: plan.id, changed: plan.changed, posted: false }
      if (!plan.changed) continue
      changedAt.push(i)
      keptDocs.set(key, plan.kept)
      if (plan.update) {
        // A row this page inserted is still waiting: change it there rather than updating what isn't written yet.
        const pending = docInserts.find((x) => x.id === plan.id)
        if (pending) Object.assign(pending, plan.update)
        else await db.updateTable('books_documents').set(plan.update).where('id', '=', plan.id).execute()
      } else docInserts.push(plan.insert)
    }
    for (const part of chunks(docInserts)) await db.insertInto('books_documents').values(part).execute()
    // Payroll runs, the same way.
    const runs = events.flatMap((e, i) => (e.type === 'payroll.run' ? [[e as PayrollRun, i] as const] : []))
    const keptRuns = new Map<string, { id: string; event_json: string; pay_date: string }>()
    const bySource = new Map<string, Set<string>>()
    for (const [r] of runs) bySource.set(r.connectionId, (bySource.get(r.connectionId) ?? new Set<string>()).add(r.externalId))
    for (const [source, ids] of bySource) {
      for (const part of chunks([...ids])) {
        const rows = await db.selectFrom('payroll_runs').select(['id', 'event_json', 'external_id', 'pay_date']).where('workspace_id', '=', ws).where('source_key', '=', source).where('external_id', 'in', part).execute()
        for (const r of rows) keptRuns.set(`${source}\0${r.external_id}`, { id: r.id, event_json: r.event_json, pay_date: r.pay_date })
      }
    }
    const runInserts: Array<NonNullable<ReturnType<typeof planRun>['insert']>> = []
    const runTz = runs.length ? await zoneOf(ws) : DEFAULT_TIME_ZONE
    for (const [r, i] of runs) {
      const key = `${r.connectionId}\0${r.externalId}`
      const plan = planRun(ws, entityId, r, r.connectionId, keptRuns.get(key), runTz)
      results[i] = { recordId: plan.id, changed: plan.changed, posted: false }
      if (!plan.changed) continue
      changedAt.push(i)
      keptRuns.set(key, plan.kept)
      if (plan.update) {
        const pending = runInserts.find((x) => x.id === plan.id)
        if (pending) Object.assign(pending, plan.update)
        else await db.updateTable('payroll_runs').set(plan.update).where('id', '=', plan.id).execute()
      } else runInserts.push(plan.insert)
    }
    for (const part of chunks(runInserts)) await db.insertInto('payroll_runs').values(part).execute()
    if (post) {
      for (const i of changedAt.sort((a, b) => a - b)) {
        await deps.ledger.post(ws, events[i] as BookEvent | PayrollRun, { entityId })
        ;(results[i] as IngestResult).posted = true
      }
    }
    return results
  }

  // ---------- subledger ----------

  async function loadSubledger(scope: ReadScope): Promise<{ ledger: Subledger; recordIdOf(key: string): Id | undefined; rows: Map<string, BooksDocumentsTable> }> {
    const s = new Subledger()
    const ids = new Map<string, Id>()
    const rows = new Map<string, BooksDocumentsTable>()
    if (scope.entityIds.length === 0) return { ledger: s, recordIdOf: () => undefined, rows }
    const docs = (await db
      .selectFrom('books_documents')
      .selectAll()
      .where('workspace_id', '=', scope.workspaceId)
      .where('entity_id', 'in', scope.entityIds)
      .where('voided_at', 'is', null)
      .execute()) as BooksDocumentsTable[]
    // Invoices first so payments find them (the subledger tolerates either order).
    const order = { invoice: 0, credit_note: 1, payment: 2 } as const
    docs.sort((a, b) => order[a.doc_type] - order[b.doc_type] || (a.doc_date < b.doc_date ? -1 : a.doc_date > b.doc_date ? 1 : a.id < b.id ? -1 : 1))
    for (const d of docs) {
      const e = JSON.parse(d.event_json) as BookEvent
      s.apply(e)
      const key = docKey(e.connectionId, e.externalId)
      if (d.doc_type === 'invoice') {
        ids.set(key, d.id)
        rows.set(key, d)
      }
    }
    return { ledger: s, recordIdOf: (k) => ids.get(k), rows }
  }

  function sourceLabel(row: BooksDocumentsTable | undefined, connectorKeys: Map<string, string>): string {
    if (!row || row.connection_id === null) return names.manual as string
    const key = connectorKeys.get(row.connection_id) ?? 'unknown'
    return names[key] ?? key
  }

  async function connectorKeys(ws: WorkspaceId): Promise<Map<string, string>> {
    const rows = await db.selectFrom('connections').select(['id', 'connector_key']).where('workspace_id', '=', ws).execute()
    return new Map(rows.map((r) => [r.id, r.connector_key]))
  }

  function toPortView(v: SubView, row: BooksDocumentsTable, source: string): PortInvoiceView {
    const e = JSON.parse(row.event_json) as InvoiceUpsert
    const status: PortInvoiceView['status'] = v.overdue && (v.status === 'open' || v.status === 'partially_paid') ? 'overdue' : v.status
    const out: PortInvoiceView = {
      id: row.id,
      entityId: row.entity_id,
      direction: v.direction,
      counterparty: v.counterparty,
      issueDate: v.issueDate,
      total: v.total,
      amountPaid: { minor: v.total.minor - v.remaining.minor, currency: v.total.currency },
      status,
      daysOverdue: v.daysOverdue,
      source,
      hasAttachment: row.document_id !== null,
      addedBy: JSON.parse(row.added_by_json) as AddedBy,
    }
    if (v.number !== undefined) out.number = v.number
    if (v.dueDate !== undefined) out.dueDate = v.dueDate
    if (e.lines) out.lines = e.lines.map((l) => (l.quantity === undefined ? { description: l.description, amount: l.amount } : { description: l.description, amount: l.amount, quantity: l.quantity }))
    if (row.note) out.note = row.note
    return out
  }

  // ---------- payroll reads ----------

  async function runsFor(ws: WorkspaceId, entityIds: EntityId[], from: IsoDate, to: IsoDate): Promise<PayrollRunsTable[]> {
    if (entityIds.length === 0) return []
    const rows = (await db
      .selectFrom('payroll_runs')
      .selectAll()
      .where('workspace_id', '=', ws)
      .where('entity_id', 'in', entityIds)
      .where('voided_at', 'is', null)
      .where('pay_date', '>=', from)
      .where('pay_date', '<=', to)
      .orderBy('pay_date', 'asc')
      .orderBy('id', 'asc')
      .execute()) as PayrollRunsTable[]
    // A bank-detected estimate is dropped when a reported run (provider or register) covers the same pay date.
    const reported = rows.filter((r) => r.source !== 'bank_detected')
    return rows.filter(
      (r) => r.source !== 'bank_detected' || !reported.some((k) => k.entity_id === r.entity_id && Math.abs(daysBetween(k.pay_date, r.pay_date)) <= 5),
    )
  }

  const employerCost = (r: PayrollRunsTable): number => {
    const e = JSON.parse(r.event_json) as PayrollRun
    return n(r.gross_minor) + n(r.employer_taxes_minor) + (e.employerBenefits?.minor ?? 0)
  }

  function nextRunOf(rows: PayrollRunsTable[], day: IsoDate): { date: IsoDate; estimate: Money; provider: string; scheduled: boolean } | null {
    const scheduled = rows.filter((r) => r.status === 'scheduled' && r.pay_date >= day)
    if (scheduled[0]) {
      const r = scheduled[0]
      return { date: r.pay_date, estimate: { minor: n(r.company_debit_minor) || employerCost(r), currency: r.currency }, provider: r.provider ?? 'Payroll', scheduled: true }
    }
    const paid = rows.filter((r) => r.status !== 'scheduled' && r.pay_date <= day)
    const last = paid[paid.length - 1]
    const prev = paid[paid.length - 2]
    if (!last || !prev) return null
    const gap = daysBetween(prev.pay_date, last.pay_date)
    if (gap < 5 || gap > 35) return null // irregular: don't guess
    let date = addDays(last.pay_date, gap)
    while (date < day) date = addDays(date, gap)
    return { date, estimate: { minor: n(last.company_debit_minor) || employerCost(last), currency: last.currency }, provider: last.provider ?? 'Payroll', scheduled: false }
  }

  async function payrollViews(scope: ReadScope, opts: { from?: IsoDate; to?: IsoDate; people: boolean }): Promise<PayrollView[]> {
    const day = today()
    const from = opts.from ?? addDays(day, -365)
    const to = opts.to ?? addDays(day, 62)
    const out: PayrollView[] = []
    for (const entityId of scope.entityIds) {
      const rows = await runsFor(scope.workspaceId, [entityId], from, to)
      if (rows.length === 0) continue
      const paid = rows.filter((r) => r.status !== 'scheduled')
      const last = paid[paid.length - 1]
      const lastEvent = last ? (JSON.parse(last.event_json) as PayrollRun) : undefined
      const next = nextRunOf(rows, day)
      const view: PayrollView = {
        entityId,
        // Runs that happened; a scheduled or future-dated run is nextRun, not history.
        runs: paid.filter((r) => r.pay_date <= day).map((r) => ({
          id: r.id,
          payDate: r.pay_date,
          gross: { minor: n(r.gross_minor), currency: r.currency },
          employerTaxes: { minor: n(r.employer_taxes_minor), currency: r.currency },
          net: { minor: n(r.net_minor), currency: r.currency },
          employerCost: { minor: employerCost(r), currency: r.currency },
          estimated: r.estimated === 1,
        })),
        nextRun: next ? { date: next.date, estimate: next.estimate } : null,
        headcount: last?.employee_count ?? null,
        contractors: lastEvent?.lines ? new Set(lastEvent.lines.filter((l) => l.kind === 'contractor').map((l) => l.person)).size : null,
      }
      if (opts.people && lastEvent?.lines) view.people = lastEvent.lines.map((l) => ({ person: l.person, kind: l.kind, gross: l.gross, net: l.net }))
      out.push(view)
    }
    return out
  }

  // ---------- writer helpers ----------

  function addedByOf(p: Provenance): AddedBy {
    const a: AddedBy = { kind: p.actorKind === 'agent' ? 'agent' : p.actorKind === 'person' ? 'person' : 'rule', name: p.label }
    if (p.grantId) a.grantId = p.grantId
    return a
  }

  async function addInvoice(cmd: WriteCommand, prov: Provenance): Promise<AppliedWrite> {
    const p = cmd.payload as {
      direction: 'receivable' | 'payable'
      counterparty: string
      number: string | null
      issueDate: IsoDate
      dueDate: IsoDate | null
      currency: string
      lines: Array<{ description: string; quantity: number; unitPriceMinor: number; amountMinor: number }>
      taxMinor: number
      totalMinor: number
      linesMismatchMinor: number
      status: 'open' | 'paid'
      note: string | null
    }
    const cur = p.currency
    const id = newId()
    const m = (minor: number): Money => ({ minor, currency: cur })
    const event: InvoiceUpsert = {
      type: 'invoice.upsert',
      externalId: id,
      connectionId: `manual:${cmd.entityId}`,
      direction: p.direction,
      counterparty: p.counterparty,
      issueDate: p.issueDate,
      total: m(p.totalMinor),
      amountPaid: m(p.status === 'paid' ? p.totalMinor : 0),
      status: p.status,
      lines: p.lines.map((l) => ({ description: l.description, amount: m(l.amountMinor), quantity: l.quantity })),
      tax: m(p.taxMinor),
      subtotal: m(p.totalMinor - p.taxMinor),
    }
    if (p.number) event.number = p.number
    if (p.dueDate) event.dueDate = p.dueDate
    // Same counterparty + number + total, or same counterparty + total within a week: likely the same document.
    const candidates = (await db
      .selectFrom('books_documents')
      .select(['id', 'counterparty', 'number', 'total_minor', 'currency', 'doc_date'])
      .where('workspace_id', '=', cmd.workspaceId)
      .where('entity_id', '=', cmd.entityId)
      .where('doc_type', '=', 'invoice')
      .where('direction', '=', p.direction)
      .where('voided_at', 'is', null)
      .execute()) as Array<Pick<BooksDocumentsTable, 'id' | 'counterparty' | 'number' | 'total_minor' | 'currency' | 'doc_date'>>
    const who = normalizeName(p.counterparty)
    const possibleDuplicates = candidates
      .filter((c) => normalizeName(c.counterparty ?? '') === who && c.currency === cur && n(c.total_minor) === p.totalMinor)
      .filter((c) => (p.number && c.number === p.number) || Math.abs(daysBetween(c.doc_date, p.issueDate)) <= 7)
      .map((c) => c.id)
    const res = await ingestDoc(cmd.workspaceId, cmd.entityId, event, addedByOf(prov), { sourceKey: `manual:${cmd.entityId}`, writeRequestId: prov.writeRequestId, ...(p.note ? { note: p.note } : {}) })
    return {
      recordId: res.recordId,
      recordType: 'invoice',
      cashImpact: [],
      suggestedLinks: [],
      possibleDuplicates,
      summary: `${p.direction === 'receivable' ? 'Invoice to' : 'Bill from'} ${p.counterparty} recorded${p.status === 'paid' ? ' as paid' : ''}.`,
    }
  }

  async function recordPayment(cmd: WriteCommand, prov: Provenance): Promise<AppliedWrite> {
    const p = cmd.payload as {
      direction: 'receivable' | 'payable'
      amountMinor: number
      currency: string
      date: IsoDate
      applications: Array<{ invoiceId: string; amountMinor: number }>
      unappliedMinor: number
      bankTransactionId: string | null
      method: string | null
      counterparty: string | null
    }
    const scope: ReadScope = { workspaceId: cmd.workspaceId, entityIds: [cmd.entityId] }
    const { ledger } = await loadSubledger(scope)
    const docs = (await db
      .selectFrom('books_documents')
      .selectAll()
      .where('workspace_id', '=', cmd.workspaceId)
      .where('id', 'in', p.applications.map((a) => a.invoiceId))
      .execute()) as BooksDocumentsTable[]
    const byId = new Map(docs.map((d) => [d.id, d]))
    // Group applications by the connection the invoice came from: one payment event per connection, so the
    // ledger can match each application to its document by (connectionId, externalId).
    const groups = new Map<string, Array<{ externalId: string; amountMinor: number }>>()
    for (const a of p.applications) {
      const d = byId.get(a.invoiceId)
      if (!d || d.doc_type !== 'invoice' || d.entity_id !== cmd.entityId || d.voided_at) throw new WriteRejected(`No ${p.direction === 'receivable' ? 'invoice' : 'bill'} ${a.invoiceId} in this company.`, 'unknown_invoice')
      if (d.direction !== p.direction) throw new WriteRejected(`${a.invoiceId} is ${d.direction === 'receivable' ? 'an invoice you sent' : 'a bill you owe'}; use the other side.`, 'wrong_side')
      if (d.currency !== p.currency) throw new WriteRejected(`${a.invoiceId} is in ${d.currency}; record the payment in that currency.`, 'currency')
      const e = JSON.parse(d.event_json) as InvoiceUpsert
      // Everything applied so far counts, whatever its date: the open amount is what's left now.
      const v = ledger.view(docKey(e.connectionId, e.externalId), '9999-12-31')
      if (!v || v.status === 'void' || v.status === 'draft') throw new WriteRejected(`${a.invoiceId} is ${v?.status ?? 'missing'} and can't take a payment.`, 'not_open')
      if (a.amountMinor > v.remaining.minor) {
        throw new WriteRejected(`That's more than is still open on ${d.number ?? a.invoiceId} (${amountIn(v.remaining.minor, p.currency)} ${p.currency}). Apply the rest elsewhere or leave it unapplied.`, 'overpayment')
      }
      const list = groups.get(e.connectionId) ?? []
      list.push({ externalId: e.externalId, amountMinor: a.amountMinor })
      groups.set(e.connectionId, list)
    }
    const id = newId()
    const sourceKey = `manual:${cmd.entityId}`
    let i = 0
    let unapplied = p.unappliedMinor
    const m = (minor: number): Money => ({ minor, currency: p.currency })
    const entries = groups.size ? [...groups.entries()] : [[sourceKey, []] as [string, Array<{ externalId: string; amountMinor: number }>]]
    let firstRecord: Id | undefined
    for (const [connectionId, apps] of entries) {
      const applied = apps.reduce((s, a) => s + a.amountMinor, 0)
      const event: PaymentApplied = {
        type: 'payment.applied',
        externalId: entries.length > 1 ? `${id}:${i}` : id,
        connectionId,
        direction: p.direction,
        date: p.date,
        amount: m(applied + unapplied),
        applications: apps.map((a) => ({ invoiceExternalId: a.externalId, amount: m(a.amountMinor) })),
        status: 'posted',
      }
      if (unapplied > 0) event.unapplied = m(unapplied)
      if (p.bankTransactionId) event.bankTxnRef = p.bankTransactionId
      if (p.method) event.method = p.method
      if (p.counterparty) event.counterparty = p.counterparty
      unapplied = 0 // leftover credit sits on the first event only
      const res = await ingestDoc(cmd.workspaceId, cmd.entityId, event, addedByOf(prov), { sourceKey, writeRequestId: prov.writeRequestId })
      firstRecord ??= res.recordId
      i++
    }
    const suggestedLinks: LinkProposal[] = p.bankTransactionId
      ? [{ type: 'invoice_payment', fromId: firstRecord as Id, toId: p.bankTransactionId, amount: m(p.amountMinor), confidence: 1, method: 'agent' }]
      : []
    return {
      recordId: firstRecord as Id,
      recordType: 'invoice',
      // Cash itself moves in the bank feed; a payment record only settles documents.
      cashImpact: [],
      suggestedLinks,
      possibleDuplicates: [],
      summary: `Payment of ${amountIn(p.amountMinor, p.currency)} ${p.currency} applied to ${p.applications.length} ${p.direction === 'receivable' ? 'invoice' : 'bill'}${p.applications.length === 1 ? '' : 's'}${p.unappliedMinor > 0 ? `, ${amountIn(p.unappliedMinor, p.currency)} left as credit` : ''}.`,
    }
  }

  // A sync ingests a page of documents from one connection: its name is read once a minute, not once per document.
  const connNames = new Map<string, { name: string; at: number }>()
  async function connectionName(connectionId: string): Promise<string> {
    const hit = connNames.get(connectionId)
    if (hit && Date.now() - hit.at < 60_000) return hit.name
    const conn = await db.selectFrom('connections').select(['display_name']).where('id', '=', connectionId).executeTakeFirst()
    const name = conn?.display_name ?? connectionId
    if (connNames.size > 1000) connNames.clear()
    connNames.set(connectionId, { name, at: Date.now() })
    return name
  }

  // ---------- public ----------

  return {
    async connectionMoved(ws, connectionId, entityId) {
      const at = new Date().toISOString()
      const docs = await db.updateTable('books_documents').set({ entity_id: entityId, updated_at: at }).where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('entity_id', '!=', entityId).executeTakeFirst()
      const runs = await db.updateTable('payroll_runs').set({ entity_id: entityId, updated_at: at }).where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('entity_id', '!=', entityId).executeTakeFirst()
      return Number(docs.numUpdatedRows) + Number(runs.numUpdatedRows)
    },

    async ingest(ws, entityId, event, opts = {}) {
      const post = opts.post ?? true
      if (event.type === 'payroll.run') return ingestRun(ws, entityId, event, event.connectionId, post)
      return ingestDoc(ws, entityId, event, { kind: 'sync', name: await connectionName(event.connectionId) }, {}, post)
    },

    async ingestMany(ws, entityId, events, opts = {}) {
      return ingestMany(ws, entityId, events, opts.post ?? true)
    },

    async followListingVoids(ws, connectionId, gone) {
      const at = now()
      let n = 0
      for (const g of gone) {
        const docType = DOC_TYPE[g.eventType as BookEvent['type']]
        if (!docType) continue
        const d = await db
          .selectFrom('books_documents')
          .select(['id', 'event_json'])
          .where('workspace_id', '=', ws)
          .where('source_key', '=', connectionId)
          .where('doc_type', '=', docType)
          .where('external_id', '=', g.externalId)
          .where('voided_at', 'is', null)
          .executeTakeFirst()
        if (!d) continue
        const voided = { ...(JSON.parse(d.event_json) as BookEvent), status: 'void' }
        await db.updateTable('books_documents').set({ voided_at: at, updated_at: at, status: 'void', event_json: JSON.stringify(voided) }).where('id', '=', d.id).execute()
        n++
      }
      return n
    },

    async retireConnection(ws, connectionId, from) {
      const at = new Date().toISOString()
      let docs = db.updateTable('books_documents').set({ voided_at: at, updated_at: at }).where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('voided_at', 'is', null)
      let runs = db.updateTable('payroll_runs').set({ voided_at: at, updated_at: at }).where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('voided_at', 'is', null)
      if (from) {
        docs = docs.where('doc_date', '>=', from)
        runs = runs.where('pay_date', '>=', from)
      }
      return Number((await docs.executeTakeFirst()).numUpdatedRows) + Number((await runs.executeTakeFirst()).numUpdatedRows)
    },

    async detectForEntity(ws, entityId, opts = {}) {
      if (!deps.bankRows) return { runs: 0, voided: 0 }
      const since = addDays(today(), -(opts.sinceDays ?? 120))
      const txns = await deps.bankRows(ws, entityId, since)
      const reported = (await db
        .selectFrom('payroll_runs')
        .select(['pay_date', 'provider', 'source', 'event_json'])
        .where('workspace_id', '=', ws)
        .where('entity_id', '=', entityId)
        .where('source', '!=', 'bank_detected')
        .where('voided_at', 'is', null)
        .where('pay_date', '>=', addDays(since, -7))
        .execute()) as Array<Pick<PayrollRunsTable, 'pay_date' | 'provider' | 'source' | 'event_json'>>
      const knownRuns = reported.map((r) => {
        const e = JSON.parse(r.event_json) as PayrollRun
        return { payDate: r.pay_date, ...(r.provider ? { provider: r.provider } : {}), externalId: e.externalId, connectionId: e.connectionId }
      })
      // A provider with its own connection is never estimated from the bank: its runs are linked instead.
      const suppressProviders = [...new Set(reported.filter((r) => r.source === 'provider' && r.provider).map((r) => r.provider as string))]
      const sourceKey = `detect:${entityId}`
      const result = detectPayroll(txns, { connectionId: sourceKey, knownRuns, suppressProviders })
      let changed = 0
      for (const run of result.runs) if ((await ingestRun(ws, entityId, run, sourceKey)).changed) changed++
      // Estimates whose bank rows are gone (or now covered by a reported run) are voided.
      const keep = new Set(result.runs.map((r) => r.externalId))
      const stale = (await db
        .selectFrom('payroll_runs')
        .selectAll()
        .where('workspace_id', '=', ws)
        .where('source_key', '=', sourceKey)
        .where('voided_at', 'is', null)
        .where('pay_date', '>=', since)
        .execute()) as PayrollRunsTable[]
      let voided = 0
      for (const r of stale) {
        if (keep.has(r.external_id)) continue
        const e = JSON.parse(r.event_json) as PayrollRun
        await ingestRun(ws, entityId, { ...e, status: 'void' }, sourceKey)
        voided++
      }
      // Settlement links, after stale estimates are voided (a bank row settles one run). The detector speaks in
      // provider ids; the ledger links its own record ids.
      const txnIds = new Map(txns.flatMap((t) => (t.recordId ? [[`${t.connectionId}\0${t.externalId}`, t.recordId] as const] : [])))
      const runConn = new Map([...result.runs.map((r) => [r.externalId, r.connectionId] as const), ...knownRuns.map((k) => [k.externalId, k.connectionId] as const)])
      const pairs: Array<typeof result.links[number]> = []
      for (const l of result.links) {
        const t = txns.find((x) => x.externalId === l.toId)
        const to = t ? (txnIds.get(`${t.connectionId}\0${t.externalId}`) ?? (await ledgerRecordId(ws, t.connectionId, t.externalId))) : null
        const from = await ledgerRecordId(ws, runConn.get(l.fromId) ?? sourceKey, l.fromId)
        if (from && to) pairs.push({ ...l, fromId: from, toId: to })
      }
      // All the links in one ledger transaction (one lock and version bump, not one each). Ids are looked up first:
      // nothing but ledger calls may run inside it (a single-connection database would wait on itself).
      const linkAll = async () => {
        for (const l of pairs) {
          try {
            await deps.ledger.link(ws, l)
          } catch (e) {
            // Rows that don't fit the run (amounts disagree) stay ordinary spending rather than failing the sync/upload.
            if ((e as Error).name !== 'LinkError') throw e
          }
        }
      }
      if (pairs.length) await (deps.ledger.transaction && pairs.length > 1 ? deps.ledger.transaction(linkAll) : linkAll())
      return { runs: changed, voided }
    },

    async ingestRegister(ws, entityId, csv, opts) {
      const sourceKey = `register:${entityId}`
      const res = parsePayrollRegister(csv, {
        connectionId: sourceKey,
        currency: opts.currency,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.rawRef ? { rawRef: opts.rawRef } : {}),
        ...(opts.dateOrder ? { dateOrder: opts.dateOrder } : {}),
        ...(opts.decimal ? { decimal: opts.decimal } : {}),
      })
      let runs = 0
      for (const r of res.runs) if ((await ingestRun(ws, entityId, r, sourceKey)).changed) runs++
      // A register is better data than a bank estimate for the same dates: re-run detection to void those.
      if (runs > 0 && deps.bankRows) await this.detectForEntity(ws, entityId)
      return { runs, issues: res.issues }
    },

    async subledger(scope) {
      const { ledger, recordIdOf } = await loadSubledger(scope)
      return { ledger, recordIdOf }
    },

    reader: {
      async dataAvailability(scope) {
        if (scope.entityIds.length === 0) return []
        const docs = await db
          .selectFrom('books_documents')
          .select(['direction'])
          .distinct()
          .where('workspace_id', '=', scope.workspaceId)
          .where('entity_id', 'in', scope.entityIds)
          .where('doc_type', '=', 'invoice')
          .where('voided_at', 'is', null)
          .execute()
        const runs = await db.selectFrom('payroll_runs').select(['id']).where('workspace_id', '=', scope.workspaceId).where('entity_id', 'in', scope.entityIds).where('voided_at', 'is', null).limit(1).execute()
        const out: DataType[] = []
        if (docs.some((d) => d.direction === 'receivable')) out.push('invoices')
        if (docs.some((d) => d.direction === 'payable')) out.push('bills')
        if (runs.length) out.push('payroll')
        return out
      },

      async searchInvoices(scope, q) {
        const asOf = today()
        const { ledger, rows } = await loadSubledger(scope)
        const keys = await connectorKeys(scope.workspaceId)
        const all = ledger.list({ asOf, ...(q.direction ? { direction: q.direction } : {}) })
        const views = all.map((v) => toPortView(v, rows.get(v.key) as BooksDocumentsTable, sourceLabel(rows.get(v.key), keys)))
        const want = q.counterparty ? normalizeName(q.counterparty) : undefined
        const filtered = views.filter((v) => {
          if (q.status && v.status !== q.status) return false
          if (want && !normalizeName(v.counterparty).includes(want)) return false
          if (q.number && (v.number ?? '').toLowerCase() !== q.number.toLowerCase()) return false
          if (q.dueBefore && !(v.dueDate && v.dueDate < q.dueBefore)) return false
          if (q.overdueDaysMin !== undefined && v.daysOverdue < q.overdueDaysMin) return false
          if (q.amountMinor !== undefined && Math.abs(v.total.minor - q.amountMinor) > (q.amountToleranceMinor ?? 0)) return false
          return true
        })
        const offset = q.cursor ? Math.max(0, Number(q.cursor) || 0) : 0
        const limit = Math.max(1, Math.min(200, q.limit))
        const page = filtered.slice(offset, offset + limit)
        const totals: InvoiceSearchResult['totals'] = []
        const agingOut: InvoiceSearchResult['aging'] = []
        for (const direction of ['receivable', 'payable'] as const) {
          if (q.direction && q.direction !== direction) continue
          for (const rep of aging(ledger, direction, asOf)) {
            const overdue = rep.total.minor - rep.buckets.current.minor
            totals.push({ direction, open: rep.total, overdue: { minor: overdue, currency: rep.currency } })
            agingOut.push({ direction, currency: rep.currency, current: rep.buckets.current, d1_30: rep.buckets['1_30'], d31_60: rep.buckets['31_60'], d61_90: rep.buckets['61_90'], d90_plus: rep.buckets['90_plus'] })
          }
        }
        return { rows: page, totalCount: filtered.length, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null, totals, aging: agingOut }
      },

      payroll: payrollViews,

      async upcoming(scope, days, kinds) {
        const day = today()
        const until = addDays(day, days)
        const out: UpcomingItem[] = []
        if (!kinds || kinds.includes('bill')) {
          const { ledger, recordIdOf } = await loadSubledger(scope)
          const docs = await db.selectFrom('books_documents').select(['id', 'entity_id']).where('workspace_id', '=', scope.workspaceId).where('doc_type', '=', 'invoice').execute()
          const entityOf = new Map(docs.map((d) => [d.id, d.entity_id]))
          for (const v of ledger.list({ direction: 'payable', asOf: day, openOnly: true })) {
            const due = v.dueDate ?? v.issueDate
            if (due > until || v.remaining.minor === 0) continue
            const id = recordIdOf(v.key) as Id
            out.push({ date: due, entityId: entityOf.get(id) as EntityId, kind: 'bill', what: `${v.counterparty}${v.number ? ` · ${v.number}` : ''}${v.overdue ? ' (overdue)' : ''}`, amount: v.remaining, confidence: 'scheduled', recordId: id })
          }
        }
        if (!kinds || kinds.includes('payroll')) {
          for (const entityId of scope.entityIds) {
            const rows = await runsFor(scope.workspaceId, [entityId], addDays(day, -70), until)
            const next = nextRunOf(rows, day)
            if (next && next.date <= until) out.push({ date: next.date, entityId, kind: 'payroll', what: `${next.provider} payroll`, amount: next.estimate, confidence: next.scheduled ? 'scheduled' : 'estimated' })
          }
        }
        return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      },

      async getRecord(ws, id) {
        const d = (await db.selectFrom('books_documents').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()) as BooksDocumentsTable | undefined
        if (d) {
          const event = JSON.parse(d.event_json) as BookEvent
          return {
            id: d.id,
            type: 'invoice',
            entityId: d.entity_id,
            dataType: d.direction === 'receivable' ? 'invoices' : 'bills',
            data: { docType: d.doc_type, ...event, note: d.note },
            links: event.type === 'payment.applied' && event.bankTxnRef ? [{ type: 'invoice_payment', recordId: event.bankTxnRef, confirmed: true }] : [],
            audit: [{ at: d.created_at, actor: JSON.parse(d.added_by_json) as AddedBy, action: 'created' }],
            addedBy: JSON.parse(d.added_by_json) as AddedBy,
            voided: d.voided_at !== null,
          }
        }
        const r = (await db.selectFrom('payroll_runs').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()) as PayrollRunsTable | undefined
        if (!r) return null
        const run = JSON.parse(r.event_json) as PayrollRun
        const addedBy: AddedBy = r.source === 'register_upload' ? { kind: 'import', name: 'Payroll register' } : r.source === 'bank_detected' ? { kind: 'rule', name: 'Payroll from bank' } : { kind: 'sync', name: r.provider ?? 'Payroll' }
        return {
          id: r.id,
          type: 'payroll_run',
          entityId: r.entity_id,
          dataType: 'payroll',
          data: { ...run, employerCost: { minor: employerCost(r), currency: r.currency } },
          links: (run.settlementTxnExternalIds ?? []).map((t) => ({ type: 'payroll_settlement' as const, recordId: t, confirmed: true })),
          audit: [{ at: r.created_at, actor: addedBy, action: 'created' }],
          addedBy,
          voided: r.voided_at !== null,
        }
      },

      async drawer(ws, entityId) {
        const day = today()
        const scope = { workspaceId: ws, entityIds: [entityId] }
        const { ledger, recordIdOf, rows } = await loadSubledger(scope)
        const keys = await connectorKeys(ws)
        let owedToYou: DrawerBooks['owedToYou'] = null
        const ar = aging(ledger, 'receivable', day)[0]
        if (ar) {
          const labels: Record<string, string> = { current: 'Not due yet', '1_30': '1–30 days', '31_60': '31–60 days', '61_90': '61–90 days', '90_plus': 'Over 90 days' }
          const open = ledger.list({ direction: 'receivable', asOf: day, openOnly: true, currency: ar.currency }).filter((v) => v.remaining.minor > 0)
          owedToYou = {
            total: ar.total,
            overdue: { minor: ar.total.minor - ar.buckets.current.minor, currency: ar.currency },
            aging: AGING_BUCKETS.filter((b) => ar.buckets[b].minor > 0).map((b) => ({ label: labels[b] as string, amount: ar.buckets[b] })),
            invoices: open.map((v) => {
              const row: NonNullable<DrawerBooks['owedToYou']>['invoices'][number] = {
                id: recordIdOf(v.key) as Id,
                counterparty: v.counterparty,
                total: v.total,
                open: v.remaining,
                dueDate: v.dueDate ?? v.issueDate,
                source: sourceLabel(rows.get(v.key), keys),
              }
              if (v.number) row.number = v.number
              return row
            }),
          }
        }
        let bills: DrawerBooks['bills'] = null
        const ap = ledger.list({ direction: 'payable', asOf: day, openOnly: true }).filter((v) => v.remaining.minor > 0)
        if (ap.length) {
          const cur = (ap[0] as SubView).remaining.currency
          const soon = ap.filter((v) => v.remaining.currency === cur && daysBetween(day, v.dueDate ?? v.issueDate) <= 14)
          bills = {
            dueSoon: { minor: soon.reduce((s, v) => s + v.remaining.minor, 0), currency: cur },
            rows: ap.map((v) => ({
              id: recordIdOf(v.key) as Id,
              name: v.counterparty,
              amount: v.remaining,
              dueDate: v.dueDate ?? v.issueDate,
              detail: v.overdue ? `${v.daysOverdue} days overdue` : v.number ? v.number : sourceLabel(rows.get(v.key), keys),
            })),
          }
        }
        let payroll: DrawerBooks['payroll'] = null
        const runs = await runsFor(ws, [entityId], addDays(day, -92), addDays(day, 62))
        if (runs.length) {
          const paid = runs.filter((r) => r.status !== 'scheduled' && r.pay_date >= addDays(day, -91))
          const cur = (runs[0] as PayrollRunsTable).currency
          const last = paid[paid.length - 1]
          const lastEvent = last ? (JSON.parse(last.event_json) as PayrollRun) : undefined
          const next = nextRunOf(runs, day)
          payroll = {
            last3Months: { minor: paid.filter((r) => r.currency === cur).reduce((s, r) => s + employerCost(r), 0), currency: cur },
            headcount: {
              employees: last?.employee_count ?? 0,
              contractors: lastEvent?.lines ? new Set(lastEvent.lines.filter((l) => l.kind === 'contractor').map((l) => l.person)).size : 0,
            },
            runs: [...paid].reverse().map((r) => ({
              id: r.id,
              date: r.pay_date,
              gross: { minor: n(r.gross_minor), currency: r.currency },
              net: { minor: n(r.net_minor), currency: r.currency },
              provider: r.estimated === 1 ? `${r.provider ?? 'Payroll'} (estimated)` : (r.provider ?? 'Payroll'),
            })),
          }
          if (next) payroll.nextRun = { date: next.date, amount: next.estimate, provider: next.provider }
        }
        return { owedToYou, bills, payroll }
      },
    },

    writer: {
      handles: (op) => op === 'add_invoice' || op === 'record_payment',

      async apply(cmd, prov) {
        if (cmd.op === 'add_invoice') return addInvoice(cmd, prov)
        if (cmd.op === 'record_payment') return recordPayment(cmd, prov)
        throw new WriteRejected(`books can't apply ${cmd.op}`, 'unsupported')
      },

      async owns(ws, recordId) {
        const d = await db.selectFrom('books_documents').select(['id']).where('workspace_id', '=', ws).where('id', '=', recordId).executeTakeFirst()
        return d !== undefined
      },

      async revert(ws, recordId, _prov) {
        const d = (await db.selectFrom('books_documents').selectAll().where('workspace_id', '=', ws).where('id', '=', recordId).executeTakeFirst()) as BooksDocumentsTable | undefined
        if (!d) throw new WriteRejected(`No record ${recordId}.`, 'unknown_record')
        if (d.connection_id !== null) throw new WriteRejected('This record comes from a connection; change it there.', 'synced')
        // A multi-connection payment was stored as several rows from one write: void them together.
        const siblings = (d.write_request_id
          ? await db.selectFrom('books_documents').selectAll().where('workspace_id', '=', ws).where('write_request_id', '=', d.write_request_id).execute()
          : [d]) as BooksDocumentsTable[]
        const at = now()
        for (const s of siblings) {
          if (s.voided_at) continue
          const e = JSON.parse(s.event_json) as BookEvent
          const voided = { ...e, status: 'void' } as BookEvent
          await db.updateTable('books_documents').set({ voided_at: at, updated_at: at, status: 'void', event_json: JSON.stringify(voided) }).where('id', '=', s.id).execute()
          await deps.ledger.post(ws, voided)
        }
      },
    },
  }

  function docColumns(e: BookEvent): Pick<BooksDocumentsTable, 'direction' | 'number' | 'counterparty' | 'doc_date' | 'due_date' | 'total_minor' | 'currency' | 'status'> {
    switch (e.type) {
      case 'invoice.upsert':
        return { direction: e.direction, number: e.number ?? null, counterparty: e.counterparty, doc_date: e.issueDate, due_date: e.dueDate ?? null, total_minor: e.total.minor, currency: e.total.currency, status: e.status }
      case 'payment.applied':
        return { direction: e.direction, number: e.reference ?? null, counterparty: e.counterparty ?? null, doc_date: e.date, due_date: null, total_minor: e.amount.minor, currency: e.amount.currency, status: e.status ?? 'posted' }
      case 'credit_note.upsert':
        return { direction: e.direction, number: e.number ?? null, counterparty: e.counterparty ?? null, doc_date: e.date, due_date: null, total_minor: e.amount.minor, currency: e.amount.currency, status: e.status ?? 'open' }
    }
  }
}
