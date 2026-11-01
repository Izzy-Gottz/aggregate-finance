// The write pipeline. Every UI, REST and MCP write goes through here (MASTER §12 "Write API"):
// pause switch → permission (grant ∩ person) → idempotency → daily cap → review holds → apply → provenance,
// 30-day undo, large-cash alert, activity log.

import { createHash } from 'node:crypto'
import type { DataType, EntityId, Id, LinkProposal, Money, PersonId, WorkspaceId, WriteOrigin, WriteResult } from '@agfn/contracts'
import { newId } from '@agfn/db'
import { appendActivity, canonicalJson, type ActivityInput } from './activity.ts'
import { DEFAULT_DAILY_WRITE_CAP, grantCovers, grantState } from './grants.ts'
import { say, wire } from './money.ts'
import { WriteRejected, type AppliedWrite, type Clock, type ControlHooks, type FinanceReader, type PeopleDirectory, type Provenance, type RecordType, type RecordWriter, type WriteOp } from './ports.ts'
import { ToolError, type Principal } from './scope.ts'
import type { ControlStore } from './store/store.ts'
import type { WriteRequestsTable } from './store/schema.ts'
import { collectStrings, detectInjection } from './untrusted.ts'
import { applyEdits } from './ui.ts'

export const UNDO_DAYS = 30
const DAY_MS = 86_400_000
/** MASTER §9: alert when an AI write moves cash by more than 10%. */
export const LARGE_CASH_CHANGE = 0.1

export type WriteActor =
  | { kind: 'agent'; principal: Principal }
  | { kind: 'person'; workspaceId: WorkspaceId; personId: PersonId; label: string; ip?: string; userAgent?: string }
  | { kind: 'system'; workspaceId: WorkspaceId; reason: string; label: string }

export interface SubmitWrite {
  actor: WriteActor
  origin: WriteOrigin
  op: WriteOp
  entityId: EntityId
  /** Data type the write touches; checked against the grant and the person. */
  dataType: DataType
  /** Normalized payload (money in minor units). Stored as provenance and hashed for idempotency. */
  payload: Record<string, unknown>
  idempotencyKey: string
  reason?: string
  fileSha256?: string
  sourceDocumentId?: string
}

export interface PipelineResult extends WriteResult {
  writeRequestId: Id
  recordType?: RecordType
  possibleDuplicates: Id[]
  /** Why the write waits for review, when status = pending_review. */
  heldBecause?: 'review_mode' | 'suspicious_text' | 'suspicious_document' | 'needs_approval'
  alerts: string[]
  summary?: string
  balanceCheck?: AppliedWrite['balanceCheck']
}

export type HoldReason = NonNullable<PipelineResult['heldBecause']>

/** What a write would do, with nothing recorded, held or logged as a change. */
export interface PreviewResult {
  status: 'dry_run'
  /** would_apply: recorded at once · would_hold: saved for a person to approve · would_reject: the ledger refuses it · already_recorded: this idempotency_key was used. */
  outcome: 'would_apply' | 'would_hold' | 'would_reject' | 'already_recorded'
  heldBecause?: HoldReason
  /** False when the ledger can't preview: every check ran, but the exact record isn't shown. */
  previewed: boolean
  recordType?: RecordType
  summary?: string
  cashImpact: Array<{ entityId: EntityId; amount: Money }>
  suggestedLinks: LinkProposal[]
  possibleDuplicates: Id[]
  /** The normalized details that would be recorded (money in minor units). */
  payload: Record<string, unknown>
  writesLeftToday?: number
  message?: string
  balanceCheck?: AppliedWrite['balanceCheck']
}

interface StoredResult {
  recordId: Id
  recordType: RecordType
  suggestedLinks: LinkProposal[]
  possibleDuplicates: Id[]
  summary: string
  alerts: string[]
  balanceCheck?: AppliedWrite['balanceCheck']
}

export interface WritePipelineDeps {
  store: ControlStore
  reader: FinanceReader
  writer: RecordWriter
  people: PeopleDirectory
  clock: Clock
  hooks?: ControlHooks
}

function workspaceOf(a: WriteActor): WorkspaceId {
  return a.kind === 'agent' ? a.principal.workspaceId : a.workspaceId
}

function idemScope(a: WriteActor): string {
  if (a.kind === 'agent') return `g:${a.principal.grant.id}`
  if (a.kind === 'person') return `p:${a.personId}`
  return `s:${a.reason}`
}

export function activityActor(a: WriteActor): Pick<ActivityInput, 'actorKind' | 'personId' | 'grantId' | 'actorLabel' | 'ip' | 'userAgent'> {
  if (a.kind === 'agent') return { actorKind: 'agent', personId: a.principal.personId, grantId: a.principal.grant.id, actorLabel: a.principal.label, ip: a.principal.ip ?? null, userAgent: a.principal.userAgent ?? null }
  if (a.kind === 'person') return { actorKind: 'person', personId: a.personId, grantId: null, actorLabel: a.label, ip: a.ip ?? null, userAgent: a.userAgent ?? null }
  return { actorKind: 'system', personId: null, grantId: null, actorLabel: a.label }
}

function provenanceFor(a: WriteActor, writeRequestId: Id, w: Pick<SubmitWrite, 'reason' | 'fileSha256' | 'sourceDocumentId'>): Provenance {
  const base = { writeRequestId, reason: w.reason, fileSha256: w.fileSha256, sourceDocumentId: w.sourceDocumentId }
  if (a.kind === 'agent') return { ...base, actorKind: 'agent', personId: a.principal.personId, grantId: a.principal.grant.id, label: a.principal.label }
  if (a.kind === 'person') return { ...base, actorKind: 'person', personId: a.personId, label: a.label }
  return { ...base, actorKind: 'system', label: a.label }
}

export function payloadHash(op: string, entityId: string, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ op, entityId, payload })).digest('hex')
}

/** Closing or reopening books: an AI's request always waits for a person, and only managers may do or approve it. */
export const PERIOD_OPS: readonly string[] = ['close_period', 'reopen_period']

const IDEM_KEY_RE = /^[A-Za-z0-9._:\-]{8,128}$/

export class WritePipeline {
  readonly deps: WritePipelineDeps
  constructor(deps: WritePipelineDeps) {
    this.deps = deps
  }

  async submit(w: SubmitWrite): Promise<PipelineResult> {
    const { store, clock } = this.deps
    const ws = workspaceOf(w.actor)
    const now = clock.now()
    const nowIso = now.toISOString()

    if (!IDEM_KEY_RE.test(w.idempotencyKey)) {
      throw new ToolError('invalid', 'idempotency_key must be 8–128 characters (letters, digits, . _ : -).', 'Generate one unique key per intended record and reuse it only when retrying the same write.')
    }

    // 1. Pause switch (agents only; people can always work in their own books).
    const settings = await store.getAiSettings(ws)
    if (w.actor.kind === 'agent' && (settings.paused_at || w.actor.principal.grant.pausedAt)) {
      await this.log(w, { action: `write.${w.op}`, status: 'denied', detail: 'AI access is paused' })
      throw new ToolError('paused', settings.paused_at ? 'The owner has paused all AI access. Nothing was recorded.' : 'The owner has paused this connection. Nothing was recorded.', 'Tell the user; they can resume AI access in Aggregate under Connect your AI.')
    }

    // 2. Permission: grant ∩ person, checked again here whatever the caller did.
    await this.assertMayWrite(w, now)

    // 3. Idempotency.
    const scope = idemScope(w.actor)
    const hash = payloadHash(w.op, w.entityId, w.payload)
    const existing = await store.findWrite(ws, scope, w.idempotencyKey)
    // A rejected write recorded nothing: a corrected retry (different payload) may reuse its key. The same payload
    // still gets the original rejection back.
    if (existing && existing.status === 'rejected' && existing.payload_hash !== hash) await store.retireRejectedKey(ws, existing.id)
    else if (existing) return this.replay(existing, hash)

    // 4. Daily cap per grant (rolling 24 h).
    if (w.actor.kind === 'agent') {
      const g = w.actor.principal.grant
      const cap = g.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP
      const used = await store.countGrantWritesSince(g.id, new Date(now.getTime() - DAY_MS).toISOString())
      if (used >= cap) {
        await this.log(w, { action: `write.${w.op}`, status: 'denied', detail: `daily cap ${cap} reached` })
        throw new ToolError('cap_reached', `This connection reached its limit of ${cap} changes in 24 hours. Nothing was recorded.`, 'Tell the user; the owner can raise the daily limit under Connect your AI.')
      }
    }

    // 5. Holds.
    const heldBecause = await this.holdReason(w, settings.review_mode_default)

    // 6. Claim the idempotency key.
    const id = newId(now.getTime())
    const row: WriteRequestsTable = {
      id,
      workspace_id: ws,
      actor_kind: w.actor.kind,
      person_id: w.actor.kind === 'system' ? null : w.actor.kind === 'agent' ? w.actor.principal.personId : w.actor.personId,
      grant_id: w.actor.kind === 'agent' ? w.actor.principal.grant.id : null,
      origin: w.origin,
      op: w.op,
      entity_id: w.entityId,
      idem_scope: scope,
      idempotency_key: w.idempotencyKey,
      payload_hash: hash,
      payload_json: JSON.stringify(w.payload),
      reason: w.reason?.slice(0, 1000) ?? null,
      file_sha256: w.fileSha256 ?? null,
      source_document_id: w.sourceDocumentId ?? null,
      status: heldBecause ? 'pending_review' : 'applying',
      hold_reason: heldBecause ?? null,
      record_id: null,
      record_type: null,
      result_json: null,
      error: null,
      undo_until: null,
      created_at: nowIso,
      decided_at: null,
      decided_by: null,
      reverted_at: null,
      reverted_by: null,
    }
    if (!(await store.insertWrite(row))) {
      const raced = await store.findWrite(ws, scope, w.idempotencyKey)
      if (raced) return this.replay(raced, hash)
      throw new ToolError('conflict', 'Could not record the write; try again with the same idempotency_key.')
    }

    if (heldBecause) {
      await this.log(w, { action: `write.${w.op}`, status: 'held', targetType: 'write_request', targetId: id, detail: `waiting for review (${heldBecause})` })
      return {
        status: 'pending_review',
        writeRequestId: id,
        heldBecause,
        possibleDuplicates: [],
        alerts: [],
        message: heldMessage(heldBecause),
      }
    }

    // 7. Apply.
    return this.applyClaimed(row, w.actor, w)
  }

  /**
   * Dry run: the same pause, permission, idempotency, cap and hold checks as submit, then the ledger's own preview
   * (applied and rolled back). Nothing is claimed, held or recorded, so there is nothing for anyone to approve: a
   * dry run can never become a write, and only a real submit with a person's approval can apply a held one.
   */
  async preview(w: SubmitWrite): Promise<PreviewResult> {
    const { store, clock, writer } = this.deps
    const ws = workspaceOf(w.actor)
    const now = clock.now()
    const base = { status: 'dry_run' as const, previewed: false, cashImpact: [], suggestedLinks: [], possibleDuplicates: [], payload: w.payload }
    const settings = await store.getAiSettings(ws)
    if (w.actor.kind === 'agent' && (settings.paused_at || w.actor.principal.grant.pausedAt)) {
      throw new ToolError('paused', settings.paused_at ? 'The owner has paused all AI access.' : 'The owner has paused this connection.', 'Tell the user; they can resume AI access in Aggregate under Connect your AI.')
    }
    await this.assertMayWrite(w, now)
    if (IDEM_KEY_RE.test(w.idempotencyKey)) {
      const existing = await store.findWrite(ws, idemScope(w.actor), w.idempotencyKey)
      if (existing && !(existing.status === 'rejected' && existing.payload_hash !== payloadHash(w.op, w.entityId, w.payload))) {
        if (existing.payload_hash !== payloadHash(w.op, w.entityId, w.payload)) throw new ToolError('conflict', 'This idempotency_key was already used for a different write.', 'Use a new idempotency_key for a new record.')
        return { ...base, outcome: 'already_recorded', message: `This idempotency_key was already used (${existing.status}); a real call returns that result and records nothing new.` }
      }
    }
    let writesLeftToday: number | undefined
    if (w.actor.kind === 'agent') {
      const g = w.actor.principal.grant
      const cap = g.dailyWriteCap ?? DEFAULT_DAILY_WRITE_CAP
      writesLeftToday = Math.max(0, cap - (await store.countGrantWritesSince(g.id, new Date(now.getTime() - DAY_MS).toISOString())))
      if (!writesLeftToday) throw new ToolError('cap_reached', `This connection reached its limit of ${cap} changes in 24 hours.`, 'Tell the user; the owner can raise the daily limit under Connect your AI.')
    }
    const heldBecause = await this.holdReason(w, settings.review_mode_default)
    const left = writesLeftToday === undefined ? {} : { writesLeftToday }
    let applied: AppliedWrite | undefined
    if (writer.preview) {
      try {
        applied = await writer.preview({ op: w.op, workspaceId: ws, entityId: w.entityId, payload: w.payload }, provenanceFor(w.actor, 'dry-run', w))
      } catch (err) {
        if (err instanceof WriteRejected) return { ...base, ...left, outcome: 'would_reject', message: err.message }
        if (!(err instanceof Error && err.name === 'PreviewUnavailable')) throw err
      }
    }
    const shown = applied ? { previewed: true, recordType: applied.recordType, summary: applied.summary, cashImpact: applied.cashImpact, suggestedLinks: applied.suggestedLinks, possibleDuplicates: applied.possibleDuplicates, ...(applied.balanceCheck ? { balanceCheck: applied.balanceCheck } : {}) } : {}
    if (heldBecause) return { ...base, ...shown, ...left, outcome: 'would_hold', heldBecause, message: `A real call would be saved for a person to approve in Aggregate (${heldBecause.replace('_', ' ')}) and would not count until then.` }
    return { ...base, ...shown, ...left, outcome: 'would_apply' }
  }

  /** Approve a held write (Review screen). Only people; two reviewers can't both apply it. */
  async approve(reviewer: Extract<WriteActor, { kind: 'person' }>, writeId: Id, edits?: Record<string, string>): Promise<PipelineResult> {
    const { store, clock } = this.deps
    const row = await store.getWrite(reviewer.workspaceId, writeId)
    if (!row) throw new ToolError('not_found', 'That change is not waiting for review.')
    await this.assertReviewer(reviewer, row)
    // Validate edits before claiming, so a typo doesn't consume the decision.
    const edited = edits && Object.keys(edits).length ? applyEdits(row.op, JSON.parse(row.payload_json) as Record<string, unknown>, edits) : null
    const patch: Partial<WriteRequestsTable> = { status: 'applying', decided_at: clock.now().toISOString(), decided_by: reviewer.personId }
    if (edited) Object.assign(patch, { payload_json: JSON.stringify(edited), payload_hash: payloadHash(row.op, row.entity_id ?? '', edited) })
    const won = await store.transitionWrite(reviewer.workspaceId, writeId, 'pending_review', patch)
    if (!won) throw new ToolError('conflict', 'Someone already decided on this change.')
    const original = await this.originalActor(row)
    const claimed = { ...row, ...patch, status: 'applying' as const }
    return this.applyClaimed(claimed, original, {
      reason: row.reason ?? undefined,
      fileSha256: row.file_sha256 ?? undefined,
      sourceDocumentId: row.source_document_id ?? undefined,
    }, reviewer, Boolean(edited))
  }

  async reject(reviewer: Extract<WriteActor, { kind: 'person' }>, writeId: Id, note?: string): Promise<void> {
    const { store, clock } = this.deps
    const row = await store.getWrite(reviewer.workspaceId, writeId)
    if (!row) throw new ToolError('not_found', 'That change is not waiting for review.')
    await this.assertReviewer(reviewer, row)
    const won = await store.transitionWrite(reviewer.workspaceId, writeId, 'pending_review', { status: 'rejected', decided_at: clock.now().toISOString(), decided_by: reviewer.personId, error: note?.slice(0, 500) ?? 'rejected in review' })
    if (!won) throw new ToolError('conflict', 'Someone already decided on this change.')
    await appendActivity(store.db, { workspaceId: reviewer.workspaceId, ...activityActor(reviewer), action: 'review.reject', targetType: 'write_request', targetId: writeId, entityIds: row.entity_id ? [row.entity_id] : null, status: 'ok', detail: note ?? null }, clock.now())
  }

  /** Undo an applied write within 30 days (MASTER §2). The record is voided, never deleted. */
  async undo(actor: WriteActor, writeId: Id): Promise<void> {
    const { store, clock, writer } = this.deps
    const ws = workspaceOf(actor)
    const row = await store.getWrite(ws, writeId)
    if (!row || row.status !== 'applied' || !row.record_id) throw new ToolError('not_found', 'Only applied changes can be undone.')
    const now = clock.now()
    if (!row.undo_until || Date.parse(row.undo_until) < now.getTime()) throw new ToolError('invalid', `This change is older than ${UNDO_DAYS} days and can no longer be undone here.`, 'Void the record instead.')
    if (actor.kind === 'agent' && row.grant_id !== actor.principal.grant.id) throw new ToolError('forbidden', 'An AI can only undo its own changes.')
    if (actor.kind === 'person') {
      const ok = row.entity_id ? await this.deps.people.can({ kind: 'person', personId: actor.personId, workspaceId: ws }, 'edit', row.entity_id, await this.dataTypeOf(row)) : false
      if (!ok && row.person_id !== actor.personId) throw new ToolError('forbidden', "You can't undo changes in this company.")
    }
    const won = await store.transitionWrite(ws, writeId, 'applied', { status: 'reverted', reverted_at: now.toISOString(), reverted_by: actor.kind === 'person' ? actor.personId : actor.kind === 'agent' ? `grant:${actor.principal.grant.id}` : actor.reason })
    if (!won) throw new ToolError('conflict', 'This change was already undone.')
    try {
      await writer.revert(ws, row.record_id, provenanceFor(actor, writeId, {}))
    } catch (err) {
      await store.updateWrite(ws, writeId, { status: 'applied', reverted_at: null, reverted_by: null })
      throw err
    }
    await appendActivity(store.db, { workspaceId: ws, ...activityActor(actor), action: 'write.undo', targetType: row.record_type, targetId: row.record_id, entityIds: row.entity_id ? [row.entity_id] : null, status: 'ok' }, now)
  }

  // ---------- internals ----------

  private async applyClaimed(row: WriteRequestsTable, actor: WriteActor, w: Pick<SubmitWrite, 'reason' | 'fileSha256' | 'sourceDocumentId'>, approvedBy?: Extract<WriteActor, { kind: 'person' }>, edited = false): Promise<PipelineResult> {
    const { store, writer, clock } = this.deps
    const ws = row.workspace_id
    const provenance = provenanceFor(actor, row.id, w)
    if (approvedBy) provenance.label = `${provenance.label} (${edited ? 'edited and approved' : 'approved'} by ${approvedBy.label})`
    // Cash before the write, for the large-change alert: read now it's usually the cached answer; read after, the write
    // has just invalidated it and the whole cash figure (checks, review, coverage) is recomputed (staging: ~100 of
    // add_entry's 187 statements).
    const before = actor.kind === 'agent' && row.entity_id ? await this.cashOf(ws, row.entity_id) : undefined
    let applied: AppliedWrite
    try {
      applied = await writer.apply({ op: row.op as WriteOp, workspaceId: ws, entityId: row.entity_id!, payload: JSON.parse(row.payload_json) as Record<string, unknown> }, provenance)
    } catch (err) {
      if (err instanceof WriteRejected) {
        await store.updateWrite(ws, row.id, { status: 'rejected', error: err.message })
        await this.logRow(row, actor, { action: `write.${row.op}`, status: 'denied', detail: err.message })
        return { status: 'rejected', writeRequestId: row.id, possibleDuplicates: [], alerts: [], message: err.message }
      }
      // Unexpected failure: release the key so a retry with the same key can run.
      if (approvedBy) await store.updateWrite(ws, row.id, { status: 'pending_review', decided_at: null, decided_by: null })
      else await store.db.deleteFrom('write_requests').where('id', '=', row.id).where('workspace_id', '=', ws).execute()
      await this.logRow(row, actor, { action: `write.${row.op}`, status: 'error', detail: (err as Error)?.message ?? 'error' })
      throw err
    }
    const now = clock.now()
    const undoUntil = new Date(now.getTime() + UNDO_DAYS * DAY_MS).toISOString()
    const alerts = await this.cashAlerts(ws, applied, actor, row, row.entity_id && before !== undefined ? new Map([[row.entity_id, before]]) : new Map())
    const stored: StoredResult = { recordId: applied.recordId, recordType: applied.recordType, suggestedLinks: applied.suggestedLinks, possibleDuplicates: applied.possibleDuplicates, summary: applied.summary, alerts, ...(applied.balanceCheck ? { balanceCheck: applied.balanceCheck } : {}) }
    await store.updateWrite(ws, row.id, { status: 'applied', record_id: applied.recordId, record_type: applied.recordType, result_json: JSON.stringify(stored), undo_until: undoUntil })
    await this.logRow(row, actor, { action: approvedBy ? `review.approve.${row.op}` : `write.${row.op}`, status: 'ok', targetType: applied.recordType, targetId: applied.recordId, detail: applied.summary })
    return {
      status: 'applied',
      writeRequestId: row.id,
      recordId: applied.recordId,
      recordType: applied.recordType,
      undoUntil,
      suggestedLinks: applied.suggestedLinks,
      possibleDuplicates: applied.possibleDuplicates,
      alerts,
      summary: applied.summary,
      ...(applied.balanceCheck ? { balanceCheck: applied.balanceCheck } : {}),
    }
  }

  private replay(existing: WriteRequestsTable, hash: string): PipelineResult {
    if (existing.payload_hash !== hash) {
      throw new ToolError('conflict', 'This idempotency_key was already used for a different write. Nothing was recorded.', 'Use a new idempotency_key for a new record; reuse a key only to retry exactly the same write.')
    }
    const stored = existing.result_json ? (JSON.parse(existing.result_json) as StoredResult) : null
    const base = { writeRequestId: existing.id, possibleDuplicates: stored?.possibleDuplicates ?? [], alerts: stored?.alerts ?? [] }
    switch (existing.status) {
      case 'applied':
      case 'reverted':
        return {
          ...base,
          status: 'duplicate',
          recordId: existing.record_id ?? undefined,
          recordType: (existing.record_type as RecordType | null) ?? undefined,
          undoUntil: existing.undo_until ?? undefined,
          suggestedLinks: stored?.suggestedLinks ?? [],
          summary: stored?.summary,
          ...(stored?.balanceCheck ? { balanceCheck: stored.balanceCheck } : {}),
          message: existing.status === 'reverted' ? 'Already recorded earlier with this idempotency_key, and since undone. Nothing new was recorded.' : 'Already recorded earlier with this idempotency_key. Nothing new was recorded.',
        }
      case 'pending_review':
        return { ...base, status: 'pending_review', heldBecause: (existing.hold_reason as HoldReason | null) ?? 'review_mode', message: 'Already submitted with this idempotency_key and still waiting for review.' }
      case 'rejected':
        return { ...base, status: 'rejected', message: existing.error ?? 'This write was rejected earlier.' }
      case 'applying':
        throw new ToolError('conflict', 'The same write is still being recorded. Retry in a moment with the same idempotency_key.')
    }
  }

  private async assertMayWrite(w: SubmitWrite, now: Date): Promise<void> {
    const ws = workspaceOf(w.actor)
    if (w.actor.kind === 'system') return
    const personId = w.actor.kind === 'agent' ? w.actor.principal.personId : w.actor.personId
    const action = w.op === 'add_entry' || w.op === 'add_invoice' || w.op === 'create_bucket' || w.op === 'create_rule' || w.op === 'record_equity_event' || w.op === 'record_investment' || w.op === 'record_payment' ? 'add' : 'edit'
    if (w.actor.kind === 'agent') {
      const g = w.actor.principal.grant
      const state = grantState(g, now)
      if (state !== 'active') throw new ToolError('forbidden', state === 'expired' ? 'This connection has expired.' : 'This connection was revoked.', 'Reconnect Aggregate to continue.')
      const entity = (await this.deps.reader.entities(ws)).find((e) => e.id === w.entityId)
      if (!entity || !grantCovers(g, entity, action, w.dataType, now)) {
        await this.log(w, { action: `write.${w.op}`, status: 'denied', detail: `grant does not allow ${action} ${w.dataType}` })
        throw new ToolError('forbidden', g.write ? `This connection can't change ${w.dataType} for that company.` : 'This connection is read-only.', 'The owner can allow adding records under Connect your AI.')
      }
    }
    if (PERIOD_OPS.includes(w.op) && !(await this.deps.people.canManageWorkspace(ws, personId))) {
      await this.log(w, { action: `write.${w.op}`, status: 'denied', detail: 'only owners and admins close or reopen books' })
      throw new ToolError('forbidden', 'Only an owner or admin can close or reopen the books, and the person behind this connection is neither.')
    }
    const ok = await this.deps.people.can({ kind: 'person', personId, workspaceId: ws }, action, w.entityId, w.dataType)
    if (!ok) {
      await this.log(w, { action: `write.${w.op}`, status: 'denied', detail: `person may not ${action} ${w.dataType}` })
      throw new ToolError('forbidden', `The person behind this connection can't change ${w.dataType} in that company.`)
    }
  }

  private async holdReason(w: SubmitWrite, workspaceDefault: 'instant' | 'review_all'): Promise<HoldReason | undefined> {
    if (w.actor.kind !== 'agent') return undefined
    // Text an AI writes may have been planted by a document it read; such writes never apply silently.
    const texts = collectStrings(w.payload).concat(w.reason ? [w.reason] : [])
    if (texts.some((t) => detectInjection(t).reasons.some((r) => r !== 'contains a link'))) return 'suspicious_text'
    if (w.sourceDocumentId) {
      const doc = await this.deps.reader.document(w.actor.principal.workspaceId, w.sourceDocumentId)
      if (doc?.injectionSuspected) return 'suspicious_document'
    }
    if (PERIOD_OPS.includes(w.op)) return 'needs_approval'
    if (workspaceDefault === 'review_all' || w.actor.principal.grant.reviewMode === 'review_all') return 'review_mode'
    return undefined
  }

  /** A company's cash figure, or null when it has none; undefined when it couldn't be read. */
  private async cashOf(ws: WorkspaceId, entityId: string): Promise<Money | null | undefined> {
    try {
      const answer = await this.deps.reader.metric('cash', { workspaceId: ws, entityIds: [entityId as EntityId], figureOnly: true })
      return answer.value && typeof answer.value === 'object' ? (answer.value as Money) : null
    } catch {
      return undefined
    }
  }

  /** `known`: cash read before the write, per company. Others are read after it, less the write's own change. */
  private async cashAlerts(ws: WorkspaceId, applied: AppliedWrite, actor: WriteActor, row: WriteRequestsTable, known: Map<string, Money | null>): Promise<string[]> {
    if (actor.kind !== 'agent') return []
    const alerts: string[] = []
    // Several changes to one company (a transfer between its accounts): each is measured against the cash before.
    for (const impact of applied.cashImpact) {
      if (impact.amount.minor === 0) continue
      let before: number | null
      if (known.has(impact.entityId)) {
        const cash = known.get(impact.entityId) ?? null
        before = cash && cash.currency === impact.amount.currency ? cash.minor : null
      } else {
        const answer = await this.deps.reader.metric('cash', { workspaceId: ws, entityIds: [impact.entityId], figureOnly: true })
        const cash = answer.value && typeof answer.value === 'object' ? (answer.value as Money) : null
        // Cash is measured after the write; compare against the balance before it.
        before = cash && cash.currency === impact.amount.currency ? cash.minor - impact.amount.minor : null
      }
      const large = before === null || before === 0 ? true : Math.abs(impact.amount.minor) > Math.abs(before) * LARGE_CASH_CHANGE
      if (!large) continue
      const name = (await this.deps.reader.entities(ws)).find((e) => e.id === impact.entityId)?.name ?? 'a company'
      const text = `${actor.principal.label} changed ${name}'s cash by ${say(wire(impact.amount).amount, impact.amount.currency)}${before !== null && before !== 0 ? ` (${Math.round((Math.abs(impact.amount.minor) / Math.abs(before)) * 100)}% of cash)` : ''}.`
      alerts.push(text)
      await appendActivity(this.deps.store.db, { workspaceId: ws, ...activityActor(actor), action: 'alert.large_cash_change', targetType: applied.recordType, targetId: applied.recordId, entityIds: [impact.entityId], status: 'alert', detail: text }, this.deps.clock.now())
      await this.deps.hooks?.onAlert?.({ workspaceId: ws, kind: 'large_cash_change', text, grantId: row.grant_id ?? undefined, recordId: applied.recordId })
    }
    return alerts
  }

  private async assertReviewer(reviewer: Extract<WriteActor, { kind: 'person' }>, row: WriteRequestsTable): Promise<void> {
    if (row.status !== 'pending_review') throw new ToolError('conflict', 'This change is no longer waiting for review.')
    const ok = row.entity_id ? await this.deps.people.can({ kind: 'person', personId: reviewer.personId, workspaceId: reviewer.workspaceId }, 'edit', row.entity_id, await this.dataTypeOf(row)) : false
    if (!ok) throw new ToolError('forbidden', "You can't review changes in this company.")
    if (PERIOD_OPS.includes(row.op) && !(await this.deps.people.canManageWorkspace(reviewer.workspaceId, reviewer.personId))) throw new ToolError('forbidden', 'Only an owner or admin can close or reopen the books.')
  }

  /**
   * The kind of data a stored change touches, for the person deciding on it (approve, reject, undo): an invoice needs
   * the right to edit invoices, a cap-table event equity, and so on, not transactions for everything. Derived from the
   * op and its payload (write_requests keeps no data type); update and void read their target record. Anything unknown
   * stays 'transactions', the old check.
   */
  private async dataTypeOf(row: WriteRequestsTable): Promise<DataType> {
    let payload: Record<string, unknown> = {}
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>
    } catch {
      /* keep {} */
    }
    switch (row.op) {
      case 'add_invoice':
      case 'record_payment':
        return payload.direction === 'payable' ? 'bills' : payload.direction === 'receivable' ? 'invoices' : 'transactions'
      case 'record_equity_event':
      case 'record_investment':
        return 'equity'
      case 'create_bucket':
      case 'update_bucket':
        return 'buckets'
      case 'update_record':
      case 'void_record': {
        const id = typeof payload.recordId === 'string' ? payload.recordId : row.record_id
        const rec = id ? await this.deps.reader.getRecord(row.workspace_id, id).catch(() => null) : null
        return rec?.dataType ?? 'transactions'
      }
      default:
        return 'transactions'
    }
  }

  /** Rebuild the actor of a held write so the applied record still says "added by <AI>". */
  private async originalActor(row: WriteRequestsTable): Promise<WriteActor> {
    if (row.actor_kind === 'agent' && row.grant_id) {
      const g = await this.deps.store.getGrant(row.workspace_id, row.grant_id)
      if (g) {
        const who = await this.deps.people.displayName(g.personId)
        return { kind: 'agent', principal: { workspaceId: row.workspace_id, personId: g.personId, grant: g, via: g.kind === 'key' ? 'key' : 'oauth', label: `${g.clientName} · ${who}`, scopes: [] } }
      }
    }
    if (row.actor_kind === 'person' && row.person_id) return { kind: 'person', workspaceId: row.workspace_id, personId: row.person_id, label: await this.deps.people.displayName(row.person_id) }
    return { kind: 'system', workspaceId: row.workspace_id, reason: row.origin, label: 'Aggregate' }
  }

  /** Refusals before anything is stored. Agent calls are logged once by the service layer (tool.*), so skip them here. */
  private async log(w: SubmitWrite, e: Pick<ActivityInput, 'action' | 'status'> & Partial<ActivityInput>): Promise<void> {
    if (w.actor.kind === 'agent' && e.status === 'denied') return
    await appendActivity(this.deps.store.db, { workspaceId: workspaceOf(w.actor), ...activityActor(w.actor), entityIds: [w.entityId], args: w.payload, ...e }, this.deps.clock.now())
  }

  private async logRow(row: WriteRequestsTable, actor: WriteActor, e: Pick<ActivityInput, 'action' | 'status'> & Partial<ActivityInput>): Promise<void> {
    await appendActivity(this.deps.store.db, { workspaceId: row.workspace_id, ...activityActor(actor), entityIds: row.entity_id ? [row.entity_id] : null, args: JSON.parse(row.payload_json) as Record<string, unknown>, ...e }, this.deps.clock.now())
  }
}

function heldMessage(h: HoldReason): string {
  switch (h) {
    case 'review_mode':
      return 'Saved and waiting for the owner to approve it in Aggregate (Review). It does not count yet.'
    case 'suspicious_text':
      return 'Held for the owner to review: the text looked like instructions rather than data. It does not count yet.'
    case 'suspicious_document':
      return 'Held for the owner to review: the source document contains text that looks like instructions. It does not count yet.'
    case 'needs_approval':
      return 'Saved and waiting for an owner or admin to approve it in Aggregate: closing or reopening books always needs a person. Nothing changed yet.'
  }
}
