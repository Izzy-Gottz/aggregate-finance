// View models for the web UI (S8's apps/web/src/api/types.ts): Connect your AI, Review, cash entries, bucket edits, undo.
// Shapes are copied structurally so packages/mcp doesn't import from an app. Every call is made by a signed-in person.

import { findReviewItem, scopedSetAside, type BucketView, type EntityId, type GrantShape, type Id, type IsoDate, type IsoTimestamp, type Money, type ReviewItemView, type SetAsideView, type WriteResult } from '@agfn/contracts'
import { setAsidePayload, type SetAsideIn, type SetAsideKept } from './set-aside-input.ts'
import type { ActivityRow } from './activity.ts'
import { listActivity } from './activity.ts'
import type { ConsentShown, ControlApi, PersonActor } from './control.ts'
import type { Grant } from './grants.ts'
import { currencyExponent, MoneyError, parseMoney, wire } from './money.ts'
import type { FinanceReader, PeopleDirectory } from './ports.ts'
import { ToolError } from './scope.ts'
import type { ControlStore } from './store/store.ts'
import type { WriteRequestsTable } from './store/schema.ts'
import { safeLabel, safeSentence } from './untrusted.ts'
import type { PipelineResult, WritePipeline } from './writes.ts'

// ---------- Shapes (mirror apps/web/src/api/types.ts) ----------

export interface AiSummary {
  grantId: Id
  client: string
  personName: string
  shape: GrantShape
  lastUsedAt: IsoTimestamp | null
  paused: boolean
}

export interface AiActivity {
  id: Id
  grantId: Id
  client: string
  at: IsoTimestamp
  kind: 'read' | 'write' | 'blocked'
  summary: string
  result: string
  recordId?: Id
  status?: 'applied' | 'pending_review' | 'undone' | 'rejected'
  undoUntil?: IsoTimestamp
}

export interface AiDetail extends AiSummary {
  connectedAt: IsoTimestamp
  via: string
  activity: AiActivity[]
}

export type ReviewKind = 'ai_write' | 'match' | 'duplicate' | 'rule' | 'whose_money' | 'document' | 'set_aside_short'

export interface UiReviewItem {
  id: Id
  kind: ReviewKind
  title: string
  detail: string
  entityName: string
  amount?: Money
  createdAt: IsoTimestamp
  /** On a 'set_aside_short': the company it's about. */
  entityId?: EntityId
  /** The plain question; clients fall back to title. */
  question?: string
  confirmLabel?: string
  rejectLabel?: string
  /** Other matches for the same money, behind this one, best first. Each resolves by its own id. */
  alternatives?: Array<{ id: Id; question: string; detail: string }>
  /** Items that can be confirmed together; label is the plural line. */
  group?: { key: string; label: string }
  editable?: Array<{ key: string; label: string; value: string }>
  /** "Which company is this account?": the account and the answers allowed (resolve with edit { companyId }). */
  pick?: { accountId: Id | null; choices: Array<{ id: EntityId | 'personal'; name: string }>; suggested?: EntityId | 'personal'; connectionId?: Id }
  /** "What is this money?": one button per answer that can apply; each resolves with edit { ...values }. */
  answers?: Array<{ label: string; values: Record<string, string> }>
}

export type ReviewDecision = { action: 'confirm' } | { action: 'reject' } | { action: 'edit'; values: Record<string, string> }

export interface AiWorkspaceSummary {
  ais: AiSummary[]
  aiPaused: boolean
  reviewCount: number
  reviewModeOn: boolean
}

export interface CashEntry {
  entityId: EntityId
  direction: 'in' | 'out'
  amount: Money
  date: IsoDate
  counterparty: string
  note?: string
  paidBy: 'company' | 'me'
}

export type FieldType = 'text' | 'money' | 'date' | 'number'

export interface BucketField {
  key: string
  label: string
  type: FieldType
  value: string
}

export interface BucketDetail {
  id: Id
  entityId: EntityId
  name: string
  fields: BucketField[]
  schedule: { amount: Money; cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'; dueDay: number; endDate: IsoDate | null } | null
  /** Cut to the accounts this person may see. */
  setAside?: SetAsideView
  /** This server offers set-asides (AGFN_SET_ASIDES). Off: none are shown, stored ones included. */
  canSetAside?: boolean
  rules: Array<{ id: Id; text: string }>
  payments: Array<{ id: Id; date: IsoDate; amount: Money; status: 'paid' | 'upcoming' | 'missed'; detail: string }>
  createdBy: { name: string; isAi: boolean; at: IsoTimestamp }
  undoUntil: IsoTimestamp | null
}

export type BucketPatch = Partial<Pick<BucketDetail, 'name' | 'fields' | 'schedule'>> & { setAside?: SetAsideIn | null }

// ---------- Plain-words activity ----------

const READ_WORDS: Record<string, string> = {
  whoami: 'checked what it can see',
  refresh_balance: 'checked balances live at the bank',
  get_overview: 'looked at the overview',
  get_metric: 'asked for a number',
  list_accounts: 'listed accounts',
  search_transactions: 'searched transactions',
  search_invoices: 'searched invoices and bills',
  get_record: 'opened a record',
  get_counterparty: 'looked up a customer or vendor',
  list_upcoming: 'looked at what is coming up',
  list_recurring: 'looked at subscriptions and recurring bills',
  get_owner_balance: 'checked what the companies owe you',
  list_buckets: 'listed buckets',
  get_bucket: 'opened a bucket',
  get_cap_table: 'looked at the cap table',
  get_payroll: 'looked at payroll',
  list_review_items: 'checked Review',
  list_documents: 'listed documents',
  get_document: 'read a document',
  get_reports: 'ran a report',
}

const METRIC_WORDS: Record<string, string> = {
  cash: 'cash', card_balances: 'card balances', net_cash: 'net cash', gross_burn: 'gross burn', net_burn: 'net burn', runway: 'runway', mrr: 'MRR', arr: 'ARR', revenue: 'revenue',
  ar_open: 'money owed to you', ar_overdue: 'overdue invoices', ap_due: 'bills due', payroll_cost: 'payroll cost', recurring_spend: 'recurring spend', owner_balance: 'owner balances',
  intercompany_balance: 'intercompany balances', fully_diluted: 'fully diluted ownership', data_health: 'data health',
  mrr_churn_rate: 'MRR churn', net_new_mrr: 'net new MRR',
}

const ENTRY_WORDS: Record<string, string> = {
  cash_income: 'cash received', expense: 'an expense', reimbursement: 'a reimbursement', owner_loan: 'an owner loan', owner_contribution: 'an owner contribution', intercompany: 'an intercompany payment', transfer: 'a transfer', other: 'an entry',
}

function money(minor: unknown, currency: unknown): string {
  if (typeof minor !== 'number' || typeof currency !== 'string') return ''
  const w = wire({ minor, currency })
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : ''
  return sym ? `${w.amount.startsWith('-') ? '-' : ''}${sym}${w.amount.replace('-', '')}` : `${w.amount} ${currency}`
}

/** "added cash received of $500.00 to Acme" from a stored write request (unredacted, UI only). */
/** How an action on an existing record reads in the activity list ("voided an invoice to Cobalt Studio for $500.00…"). */
const CHANGE_VERB: Record<string, string> = { void_record: 'voided', update_record: 'changed', resolve_review_item: 'resolved', record_payment: 'recorded a payment on', update_bucket: 'changed' }

export function describeWrite(op: string, payload: Record<string, unknown>, company: string): { summary: string; amount?: Money } {
  const P = payload as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const amt = typeof P.amountMinor === 'number' ? { minor: P.amountMinor as number, currency: String(P.currency) } : typeof P.totalMinor === 'number' ? { minor: P.totalMinor as number, currency: String(P.currency) } : undefined
  const m = amt ? money(amt.minor, amt.currency) : ''
  const who = typeof P.counterparty === 'string' && P.counterparty ? ` (${safeLabel(P.counterparty)})` : ''
  switch (op) {
    case 'add_entry':
      return { summary: `added ${ENTRY_WORDS[P.kind] ?? 'an entry'} of ${m} to ${company}${who}`, amount: amt }
    case 'add_invoice':
      return { summary: `added ${P.direction === 'payable' ? 'a bill from' : 'an invoice to'} ${safeLabel(P.counterparty) ?? 'someone'} for ${m} in ${company}`, amount: amt }
    case 'record_payment':
      return { summary: `recorded a payment of ${m} in ${company}`, amount: amt }
    case 'create_bucket':
      return { summary: `created the bucket "${safeLabel(P.name)}" in ${company}` }
    case 'update_bucket':
      return { summary: `changed a bucket in ${company}` }
    case 'create_rule':
      return { summary: `created a rule in ${company}` }
    case 'update_record':
      return { summary: `changed a record in ${company}` }
    case 'record_equity_event':
      return { summary: `recorded ${String(P.kind ?? 'an equity event').replace('_', ' ')} for ${safeLabel(P.stakeholder) ?? 'someone'} in ${company}` }
    case 'record_investment': {
      const e = (P.event ?? {}) as Record<string, unknown>
      return { summary: `recorded ${String(e.kind ?? 'an investment event').replace('_', ' ')} in ${safeLabel(e.issuer as string | undefined) ?? 'an investment'} for ${company}` }
    }
    case 'resolve_review_item':
      return { summary: `resolved a review item in ${company}` }
    case 'void_record':
      return { summary: `voided a record in ${company}` }
    default:
      return { summary: `changed something in ${company}` }
  }
}

const HOLD_WORDS: Record<string, string> = {
  review_mode: 'waiting for your review',
  suspicious_text: 'held: the text looked like instructions, not data',
  suspicious_document: 'held: its source document contains instructions',
  needs_approval: 'needs your approval: closing or reopening books',
}

function uiStatus(s: WriteRequestsTable['status']): AiActivity['status'] {
  return s === 'reverted' ? 'undone' : s === 'applying' ? 'applied' : s
}

// ---------- The UI service ----------

export interface UiDeps {
  store: ControlStore
  control: ControlApi
  pipeline: WritePipeline
  reader: FinanceReader
  people: PeopleDirectory
  /** AGFN_SET_ASIDES: only then does Review show a short set-aside. */
  setAsides?: boolean
}

export class AiUi {
  readonly deps: UiDeps
  constructor(deps: UiDeps) {
    this.deps = deps
  }

  private async names(actor: PersonActor): Promise<Map<EntityId, string>> {
    const ents = await this.deps.people.entitiesFor(actor.workspaceId, actor.personId)
    return new Map(ents.map((e) => [e.id, e.kind === 'personal' ? 'Personal' : e.name]))
  }

  private async summary(g: Grant): Promise<AiSummary> {
    return { grantId: g.id, client: g.clientName, personName: await this.deps.people.displayName(g.personId), shape: { entityIds: g.entityIds, dataTypes: g.dataTypes, write: g.write, reviewMode: g.reviewMode, dailyWriteCap: g.dailyWriteCap, expiresAt: g.expiresAt }, lastUsedAt: g.lastUsedAt, paused: Boolean(g.pausedAt) }
  }

  /** Workspace page: AI rows, pause state, Review count, review mode. */
  async workspaceSummary(actor: PersonActor): Promise<AiWorkspaceSummary> {
    const grants = await this.deps.control.listGrants(actor)
    const settings = await this.deps.control.aiSettings(actor)
    const review = await this.review(actor)
    return {
      ais: await Promise.all(grants.filter((s) => s.sentence.state === 'active').map((s) => this.summary(s.grant))),
      aiPaused: settings.paused,
      reviewCount: review.length,
      reviewModeOn: settings.reviewModeDefault === 'review_all' || grants.some((s) => s.sentence.state === 'active' && s.grant.write && s.grant.reviewMode === 'review_all'),
    }
  }

  async detail(actor: PersonActor, grantId: Id): Promise<AiDetail> {
    const d = await this.deps.control.describeGrant(actor, grantId)
    const g = d.grant
    const key = d.keys[0]
    return {
      ...(await this.summary(g)),
      connectedAt: g.createdAt,
      via: g.kind === 'key' ? (key ? `Agent key ${key.display_prefix}…${key.last4}` : 'Agent key') : 'Sign-in from the app',
      activity: await this.activityFor(actor, g.id, 50),
    }
  }

  async updateGrant(actor: PersonActor, grantId: Id, shape: GrantShape | undefined, name?: string): Promise<AiSummary> {
    let g = name !== undefined ? await this.deps.control.renameGrant(actor, grantId, name) : undefined
    if (shape) g = await this.deps.control.updateGrant(actor, grantId, shape)
    if (!g) throw new ToolError('invalid', 'Nothing to change.')
    return this.summary(g)
  }

  async setPaused(actor: PersonActor, grantId: Id, paused: boolean): Promise<void> {
    await this.deps.control.setGrantPaused(actor, grantId, paused)
  }

  async pauseAll(actor: PersonActor, paused: boolean): Promise<void> {
    if (paused) await this.deps.control.pauseAll(actor)
    else await this.deps.control.resumeAll(actor)
  }

  async createKey(actor: PersonActor, name: string, shape: GrantShape, consent?: ConsentShown): Promise<{ grantId: Id; key: string }> {
    const created = await this.deps.control.createAgentKey(actor, { name, shape, ...(consent ? { consent } : {}) })
    return { grantId: created.grant.id, key: created.key }
  }

  /** Latest AI activity the person may see (onboarding waits for the first question). */
  async latestActivity(actor: PersonActor): Promise<AiActivity | null> {
    const grants = (await this.deps.control.listGrants(actor, { includeRevoked: true })).map((s) => s.grant)
    const byId = new Map(grants.map((g) => [g.id, g]))
    const rows = await this.deps.control.activity(actor, { actorKind: 'agent', limit: 50 })
    const names = await this.names(actor)
    for (const r of rows) {
      if (!r.grant_id || !byId.has(r.grant_id)) continue
      const a = await this.toActivity(r, byId.get(r.grant_id)!, names)
      if (a) return a
    }
    return null
  }

  private async activityFor(actor: PersonActor, grantId: Id, limit: number): Promise<AiActivity[]> {
    const g = await this.deps.store.getGrant(actor.workspaceId, grantId)
    if (!g) return []
    const names = await this.names(actor)
    const rows = await listActivity(this.deps.store.db, actor.workspaceId, { grantId, actorKind: 'agent', limit: limit * 2 })
    const out: AiActivity[] = []
    for (const r of rows) {
      const a = await this.toActivity(r, g, names)
      if (a) out.push(a)
      if (out.length >= limit) break
    }
    return out
  }

  private async toActivity(r: ActivityRow, g: Grant, names: Map<EntityId, string>): Promise<AiActivity | null> {
    const [ns, name] = [r.action.split('.')[0], r.action.slice(r.action.indexOf('.') + 1)]
    const ents = r.entity_ids_json ? (JSON.parse(r.entity_ids_json) as string[]) : []
    const where = ents.length && ents.length <= 3 ? ` for ${ents.map((e) => names.get(e) ?? 'a company').join(', ')}` : ''
    const base = { id: r.id, grantId: g.id, client: g.clientName, at: r.at }
    if (ns === 'tool') {
      const args = r.args_json ? (JSON.parse(r.args_json) as Record<string, unknown>) : {}
      let words = READ_WORDS[name] ?? `used ${name.replace(/_/g, ' ')}`
      if (name === 'get_metric' && typeof args.metric === 'string') words = `asked for ${METRIC_WORDS[args.metric] ?? args.metric}`
      if (name === 'get_reports' && typeof args.kind === 'string') words = `ran a ${args.kind.replace(/_/g, ' ')} report`
      if (r.status === 'ok') return { ...base, kind: 'read', summary: words + where, result: r.rows_returned !== null ? `${r.rows_returned} row${r.rows_returned === 1 ? '' : 's'}` : 'answered' }
      const detail = (r.detail ?? '').split(' · ')[0] ?? ''
      return { ...base, kind: 'blocked', summary: (READ_WORDS[name] ? words : `tried to ${name.replace(/_/g, ' ')}`) + where, result: detail || 'refused' }
    }
    if (ns === 'write' && name !== 'undo') {
      const wr = r.target_type === 'write_request' && r.target_id ? await this.deps.store.getWrite(r.workspace_id, r.target_id) : r.target_id ? await this.deps.store.findWriteByRecord(r.workspace_id, r.target_id) : null
      const company = names.get(wr?.entity_id ?? ents[0] ?? '') ?? 'a company'
      // A void or change points at the record it changed, so `wr` is the write that first added it. Describe this
      // action in its own words, and never attach that add's record or Undo to it (QA: a void showed as a second "added
      // an invoice…" line with an Undo that would have undone the invoice).
      if (wr && wr.op !== name) {
        const what = describeWrite(wr.op, JSON.parse(wr.payload_json) as Record<string, unknown>, company).summary.replace(/^added /, '')
        const summary = `${CHANGE_VERB[name] ?? name.replace(/_/g, ' ')} ${what}`
        if (r.status === 'denied') return { ...base, kind: 'write', summary, result: r.detail ?? 'not recorded', status: 'rejected' }
        const held = r.status === 'held'
        return { ...base, kind: 'write', summary, result: held ? 'waiting for your review' : 'recorded', status: held ? 'pending_review' : 'applied' }
      }
      const desc = wr ? describeWrite(wr.op, JSON.parse(wr.payload_json) as Record<string, unknown>, company) : { summary: `${name.replace(/_/g, ' ')} in ${company}` }
      if (r.status === 'denied') return { ...base, kind: 'write', summary: desc.summary, result: r.detail ?? 'not recorded', status: 'rejected' }
      const status = wr ? uiStatus(wr.status) : r.status === 'held' ? 'pending_review' : 'applied'
      const result = status === 'pending_review' ? HOLD_WORDS[wr?.hold_reason ?? 'review_mode'] ?? 'waiting for your review' : status === 'undone' ? 'undone' : status === 'rejected' ? wr?.error ?? 'rejected' : 'recorded'
      return { ...base, kind: 'write', summary: desc.summary, result, ...(wr?.record_id ? { recordId: wr.record_id } : {}), status, ...(status === 'applied' && wr?.undo_until ? { undoUntil: wr.undo_until } : {}) }
    }
    return null
  }

  // ---------- Review ----------

  async review(actor: PersonActor): Promise<UiReviewItem[]> {
    const names = await this.names(actor)
    const out: UiReviewItem[] = []
    for (const p of await this.deps.control.pendingWrites(actor)) {
      const company = names.get(p.entityId ?? '') ?? 'a company'
      const d = describeWrite(p.op, p.payload, company)
      out.push({
        id: `write:${p.id}`,
        kind: 'ai_write',
        title: `${p.by.split(' · ')[0]} ${d.summary}`,
        detail: [HOLD_WORDS[p.heldBecause ?? 'review_mode'], p.reason ? `Reason given: ${safeLabel(p.reason, 'agent_text')}` : null].filter(Boolean).join(' · '),
        entityName: company,
        ...(d.amount ? { amount: d.amount } : {}),
        createdAt: p.createdAt,
        confirmLabel: 'Apply',
        rejectLabel: 'Discard',
        ...(editableFor(p.op, p.payload) ? { editable: editableFor(p.op, p.payload) } : {}),
      })
    }
    const visible = [...names.keys()]
    const actorP = { kind: 'person' as const, personId: actor.personId, workspaceId: actor.workspaceId }
    const allowed: EntityId[] = []
    for (const id of visible) if (await this.deps.people.can(actorP, 'view', id, 'transactions')) allowed.push(id)
    if (allowed.length) {
      for (const it of await this.reviewItemsOrNone({ workspaceId: actor.workspaceId, entityIds: allowed })) {
        const kind = REVIEW_KIND[it.kind]
        if (!kind || it.entityId === null || (kind === 'set_aside_short' && !this.deps.setAsides)) continue
        out.push({
          id: it.id,
          kind,
          title: safeLabel(it.title, 'processor_description') ?? '',
          detail: safeLabel(it.detail, 'processor_description') ?? '',
          entityName: names.get(it.entityId) ?? '',
          createdAt: it.createdAt,
          // Say what Confirm does ("Confirm: a card payment"); items without one proposal get their answers instead.
          ...(it.question ? { question: questionOf(it.question, it.questionNames) } : {}),
          // Nothing to answer: it clears itself, and the app links to the company.
          ...(kind === 'set_aside_short' ? { entityId: it.entityId } : {}),
          ...(it.confirmLabel ? { confirmLabel: it.confirmLabel } : {}),
          ...(it.rejectLabel ? { rejectLabel: it.rejectLabel } : {}),
          ...(it.group ? { group: it.group } : {}),
          ...(it.alternatives ? { alternatives: it.alternatives.map((a) => ({ id: a.id, question: a.question ? questionOf(a.question, a.questionNames) : (safeLabel(a.title, 'processor_description') ?? ''), detail: safeLabel(a.detail, 'processor_description') ?? '' })) } : {}),
          ...(it.choices?.length ? { answers: it.choices.map((c) => ({ label: safeLabel(c.label, 'processor_description') ?? '', values: c.edits })) } : {}),
        })
      }
    }
    // "Which company is this account?" (no company yet): only people who manage the workspace answer these.
    if (await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId)) {
      const ents = await this.deps.people.entitiesFor(actor.workspaceId, actor.personId)
      const choices = [...ents.filter((e) => e.kind === 'company').map((e) => ({ id: e.id, name: e.name })), { id: 'personal' as const, name: 'Personal' }]
      for (const it of await this.reviewItemsOrNone({ workspaceId: actor.workspaceId, entityIds: ents.map((e) => e.id) })) {
        if (it.kind !== 'which_company' || it.entityId !== null) continue
        out.push({ id: it.id, kind: REVIEW_KIND.which_company!, title: safeLabel(it.title, 'processor_description') ?? '', detail: safeLabel(it.detail, 'processor_description') ?? '', entityName: '', createdAt: it.createdAt, confirmLabel: 'Assign', pick: { accountId: it.accountId ?? null, choices, ...(it.suggested ? { suggested: it.suggested } : {}), ...(it.connectionId ? { connectionId: it.connectionId } : {}) } })
      }
    }
    // The ledger's items come in the order they matter (core review.ts); an AI's held writes, newest first, go on top.
    const held = out.filter((i) => i.kind === 'ai_write').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return [...held, ...out.filter((i) => i.pick), ...out.filter((i) => i.kind !== 'ai_write' && !i.pick)]
  }

  /** The ledger's own review items; an install without the ledger yet just has none. */
  private async reviewItemsOrNone(scope: { workspaceId: string; entityIds: EntityId[] }): Promise<ReviewItemView[]> {
    try {
      return await this.deps.reader.reviewItems(scope)
    } catch (err) {
      if (err instanceof ToolError && err.code === 'unavailable') return []
      throw err
    }
  }

  /** What was filed for the person: the count, and the list behind it. */
  async filed(actor: PersonActor): Promise<{ count: number; items: Array<{ id: string; text: string; filedAt: string }> }> {
    const names = await this.names(actor)
    const items = (await this.deps.reader.filedItems?.({ workspaceId: actor.workspaceId, entityIds: [...names.keys()] })) ?? []
    return { count: items.length, items: items.map((i) => ({ id: i.id, text: safeLabel(i.text, 'processor_description') ?? '', filedAt: i.filedAt })) }
  }

  /** Put something filed back in Review. It isn't filed again. */
  async undoFiled(actor: PersonActor, id: string): Promise<void> {
    const names = await this.names(actor)
    const item = (await this.deps.reader.filedItems?.({ workspaceId: actor.workspaceId, entityIds: [...names.keys()] }))?.find((i) => i.id === id)
    if (!item || item.entityId === null) throw new ToolError('not_found', 'That was already put back.')
    const r = await this.deps.pipeline.submit({
      actor: await this.personActor(actor),
      origin: 'ui',
      op: 'resolve_review_item',
      entityId: item.entityId,
      dataType: 'transactions',
      payload: { reviewItemId: `filed:${id}`, kind: 'filed', decision: 'reject', edits: null },
      idempotencyKey: await this.reviewKey(actor, `filed:${id}:undo`),
    })
    if (r.status === 'rejected') throw new ToolError('invalid', r.message ?? 'That could not be undone.')
  }

  /** Confirm a group together: only the ids the screen showed that are still in the group. */
  async confirmGroup(actor: PersonActor, key: string, ids: string[]): Promise<{ count: number }> {
    const asked = new Set(ids)
    const items = (await this.review(actor)).filter((i) => i.group?.key === key && asked.has(i.id))
    let count = 0
    for (const i of items) {
      await this.resolve(actor, i.id, { action: 'confirm' })
      count++
    }
    return { count }
  }

  /** What the answer did, for the toast: the writer's own summary and the record Undo reverts (when there is one). */
  async resolve(actor: PersonActor, id: Id, decision: ReviewDecision): Promise<{ recordId?: Id; summary?: string } | void> {
    if (id.startsWith('write:')) {
      const writeId = id.slice('write:'.length)
      if (decision.action === 'reject') return this.deps.control.rejectWrite(actor, writeId)
      const patch = decision.action === 'edit' ? decision.values : undefined
      const r = await this.deps.control.approveWrite(actor, writeId, patch)
      if (r.status === 'rejected') throw new ToolError('invalid', r.message ?? 'That change could not be applied.')
      return
    }
    const names = await this.names(actor)
    const items = await this.deps.reader.reviewItems({ workspaceId: actor.workspaceId, entityIds: [...names.keys()] })
    const item = findReviewItem(items, id)
    if (item?.kind === 'which_company' && item.entityId === null) return this.assignAccount(actor, item, decision)
    if (!item || item.entityId === null) throw new ToolError('not_found', 'That item is no longer waiting.')
    const r = await this.deps.pipeline.submit({
      actor: await this.personActor(actor),
      origin: 'ui',
      op: 'resolve_review_item',
      entityId: item.entityId,
      dataType: 'transactions',
      payload: { reviewItemId: id, kind: item.kind, decision: decision.action, edits: decision.action === 'edit' ? decision.values : null },
      idempotencyKey: await this.reviewKey(actor, `review:${id}:${decision.action}`),
    })
    if (r.status === 'rejected') throw new ToolError('invalid', r.message ?? 'That could not be resolved.')
    return { ...(r.recordId ? { recordId: r.recordId } : {}), ...(r.summary ? { summary: r.summary } : {}) }
  }

  /**
   * The key for answering a review item. A double click reuses it (one write); an answer that was since undone does not,
   * so answering the same way again after Undo makes a new write instead of replaying the undone one.
   */
  private async reviewKey(actor: PersonActor, base: string): Promise<string> {
    const scope = `p:${actor.personId}`
    for (let n = 0; n < 50; n++) {
      const key = (n === 0 ? base : `${base}:${n}`).slice(0, 128)
      const w = await this.deps.store.findWrite(actor.workspaceId, scope, key)
      if (!w || w.status !== 'reverted') return key
    }
    throw new ToolError('invalid', 'This item has been answered and undone too many times.')
  }

  /** Answer "which company is this account?": managers only; "personal" means the person's own Personal. */
  private async assignAccount(actor: PersonActor, item: ReviewItemView, decision: ReviewDecision): Promise<void> {
    if (!(await this.deps.people.canManageWorkspace(actor.workspaceId, actor.personId))) throw new ToolError('forbidden', 'Only an owner or admin can say which company an account belongs to.')
    const choice = decision.action === 'edit' ? decision.values.companyId : undefined
    if (typeof choice !== 'string' || !choice) throw new ToolError('invalid', 'Pick the company this account belongs to.')
    const ents = await this.deps.people.entitiesFor(actor.workspaceId, actor.personId)
    const target = choice === 'personal' ? ents.find((e) => e.kind === 'personal') : ents.find((e) => e.id === choice && e.kind === 'company')
    if (!target) throw new ToolError('invalid', 'That company isn’t in this workspace.')
    const r = await this.deps.pipeline.submit({
      actor: await this.personActor(actor),
      origin: 'ui',
      op: 'resolve_review_item',
      entityId: target.id,
      dataType: 'transactions',
      payload: { reviewItemId: item.id, kind: item.kind, decision: 'edit', edits: { companyId: target.id }, accountId: item.accountId ?? null },
      idempotencyKey: await this.reviewKey(actor, `review:${item.id}:assign:${target.id}`),
    })
    if (r.status === 'rejected') throw new ToolError('invalid', r.message ?? 'That account could not be assigned.')
  }

  // ---------- Writes from the UI ----------

  private async personActor(actor: PersonActor) {
    return { kind: 'person' as const, workspaceId: actor.workspaceId, personId: actor.personId, label: await this.deps.people.displayName(actor.personId), ip: actor.ip, userAgent: actor.userAgent }
  }

  /** "+ Add cash or a receipt". */
  async addCash(actor: PersonActor, entry: CashEntry, idempotencyKey: string): Promise<WriteResult> {
    if (entry.amount.minor <= 0 || !Number.isSafeInteger(entry.amount.minor)) throw new ToolError('invalid', 'Enter an amount above zero.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new ToolError('invalid', 'Pick a date.')
    currencyExponent(entry.amount.currency)
    const accountId = await this.#personalCashAccount(actor, entry)
    const r = await this.deps.pipeline.submit({
      actor: await this.personActor(actor),
      origin: 'ui',
      op: 'add_entry',
      entityId: entry.entityId,
      dataType: 'transactions',
      payload: {
        kind: entry.direction === 'in' ? 'cash_income' : 'expense',
        amountMinor: entry.amount.minor,
        currency: entry.amount.currency.toUpperCase(),
        date: entry.date,
        paidBy: entry.paidBy === 'me' ? { type: 'owner', personId: actor.personId } : { type: 'entity', entityId: entry.entityId },
        forEntityId: entry.entityId,
        counterparty: entry.counterparty.trim().slice(0, 120) || null,
        category: null,
        bucketId: null,
        accountId,
        toAccountId: null,
        toEntityId: null,
        description: entry.note?.slice(0, 500) ?? null,
      },
      idempotencyKey,
    })
    return toWriteResult(r)
  }

  /** Cash out on Personal comes off Cash on hand, so it lowers what was added. Without one it stays paid personally. */
  async #personalCashAccount(actor: PersonActor, entry: CashEntry): Promise<string | null> {
    if (entry.direction !== 'out' || entry.paidBy !== 'company') return null
    const entity = (await this.deps.reader.entities(actor.workspaceId)).find((e) => e.id === entry.entityId)
    if (entity?.kind !== 'personal') return null
    const accounts = await this.deps.reader.accounts({ workspaceId: actor.workspaceId, entityIds: [entry.entityId] }, {})
    return accounts.find((a) => a.type === 'cash_on_hand' && !a.closed)?.id ?? null
  }

  /**
   * Equity events from the app (cap table drawer), through the same pipeline as the record_equity_event tool, so they
   * get provenance, idempotency, an activity row and undo. `payload` is the tool's normalized shape (kind, date,
   * stakeholder, shares, shareClass, amount/pricePerShare/valuationCap as {minor, currency}, …).
   */
  async recordEquity(actor: PersonActor, entityId: EntityId, payload: Record<string, unknown>, idempotencyKey: string): Promise<WriteResult> {
    const kinds = ['issuance', 'safe', 'convertible_note', 'option_grant', 'exercise', 'transfer', 'cancellation']
    if (!kinds.includes(String(payload.kind))) throw new ToolError('invalid', 'Pick what kind of equity event this is.')
    if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) throw new ToolError('invalid', 'Pick a date.')
    if (typeof payload.stakeholder !== 'string' || !payload.stakeholder.trim()) throw new ToolError('invalid', 'Who is it for?')
    const r = await this.deps.pipeline.submit({ actor: await this.personActor(actor), origin: 'ui', op: 'record_equity_event', entityId, dataType: 'equity', payload, idempotencyKey })
    return toWriteResult(r)
  }

  /**
   * An investment the company holds, from the app's Investments page, through the same pipeline as any write
   * (provenance, idempotency, review mode, activity, undo). `event` is the InvestmentEvent without its connector
   * fields; a new position's first invest carries the positionId the caller minted.
   */
  async recordInvestment(actor: PersonActor, entityId: EntityId, payload: { event: Record<string, unknown>; bankTransactionId?: string }, idempotencyKey: string): Promise<WriteResult> {
    const kinds = ['invest', 'mark', 'distribution', 'write_off', 'exit', 'convert']
    if (!kinds.includes(String(payload.event?.kind))) throw new ToolError('invalid', 'Pick what kind of investment event this is.')
    if (typeof payload.event.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(payload.event.date)) throw new ToolError('invalid', 'Pick a date.')
    const r = await this.deps.pipeline.submit({ actor: await this.personActor(actor), origin: 'ui', op: 'record_investment', entityId, dataType: 'equity', payload, idempotencyKey })
    return toWriteResult(r)
  }

  /** "undo" on any record: reverts the write that created it (30 days); otherwise voids a manual record. */
  async undo(actor: PersonActor, recordId: Id, idempotencyKey: string): Promise<WriteResult> {
    const w = await this.deps.store.findWriteByRecord(actor.workspaceId, recordId)
    if (w && w.status === 'applied') {
      await this.deps.control.undo(actor, { writeId: w.id })
      return { status: 'applied', recordId, message: 'Undone.' }
    }
    // A second click on Undo (or a stale toast): the newest write on it was already undone, so don't fall through to voiding.
    if (w && w.status === 'reverted') return { status: 'applied', recordId, message: 'Already undone.' }
    const rec = await this.deps.reader.getRecord(actor.workspaceId, recordId)
    if (!rec) throw new ToolError('not_found', 'That record no longer exists.')
    const r = await this.deps.pipeline.submit({ actor: await this.personActor(actor), origin: 'ui', op: 'void_record', entityId: rec.entityId, dataType: rec.dataType, payload: { recordId, reason: 'undone in the app' }, idempotencyKey })
    return toWriteResult(r)
  }

  async bucket(actor: PersonActor, id: Id): Promise<BucketDetail> {
    const b = await this.deps.reader.bucket(actor.workspaceId, id)
    const actorP = { kind: 'person' as const, personId: actor.personId, workspaceId: actor.workspaceId }
    if (!b || !(await this.deps.people.can(actorP, 'view', b.entityId, 'buckets'))) throw new ToolError('not_found', 'No such bucket.')
    const w = await this.deps.store.findWriteByRecord(actor.workspaceId, id)
    const detail = bucketDetail(b, w)
    if (!this.deps.setAsides) return detail
    if (!b.setAside) return { ...detail, canSetAside: true }
    const seen = await this.#balanceCompanies(actor)
    const today = new Date().toISOString().slice(0, 10)
    return { ...detail, canSetAside: true, setAside: scopedSetAside(b.setAside, seen, b.createdOn ?? today, today) }
  }

  /** Companies whose balances this person sees: a set-aside may name or show only their accounts. */
  async #balanceCompanies(actor: PersonActor): Promise<EntityId[]> {
    const actorP = { kind: 'person' as const, personId: actor.personId, workspaceId: actor.workspaceId }
    const out: EntityId[] = []
    for (const e of await this.deps.reader.entities(actor.workspaceId)) if (await this.deps.people.can(actorP, 'view', e.id, 'balances')) out.push(e.id)
    return out
  }

  async #setAside(actor: PersonActor, entityId: EntityId, input: SetAsideIn, kept?: SetAsideKept): Promise<Record<string, unknown>> {
    const entityIds = await this.#balanceCompanies(actor)
    const accounts = await this.deps.reader.accounts({ workspaceId: actor.workspaceId, entityIds }, {})
    const base = (await this.deps.reader.entities(actor.workspaceId)).find((e) => e.id === entityId)?.currency ?? 'USD'
    return setAsidePayload(input, accounts, base, new Date().toISOString().slice(0, 10), kept)
  }

  /** "+ Add" a bucket from the app (e.g. a stake in a private company under Personal): the create_bucket write path. */
  #offerSetAsides(patch: BucketPatch): void {
    if (patch.setAside !== undefined && !this.deps.setAsides) throw new ToolError('invalid', 'Setting money aside isn’t available yet.')
  }

  async createBucket(actor: PersonActor, entityId: EntityId, input: BucketPatch, idempotencyKey: string): Promise<BucketDetail> {
    this.#offerSetAsides(input)
    const name = (input.name ?? '').trim().slice(0, 60)
    if (!name) throw new ToolError('invalid', 'Give the bucket a name.')
    const fields = input.fields ?? []
    if (fields.length > 30) throw new ToolError('invalid', 'Up to 30 fields.')
    const s = input.schedule
    const payload = {
      name,
      fields: fields.map((f) => ({ key: f.key, label: f.label.slice(0, 60), type: f.type })),
      values: Object.fromEntries(fields.map((f) => [f.key, storedValue(f)])),
      schedule: s ? { amountMinor: s.amount.minor, currency: s.amount.currency, cadence: s.cadence, dueDay: s.dueDay, endDate: s.endDate } : null,
      rule: null,
      ...(input.setAside ? { setAside: await this.#setAside(actor, entityId, input.setAside) } : {}),
    }
    const r = await this.deps.pipeline.submit({ actor: await this.personActor(actor), origin: 'ui', op: 'create_bucket', entityId, dataType: 'buckets', payload, idempotencyKey })
    if (r.status === 'rejected' || !r.recordId) throw new ToolError(r.status === 'rejected' ? 'forbidden' : 'invalid', r.message ?? 'That bucket could not be saved.')
    return this.bucket(actor, r.recordId)
  }

  async updateBucket(actor: PersonActor, id: Id, patch: BucketPatch, idempotencyKey: string): Promise<BucketDetail> {
    this.#offerSetAsides(patch)
    const b = await this.deps.reader.bucket(actor.workspaceId, id)
    if (!b) throw new ToolError('not_found', 'No such bucket.')
    const changes: Record<string, unknown> = {}
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 60)
      if (!name) throw new ToolError('invalid', 'Give the bucket a name.')
      changes.name = name
    }
    if (patch.fields !== undefined) {
      if (patch.fields.length > 30) throw new ToolError('invalid', 'Up to 30 fields.')
      changes.fields = patch.fields.map((f) => ({ key: f.key, label: f.label.slice(0, 60), type: f.type }))
      changes.values = Object.fromEntries(patch.fields.map((f) => [f.key, storedValue(f)]))
    }
    if (patch.schedule !== undefined) {
      const s = patch.schedule
      changes.schedule = s ? { amountMinor: s.amount.minor, currency: s.amount.currency, cadence: s.cadence, dueDay: s.dueDay, endDate: s.endDate } : null
    }
    if (patch.setAside !== undefined) {
      changes.setAside = patch.setAside && (await this.#setAside(actor, b.entityId, patch.setAside, b.setAside))
      changes.setAsideAccounts = (await this.deps.reader.accounts({ workspaceId: actor.workspaceId, entityIds: await this.#balanceCompanies(actor) }, {})).map((a) => a.id)
    }
    if (!Object.keys(changes).length) return this.bucket(actor, id)
    const r = await this.deps.pipeline.submit({ actor: await this.personActor(actor), origin: 'ui', op: 'update_bucket', entityId: b.entityId, dataType: 'buckets', payload: { bucketId: id, changes }, idempotencyKey })
    if (r.status === 'rejected') throw new ToolError('invalid', r.message ?? 'That change could not be saved.')
    return this.bucket(actor, id)
  }
}

const questionOf = (question: string, names?: string[]): string => (names ? safeSentence(question, names) : (safeLabel(question, 'processor_description') ?? ''))

const REVIEW_KIND: Partial<Record<ReviewItemView['kind'], ReviewKind>> = {
  suggested_match: 'match',
  possible_duplicate: 'duplicate',
  suggested_rule: 'rule',
  whose_money: 'whose_money',
  which_company: 'whose_money',
  unread_document: 'document',
  suspicious_text: 'document',
  underfunded_set_aside: 'set_aside_short',
}

/** Fields a reviewer can correct before applying a held AI write. */
export const EDITABLE_KEYS = ['amount', 'date', 'counterparty', 'category', 'description'] as const

function editableFor(op: string, payload: Record<string, unknown>): UiReviewItem['editable'] | undefined {
  const P = payload as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  if (op === 'add_entry') {
    return [
      { key: 'amount', label: 'Amount', value: wire({ minor: P.amountMinor, currency: P.currency }).amount },
      { key: 'date', label: 'Date', value: String(P.date ?? '') },
      { key: 'counterparty', label: 'Who', value: String(P.counterparty ?? '') },
      { key: 'category', label: 'Category', value: String(P.category ?? '') },
      { key: 'description', label: 'Note', value: String(P.description ?? '') },
    ]
  }
  if (op === 'add_invoice') {
    return [
      { key: 'amount', label: 'Total', value: wire({ minor: P.totalMinor, currency: P.currency }).amount },
      { key: 'date', label: 'Issue date', value: String(P.issueDate ?? '') },
      { key: 'counterparty', label: 'Who', value: String(P.counterparty ?? '') },
      { key: 'description', label: 'Note', value: String(P.note ?? '') },
    ]
  }
  return undefined
}

/** Apply a reviewer's edits to a held payload. Only known fields; amounts parsed in the payload's currency. */
export function applyEdits(op: string, payload: Record<string, unknown>, values: Record<string, string>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload }
  const currency = String(payload.currency ?? 'USD')
  for (const [k, raw] of Object.entries(values)) {
    const v = raw.trim()
    if (!(EDITABLE_KEYS as readonly string[]).includes(k)) throw new ToolError('invalid', `"${k}" can't be edited here.`)
    if (k === 'amount') {
      let minor: number
      try {
        minor = parseMoney({ amount: v, currency }).minor
      } catch (err) {
        throw new ToolError('invalid', err instanceof MoneyError ? err.message : 'Enter an amount like 500.00.')
      }
      if (minor <= 0) throw new ToolError('invalid', 'Enter an amount above zero.')
      if (op === 'add_invoice') {
        next.linesMismatchMinor = (typeof payload.linesMismatchMinor === 'number' ? payload.linesMismatchMinor : 0) + (minor - Number(payload.totalMinor))
        next.totalMinor = minor
      } else next.amountMinor = minor
    } else if (k === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ToolError('invalid', 'Use a date like 2026-10-09.')
      next[op === 'add_invoice' ? 'issueDate' : 'date'] = v
    } else if (k === 'description') next[op === 'add_invoice' ? 'note' : 'description'] = v.slice(0, 500) || null
    else next[k] = v.slice(0, 120) || null
  }
  return next
}

function bucketDetail(b: BucketView, w: WriteRequestsTable | null): BucketDetail {
  return {
    id: b.id,
    entityId: b.entityId,
    name: safeLabel(b.name) ?? '',
    fields: b.fields.map((f) => ({ key: f.key, label: f.label, type: f.type === 'boolean' ? 'text' : f.type, value: shownValue(b.values[f.key]) })),
    schedule: b.schedule ? { amount: b.schedule.amount, cadence: b.schedule.cadence, dueDay: b.schedule.dueDay ?? 1, endDate: b.schedule.endDate ?? null } : null,
    rules: b.rules.map((r) => ({ id: r.id, text: safeLabel(r.description, 'invoice_line') ?? '' })),
    payments: (b.payments ?? []).map((p, i) => ({ id: p.txnId ?? `${b.id}:${i}`, date: p.date, amount: p.amount, status: p.state, detail: p.state === 'paid' ? 'Paid' : p.state === 'missed' ? 'Missed' : 'Upcoming' })),
    createdBy: { name: safeLabel(b.addedBy.name) ?? '', isAi: b.addedBy.kind === 'agent', at: w?.created_at ?? '' },
    undoUntil: w?.status === 'applied' && w.op === 'create_bucket' ? w.undo_until : null,
  }
}

function toWriteResult(r: PipelineResult): WriteResult {
  return {
    status: r.status,
    ...(r.recordId ? { recordId: r.recordId } : {}),
    ...(r.undoUntil ? { undoUntil: r.undoUntil } : {}),
    ...(r.suggestedLinks?.length ? { suggestedLinks: r.suggestedLinks } : {}),
    ...(r.message ? { message: r.message } : {}),
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.possibleDuplicates.length ? { possibleDuplicates: r.possibleDuplicates } : {}),
  }
}


const SYMBOL: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP' }

/**
 * The screen sends every field as text; the ledger keeps money as {minor, currency} and numbers as numbers. "$25,000",
 * "25000", "€1,200.50" and "1200.50 EUR" all read; anything else is a plain message, never the validator's wording.
 */
function storedValue(f: { label: string; type: string; value: string }): unknown {
  const text = f.value.trim().slice(0, 500)
  if (!text || (f.type !== 'money' && f.type !== 'number')) return text
  if (f.type === 'number') {
    const n = Number(text.replace(/,/g, ''))
    if (!Number.isFinite(n)) throw new ToolError('invalid', `${f.label}: that isn’t a number.`)
    return n
  }
  const m = /^(-)?\s*([$€£])?\s*([\d,]+(?:\.\d+)?)\s*([A-Za-z]{3})?$/.exec(text)
  if (!m) throw new ToolError('invalid', `${f.label}: that amount isn’t a number.`)
  const currency = (m[4] ?? (m[2] ? SYMBOL[m[2]] : undefined) ?? 'USD').toUpperCase()
  try {
    return parseMoney({ amount: `${m[1] ?? ''}${m[3]!.replace(/,/g, '')}`, currency })
  } catch (e) {
    throw new ToolError('invalid', `${f.label}: ${e instanceof MoneyError ? 'that amount has too many decimal places.' : 'that amount isn’t a number.'}`)
  }
}

/** Back to text for the screen: money as "$25,000.00", the rest as written. */
function shownValue(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'object' && 'minor' in (v as object)) {
    const { minor, currency } = v as Money
    const exp = currencyExponent(currency)
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp)
    } catch {
      return money(minor, currency)
    }
  }
  return String(v)
}
