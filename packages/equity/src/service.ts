// The equity module's service: stores cap-table objects (Kysely, SQLite or Postgres), replays them, posts the money
// side to the ledger, applies record_equity_event writes from AIs and people, undoes them, imports OCF / Carta /
// Pulley files, exports OCF, and answers the ledger's FinanceReader (capTable) and the fully_diluted metric.

import type {
  AppliedWrite,
  CapTableView,
  EntityId,
  AddedBy,
  EquityEvent,
  FinanceReader,
  Id,
  RecordView,
  RecordWriter,
  LinkProposal,
  MetricAnswer,
  MetricScope,
  Money,
  Provenance,
  ReadScope,
  WorkspaceId,
  WriteCommand,
} from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { newId, nowIso, type CoreTables } from '@agfn/db'
import type { Kysely } from 'kysely'
import { fullyDiluted, replay, type CapState } from './captable.ts'
import { modelRound, type RoundInput, type RoundResult } from './conversion.ts'
import { importCapTableCsv } from './csv.ts'
import type { EquityObject, IsoDate } from './model.ts'
import { exportOcf, importOcf } from './ocf.ts'
import { holdingDiffs, holdings, importCapTableXlsx, SNAPSHOT_ID } from './workbook.ts'
import { XlsxError } from './xlsx.ts'
import { capTableView, equityDetail, type EquityDetail } from './view.ts'
import { currenciesIn, ratesFor, type EquityRatePort } from './fx.ts'
import { cashEvents, parsePayload, planWrite, possibleDuplicates } from './writes.ts'
import { waterfall, type WaterfallOptions, type WaterfallResult } from './waterfall.ts'

// ---------- Tables ----------

export interface EquityObjectsTable {
  id: string
  workspace_id: string
  entity_id: string
  object_id: string
  object_type: string
  date: string
  seq: number
  body_json: string
  write_id: string
  origin: 'ui' | 'agent' | 'import' | 'system'
  created_by: string | null
  added_by_label: string | null
  created_at: string
  voided_at: string | null
  voided_by: string | null
}

export interface EquityTables {
  equity_objects: EquityObjectsTable
}

type Db = Kysely<CoreTables & EquityTables>

// ---------- Ports ----------

/** The slice of the ledger engine equity needs (S1 LedgerEngine satisfies it). */
export interface EquityLedgerPort {
  post(ws: WorkspaceId, event: EquityEvent): Promise<unknown>
  /** Optional explicit link to a bank deposit when the caller names it. */
  link?(ws: WorkspaceId, proposal: LinkProposal): Promise<unknown>
  recordIdFor?(ws: WorkspaceId, connectionId: Id, type: 'equity.event', externalId: string): Promise<Id | null>
}

export interface WriteMeta {
  origin: EquityObjectsTable['origin']
  createdBy?: string | null
  /** "Claude · Alex", "you", "Carta import". */
  label?: string | null
}

export interface EquityServiceOptions {
  db: Db
  ledger?: EquityLedgerPort
  now?: () => string
  /** FX for totals across currencies (the ledger's RateSource). Without it, mixed-currency totals are unknown. */
  rates?: EquityRatePort
}

const today = (now: string) => now.slice(0, 10)
const CONNECTOR_KEY = 'equity'

export class EquityService {
  readonly db: Db
  readonly ledger: EquityLedgerPort | undefined
  readonly rates: EquityRatePort | undefined
  readonly now: () => string

  constructor(o: EquityServiceOptions) {
    this.db = o.db
    this.ledger = o.ledger
    this.now = o.now ?? nowIso
    this.rates = o.rates
  }

  // ---------- Reading ----------

  async objects(ws: WorkspaceId, entityId: EntityId): Promise<EquityObject[]> {
    const rows = await this.db
      .selectFrom('equity_objects')
      .select(['body_json'])
      .where('workspace_id', '=', ws)
      .where('entity_id', '=', entityId)
      .where('voided_at', 'is', null)
      .orderBy('seq')
      .execute()
    return rows.map((r) => JSON.parse(r.body_json) as EquityObject)
  }

  async state(ws: WorkspaceId, entityId: EntityId, asOf?: IsoDate): Promise<CapState> {
    return replay(await this.objects(ws, entityId), asOf ?? today(this.now()))
  }

  async detail(ws: WorkspaceId, entityId: EntityId, asOf?: IsoDate): Promise<EquityDetail> {
    const s = await this.state(ws, entityId, asOf)
    const home = await this.homeCurrency(ws, entityId)
    const date = asOf ?? today(this.now())
    return equityDetail(entityId, s, undefined, { currency: home, rates: await ratesFor(this.rates, currenciesIn(s), home, date) })
  }

  /** The company's own currency. */
  async homeCurrency(ws: WorkspaceId, entityId: EntityId): Promise<string> {
    const e = await this.db.selectFrom('entities').select('base_currency').where('workspace_id', '=', ws).where('id', '=', entityId).executeTakeFirst()
    return e?.base_currency ?? 'USD'
  }

  async hasEquity(scope: ReadScope): Promise<boolean> {
    if (!scope.entityIds.length) return false
    const r = await this.db
      .selectFrom('equity_objects')
      .select('id')
      .where('workspace_id', '=', scope.workspaceId)
      .where('entity_id', 'in', scope.entityIds)
      .where('voided_at', 'is', null)
      .limit(1)
      .executeTakeFirst()
    return !!r
  }

  /** FinanceReader.capTable: one view per company in scope that has a cap table. */
  async capTable(scope: ReadScope): Promise<CapTableView[]> {
    const out: CapTableView[] = []
    for (const id of await this.#entitiesWithEquity(scope.workspaceId, scope.entityIds)) {
      const s = await this.state(scope.workspaceId, id)
      const home = await this.homeCurrency(scope.workspaceId, id)
      out.push(capTableView(id, s, { currency: home, rates: await ratesFor(this.rates, currenciesIn(s), home, today(this.now())) }))
    }
    return out
  }

  /** MetricProvider for 'fully_diluted' (register with engine.registerMetricProvider). */
  readonly fullyDilutedMetric = async (scope: MetricScope): Promise<MetricAnswer> => {
    const ids = scope.entityIds === 'all' ? await this.#allEntities(scope.workspaceId) : scope.entityIds
    const withEq = await this.#entitiesWithEquity(scope.workspaceId, ids)
    let total = 0
    const rowIds: Id[] = []
    let agent = 0
    for (const id of withEq) {
      const s = await this.state(scope.workspaceId, id, scope.to)
      total += fullyDiluted(s).total
      const rows = await this.db.selectFrom('equity_objects').select(['object_id', 'origin']).where('workspace_id', '=', scope.workspaceId).where('entity_id', '=', id).where('voided_at', 'is', null).execute()
      rowIds.push(...rows.map((r) => r.object_id))
      agent += rows.filter((r) => r.origin === 'agent').length
    }
    return {
      name: 'fully_diluted',
      value: withEq.length ? total : null,
      state: withEq.length ? 'ok' : 'no_data',
      basis: 'accrual',
      asOf: this.now(),
      includedAccounts: [],
      excludedAccounts: [],
      staleSources: [],
      pendingReviewCount: 0,
      agentEntriesIncluded: agent,
      rowIds: rowIds.slice(0, 200),
      formula: 'Outstanding shares (preferred as converted to common) + outstanding options, RSUs and warrants + unissued option pool. SAFEs and notes are not counted until they convert.',
    }
  }

  async #allEntities(ws: WorkspaceId): Promise<EntityId[]> {
    const rows = await this.db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').execute()
    return rows.map((r) => r.id)
  }

  async #entitiesWithEquity(ws: WorkspaceId, ids: EntityId[]): Promise<EntityId[]> {
    if (!ids.length) return []
    const rows = await this.db.selectFrom('equity_objects').select('entity_id').distinct().where('workspace_id', '=', ws).where('entity_id', 'in', ids).where('voided_at', 'is', null).execute()
    const have = new Set(rows.map((r) => r.entity_id))
    return ids.filter((id) => have.has(id))
  }

  // ---------- Modeling (no writes) ----------

  async modelRound(ws: WorkspaceId, entityId: EntityId, input: RoundInput): Promise<RoundResult> {
    const s = await this.state(ws, entityId, input.date)
    const rates = input.rates ?? (await ratesFor(this.rates, [...currenciesIn(s), input.investment.currency], input.preMoney.currency, input.date))
    return modelRound(s, { ...input, rates })
  }

  async waterfall(ws: WorkspaceId, entityId: EntityId, exit: Money, opts?: WaterfallOptions): Promise<WaterfallResult> {
    const s = await this.state(ws, entityId)
    const rates = opts?.rates ?? (await ratesFor(this.rates, currenciesIn(s), exit.currency, today(this.now())))
    return waterfall(s, exit, { ...opts, rates })
  }

  // ---------- Writing ----------

  /** Adds objects as one write (one undo). Returns the write id and any new cap-table warnings. */
  async add(ws: WorkspaceId, entityId: EntityId, objects: EquityObject[], meta: WriteMeta): Promise<{ writeId: string; warnings: string[] }> {
    if (!objects.length) throw new WriteRejected('Nothing to add.', 'empty')
    const entity = await this.db.selectFrom('entities').select(['id', 'kind']).where('workspace_id', '=', ws).where('id', '=', entityId).executeTakeFirst()
    if (!entity) throw new WriteRejected('That company doesn’t exist.', 'unknown_entity')
    if (entity.kind !== 'company') throw new WriteRejected('Only companies have a cap table.', 'not_company')
    const existing = await this.objects(ws, entityId)
    const ids = new Set(existing.map((o) => o.id))
    for (const o of objects) {
      if (ids.has(o.id)) throw new WriteRejected(`${o.type} ${o.id} is already on the cap table.`, 'duplicate_id')
      ids.add(o.id)
    }
    const before = new Set(replay(existing).warnings)
    const warnings = replay([...existing, ...objects]).warnings.filter((w) => !before.has(w))

    const writeId = 'eqw_' + newId()
    const at = this.now()
    await this.db.transaction().execute(async (tx) => {
      const last = await tx.selectFrom('equity_objects').select((eb) => eb.fn.max('seq').as('m')).where('workspace_id', '=', ws).where('entity_id', '=', entityId).executeTakeFirst()
      let seq = Number(last?.m ?? 0)
      for (const o of objects) {
        await tx
          .insertInto('equity_objects')
          .values({
            id: newId(),
            workspace_id: ws,
            entity_id: entityId,
            object_id: o.id,
            object_type: o.type,
            date: 'date' in o ? o.date : '0000-01-01',
            seq: ++seq,
            body_json: JSON.stringify(o),
            write_id: writeId,
            origin: meta.origin,
            created_by: meta.createdBy ?? null,
            added_by_label: meta.label ?? null,
            created_at: at,
            voided_at: null,
            voided_by: null,
          })
          .execute()
      }
    })
    try {
      await this.#postCash(ws, entityId, [...existing, ...objects], objects, false)
    } catch (e) {
      await this.#void(ws, writeId, 'system')
      throw e
    }
    return { writeId, warnings }
  }

  /** Undo one write: its objects are voided (kept for audit) and their money is reversed in the ledger. */
  async revert(ws: WorkspaceId, writeId: Id, provenance?: Pick<Provenance, 'label'>): Promise<void> {
    const rows = await this.db.selectFrom('equity_objects').select(['entity_id', 'body_json', 'voided_at']).where('workspace_id', '=', ws).where('write_id', '=', writeId).execute()
    if (!rows.length) throw new WriteRejected('Nothing to undo with that id.', 'unknown_record')
    if (rows.every((r) => r.voided_at)) return
    const entityId = rows[0]!.entity_id
    const all = await this.objects(ws, entityId)
    await this.#void(ws, writeId, provenance?.label ?? 'someone')
    await this.#postCash(ws, entityId, all, rows.map((r) => JSON.parse(r.body_json) as EquityObject), true)
  }

  async #void(ws: WorkspaceId, writeId: string, by: string): Promise<void> {
    await this.db.updateTable('equity_objects').set({ voided_at: this.now(), voided_by: by }).where('workspace_id', '=', ws).where('write_id', '=', writeId).where('voided_at', 'is', null).execute()
  }

  /** Is this id one of ours (a write id, or an object id)? Revert routing uses it. */
  async owns(ws: WorkspaceId, id: string): Promise<boolean> {
    const r = await this.db.selectFrom('equity_objects').select('id').where('workspace_id', '=', ws).where((eb) => eb.or([eb('write_id', '=', id), eb('object_id', '=', id)])).limit(1).executeTakeFirst()
    return !!r
  }

  /** get_record for an equity write (all its objects) or a single object. */
  async record(ws: WorkspaceId, id: string): Promise<RecordView | null> {
    const rows = await this.db.selectFrom('equity_objects').selectAll().where('workspace_id', '=', ws).where((eb) => eb.or([eb('write_id', '=', id), eb('object_id', '=', id)])).orderBy('seq').execute()
    const first = rows[0]
    if (!first) return null
    const addedBy: AddedBy = { kind: first.origin === 'agent' ? 'agent' : first.origin === 'import' ? 'import' : 'person', name: first.added_by_label ?? (first.origin === 'import' ? 'import' : 'someone') }
    return {
      id,
      type: 'equity_event',
      entityId: first.entity_id,
      dataType: 'equity',
      data: { writeId: first.write_id, objects: rows.map((r) => JSON.parse(r.body_json) as unknown) },
      links: [],
      audit: [
        { at: first.created_at, actor: addedBy, action: 'added' },
        ...(first.voided_at ? [{ at: first.voided_at, actor: { kind: 'person' as const, name: first.voided_by ?? 'someone' }, action: 'undone' }] : []),
      ],
      addedBy,
      voided: rows.every((r) => !!r.voided_at),
    }
  }

  // ---------- The money side ----------

  /** One native "Cap table" connection per company carries equity events into the ledger. */
  async connectionFor(ws: WorkspaceId, entityId: EntityId): Promise<Id> {
    const found = await this.db.selectFrom('connections').select('id').where('workspace_id', '=', ws).where('connector_key', '=', CONNECTOR_KEY).where('entity_id', '=', entityId).executeTakeFirst()
    if (found) return found.id
    const id = newId()
    await this.db
      .insertInto('connections')
      .values({ id, workspace_id: ws, connector_key: CONNECTOR_KEY, entity_id: entityId, display_name: 'Cap table', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: this.now(), last_error: null, created_by: null, created_at: this.now() })
      .execute()
    return id
  }

  async #postCash(ws: WorkspaceId, entityId: EntityId, context: EquityObject[], changed: EquityObject[], voiding: boolean): Promise<void> {
    if (!this.ledger) return
    const events = cashEvents(context, changed)
    if (!events.length) return
    const connectionId = await this.connectionFor(ws, entityId)
    for (const e of events) {
      await this.ledger.post(ws, { ...e, connectionId, ...(voiding && e.amount ? { amount: { minor: 0, currency: e.amount.currency } } : {}) })
    }
  }

  // ---------- record_equity_event (S7 write tool, UI forms) ----------

  async apply(cmd: WriteCommand, p: Provenance): Promise<AppliedWrite> {
    if (cmd.op !== 'record_equity_event') throw new WriteRejected(`Equity can’t apply ${cmd.op}.`, 'wrong_op')
    const payload = parsePayload(cmd.payload)
    const existing = await this.objects(cmd.workspaceId, cmd.entityId)
    const { objects, summary } = planWrite(replay(existing, '9999-12-31'), existing, payload)
    const dupes = possibleDuplicates(existing, objects)
    const linking = !!(payload.bankTransactionId && this.ledger?.link && this.ledger.recordIdFor)
    const cash = linking ? objects.find((o) => cashEvents([...existing, ...objects], [o]).length) : undefined
    // Check the bank row before writing anything, so a refused link never leaves a half-recorded event behind.
    if (payload.bankTransactionId && cash) await this.#checkBankRow(cmd.workspaceId, cmd.entityId, payload.bankTransactionId)
    const { writeId, warnings } = await this.add(cmd.workspaceId, cmd.entityId, objects, { origin: p.actorKind === 'agent' ? 'agent' : 'ui', createdBy: p.personId ?? null, label: p.label })
    if (payload.bankTransactionId && cash && this.ledger?.link && this.ledger.recordIdFor) {
      try {
        const conn = await this.connectionFor(cmd.workspaceId, cmd.entityId)
        const fromId = await this.ledger.recordIdFor(cmd.workspaceId, conn, 'equity.event', cash.id)
        if (fromId) await this.ledger.link(cmd.workspaceId, { type: 'equity_cash', fromId, toId: payload.bankTransactionId, confidence: 1, method: p.actorKind === 'agent' ? 'agent' : 'human' })
      } catch (e) {
        // The ledger refused the link after all: undo the event so a retry doesn't record it twice.
        await this.revert(cmd.workspaceId, writeId, { label: p.label })
        throw new WriteRejected(`Nothing was recorded: that bank transaction can’t be linked (${e instanceof Error ? e.message : 'refused'}).`, 'invalid')
      }
    }
    return {
      recordId: writeId,
      recordType: 'equity_event',
      cashImpact: [],
      suggestedLinks: [],
      possibleDuplicates: dupes,
      summary: warnings.length ? `${summary} Note: ${warnings.join(' ')}` : summary,
    }
  }

  /** The bank row must be a ledger record in this workspace, booked to this company. */
  async #checkBankRow(ws: WorkspaceId, entityId: EntityId, id: string): Promise<void> {
    const db = this.db as unknown as Kysely<{ ledger_records: { id: string; workspace_id: string; entity_id: string | null; status: string } }>
    const row = await db
      .selectFrom('ledger_records')
      .select(['entity_id', 'status'])
      .where('id', '=', id)
      .where('workspace_id', '=', ws)
      .executeTakeFirst()
      .catch(() => undefined)
    if (!row) throw new WriteRejected('Nothing was recorded: that bank transaction isn’t in this workspace.', 'invalid')
    if (row.entity_id && row.entity_id !== entityId) throw new WriteRejected('Nothing was recorded: that bank transaction belongs to another company.', 'invalid')
    if (row.status === 'void') throw new WriteRejected('Nothing was recorded: that bank transaction was removed.', 'invalid')
  }

  // ---------- Files ----------

  async importOcf(ws: WorkspaceId, entityId: EntityId, json: unknown, meta: WriteMeta): Promise<ImportOutcome> {
    const r = importOcf(json)
    return this.#importObjects(ws, entityId, r.objects, r.notes, meta)
  }

  async importCsv(ws: WorkspaceId, entityId: EntityId, text: string, meta: WriteMeta, currency = 'USD'): Promise<ImportOutcome> {
    const existing = await this.objects(ws, entityId)
    // Ids come from the file's own contents, so importing the same file again skips every row instead of doubling them.
    const r = importCapTableCsv(text, { currency, existing, idPrefix: 'csv' + contentKey(text.replace(/\r\n?/g, '\n').trim() + '|' + currency) })
    return this.#importObjects(ws, entityId, r.objects, r.notes, meta)
  }

  /**
   * A Pulley, Carta or Mantle (OCX) Excel export. Ledger tabs import like a CSV. A snapshot (holdings on one date) never
   * stacks on a cap table that already has holdings: when they match, nothing is added; when they differ, nothing is
   * imported and the differences are listed. Nor does a ledger stack on a cap table built from a snapshot.
   */
  async importXlsx(ws: WorkspaceId, entityId: EntityId, bytes: Uint8Array, meta: WriteMeta, currency = 'USD'): Promise<ImportOutcome> {
    const existing = await this.objects(ws, entityId)
    const key = contentKey(Buffer.from(bytes).toString('base64') + '|' + currency)
    let r: ReturnType<typeof importCapTableXlsx>
    try {
      r = importCapTableXlsx(bytes, { currency, existing, idPrefix: 'x' + key, today: today(this.now()) })
    } catch (e) {
      if (e instanceof XlsxError) throw new WriteRejected(e.message, 'invalid')
      throw e
    }
    const held = existing.some((o) => o.type.startsWith('TX_') && !o.id.startsWith(SNAPSHOT_ID))
    const fromSnapshot = existing.some((o) => o.type.startsWith('TX_') && o.id.startsWith(SNAPSHOT_ID))
    if (r.kind === 'snapshot' && (held || fromSnapshot)) {
      const asOf = r.asOf ?? today(this.now())
      const diffs = holdingDiffs(holdings(existing, asOf), holdings(r.objects, asOf), ['on the cap table', 'in the file'])
      if (!diffs.length) return { writeId: null, added: 0, notes: [`This summary matches the cap table on ${asOf} holding for holding, so nothing was added.`], warnings: [] }
      return { writeId: null, added: 0, notes: [`Nothing was imported: this is a summary of holdings, and the cap table already has holdings that differ on ${asOf}, so importing it would count shares twice. Differences: ${diffs.join('; ')}.`, 'To replace the cap table with this file, undo the earlier import first.'], warnings: [] }
    }
    if (r.kind === 'ledger' && fromSnapshot) {
      return { writeId: null, added: 0, notes: ['Nothing was imported: this cap table was built from a summary snapshot, and adding the ledger would count every share twice. Undo the snapshot import, then import this file for the full history.'], warnings: [] }
    }
    return this.#importObjects(ws, entityId, r.objects, r.notes, meta)
  }

  /** Re-importing the same file is harmless: objects already on the cap table are skipped. */
  async #importObjects(ws: WorkspaceId, entityId: EntityId, objects: EquityObject[], notes: string[], meta: WriteMeta): Promise<ImportOutcome> {
    const existing = await this.objects(ws, entityId)
    const have = new Set(existing.map((o) => o.id))
    const fresh = sameContent(existing, objects.filter((o) => !have.has(o.id)))
    const skipped = objects.length - fresh.length
    if (skipped) notes.push(`${skipped} ${skipped === 1 ? 'item was' : 'items were'} already on the cap table and skipped.`)
    if (!fresh.length) return { writeId: null, added: 0, notes, warnings: [] }
    const { writeId, warnings } = await this.add(ws, entityId, fresh, meta)
    return { writeId, added: fresh.length, notes, warnings }
  }

  async exportOcf(ws: WorkspaceId, entityId: EntityId): Promise<Record<string, unknown>> {
    const e = await this.db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', ws).where('id', '=', entityId).executeTakeFirst()
    if (!e) throw new WriteRejected('That company doesn’t exist.', 'unknown_entity')
    return exportOcf({ id: e.id, legalName: e.name }, await this.objects(ws, entityId), today(this.now()))
  }
}

export interface ImportOutcome {
  writeId: string | null
  added: number
  notes: string[]
  warnings: string[]
}


// ---------------------------------------------------------------------------------------------
// The server's composeFinance part (apps/server/src/finance.ts: FinanceParts['equity'])
// ---------------------------------------------------------------------------------------------

export interface EquityFinancePart {
  reader: Pick<FinanceReader, 'capTable' | 'dataAvailability' | 'getRecord'>
  writer: RecordWriter & { handles(op: WriteCommand['op']): boolean; owns(ws: WorkspaceId, recordId: string): Promise<boolean> }
  ops: Array<WriteCommand['op']>
}

/** Reader + writer for the ledger/MCP composition: capTable, 'equity' availability, equity records, and the
 *  record_equity_event writes (with undo). */
export function equityFinancePart(svc: EquityService): EquityFinancePart {
  return {
    reader: {
      capTable: (scope) => svc.capTable(scope),
      dataAvailability: async (scope) => ((await svc.hasEquity(scope)) ? ['equity'] : []),
      getRecord: (ws, id) => svc.record(ws, id),
    },
    writer: {
      handles: (op) => op === 'record_equity_event',
      owns: (ws, id) => svc.owns(ws, id),
      apply: (cmd, p) => svc.apply(cmd, p),
      revert: (ws, id, p) => svc.revert(ws, id, p),
    },
    ops: ['record_equity_event'],
  }
}

/** A short stable key for a file's contents (FNV-1a, 32-bit, base 36). Not a security hash; it only names rows. */
function contentKey(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

/**
 * Rows already on the cap table under other ids (an import from before ids came from the file's contents): an
 * issuance with the same type, holder, date, class, quantity, amount and price is the same row. What hangs off a
 * skipped issuance (a release, exercise or cancellation) is pointed at the one already there, and skipped too when that
 * one already has it.
 */
export function sameContent(existing: readonly EquityObject[], fresh: EquityObject[]): EquityObject[] {
  const m = (x: unknown) => (x && typeof x === 'object' && 'minor' in x ? `${(x as Money).minor}${(x as Money).currency}` : '')
  const o = (x: EquityObject) => x as unknown as Record<string, unknown>
  const issuance = (x: EquityObject) => 'stakeholderId' in x && 'securityId' in x && x.type.startsWith('TX_') && x.type.endsWith('ISSUANCE')
  const key = (x: EquityObject) => [x.type, o(x).date, o(x).stakeholderId, o(x).stockClassId ?? '', o(x).quantity ?? '', m(o(x).amount), m(o(x).exercisePrice), m(o(x).pricePerShare)].join('|')
  const issued = new Map(existing.filter(issuance).map((x) => [key(x), String(o(x).securityId)]))
  const follow = new Set(existing.filter((x) => !issuance(x) && 'securityId' in x).map((x) => [x.type, o(x).date, o(x).securityId, o(x).quantity ?? ''].join('|')))
  const moved = new Map<string, string>()
  const out: EquityObject[] = []
  for (const x of fresh) {
    if (issuance(x)) {
      const same = issued.get(key(x))
      if (same) {
        moved.set(String(o(x).securityId), same)
        continue
      }
      out.push(x)
      continue
    }
    const sec = 'securityId' in x ? moved.get(String(o(x).securityId)) : undefined
    if (sec === undefined) {
      out.push(x)
      continue
    }
    const y = { ...x, securityId: sec } as EquityObject
    if (!follow.has([y.type, o(y).date, sec, o(y).quantity ?? ''].join('|'))) out.push(y)
  }
  return out
}
