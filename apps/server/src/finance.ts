// Finance composition: one FinanceReader + RecordWriter for MCP and REST, merged from the slices that own the data.
//   core   (S1, @agfn/core): cash, accounts, transactions, metrics, buckets, review, documents, reports
//   books  (S4/S5, @agfn/invoices/db): invoices, bills, payments, payroll
//   equity (S6): cap table, equity events
// Rules (agreed with meridn-c6): core is canonical for invoices and every write, because its ids are the ledger record
// ids that links and update_record use. Books owns payroll (reported runs supersede bank estimates) and the payroll
// items in `upcoming`. Data availability is a union; getRecord asks core, then books, then equity; equity ops and reverts go to equity first, then
// whichever part owns() the record. A part that isn't installed answers "unavailable" instead of inventing numbers.
import type {
  AppliedWrite,
  DataType,
  DocumentView,
  EntityId,
  FinanceReader,
  IsoDate,
  NormalizedEvent,
  Overview,
  Provenance,
  ReadScope,
  RecordWriter,
  TxnUpsert,
  UpcomingItem,
  WorkspaceId,
  WriteCommand,
} from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { perfEnabled, perfLine, withPerf, type CoreTables } from '@agfn/db'
import { extractPdfText } from '@agfn/connector-files'
import { pdfExtract } from './documents.ts'
import * as coreModule from '@agfn/core'
import { createBooks, type Books, type BooksTables } from '@agfn/invoices/db'
import { createRecurring } from '@agfn/recurring'
import { recordTermsPage, tapTerms, termsReader, type TermsReader, type TermsTables } from './account-terms.ts'
import { detectInjection, ToolError } from '@agfn/mcp'
import type { Kysely } from 'kysely'
import type { Services } from './services.ts'
import type { RoutePage } from '@agfn/sync'
import { equityPartFor } from './equity.ts'
import { cacheWarmer, type CacheWarmer } from './warm.ts'
import { DEMO_READY_SETTING } from '@agfn/demo'

/** A writer that can say which records are its own (so revert reaches the right slice). */
export interface OwnedWriter extends RecordWriter {
  handles?(op: WriteCommand['op']): boolean
  owns?(workspaceId: WorkspaceId, recordId: string): Promise<boolean>
}

export interface FinanceParts {
  /** S1. Optional until its reader/writer merge lands. */
  core?: {
    reader: Partial<FinanceReader>
    writer?: RecordWriter
    owns?(workspaceId: WorkspaceId, recordId: string): Promise<boolean>
    bankRows?(workspaceId: WorkspaceId, entityId: EntityId, since: IsoDate): Promise<TxnUpsert[]>
  }
  books?: Books
  /** S6. */
  equity?: { reader?: Partial<FinanceReader>; writer?: OwnedWriter; ops?: WriteCommand['op'][] }
  /** The ledger's cache that lasts until the workspace's next write (recurring bills read 400 days of rows through it). */
  cacheFor?: (workspaceId: string) => (<T>(key: string, fn: () => Promise<T>) => Promise<T>) | undefined
  /** Entity list fallback when core isn't installed. */
  entities?: FinanceReader['entities']
  /** Card/loan terms and investment positions (account-terms.ts). */
  terms?: TermsReader
  /** Today in the workspace's own time zone (what "due in 30 days" counts from). UTC when absent. */
  today?: (workspaceId: string) => Promise<IsoDate>
}

/**
 * A recurring charge that is really a card or loan payment already due from the provider's terms (same company,
 * amount within 7.5%, within a week): the scheduled payment counts, the guessed one doesn't.
 */
/** Kinds of upcoming items that are money going out. */
const OUTFLOW_KINDS = new Set<UpcomingItem['kind']>(['bill', 'payroll', 'subscription', 'tax', 'loan_payment'])

/**
 * One sign for every upcoming item, whatever source made it: money out negative, money in positive (sources disagreed:
 * payroll and bills came back positive next to negative subscriptions, and an AI read payroll as income). A bucket
 * schedule keeps its own direction (it can be either).
 */
export function signed(u: UpcomingItem): UpcomingItem {
  if (u.kind === 'bucket_schedule') return u
  const minor = OUTFLOW_KINDS.has(u.kind) ? -Math.abs(u.amount.minor) : Math.abs(u.amount.minor)
  return minor === u.amount.minor ? u : { ...u, amount: { ...u.amount, minor } }
}

function samePayment(r: { entityId: string; nextDue: string; amount: { minor: number; currency: string } }, p: UpcomingItem): boolean {
  const gap = Math.abs(Date.parse(`${r.nextDue}T00:00:00Z`) - Date.parse(`${p.date}T00:00:00Z`)) / 86_400_000
  const a = Math.abs(r.amount.minor)
  const b = Math.abs(p.amount.minor)
  return r.entityId === p.entityId && r.amount.currency === p.amount.currency && gap <= 7 && Math.abs(a - b) <= 0.075 * Math.max(a, b)
}

export interface Finance {
  reader: FinanceReader
  writer: RecordWriter
  books: Books
}

const unavailable = (what: string): never => {
  throw new ToolError('unavailable', `${what} is still being set up on this server.`)
}

const EQUITY_OPS: WriteCommand['op'][] = ['record_equity_event']

export function composeFinance(parts: FinanceParts): { reader: FinanceReader; writer: RecordWriter } {
  const core = parts.core?.reader ?? {}
  const books = parts.books
  const eq = parts.equity?.reader ?? {}

  /** The core method, or an "unavailable" answer. */
  function fromCore<K extends keyof FinanceReader>(k: K): FinanceReader[K] {
    const fn = core[k] as FinanceReader[K] | undefined
    if (fn) return fn.bind(core) as FinanceReader[K]
    return (async () => unavailable(k === 'metric' ? 'That number' : 'This data')) as unknown as FinanceReader[K]
  }

  const todayOf = async (ws: string): Promise<IsoDate> => (parts.today ? parts.today(ws) : (new Date().toISOString().slice(0, 10) as IsoDate))

  async function settle<T>(p: Promise<T> | undefined): Promise<T | undefined> {
    if (!p) return undefined
    try {
      return await p
    } catch (e) {
      if (e instanceof ToolError && e.code === 'unavailable') return undefined
      throw e
    }
  }

  const reader: FinanceReader = {
    entities: core.entities?.bind(core) ?? parts.entities ?? (async () => unavailable('Companies')),

    async dataAvailability(scope) {
      const all = await Promise.all([settle(core.dataAvailability?.(scope)), settle(books?.reader.dataAvailability(scope)), settle(eq.dataAvailability?.(scope))])
      const set = new Set<DataType>()
      for (const list of all) for (const d of list ?? []) set.add(d)
      return [...set]
    },

    sources: core.sources?.bind(core) ?? (async () => []),

    // Investments the company holds (core's investment.event); absent when core doesn't offer it.
    ...(core.investments ? { investments: core.investments.bind(core) } : {}),
    ...(core.investmentTotals ? { investmentTotals: core.investmentTotals.bind(core) } : {}),

    async overview(scope, asOf) {
      let base = (await fromCore('overview')(scope, asOf)) as Overview
      if (books) {
        // Next payroll comes from books, where a reported run replaces the bank estimate for the same date.
        const up = await books.reader.upcoming(scope, 62, ['payroll'])
        base = {
          ...base,
          entities: base.entities.map((e) => {
            const pay = up.find((u) => u.entityId === e.entityId)
            return pay ? { ...e, nextPayroll: { date: pay.date, estimate: pay.amount } } : e
          }),
        }
      }
      // Bills due in 30 days: open bills (core), plus recurring charges expected in that window that aren't billed yet,
      // plus card and loan minimum payments due (each counted once: a recurring guess at a scheduled payment drops).
      const today = asOf ? asOf.slice(0, 10) : await todayOf(scope.workspaceId)
      const payments = (await settle(parts.terms?.paymentsDue(scope, today, 30))) ?? []
      const due = ((await settle(recurring.due(scope, today, 30))) ?? []).filter((r) => !payments.some((p) => samePayment(r, p)))
      const extra = [...due.map((d) => ({ entityId: d.entityId, amount: d.amount })), ...payments.map((p) => ({ entityId: p.entityId, amount: { ...p.amount, minor: -p.amount.minor } }))]
      if (!extra.length) return base
      return {
        ...base,
        entities: base.entities.map((e) => {
          const add = extra.filter((d) => d.entityId === e.entityId && d.amount.currency === e.billsDue30d.currency).reduce((n, d) => n + d.amount.minor, 0)
          return add ? { ...e, billsDue30d: { ...e.billsDue30d, minor: e.billsDue30d.minor + add } } : e
        }),
      }
    },

    metric: fromCore('metric'),
    accounts: fromCore('accounts'),
    searchTransactions: fromCore('searchTransactions'),

    async searchInvoices(scope, q) {
      if (core.searchInvoices) return core.searchInvoices(scope, q)
      if (books) return books.reader.searchInvoices(scope, q)
      return unavailable('Invoices')
    },

    async getRecord(ws, id) {
      return (await settle(core.getRecord?.(ws, id))) ?? (await books?.reader.getRecord(ws, id)) ?? (await settle(eq.getRecord?.(ws, id))) ?? null
    },

    counterparty: fromCore('counterparty'),

    async upcoming(scope, days, kinds) {
      const wantSubs = !kinds || kinds.includes('subscription')
      const lists = await Promise.all([settle(core.upcoming?.(scope, days, kinds)), settle(books?.reader.upcoming(scope, days, kinds)), settle(eq.upcoming?.(scope, days, kinds))])
      // Subscriptions from the recurring detector (the same series list_recurring shows), not a second guess.
      const today = await todayOf(scope.workspaceId)
      const payments = !kinds || kinds.includes('loan_payment') ? ((await settle(parts.terms?.paymentsDue(scope, today, days))) ?? []) : []
      const subs = wantSubs ? (await settle(recurring.due(scope, today, days)))?.filter((r) => !payments.some((p) => samePayment(r, p))) : undefined
      // A bucket schedule is the obligation as the user stated it: a detected series paying it (the Commonspace rent
      // behind a Rent bucket) is that same payment, not a second one.
      const schedules = (lists[0] ?? []).filter((u) => u.kind === 'bucket_schedule')
      const recurringItems: UpcomingItem[] = (subs ?? []).filter((r) => !schedules.some((b) => samePayment(r, b))).map((r) => ({ date: r.nextDue, entityId: r.entityId, kind: 'subscription', what: r.counterparty, amount: { ...r.amount, minor: -r.amount.minor }, confidence: 'recurring_detected', recordId: r.id }))
      // Payroll from books (reported runs win over bank estimates); bills from core when core is installed.
      const coreItems = (lists[0] ?? []).filter((u) => (!books || u.kind !== 'payroll') && (subs === undefined || u.kind !== 'subscription'))
      const bookItems = (lists[1] ?? []).filter((u) => u.kind === 'payroll' || !core.upcoming)
      const seen = new Set<string>()
      const out: UpcomingItem[] = []
      for (const u of [...coreItems, ...bookItems, ...(lists[2] ?? []), ...recurringItems, ...payments]) {
        const key = `${u.kind}:${u.recordId ?? `${u.entityId}:${u.date}:${u.what}`}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push(signed(u))
      }
      return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    },

    ownerBalances: fromCore('ownerBalances'),
    buckets: fromCore('buckets'),
    bucket: fromCore('bucket'),
    capTable: eq.capTable?.bind(eq) ?? core.capTable?.bind(core) ?? (async () => unavailable('The cap table')),
    // Optional: get_mrr_movements is listed only when the reader has it.
    ...(core.mrrMovements ? { mrrMovements: core.mrrMovements.bind(core) } : {}),
    payroll: books ? books.reader.payroll : (core.payroll?.bind(core) ?? (async () => unavailable('Payroll'))),
    reviewItems: fromCore('reviewItems'),
    documents: fromCore('documents'),
    document: fromCore('document'),
    reports: fromCore('reports'),
    // Optional: MCP lists get_coverage only when the reader has it.
    ...(core.coverage ? { coverage: core.coverage.bind(core) } : {}),
    // Optional: get_overview shows books_closed_through only when the reader has it.
    ...(core.periodLocks ? { periodLocks: core.periodLocks.bind(core) } : {}),

    async recurring(scope, opts) {
      return recurring.list(scope, { asOf: opts.asOf ?? (await todayOf(scope.workspaceId)), ...(opts.status ? { status: opts.status } : {}) })
    },
    ...(parts.terms
      ? {
          liabilities: (scope: ReadScope) => parts.terms!.liabilities(scope),
          holdings: (scope: ReadScope, opts?: { accountId?: string; asOf?: string }) => parts.terms!.holdings(scope, opts),
        }
      : {}),
  }
  // Built over the composed reader (its transactions and invoices), so it sees exactly what the tools see.
  const recurring = createRecurring(
    { searchTransactions: (sc, q) => reader.searchTransactions(sc, q), searchInvoices: (sc, q) => reader.searchInvoices(sc, q) },
    parts.cacheFor ? { cacheFor: parts.cacheFor } : {},
  )

  const coreWriter = parts.core?.writer
  const coreOwns = parts.core?.owns
  const eqWriter = parts.equity?.writer
  const eqOps = parts.equity?.ops ?? EQUITY_OPS

  const writer: RecordWriter = {
    async apply(cmd: WriteCommand, prov: Provenance): Promise<AppliedWrite> {
      // Equity owns its ops when installed (S6); core applies everything else; books serves installs without core.
      if (eqWriter && (eqWriter.handles?.(cmd.op) ?? eqOps.includes(cmd.op))) return eqWriter.apply(cmd, prov)
      // "Undo" in the app voids records it has no pipeline write for; an equity write is undone by reverting it.
      const voidId = cmd.op === 'void_record' ? (cmd.payload as { recordId?: unknown }).recordId : undefined
      if (typeof voidId === 'string' && eqWriter?.owns && (await eqWriter.owns(cmd.workspaceId, voidId))) {
        await eqWriter.revert(cmd.workspaceId, voidId, prov)
        return { recordId: voidId, recordType: 'equity_event', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: 'Undid the cap table change.' }
      }
      if (coreWriter) return coreWriter.apply(cmd, prov)
      if (books?.writer.handles(cmd.op)) return books.writer.apply(cmd, prov)
      return unavailable('Recording entries')
    },
    // Dry run (MCP dry_run): the same routing as apply, with each slice's own rollback preview.
    async preview(cmd: WriteCommand, prov: Provenance): Promise<AppliedWrite> {
      const none = () => {
        throw Object.assign(new Error('This change can only be checked, not previewed.'), { name: 'PreviewUnavailable' })
      }
      if (eqWriter && (eqWriter.handles?.(cmd.op) ?? eqOps.includes(cmd.op))) return eqWriter.preview ? eqWriter.preview(cmd, prov) : none()
      if (cmd.op === 'void_record' && eqWriter?.owns && typeof (cmd.payload as { recordId?: unknown }).recordId === 'string' && (await eqWriter.owns(cmd.workspaceId, (cmd.payload as { recordId: string }).recordId))) return none()
      if (coreWriter) return coreWriter.preview ? coreWriter.preview(cmd, prov) : none()
      if (books?.writer.handles(cmd.op)) return none()
      return unavailable('Recording entries')
    },
    async revert(ws, recordId, prov) {
      if (eqWriter?.owns && (await eqWriter.owns(ws, recordId))) return eqWriter.revert(ws, recordId, prov)
      if (coreWriter && (!coreOwns || (await coreOwns(ws, recordId)))) return coreWriter.revert(ws, recordId, prov)
      if (books && (await books.writer.owns(ws, recordId))) return books.writer.revert(ws, recordId, prov)
      throw new WriteRejected(`No record ${recordId}.`, 'not_found')
    },
  }
  return { reader, writer }
}

/**
 * Posted bank and card rows of one entity, read from the ledger's record store (meridn-c6's ledger_records:
 * every txn.upsert it accepted, with the entity it was assigned to). Read-only.
 */
export function bankRowsFromLedger(db: Kysely<CoreTables>) {
  const q = db as unknown as Kysely<{ ledger_records: { id: string; workspace_id: string; entity_id: string | null; event_type: string; date: string; event_json: string } }>
  return async (ws: WorkspaceId, entityId: EntityId, since: IsoDate): Promise<Array<TxnUpsert & { recordId: string }>> => {
    const rows = await q
      .selectFrom('ledger_records')
      .select(['id', 'event_json'])
      .where('workspace_id', '=', ws)
      .where('entity_id', '=', entityId)
      .where('event_type', '=', 'txn.upsert')
      .where('date', '>=', since)
      .orderBy('date', 'asc')
      .execute()
    return rows.map((r) => ({ ...(JSON.parse(r.event_json) as TxnUpsert), recordId: r.id })).filter((t) => t.status === 'posted')
  }
}

const BOOK_EVENTS = new Set(['invoice.upsert', 'payment.applied', 'credit_note.upsert', 'payroll.run'])

/**
 * One Finance per database, wired into the sync engine the first time it's asked for: book events go to
 * books.ingest (which posts to the ledger itself), and payroll detection runs after each sync for the companies
 * whose bank accounts that connection feeds.
 */
const built = new WeakMap<object, Finance>()

export function financeFor(s: Pick<Services, 'db' | 'ledger' | 'syncDeps'>, parts: Omit<FinanceParts, 'books'> = {}): Finance {
  const hit = built.get(s.db)
  if (hit) return hit
  const db = s.db as unknown as Kysely<CoreTables & BooksTables>
  const core = parts.core ?? coreFinance(s.ledger, { documents: documentsProvider(s), names: namesProvider(s) })
  const bankRows = core?.bankRows ? core.bankRows.bind(core) : bankRowsFromLedger(s.db)
  const books = createBooks(db, { ledger: s.ledger, bankRows })
  const entities: FinanceReader['entities'] = async (workspaceId) =>
    (await s.db.selectFrom('entities').select(['id', 'name', 'kind', 'base_currency']).where('workspace_id', '=', workspaceId).where('archived_at', 'is', null).execute()).map((e) => ({
      id: e.id,
      name: e.name,
      kind: e.kind as 'company' | 'personal',
      currency: e.base_currency,
    }))
  const terms = termsReader(s.db as unknown as Kysely<CoreTables & TermsTables>)
  // The engine's derived-results cache (reset by any write to the workspace), when the ledger is Aggregate's engine.
  const ledger = s.ledger as { metricContext?: (ws: WorkspaceId) => { shared?: <T>(key: string, fn: () => Promise<T>) => Promise<T> } }
  const cacheFor = ledger.metricContext ? (ws: string) => ledger.metricContext!(ws as WorkspaceId).shared : undefined
  const today = async (workspaceId: string): Promise<IsoDate> => {
    const row = await s.db.selectFrom('workspaces').select('time_zone').where('id', '=', workspaceId).executeTakeFirst()
    return coreModule.localDate(new Date().toISOString(), row?.time_zone ?? coreModule.DEFAULT_TIME_ZONE) as IsoDate
  }
  const composed = composeFinance({ entities, equity: equityPartFor(s), terms, today, ...(cacheFor ? { cacheFor } : {}), ...parts, ...(core ? { core } : {}), books })
  const fin: Finance = { ...composed, books }
  built.set(s.db, fin)

  const deps = s.syncDeps
  const previous = deps.route
  // A sync still running when its connection was disconnected: its late documents don't reach the books store (the
  // ledger excludes them too). One primary-key read per book event; no cache, since the race is the point.
  const disconnected = async (connectionId: string) => {
    const row = await s.db.selectFrom('connections').select('status').where('id', '=', connectionId).executeTakeFirst()
    return !row || row.status === 'disconnected'
  }
  // A sync page's book documents, kept at once on the page's first one (one read per connection and kind, multi-row
  // inserts) instead of a status read, a select and an insert per document. The engine checked the connection at the
  // page's start. Results by event.
  const pageBooks = (ws: string, entityId: string, page: RoutePage): Promise<Map<NormalizedEvent, { changed: boolean }>> => {
    const hit = page.cache.get('books') as Promise<Map<NormalizedEvent, { changed: boolean }>> | undefined
    if (hit) return hit
    const run = (async () => {
      const docs = page.events.filter((x) => BOOK_EVENTS.has(x.type))
      const results = await books.ingestMany(ws, entityId, docs as never, { post: false })
      return new Map(docs.map((d, i) => [d, results[i] as { changed: boolean }]))
    })()
    page.cache.set('books', run)
    return run
  }
  deps.route = async (ws, entityId, e, page) => {
    if (BOOK_EVENTS.has(e.type) && entityId && (page ? true : !(await disconnected(e.connectionId)))) {
      // The books store keeps the document; the ledger gets a changed one in the sync's page batch (null = not
      // taken), one transaction per page instead of one per document. The ledger finds the same company from the
      // connection that `entityId` came from.
      const r = page ? ((await pageBooks(ws, entityId, page)).get(e) ?? (await books.ingest(ws, entityId, e as never, { post: false }))) : await books.ingest(ws, entityId, e as never, { post: false })
      // Unchanged documents still go to the ledger (it dedupes them in the page batch): that's how it knows a full
      // listing saw them, so listing.complete voids only what the provider deleted. Payroll isn't listed.
      return r.changed || e.type !== 'payroll.run' ? null : { journalEntryId: null, status: 'duplicate' }
    }
    return previous ? previous(ws, entityId, e, page) : null
  }
  // Card/loan terms and positions are recorded as their events pass (a sync page's at once, when it's done); the
  // ledger still gets every one.
  const termsDb = s.db as unknown as Kysely<CoreTables & TermsTables>
  deps.route = tapTerms(termsDb, deps.route)
  const previousPageDone = deps.pageDone
  deps.pageDone = async (ws, entityId, page) => {
    await recordTermsPage(termsDb, ws, page)
    if (previousPageDone) await previousPageDone(ws, entityId, page)
  }
  ;(deps.afterSync ??= []).push(async (ws, connectionId) => {
    for (const entityId of await entitiesFedBy(s.db, ws, connectionId)) await books.detectForEntity(ws, entityId)
  })
  // Documents a completed listing voided in the ledger (deleted at the provider) leave the books store too.
  deps.afterSync.push(async (ws, connectionId) => {
    const gone = await (s.db as unknown as Kysely<{ ledger_records: { workspace_id: string; connection_id: string; event_type: string; external_id: string; status: string; content_hash: string } }>)
      .selectFrom('ledger_records')
      .select(['event_type as eventType', 'external_id as externalId'])
      .where('workspace_id', '=', ws)
      .where('connection_id', '=', connectionId)
      .where('status', '=', 'void')
      .where('content_hash', 'like', 'gone:%')
      .where('event_type', 'in', ['invoice.upsert', 'payment.applied', 'credit_note.upsert'])
      .execute()
    if (gone.length) await books.followListingVoids(ws, connectionId, gone)
  })
  // The first view after a sync shouldn't pay for checks and review: compute them once the sync settles.
  if (core) {
    const ledger = s.ledger as { dataHealth?: (ws: string) => Promise<unknown> }
    // The warm itself reads through the reader as it was; requests go through one that waits for a running warm.
    const reader = fin.reader
    /** Per workspace: the overview scopes requests asked for, and when. */
    const asked = new Map<string, Map<string, number>>()
    const warm = async (ws: string, ready: (key: string) => void = () => {}, only?: string[]) => {
      // The scopes requests ask for, first the likeliest: everything (the home page, an owner's AI), then the companies
      // (an AI connection without Personal), then each one. Results keyed by the set of entities (recurring rows, for
      // one) only help a request that asks for the same set. After a write (`only`): everything, then just the
      // companies it touched (af: a full warm per write would multiply the work of a burst instead of saving it).
      // Beyond everything-at-once, only scopes someone read in the last day (or the companies a write touched): a new
      // demo's every company, warmed for nobody, was most of a full warm (f8's 50-session test).
      const all = await entities(ws)
      const seen = asked.get(ws)
      const read = (ids: string[]) => (seen?.get(scopeKey(ids)) ?? 0) > Date.now() - ASKED_FOR_MS
      const companies = all.filter((e) => e.kind === 'company')
      const each = all.length > 1 ? all.filter((e) => (only ? only.includes(e.id) : read([e.id]))).map((e) => [e]) : []
      const wantCompanies = !only && companies.length !== all.length && companies.length > 0 && read(companies.map((e) => e.id))
      const scopes = [all, ...(wantCompanies ? [companies] : []), ...each]
      // AGFN_PERF_LOG=1: what each part of the warm cost, on its own line.
      const step = async (name: string, fn: () => Promise<unknown>) => {
        if (!perfEnabled()) return void (await fn())
        console.info(`[agfn] perf warm step ${name}: ${perfLine(await withPerf(fn))}`)
      }
      for (const set of scopes) {
        await step(`overview(${set.length})`, () => reader.overview({ workspaceId: ws, entityIds: set.map((e) => e.id) }))
        ready(scopeKey(set.map((e) => e.id)))
      }
      // Every transaction's category for the whole workspace (query_transactions reads them all; staging: 1.2 s cold).
      // Kept until the next write; a request asking meanwhile joins the same read.
      if (all.length) await step('searchTransactions', () => reader.searchTransactions({ workspaceId: ws, entityIds: all.map((e) => e.id) }, { limit: 10_000 }))
      if (!only) await step('dataHealth', async () => ledger.dataHealth?.(ws))
    }
    const warmer = cacheWarmer(
      // Not in a transaction: a warm waits its turn for overview builds and big searches and reads outside the ledger
      // (documents, books, terms), and a transaction would hold a pool connection through all of it. On staging's pool
      // of 3 that starved every request and the health check for minutes (2026-10-13). Each read checks out on its own.
      (ws, ready, only) => warm(ws, ready, only),
      {
        // Not while the workspace is still syncing (the demo's connections import one after another): a sync running,
        // or one due within half a minute. Nor while a demo is still filling: it warms itself just before it says ready.
        busy: async (ws) => {
          const flags = await s.db.selectFrom('settings').select('key').where('workspace_id', '=', ws).where('key', 'in', ['demo', DEMO_READY_SETTING]).execute()
          if (flags.some((f) => f.key === 'demo') && !flags.some((f) => f.key === DEMO_READY_SETTING)) return true
          const soon = new Date(Date.now() + 30_000).toISOString()
          const row = await s.db
            .selectFrom('jobs')
            .select('id')
            .where('workspace_id', '=', ws)
            .where('kind', '=', 'connection.sync')
            .where((eb) => eb.or([eb('status', '=', 'running'), eb.and([eb('status', '=', 'queued'), eb('run_at', '<=', soon)])]))
            .executeTakeFirst()
          return row !== undefined
        },
        log: (m, f) => console.warn(`[agfn] ${m}`, f),
      },
    )
    warmers.set(s.db, warmer)
    /** Per workspace: when a request last read anything the warm computes. */
    const lastRead = new Map<string, number>()
    // Only for a workspace someone read in the last day. sync.all re-syncs every connection hourly, every "Try the demo"
    // leaves four, and a caught-up one's sync still warmed in full (260-500 statements) for nobody: staging's 0.5 CU
    // database saturated at boot and on the hour (af, 2026-10-12). An unread workspace's next read computes itself.
    deps.afterSync.push(async (ws) => {
      if ((lastRead.get(ws) ?? 0) > Date.now() - ASKED_FOR_MS) warmer.schedule(ws)
    })
    fin.reader = joinWarm(reader, warmer, (ws, key) => {
      lastRead.set(ws, Date.now())
      if (key === undefined) return
      const m = asked.get(ws) ?? new Map<string, number>()
      m.set(key, Date.now())
      asked.set(ws, m)
    })
    // After a write the next read recomputed cold, alongside itself, on a pool of 3 (staging: get_overview right after
    // add_entry 1.6 s, half of it waiting for connections). The warm starts at once instead, in one transaction, and
    // the read joins it.
    const writer = fin.writer
    fin.writer = {
      apply: async (cmd, p) => {
        const out = await writer.apply(cmd, p)
        warmer.soon(cmd.workspaceId, WARM_AFTER_WRITE_MS, [...new Set([cmd.entityId, ...out.cashImpact.map((c) => c.entityId)].filter(Boolean))])
        return out
      },
      ...(writer.preview ? { preview: writer.preview.bind(writer) } : {}),
      revert: async (ws, id, p) => {
        await writer.revert(ws, id, p)
        warmer.soon(ws, WARM_AFTER_WRITE_MS)
      },
    }
  }
  return fin
}

/** "Added by …": a person of this workspace by name (else email), or an AI connection by its name. Never anyone outside it. */
function namesProvider(s: Pick<Services, 'db'>) {
  return async (ws: string, id: string): Promise<string | null> => {
    const person = await s.db
      .selectFrom('people')
      .innerJoin('memberships', 'memberships.person_id', 'people.id')
      .select(['people.name', 'people.email'])
      .where('people.id', '=', id)
      .where('memberships.workspace_id', '=', ws)
      .executeTakeFirst()
    if (person) return person.name.trim() || person.email
    return null
  }
}

/**
 * The first request after a sync often lands while the warmer is computing the same results (staging: the first
 * get_overview raced the warm on a 3-connection pool and waited 2.5 s for connections). Reads that use those results
 * wait for a running warm of their workspace first, briefly (a slow warm must never hold reads up: staging, a warm stuck on
 * one bad plan held reads after a write for 6–13 s), then read from the cache it filled or compute themselves.
 */
/** A scope as the warm reports it ready: its entity ids in a stable order. */
const scopeKey = (ids: readonly string[]) => [...ids].sort().join(',')
const JOIN_WARM_MAX_MS = 1_500
/** A workspace (or scope) read this recently is warmed again after a sync (see the warm's scopes). */
const ASKED_FOR_MS = 24 * 60 * 60_000
/** A write's warm waits this long for the next write of a burst. */
const WARM_AFTER_WRITE_MS = 200
const JOIN_WARM: ReadonlySet<string> = new Set(['overview', 'sources', 'reviewItems', 'searchTransactions', 'accounts', 'upcoming', 'coverage'])
function joinWarm(reader: Finance['reader'], warmer: CacheWarmer, noteAsked?: (workspaceId: string, key?: string) => void): Finance['reader'] {
  return new Proxy(reader, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      if (typeof prop !== 'string' || !JOIN_WARM.has(prop)) return v.bind(target)
      return async (scope: { workspaceId: string }, ...rest: unknown[]) => {
        if (scope && typeof scope.workspaceId === 'string') {
          const ids = (scope as { entityIds?: unknown }).entityIds
          const key = Array.isArray(ids) ? scopeKey(ids as string[]) : undefined
          noteAsked?.(scope.workspaceId, prop === 'overview' ? key : undefined)
          await warmer.wait(scope.workspaceId, JOIN_WARM_MAX_MS, key)
        }
        return (v as (...a: unknown[]) => unknown).call(target, scope, ...rest)
      }
    },
  })
}

const warmers = new WeakMap<object, CacheWarmer>()

/** The cache warmer financeFor installed for this database, if the ledger is Aggregate's engine. */
export function warmerFor(s: Pick<Services, 'db'>): CacheWarmer | undefined {
  return warmers.get(s.db)
}

type CreateFinance = (engine: unknown, opts?: Record<string, unknown>) => NonNullable<FinanceParts['core']>

/** meridn-c6's createFinance (merge 2), when @agfn/core exports it and the ledger is its engine. */
function coreFinance(ledger: Services['ledger'], providers: Record<string, unknown>): FinanceParts['core'] | undefined {
  const create = (coreModule as Record<string, unknown>).createFinance as CreateFinance | undefined
  const Engine = (coreModule as Record<string, unknown>).LedgerEngine as (new (...a: never[]) => unknown) | undefined
  if (!create || !Engine || !(ledger instanceof Engine)) return undefined
  return create(ledger, { providers })
}

const DOC_TEXT_MAX = 20_000

/** The PDF text kept in extracted_json, if it was read. */
function pdfOf(json: string | null): ReturnType<typeof pdfExtract> | null {
  if (!json) return null
  const v = JSON.parse(json) as Partial<ReturnType<typeof pdfExtract>>
  return v.pdf ? (v as ReturnType<typeof pdfExtract>) : null
}
type DocRow = { id: string; entity_id: string | null; original_name: string | null; mime_type: string; size_bytes: number | string; sha256: string; created_at: string; arrived_via: string; status: string; record_id: string | null; storage_key: string; extracted_json: string | null }

/**
 * Documents (uploads and email-in) for the ledger's reader, so document tools are offered when there are some.
 * Text is included for statement files (CSV/OFX); it's third-party content and S7 labels it untrusted.
 */
export function documentsProvider(s: Pick<Services, 'db'> & Partial<Pick<Services, 'files'>>) {
  const q = s.db as unknown as Kysely<{ documents: DocRow & { workspace_id: string } }>
  const view = async (r: DocRow, withText: boolean): Promise<DocumentView> => {
    const name = r.original_name ?? 'document'
    let text: string | undefined
    let scanned = false
    if (withText && s.files && /^(text\/csv|application\/x-(ofx|qfx)|application\/xml)$/.test(r.mime_type)) {
      const bytes = await s.files.get(r.storage_key).catch(() => null)
      if (bytes) text = new TextDecoder().decode(bytes.subarray(0, DOC_TEXT_MAX))
    }
    if (r.mime_type === 'application/pdf') {
      // Read at upload (documents.ts); a PDF that came another way (email, before this existed) is read on first open.
      let got = pdfOf(r.extracted_json)
      if (!got && withText && s.files) {
        const bytes = await s.files.get(r.storage_key).catch(() => null)
        if (bytes) {
          got = pdfExtract(await extractPdfText(bytes))
          const kept = { ...(r.extracted_json ? (JSON.parse(r.extracted_json) as Record<string, unknown>) : {}), ...got }
          await q.updateTable('documents').set({ extracted_json: JSON.stringify(kept) }).where('id', '=', r.id).execute()
        }
      }
      // The text counts for the "looks like instructions" flag even in lists; it's only handed out by get.
      if (got?.text !== undefined) text = got.text
      scanned = got?.pdf.status === 'scanned'
    }
    const flagged = text !== undefined && detectInjection(text).suspected
    if (!withText) text = undefined
    return {
      id: r.id,
      entityId: r.entity_id as EntityId,
      fileName: name,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      sha256: r.sha256,
      receivedAt: r.created_at,
      via: r.arrived_via === 'email' ? 'email' : r.arrived_via === 'agent' ? 'agent' : 'upload',
      status: r.status === 'unread' ? 'unread' : r.status === 'ignored' ? 'ignored' : 'recorded',
      injectionSuspected: detectInjection(name).suspected || flagged,
      ...(text !== undefined ? { text } : {}),
      ...(scanned ? { scanned: true } : {}),
      recordIds: r.record_id ? [r.record_id] : [],
    } as DocumentView
  }
  return {
    async list(scope: { workspaceId: WorkspaceId; entityIds: EntityId[] }, status?: DocumentView['status']): Promise<DocumentView[]> {
      if (!scope.entityIds.length) return []
      const rows = (await q.selectFrom('documents').selectAll().where('workspace_id', '=', scope.workspaceId).where('entity_id', 'in', scope.entityIds).orderBy('created_at', 'desc').execute()) as DocRow[]
      const out = await Promise.all(rows.map((r) => view(r, false)))
      return status ? out.filter((d) => d.status === status) : out
    },
    async get(ws: WorkspaceId, id: string): Promise<DocumentView | null> {
      const r = (await q.selectFrom('documents').selectAll().where('workspace_id', '=', ws).where('id', '=', id).executeTakeFirst()) as DocRow | undefined
      return r && r.entity_id ? view(r, true) : null
    },
  }
}

/** Companies a connection feeds: its own entity, plus the entities its bank/card accounts are assigned to. */
async function entitiesFedBy(db: Kysely<CoreTables>, ws: WorkspaceId, connectionId: string): Promise<EntityId[]> {
  const conn = await db.selectFrom('connections').select(['entity_id']).where('id', '=', connectionId).where('workspace_id', '=', ws).executeTakeFirst()
  const accts = await db.selectFrom('accounts').select(['entity_id']).where('connection_id', '=', connectionId).execute()
  const ids = new Set<string>()
  if (conn?.entity_id) ids.add(conn.entity_id)
  for (const a of accts) if (a.entity_id) ids.add(a.entity_id)
  return [...ids]
}

export type { ReadScope }
