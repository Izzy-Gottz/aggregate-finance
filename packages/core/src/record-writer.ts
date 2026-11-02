// RecordWriter (contracts): applies S7's validated write commands to the ledger, atomically, with provenance,
// and undoes them (void / restore, never delete). Business-rule failures throw WriteRejected for the AI to read.
import {
  WriteRejected,
  type AppliedWrite,
  type EntityId,
  type Id,
  type InvestmentEvent,
  type LinkProposal,
  type LinkType,
  type Money,
  type NormalizedEvent,
  type Provenance,
  type RecordWriter,
  type TxnKind,
  type TxnUpsert,
  type WorkspaceId,
  type WriteCommand,
  type WriteOrigin,
} from '@agfn/contracts'
import { BucketValidationError } from './buckets.ts'
import { defineRole, FIXED_ROLES, isFixedRole } from './coa.ts'
import { openItems } from './checks.ts'
import { formatMoney } from './money.ts'
import { LinkError, type LedgerEngine } from './engine.ts'
import { keepUnseenAllocations } from './set-aside.ts'
import type { Bucket, BucketField, BucketSchedule, EntityInfo, SetAside, RecordOverride, RuleConditions, SourceAccountInfo, SourceRecord, WriteLogEntry } from './model.ts'
import { MoneyError } from './money.ts'
import { PostingError, positionOrder } from './posting.ts'
import { today } from './queries.ts'
import { RuleValidationError } from './rules.ts'
import { EventValidationError } from './validate.ts'

/** S6 handles cap-table writes; the ledger only sees the money they move. */
export interface EquityWriter {
  apply(cmd: WriteCommand, provenance: Provenance): Promise<AppliedWrite>
  revert(workspaceId: WorkspaceId, recordId: Id, provenance: Provenance): Promise<void>
}

type Payload = Record<string, unknown>
type Party = { type: 'entity'; entityId: EntityId } | { type: 'owner'; personId: string }

const SYNONYMS: Record<string, string> = {
  income: 'revenue',
  sales: 'revenue',
  aws: 'cloud',
  hosting: 'cloud',
  infrastructure: 'cloud',
  subscriptions: 'software',
  saas: 'software',
  office: 'rent',
  lease: 'rent',
  utility: 'utilities',
  electricity: 'utilities',
  power: 'utilities',
  water: 'utilities',
  internet: 'utilities',
  phone: 'utilities',
  legal: 'professional_fees',
  accounting: 'professional_fees',
  ads: 'marketing',
  advertising: 'marketing',
  food: 'meals',
  restaurants: 'meals',
  eating_out: 'meals',
  supplies: 'groceries',
  mortgage: 'housing',
  streaming: 'entertainment',
  payroll: 'payroll_expense',
  salaries: 'payroll_expense',
  fees: 'bank_fees',
  tax: 'taxes',
  uncategorized: 'uncategorized_expense',
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

/** A category from an AI or the UI: a role key, a display name ("Cloud and infrastructure") or a common synonym. */
export function resolveCategory(input: string): string {
  const raw = input.trim()
  if (isFixedRole(raw)) return raw
  if (/^(due_from|due_to|owner_payable):/.test(raw)) {
    defineRole(raw)
    return raw
  }
  const n = norm(raw)
  if (isFixedRole(n)) return n
  if (SYNONYMS[n]) return SYNONYMS[n] as string
  for (const role of FIXED_ROLES) if (norm(defineRole(role).name) === n) return role
  throw new WriteRejected(`Unknown category "${raw}". Use one of: ${FIXED_ROLES.filter((r) => !r.startsWith('clearing_')).join(', ')}.`, 'unknown_category')
}

function str(p: Payload, k: string): string | null {
  const v = p[k]
  return typeof v === 'string' && v !== '' ? v : null
}

function int(p: Payload, k: string): number {
  const v = p[k]
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new WriteRejected(`${k} must be whole minor units`, 'invalid')
  return v
}

export interface WriterOptions {
  equity?: EquityWriter
}

/**
 * A processor fee row (search shows a charge's fee as its own row, id `<charge id>:fee`) isn't a record: it follows
 * its charge. A write naming one is refused whole, never half-applied.
 */
function refuseFeeRows(x: unknown): void {
  const m = /([0-9A-HJKMNP-TV-Z]{26}):fee\b/.exec(typeof x === 'string' ? x : JSON.stringify(x))
  if (m) throw new WriteRejected(`${m[0]} is the processor's fee on charge ${m[1]}: the fee follows its charge. Change the charge (${m[1]}) instead.`, 'invalid')
}

export class LedgerRecordWriter implements RecordWriter {
  readonly engine: LedgerEngine
  readonly opts: WriterOptions

  constructor(engine: LedgerEngine, opts: WriterOptions = {}) {
    this.engine = engine
    this.opts = opts
  }

  async apply(cmd: WriteCommand, p: Provenance): Promise<AppliedWrite> {
    refuseFeeRows(cmd)
    if (cmd.op === 'record_equity_event' && this.opts.equity) return this.opts.equity.apply(cmd, p)
    try {
      return await this.engine.transaction(() => this.#apply(cmd, p))
    } catch (err) {
      throw asRejection(err)
    }
  }

  /** Dry run: apply inside the store transaction, keep the result, roll everything back (MCP dry_run). */
  async preview(cmd: WriteCommand, p: Provenance): Promise<AppliedWrite> {
    refuseFeeRows(cmd)
    if (cmd.op === 'record_equity_event') {
      const eq = this.opts.equity as (typeof this.opts.equity & { preview?: (c: WriteCommand, p: Provenance) => Promise<AppliedWrite> }) | undefined
      if (eq?.preview) return eq.preview(cmd, p)
      if (eq) throw new PreviewUnavailable()
    }
    let result: AppliedWrite | undefined
    try {
      await this.engine.transaction(async () => {
        result = await this.#apply(cmd, p)
        throw ROLLBACK
      })
    } catch (err) {
      if (err !== ROLLBACK) throw asRejection(err)
    }
    return result!
  }

  async revert(ws: WorkspaceId, recordId: Id, p: Provenance): Promise<void> {
    refuseFeeRows(recordId)
    try {
      await this.engine.transaction(() => this.#revert(ws, recordId, p))
    } catch (err) {
      if (this.opts.equity && err instanceof WriteRejected && err.code === 'not_found') return this.opts.equity.revert(ws, recordId, p)
      throw asRejection(err)
    }
  }

  // ---------- helpers ----------

  #origin(p: Provenance): WriteOrigin {
    return p.actorKind === 'agent' ? 'agent' : p.actorKind === 'person' ? 'ui' : 'import'
  }

  #by(p: Provenance): string | null {
    return p.grantId ?? p.personId ?? null
  }

  async #entity(ws: WorkspaceId, id: EntityId): Promise<EntityInfo> {
    const e = await this.engine.directory.getEntity(ws, id)
    if (!e) throw new WriteRejected(`Unknown company ${id}`, 'not_found')
    return e
  }

  async #personalOf(ws: WorkspaceId, personId: string): Promise<EntityInfo> {
    const e = (await this.engine.directory.listEntities(ws)).find((x) => x.kind === 'personal' && x.ownerPersonId === personId)
    if (!e) throw new WriteRejected('There is no Personal space for this person yet, so "owner" money has nowhere to come from. Add a Personal space, or say which company paid.', 'no_personal_space')
    return e
  }

  async #payer(ws: WorkspaceId, party: Party | undefined, fallback: EntityId): Promise<EntityInfo> {
    if (!party) return this.#entity(ws, fallback)
    return party.type === 'entity' ? this.#entity(ws, party.entityId) : this.#personalOf(ws, party.personId)
  }

  async #account(ws: WorkspaceId, id: Id): Promise<SourceAccountInfo> {
    const a = await this.engine.directory.getSourceAccount(ws, id)
    if (!a || !a.entityId) throw new WriteRejected(`Unknown account ${id}. Use list_accounts for ids.`, 'not_found')
    return a
  }

  async #moneyAccount(ws: WorkspaceId, entity: EntityInfo, accountId: Id | null, inflow: boolean): Promise<SourceAccountInfo> {
    if (accountId) {
      const a = await this.#account(ws, accountId)
      if (a.entityId !== entity.id) throw new WriteRejected(`Account ${a.name} belongs to another company, not ${entity.name}.`, 'wrong_company')
      return a
    }
    if (entity.kind === 'personal') return this.engine.directory.ensureManualAccount(ws, entity.id, 'other', 'Paid personally (not connected)')
    void inflow
    return this.engine.directory.ensureManualAccount(ws, entity.id, 'cash_on_hand', 'Cash on hand')
  }

  async #record(ws: WorkspaceId, id: Id): Promise<SourceRecord> {
    const r = await this.engine.store.getRecord(ws, id)
    if (!r) throw new WriteRejected(`No record ${id}.`, 'not_found')
    return r
  }

  async #log(ws: WorkspaceId, p: Provenance, op: string, recordIds: Id[], before: unknown = null): Promise<void> {
    const entry: WriteLogEntry = { id: p.writeRequestId, workspaceId: ws, op, recordIds, before, createdAt: this.engine.now(), revertedAt: null }
    await this.engine.store.saveWrite(entry)
  }

  async #post(ws: WorkspaceId, ev: NormalizedEvent, p: Provenance, entityId?: EntityId): Promise<SourceRecord> {
    await this.engine.post(ws, ev, { origin: this.#origin(p), createdBy: this.#by(p), provenance: p, ...(entityId ? { entityId } : {}) })
    const r = await this.engine.store.findRecord(ws, ev.connectionId, ev.type, ev.externalId)
    if (!r) throw new Error('posted record not found')
    return r
  }

  /** Suggested links and possible duplicates touching the new records (from the matcher; nothing applied). */
  async #matches(ws: WorkspaceId, records: SourceRecord[]): Promise<{ suggestedLinks: LinkProposal[]; possibleDuplicates: Id[] }> {
    const set = new Set(records.map((r) => r.id))
    const all = await this.engine.suggestLinksFor(ws, records)
    const possibleDuplicates = all.filter((m) => m.type === 'duplicate').map((m) => (set.has(m.fromId) ? m.toId : m.fromId))
    return { suggestedLinks: all.filter((m) => m.type !== 'duplicate'), possibleDuplicates: [...new Set(possibleDuplicates)] }
  }

  // ---------- apply ----------

  async #apply(cmd: WriteCommand, p: Provenance): Promise<AppliedWrite> {
    const ws = cmd.workspaceId
    const P = cmd.payload
    switch (cmd.op) {
      case 'add_entry':
        return this.#addEntry(ws, cmd.entityId, P, p)
      case 'add_invoice':
        return this.#addInvoice(ws, cmd.entityId, P, p)
      case 'record_payment':
        return this.#recordPayment(ws, cmd.entityId, P, p)
      case 'create_bucket':
        return this.#createBucket(ws, cmd.entityId, P, p)
      case 'update_bucket':
        return this.#updateBucket(ws, P, p)
      case 'create_rule':
        return this.#createRule(ws, cmd.entityId, P, p)
      case 'update_record':
        return this.#updateRecord(ws, P, p)
      case 'record_equity_event':
        return this.#equityEvent(ws, cmd.entityId, P, p)
      case 'record_investment':
        return this.#investment(ws, cmd.entityId, P, p)
      case 'resolve_review_item':
        return this.#resolveReview(ws, P, p)
      case 'void_record':
        return this.#void(ws, P, p)
      case 'pin_balance':
        return this.#pinBalance(ws, cmd.entityId, P, p)
      case 'close_period':
        return this.#closePeriod(ws, cmd.entityId, P, p)
      case 'reopen_period':
        return this.#reopenPeriod(ws, cmd.entityId, p)
    }
  }

  async #addEntry(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const kind = str(P, 'kind') as 'cash_income' | 'expense' | 'reimbursement' | 'owner_loan' | 'owner_contribution' | 'intercompany' | 'transfer' | 'other'
    const minor = int(P, 'amountMinor')
    if (minor <= 0) throw new WriteRejected('amount must be positive; kind says which way it went', 'invalid')
    const currency = str(P, 'currency') ?? 'USD'
    const date = str(P, 'date') as string
    const company = await this.#entity(ws, companyId)
    const paidBy = P['paidBy'] as Party | undefined
    const counterparty = str(P, 'counterparty')
    const description = str(P, 'description')
    const category = str(P, 'category') ? resolveCategory(str(P, 'category') as string) : null
    const bucketId = str(P, 'bucketId')
    if (bucketId) {
      const b = await this.engine.store.getBucket(ws, bucketId)
      if (!b) throw new WriteRejected(`Unknown bucket ${bucketId}`, 'not_found')
    }
    const base = (acct: SourceAccountInfo, signed: number, suffix = ''): TxnUpsert => {
      if (acct.currency !== currency) throw new WriteRejected(`Account ${acct.name} is in ${acct.currency}, the entry is in ${currency}.`, 'currency_mismatch')
      return {
        type: 'txn.upsert',
        externalId: `wr:${p.writeRequestId}${suffix}`,
        connectionId: acct.connectionId as string,
        accountExternalId: acct.externalId as string,
        date,
        amount: { minor: signed, currency },
        status: 'posted',
        ...(counterparty ? { counterparty } : {}),
        ...(description ? { rawText: description } : {}),
      }
    }
    const records: SourceRecord[] = []
    const cashImpact: AppliedWrite['cashImpact'] = []
    const impact = (acct: SourceAccountInfo, signed: number) => {
      if (acct.includeInCash && acct.entityId) cashImpact.push({ entityId: acct.entityId, amount: { minor: signed, currency } })
    }
    const override = async (r: SourceRecord, o: Omit<Partial<RecordOverride>, 'recordId' | 'workspaceId' | 'updatedAt' | 'updatedBy'>) => {
      const clean = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null))
      if (Object.keys(clean).length) await this.engine.setOverride(ws, r.id, clean, this.#by(p))
    }

    if (kind === 'transfer') {
      const from = await this.#account(ws, str(P, 'accountId') as Id)
      const to = await this.#account(ws, str(P, 'toAccountId') as Id)
      const out = await this.#post(ws, base(from, -minor, ':out'), p)
      const inn = await this.#post(ws, { ...base(to, minor, ':in'), amount: { minor, currency: to.currency } }, p)
      await this.engine.link(ws, { type: from.entityId === to.entityId ? 'transfer' : 'intercompany', fromId: out.id, toId: inn.id, confidence: 1, method: p.actorKind === 'agent' ? 'agent' : 'human' }, { createdBy: this.#by(p) })
      records.push(out, inn)
      impact(from, -minor)
      impact(to, minor)
    } else if (kind === 'cash_income' || kind === 'owner_loan' || kind === 'owner_contribution') {
      const acct = await this.#moneyAccount(ws, company, str(P, 'accountId'), true)
      const r = await this.#post(ws, base(acct, minor), p)
      if (kind === 'cash_income') {
        await override(r, { kind: 'cash_income', category: category ?? undefined, bucketId: bucketId ?? undefined })
      } else {
        const owner = paidBy?.type === 'owner' ? await this.#personalOf(ws, paidBy.personId) : paidBy?.type === 'entity' ? await this.#entity(ws, paidBy.entityId) : null
        if (!owner || owner.kind !== 'personal') throw new WriteRejected('Owner money must be paid by "owner" or a Personal space. Money from another company is kind intercompany.', 'invalid')
        await override(r, { kind: kind as TxnKind, ownerEntityId: owner.id, bucketId: bucketId ?? undefined })
      }
      records.push(r)
      impact(acct, minor)
    } else if (kind === 'reimbursement') {
      const payer = await this.#payer(ws, paidBy, companyId)
      if (payer.kind !== 'company') throw new WriteRejected('A reimbursement is the company paying an owner back: paid_by should be the company.', 'invalid')
      const owner = p.personId ? await this.#personalOf(ws, p.personId) : null
      const acct = await this.#moneyAccount(ws, payer, str(P, 'accountId'), false)
      const r = await this.#post(ws, base(acct, -minor), p)
      await override(r, { kind: 'reimbursement', ownerEntityId: owner?.id, bucketId: bucketId ?? undefined })
      records.push(r)
      impact(acct, -minor)
    } else {
      // expense, intercompany, other: money out of the payer's account, for the company (or to_company).
      const payer = await this.#payer(ws, paidBy, companyId)
      const forId = kind === 'intercompany' ? (str(P, 'toEntityId') ?? str(P, 'forEntityId')) : (str(P, 'forEntityId') ?? companyId)
      if (!forId) throw new WriteRejected('An intercompany entry needs the company that benefited.', 'invalid')
      await this.#entity(ws, forId)
      const acct = await this.#moneyAccount(ws, payer, str(P, 'accountId'), false)
      const r = await this.#post(ws, base(acct, -minor), p)
      await override(r, {
        kind: kind === 'other' ? 'other' : 'expense',
        category: category ?? (kind === 'other' ? 'other_expense' : undefined),
        bucketId: bucketId ?? undefined,
        forEntityId: forId !== payer.id ? forId : undefined,
        note: description ?? undefined,
      })
      records.push(r)
      impact(acct, -minor)
    }
    const ids = records.map((r) => r.id)
    await this.#log(ws, p, 'add_entry', ids)
    const m = await this.#matches(ws, records)
    return { recordId: ids[0] as Id, recordType: 'entry', cashImpact, ...m, summary: `${kind.replace(/_/g, ' ')} ${fmt(minor, currency)} in ${company.name}` }
  }

  async #manualConnection(ws: WorkspaceId, entityId: EntityId): Promise<Id> {
    const acct = await this.engine.directory.ensureManualAccount(ws, entityId, 'cash_on_hand', 'Cash on hand')
    return acct.connectionId as Id
  }

  async #addInvoice(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const company = await this.#entity(ws, companyId)
    const currency = (str(P, 'currency') ?? company.baseCurrency).toUpperCase()
    const total = int(P, 'totalMinor')
    const tax = typeof P['taxMinor'] === 'number' ? int(P, 'taxMinor') : 0
    if (total <= 0) throw new WriteRejected('total must be positive', 'invalid')
    if (tax < 0 || tax > total) throw new WriteRejected('tax must be between 0 and the total', 'invalid')
    const direction = str(P, 'direction') === 'payable' ? 'payable' : 'receivable'
    const counterparty = str(P, 'counterparty') ?? 'Unknown'
    const number = str(P, 'number')
    const issueDate = str(P, 'issueDate') as string
    const lines = (Array.isArray(P['lines']) ? P['lines'] : []) as Array<{ description: string; quantity?: number; amountMinor: number }>
    const status = str(P, 'status') === 'paid' ? 'paid' : 'open'
    const ev: NormalizedEvent = {
      type: 'invoice.upsert',
      externalId: `wr:${p.writeRequestId}`,
      connectionId: await this.#manualConnection(ws, companyId),
      direction,
      ...(number ? { number } : {}),
      counterparty,
      issueDate,
      ...(str(P, 'dueDate') ? { dueDate: str(P, 'dueDate') as string } : {}),
      total: { minor: total, currency },
      amountPaid: { minor: status === 'paid' ? total : 0, currency },
      status,
      ...(tax ? { tax: { minor: tax, currency }, subtotal: { minor: total - tax, currency } } : {}),
      lines: lines.map((l) => ({ description: l.description, amount: { minor: l.amountMinor, currency }, ...(l.quantity !== undefined ? { quantity: l.quantity } : {}) })),
    }
    // Possible duplicates: same counterparty and number, or same counterparty and total within 5 days.
    const existing = await this.engine.store.listRecords(ws, { entityIds: [companyId], eventTypes: ['invoice.upsert'] })
    const dups = existing
      .filter((r) => r.event.type === 'invoice.upsert' && r.status !== 'void' && r.event.direction === direction)
      .filter((r) => {
        const e = r.event as Extract<NormalizedEvent, { type: 'invoice.upsert' }>
        const sameParty = e.counterparty.trim().toLowerCase() === counterparty.trim().toLowerCase()
        return sameParty && ((number && e.number === number) || (e.total.minor === total && e.total.currency === currency && Math.abs(Date.parse(e.issueDate) - Date.parse(issueDate)) <= 5 * 86_400_000))
      })
      .map((r) => r.id)
    const r = await this.#post(ws, ev, p, companyId)
    const note = str(P, 'note')
    const mismatch = typeof P['linesMismatchMinor'] === 'number' ? (P['linesMismatchMinor'] as number) : 0
    if (note || mismatch) await this.engine.setOverride(ws, r.id, { note: [note, mismatch ? `Lines and total differ by ${fmt(mismatch, currency)}` : null].filter(Boolean).join(' · ') }, this.#by(p))
    await this.#log(ws, p, 'add_invoice', [r.id])
    const m = await this.#matches(ws, [r])
    return { recordId: r.id, recordType: 'invoice', cashImpact: [], suggestedLinks: m.suggestedLinks, possibleDuplicates: [...new Set([...dups, ...m.possibleDuplicates])], summary: `${direction === 'receivable' ? 'Invoice to' : 'Bill from'} ${counterparty} ${fmt(total, currency)}` }
  }

  async #recordPayment(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const direction = str(P, 'direction') === 'payable' ? 'payable' : 'receivable'
    const currency = (str(P, 'currency') ?? 'USD').toUpperCase()
    const amount = int(P, 'amountMinor')
    const apps = (Array.isArray(P['applications']) ? P['applications'] : []) as Array<{ invoiceId: Id; amountMinor: number }>
    if (apps.length === 0) throw new WriteRejected('A payment needs at least one invoice', 'invalid')
    const open = new Map((await openItems(this.engine.metricContext(ws), [companyId], direction, '9999-12-31')).map((o) => [o.record.id, o]))
    const invoices: SourceRecord[] = []
    for (const a of apps) {
      const r = await this.#record(ws, a.invoiceId)
      if (r.event.type !== 'invoice.upsert' || r.entityId !== companyId) throw new WriteRejected(`${a.invoiceId} is not an invoice of this company`, 'not_found')
      if (r.event.direction !== direction) throw new WriteRejected(`${a.invoiceId} is ${r.event.direction === 'receivable' ? 'money owed to you' : 'a bill'}, not ${direction === 'receivable' ? 'money owed to you' : 'a bill'}`, 'invalid')
      if (r.event.total.currency !== currency) throw new WriteRejected(`${a.invoiceId} is in ${r.event.total.currency}`, 'currency_mismatch')
      const remaining = open.get(r.id)?.remainingMinor ?? 0
      if (a.amountMinor > remaining) throw new WriteRejected(`${r.event.number ?? a.invoiceId} has ${fmt(remaining, currency)} left to pay; ${fmt(a.amountMinor, currency)} would overpay it. Record the extra as unapplied.`, 'overpayment')
      invoices.push(r)
    }
    const conns = new Set(invoices.map((r) => r.connectionId))
    if (conns.size > 1) throw new WriteRejected('These invoices come from different sources; record one payment per source.', 'invalid')
    let bankRef: string | undefined
    const bankId = str(P, 'bankTransactionId')
    if (bankId) {
      const bank = await this.#record(ws, bankId)
      if (bank.event.type !== 'txn.upsert' || bank.entityId !== companyId) throw new WriteRejected(`${bankId} is not a bank transaction of this company`, 'not_found')
      const sign = bank.event.amount.minor
      if ((direction === 'receivable') !== sign > 0) throw new WriteRejected('That bank row goes the other way', 'invalid')
      if (Math.abs(sign) !== amount) throw new WriteRejected(`The bank row is ${fmt(Math.abs(sign), bank.event.amount.currency)}, the payment is ${fmt(amount, currency)}`, 'amount_mismatch')
      bankRef = bank.externalId
    }
    const ev: NormalizedEvent = {
      type: 'payment.applied',
      externalId: `wr:${p.writeRequestId}`,
      connectionId: [...conns][0] as Id,
      direction,
      date: str(P, 'date') as string,
      amount: { minor: amount, currency },
      ...(str(P, 'method') ? { method: str(P, 'method') as string } : {}),
      ...(str(P, 'counterparty') ? { counterparty: str(P, 'counterparty') as string } : {}),
      applications: apps.map((a, i) => ({ invoiceExternalId: (invoices[i] as SourceRecord).externalId, amount: { minor: a.amountMinor, currency } })),
      ...(typeof P['unappliedMinor'] === 'number' && P['unappliedMinor'] > 0 ? { unapplied: { minor: P['unappliedMinor'] as number, currency } } : {}),
      ...(bankRef ? { bankTxnRef: bankRef } : {}),
    }
    const r = await this.#post(ws, ev, p, companyId)
    await this.#log(ws, p, 'record_payment', [r.id])
    const m = await this.#matches(ws, [r])
    return { recordId: r.id, recordType: 'entry', cashImpact: [], ...m, summary: `Payment ${fmt(amount, currency)} applied to ${apps.length} ${direction === 'receivable' ? 'invoice(s)' : 'bill(s)'}` }
  }

  #schedule(s: Payload | null | undefined): BucketSchedule | null {
    if (!s) return null
    const cadence = ({ weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'annual', annual: 'annual', biweekly: 'biweekly' } as const)[String(s['cadence']) as 'weekly']
    if (!cadence) throw new WriteRejected(`Unknown cadence ${String(s['cadence'])}`, 'invalid')
    return {
      amount: { minor: int(s, 'amountMinor'), currency: (str(s, 'currency') ?? 'USD').toUpperCase() },
      direction: s['direction'] === 'in' ? 'in' : 'out',
      cadence,
      ...(typeof s['dueDay'] === 'number' ? { dueDay: s['dueDay'] as number } : {}),
      startDate: str(s, 'startDate') ?? today(this.engine.now()),
      ...(str(s, 'endDate') ? { endDate: str(s, 'endDate') as string } : {}),
    }
  }

  #conditions(match: Payload, entityId: EntityId): RuleConditions {
    const c: RuleConditions = { entityIds: [entityId] }
    const desc = str(match, 'descriptionContains')
    if (desc) c.textPatterns = [desc.includes('*') ? desc : `*${desc}*`]
    if (str(match, 'counterparty')) c.counterparty = str(match, 'counterparty') as string
    if (typeof match['minAbsMinor'] === 'number') c.minAbsMinor = match['minAbsMinor'] as number
    if (typeof match['maxAbsMinor'] === 'number') c.maxAbsMinor = match['maxAbsMinor'] as number
    if (str(match, 'currency')) c.currency = (str(match, 'currency') as string).toUpperCase()
    if (str(match, 'accountId')) c.sourceAccountIds = [str(match, 'accountId') as string]
    if (str(match, 'query')) c.query = str(match, 'query') as string
    return c
  }

  async #createBucket(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const bucket = await this.engine.createBucket(ws, {
      entityId: companyId,
      name: str(P, 'name') ?? 'Bucket',
      fields: (P['fields'] as BucketField[] | undefined) ?? [],
      values: (P['values'] as Record<string, unknown> | undefined) ?? {},
      schedule: this.#schedule(P['schedule'] as Payload | null),
      ...(P['setAside'] ? { setAside: P['setAside'] as SetAside } : {}),
      origin: this.#origin(p),
      createdBy: this.#by(p),
    })
    const ids: Id[] = [bucket.id]
    const match = P['rule'] as Payload | null | undefined
    if (match) {
      const rule = await this.engine.createRule(ws, { name: `${bucket.name}: matching transactions`, conditions: this.#conditions(match, companyId), actions: { bucketId: bucket.id }, origin: p.actorKind === 'agent' ? 'agent' : 'user', createdBy: this.#by(p) })
      ids.push(rule.id)
    }
    await this.#log(ws, p, 'create_bucket', ids)
    return { recordId: bucket.id, recordType: 'bucket', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `Bucket "${bucket.name}"` }
  }

  async #updateBucket(ws: WorkspaceId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const id = str(P, 'bucketId') as Id
    const before = await this.engine.store.getBucket(ws, id)
    if (!before) throw new WriteRejected(`No bucket ${id}`, 'not_found')
    const ch = (P['changes'] ?? {}) as Payload
    const patch: Parameters<LedgerEngine['updateBucket']>[2] = {}
    if (str(ch, 'name')) patch.name = str(ch, 'name') as string
    if (Array.isArray(ch['fields'])) patch.fields = ch['fields'] as BucketField[]
    if (ch['values'] && typeof ch['values'] === 'object') patch.values = ch['values'] as Record<string, unknown>
    if ('schedule' in ch) patch.schedule = this.#schedule(ch['schedule'] as Payload | null)
    if ('setAside' in ch) patch.setAside = Array.isArray(ch['setAsideAccounts']) ? keepUnseenAllocations(before.setAside, ch['setAside'] as SetAside | null, ch['setAsideAccounts'] as Id[]) : (ch['setAside'] as SetAside | null)
    const b = await this.engine.updateBucket(ws, id, patch)
    await this.#log(ws, p, 'update_bucket', [id], before)
    return { recordId: b.id, recordType: 'bucket', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `Bucket "${b.name}" updated` }
  }

  async #createRule(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const set = (P['set'] ?? {}) as Payload
    const conditions = this.#conditions((P['match'] ?? {}) as Payload, companyId)
    if (P['applyToExisting'] !== true) conditions.createdAfter = this.engine.now()
    const actions = {
      ...(str(set, 'category') ? { category: resolveCategory(str(set, 'category') as string) } : {}),
      ...(str(set, 'bucketId') ? { bucketId: str(set, 'bucketId') as string } : {}),
      ...(str(set, 'kind') ? { kind: str(set, 'kind') as TxnKind } : {}),
      ...(str(set, 'entityId') && str(set, 'entityId') !== companyId ? { forEntityId: str(set, 'entityId') as string } : {}),
      ...(str(set, 'renameTo') ? { renameTo: (str(set, 'renameTo') as string).trim() } : {}),
      ...(P['stopProcessing'] === true ? { stop: true } : {}),
    }
    const rule = await this.engine.createRule(ws, { name: describeRule(conditions, actions), conditions, actions, origin: p.actorKind === 'agent' ? 'agent' : 'user', createdBy: this.#by(p) })
    await this.#log(ws, p, 'create_rule', [rule.id])
    return { recordId: rule.id, recordType: 'rule', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: rule.name }
  }

  async #updateRecord(ws: WorkspaceId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const id = str(P, 'recordId') as Id
    const r = await this.#record(ws, id)
    const ch = (P['changes'] ?? {}) as Payload
    if (ch['paidBy'] !== undefined) {
      throw new WriteRejected(r.origin === 'connector' ? 'Who paid a synced row is fixed by its account. Use for_company to say whose money it was.' : 'To change who paid, void this entry and add it again with paid_by.', 'not_supported')
    }
    const before = await this.engine.store.getOverride(ws, id)
    const patch: Omit<Partial<RecordOverride>, 'recordId' | 'workspaceId' | 'updatedAt' | 'updatedBy'> = {}
    if (str(ch, 'category')) patch.category = resolveCategory(str(ch, 'category') as string)
    if (str(ch, 'note')) patch.note = str(ch, 'note') as string
    const forId = str(ch, 'forEntityId') ?? str(ch, 'entityId')
    if (forId) {
      await this.#entity(ws, forId)
      if (r.event.type !== 'txn.upsert' && r.event.type !== 'processor.balance_txn') {
        throw new WriteRejected(r.origin === 'connector' ? 'Synced invoices stay with the company their source belongs to.' : 'To move this record, void it and add it again in the other company.', 'not_supported')
      }
      patch.forEntityId = forId === r.entityId ? undefined : forId
    }
    const ids: Id[] = [id]
    if (Object.keys(patch).length) await this.engine.setOverride(ws, id, patch, this.#by(p))
    const link = ch['link'] as { recordId: Id; type: LinkType } | undefined
    if (link) {
      const other = await this.#record(ws, link.recordId)
      const res = await this.#linkEitherWay(ws, link.type, r, other, p)
      ids.push(res.linkId)
    }
    await this.#log(ws, p, 'update_record', ids, { override: before })
    return { recordId: id, recordType: r.event.type === 'invoice.upsert' ? 'invoice' : r.origin === 'connector' ? 'transaction' : 'entry', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: 'Record updated' }
  }

  /** Links go from→to in a fixed direction per type; try the given order, then the reverse. */
  async #linkEitherWay(ws: WorkspaceId, type: LinkType, a: SourceRecord, b: SourceRecord, p: Provenance): Promise<{ linkId: Id }> {
    const method = p.actorKind === 'agent' ? 'agent' : 'human'
    const by = { createdBy: this.#by(p) }
    try {
      return await this.engine.link(ws, { type, fromId: a.id, toId: b.id, confidence: 1, method }, by)
    } catch (err) {
      if (!(err instanceof LinkError)) throw err
      try {
        return await this.engine.link(ws, { type, fromId: b.id, toId: a.id, confidence: 1, method }, by)
      } catch {
        throw new WriteRejected(err.message, 'link_rejected')
      }
    }
  }

  async #equityEvent(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const amount = P['amount'] as Money | null
    const kind = str(P, 'kind') as Extract<NormalizedEvent, { type: 'equity.event' }>['kind']
    const ev: NormalizedEvent = {
      type: 'equity.event',
      externalId: `wr:${p.writeRequestId}`,
      connectionId: await this.#manualConnection(ws, companyId),
      kind,
      date: str(P, 'date') as string,
      stakeholder: str(P, 'stakeholder') ?? 'Unknown',
      ...(amount ? { amount } : {}),
      ...(typeof P['shares'] === 'number' ? { shares: P['shares'] as number } : {}),
      ocf: Object.fromEntries(Object.entries(P).filter(([k, v]) => v !== null && !['kind', 'date', 'stakeholder', 'amount', 'shares', 'bankTransactionId'].includes(k))),
    }
    const r = await this.#post(ws, ev, p, companyId)
    const ids: Id[] = [r.id]
    const bankId = str(P, 'bankTransactionId')
    if (bankId) {
      const bank = await this.#record(ws, bankId)
      ids.push((await this.#linkEitherWay(ws, 'equity_cash', r, bank, p)).linkId)
    }
    await this.#log(ws, p, 'record_equity_event', ids)
    const m = await this.#matches(ws, [r])
    return { recordId: r.id, recordType: 'equity_event', cashImpact: [], ...m, summary: `${kind} for ${ev.stakeholder}` }
  }

  /**
   * One investment event, through the same audit, preview, undo and period locks as any write. A later event names
   * its position and may leave out what the position already says (issuer, security type). Refused in plain words:
   * an unknown position, a different currency, anything after the position ended, converting what isn't a SAFE or note.
   */
  async #investment(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const given = (P['event'] ?? {}) as Partial<InvestmentEvent>
    const kind = given.kind
    if (!kind) throw new WriteRejected('Say what happened: invest, mark, distribution, write_off, exit or convert.', 'invalid')
    const earlier = given.positionId
      ? (await this.engine.store.listRecords(ws, { entityIds: [companyId], eventTypes: ['investment.event'], statuses: ['posted'] }))
          .filter((r) => r.event.type === 'investment.event' && r.event.positionId === given.positionId)
          .sort(positionOrder)
      : []
    if (kind !== 'invest' && !given.positionId) throw new WriteRejected(`A ${kind.replace('_', '-')} needs the investment it belongs to (positionId).`, 'invalid')
    if (given.positionId && kind !== 'invest' && earlier.length === 0) throw new WriteRejected(`No investment ${given.positionId} in this company.`, 'not_found')
    const pos = earlier.map((r) => r.event as InvestmentEvent)
    const first = pos.find((e) => e.kind === 'invest' && e.amount) ?? pos[0]
    const issuer = given.issuer ?? first?.issuer
    if (!issuer) throw new WriteRejected('Say which company the investment is in (issuer).', 'invalid')
    const ended = earlier.find((r) => r.event.type === 'investment.event' && (r.event.kind === 'exit' || r.event.kind === 'write_off'))
    if (ended && given.date && given.date > ended.date) throw new WriteRejected(`${issuer} ended on ${ended.date} (${(ended.event as InvestmentEvent).kind.replace('_', '-')}); nothing can follow it.`, 'invalid')
    const cur = first?.amount?.currency
    if (cur && given.amount && given.amount.currency !== cur) throw new WriteRejected(`${issuer} is held in ${cur}; this amount is in ${given.amount.currency}. Record it in ${cur}.`, 'invalid')
    const current = [...pos].reverse().find((e) => e.kind === 'convert')?.securityType ?? first?.securityType
    if (kind === 'convert' && current && current !== 'safe' && current !== 'convertible_note') throw new WriteRejected(`${issuer} is ${current.replace('_', ' ')}, not a SAFE or note: nothing to convert.`, 'invalid')
    const securityType = given.securityType ?? (kind === 'convert' ? undefined : current)
    if (!securityType) throw new WriteRejected('Say what was bought (securityType: safe, convertible_note, preferred_stock, common_stock, warrant or other).', 'invalid')
    const positionId = given.positionId ?? `pos_${p.writeRequestId}`
    const { type: _t, externalId: _e, connectionId: _c, rawRef: _r, ...rest } = given as InvestmentEvent & { rawRef?: string }
    const ev: InvestmentEvent = { ...rest, type: 'investment.event', externalId: `wr:${p.writeRequestId}`, connectionId: await this.#manualConnection(ws, companyId), kind, positionId, issuer, securityType, date: given.date as string }
    const r = await this.#post(ws, ev, p, companyId)
    const ids: Id[] = [r.id]
    const bankId = str(P, 'bankTransactionId')
    if (bankId) {
      const bank = await this.#record(ws, bankId)
      ids.push((await this.#linkEitherWay(ws, 'investment_cash', r, bank, p)).linkId)
    }
    await this.#log(ws, p, 'record_investment', ids)
    const m = await this.#matches(ws, [r])
    const what = { invest: 'Invested in', mark: 'Marked', distribution: 'Money back from', write_off: 'Wrote off', exit: 'Exited', convert: 'Converted' }[kind]
    return { recordId: r.id, recordType: 'entry', positionId, cashImpact: [], ...m, summary: `${what} ${issuer}` }
  }

  async #resolveReview(ws: WorkspaceId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const itemId = str(P, 'reviewItemId') as string
    const decision = str(P, 'decision')
    const edits = (P['edits'] ?? {}) as Payload
    const [kind, subject] = [itemId.slice(0, itemId.indexOf(':')), itemId.slice(itemId.indexOf(':') + 1)]
    const by = this.#by(p)
    if (kind === 'filed') {
      const { recordId } = await this.engine.undoFiled(ws, subject)
      await this.#log(ws, p, 'resolve_review_item', [recordId], { filed: subject })
      return { recordId, recordType: 'transaction', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: 'Back in Review' }
    }
    if (kind === 'suggested_match') {
      if (decision !== 'confirm' && decision !== 'reject') throw new WriteRejected('A suggested match is confirmed or rejected', 'invalid')
      const link = await this.engine.store.getLink(ws, subject)
      if (!link) throw new WriteRejected('That suggestion is gone', 'not_found')
      await this.engine.decideLink(ws, subject, decision === 'confirm' ? 'confirmed' : 'rejected', by)
      // Logged against the money's own record (the id this returns), so "undo" on it puts the question back.
      await this.#log(ws, p, 'resolve_review_item', [link.toId], { link: link.status, linkId: subject })
      return { recordId: link.toId, recordType: 'transaction', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: decision === 'confirm' ? 'Linked: counted once' : 'Not the same money; kept apart' }
    }
    if (kind === 'suggested_rule') {
      const rule = await this.engine.store.getRule(ws, subject)
      if (!rule) throw new WriteRejected('That rule suggestion is gone', 'not_found')
      await this.engine.setRuleStatus(ws, subject, decision === 'confirm' ? 'active' : 'rejected')
      await this.#log(ws, p, 'resolve_review_item', [subject], { rule: rule.status })
      return { recordId: subject, recordType: 'rule', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: decision === 'confirm' ? `Rule on: ${rule.name}` : 'Rule suggestion dismissed' }
    }
    if (kind === 'owner_money' || kind === 'unexplained_money') {
      if (decision !== 'edit') throw new WriteRejected('Say what this money is (edit with kind or category)', 'invalid')
      const paysInvoice = str(edits, 'paysInvoice')
      if (paysInvoice) return this.#paysInvoice(ws, subject, paysInvoice, p)
      const before = await this.engine.store.getOverride(ws, subject)
      const patch: Omit<Partial<RecordOverride>, 'recordId' | 'workspaceId' | 'updatedAt' | 'updatedBy'> = {}
      const k = str(edits, 'kind')
      if (k) {
        const allowed = ['owner_loan', 'owner_contribution', 'revenue', 'cash_income', 'equity_financing', 'refund', 'transfer', 'payout', 'intercompany', 'other']
        if (!allowed.includes(k)) throw new WriteRejected(`kind must be one of ${allowed.join(', ')}`, 'invalid')
        patch.kind = k as TxnKind
      }
      if (str(edits, 'category')) patch.category = resolveCategory(str(edits, 'category') as string)
      if (Object.keys(patch).length === 0) throw new WriteRejected('edits needs kind or category', 'invalid')
      // Older money in an account, asked as one question: the answer goes to every row in it.
      if (subject.startsWith('older:')) {
        const item = (await this.engine.reviewItems(ws)).find((i) => i.id === itemId)
        if (!item || item.recordIds.length === 0) throw new WriteRejected('Those deposits are already explained', 'not_found')
        const prior: Record<string, RecordOverride | null> = {}
        for (const id of item.recordIds) {
          prior[id] = await this.engine.store.getOverride(ws, id)
          await this.engine.setOverride(ws, id, patch, by)
        }
        await this.#log(ws, p, 'resolve_review_item', item.recordIds, { overrides: prior })
        return { recordId: item.recordIds[0] as Id, recordType: 'transaction', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `Recorded what ${item.recordIds.length} deposits are` }
      }
      await this.engine.setOverride(ws, subject, patch, by)
      await this.#log(ws, p, 'resolve_review_item', [subject], { override: before })
      return { recordId: subject, recordType: 'transaction', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: 'Recorded what this money is' }
    }
    if (kind === 'which_company') {
      if (decision !== 'edit') throw new WriteRejected('Say which company this account belongs to (edit with companyId)', 'invalid')
      const companyId = str(edits, 'companyId')
      if (!companyId) throw new WriteRejected('edits needs companyId', 'invalid')
      const acc = await this.engine.directory.getSourceAccount(ws, subject)
      if (!acc) throw new WriteRejected('That account is gone', 'not_found')
      if (!(await this.engine.directory.getEntity(ws, companyId))) throw new WriteRejected('No company with that id', 'wrong_company')
      if (acc.entityId && acc.entityId !== companyId) throw new WriteRejected(`${acc.name} already belongs to a company`, 'invalid')
      await this.engine.assignAccount(ws, subject, companyId)
      await this.#log(ws, p, 'resolve_review_item', [subject], { account: { entityId: null } })
      return { recordId: subject, recordType: 'account', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `${acc.name} now belongs to ${(await this.engine.directory.getEntity(ws, companyId))?.name ?? 'that company'}` }
    }
    throw new WriteRejected('That review item is answered in Aggregate itself', 'not_supported')
  }

  /** "Pays an invoice": the person links this money to one of the company's open invoices (undo unlinks it). */
  async #paysInvoice(ws: WorkspaceId, recordId: Id, invoiceId: Id, p: Provenance): Promise<AppliedWrite> {
    const [rec, inv] = await Promise.all([this.engine.store.getRecord(ws, recordId), this.engine.store.getRecord(ws, invoiceId)])
    if (!rec || !rec.amount) throw new WriteRejected('That money is gone', 'not_found')
    if (!inv || inv.event.type !== 'invoice.upsert' || inv.status !== 'posted') throw new WriteRejected('That invoice is gone', 'not_found')
    if (inv.entityId !== rec.entityId) throw new WriteRejected('That invoice belongs to another company', 'wrong_company')
    if (inv.event.total.currency !== rec.amount.currency) throw new WriteRejected(`The invoice is in ${inv.event.total.currency}, the money in ${rec.amount.currency}`, 'currency_mismatch')
    if ((inv.event.direction === 'receivable') !== rec.amount.minor > 0) throw new WriteRejected('Money in pays invoices, money out pays bills', 'invalid')
    const open = (await openItems(this.engine.metricContext(ws), [inv.entityId as EntityId], inv.event.direction, '9999-12-31')).find((o) => o.record.id === inv.id)
    if (!open || open.remainingMinor <= 0) throw new WriteRejected('That invoice is already paid', 'invalid')
    const amount = Math.min(Math.abs(rec.amount.minor), open.remainingMinor)
    const prior = (await this.engine.store.listLinks(ws, { recordId: inv.id })).find((l) => l.type === 'invoice_payment' && l.toId === rec.id)
    const res = await this.engine.link(ws, { type: 'invoice_payment', fromId: inv.id, toId: rec.id, amount: { minor: amount, currency: rec.amount.currency }, confidence: 1, method: 'human' }, { createdBy: this.#by(p) })
    // Logged against the money's own record, so "undo" on it (the id the answer returns) unlinks it again.
    await this.#log(ws, p, 'resolve_review_item', [recordId], { link: prior?.status === 'proposed' ? 'proposed' : 'rejected', linkId: res.linkId })
    const num = inv.event.number ? ` ${inv.event.number}` : ''
    return { recordId, recordType: 'transaction', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `Linked: pays invoice${num} (${formatMoney(amount, rec.amount.currency)})` }
  }

  async #pinBalance(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const acc = await this.#account(ws, str(P, 'accountId') as Id)
    const primaryId = acc.duplicateOf ?? acc.id
    const primary = primaryId === acc.id ? acc : await this.#account(ws, primaryId)
    if (primary.entityId !== companyId) throw new WriteRejected(`${primary.name} belongs to another company.`, 'wrong_company')
    const date = str(P, 'date')
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WriteRejected('date must be YYYY-MM-DD', 'invalid')
    if (date > this.engine.now().slice(0, 10)) throw new WriteRejected('A balance can only be pinned for today or earlier', 'invalid')
    const balance = P['balance'] as Money | undefined
    if (!balance || !Number.isSafeInteger(balance.minor) || typeof balance.currency !== 'string') throw new WriteRejected('balance needs minor units and a currency', 'invalid')
    if (balance.currency !== primary.currency) throw new WriteRejected(`${primary.name} is in ${primary.currency}, not ${balance.currency}.`, 'currency_mismatch')
    const a = await this.engine.addBalanceAssertion(ws, { accountId: primary.id, date, balance, source: str(P, 'source') ?? null, createdBy: this.#by(p), provenance: p })
    await this.#log(ws, p, 'pin_balance', [a.id])
    const check = (await this.engine.checks(ws, { entityIds: [companyId] })).find((c) => c.name === 'balance_assertion' && c.subjectId === a.id)
    const agrees = check?.status === 'ok'
    // The check compares in ledger sign; people (and the AI) state cards and loans as positive amounts owed.
    const owed = check && check.expectedMinor !== null && check.expectedMinor === -balance.minor && balance.minor !== 0
    const ledgerShown = check?.actualMinor == null ? null : owed ? -check.actualMinor : check.actualMinor
    const balanceCheck = ledgerShown === null ? undefined : { matches: agrees, stated: balance, ledger: { minor: ledgerShown, currency: balance.currency }, difference: { minor: balance.minor - ledgerShown, currency: balance.currency } }
    return {
      recordId: a.id,
      recordType: 'balance_assertion',
      cashImpact: [],
      suggestedLinks: [],
      possibleDuplicates: [],
      ...(balanceCheck ? { balanceCheck } : {}),
      summary: agrees
        ? `Pinned: ${primary.name} held ${fmt(balance.minor, balance.currency)} on ${date}; the ledger agrees`
        : `Pinned: ${primary.name} held ${fmt(balance.minor, balance.currency)} on ${date}; the ledger differs${ledgerShown === null ? '' : ` (ledger ${fmt(ledgerShown, balance.currency)}, difference ${fmt(balance.minor - ledgerShown, balance.currency)})`}, so it shows as a check to fix`,
    }
  }

  async #closePeriod(ws: WorkspaceId, companyId: EntityId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const company = await this.#entity(ws, companyId)
    const through = str(P, 'through')
    if (!through || !/^\d{4}-\d{2}-\d{2}$/.test(through)) throw new WriteRejected('through must be YYYY-MM-DD', 'invalid')
    const prev = (await this.engine.periodLocks(ws)).find((l) => l.entityId === companyId) ?? null
    const lock = await this.engine.lockPeriod(ws, { entityId: companyId, through, note: str(P, 'note') ?? null, createdBy: this.#by(p), provenance: p })
    await this.#log(ws, p, 'close_period', [lock.id], { entityId: companyId, lock: prev ? { through: prev.through, note: prev.note } : null })
    return { recordId: lock.id, recordType: 'period_lock', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `${company.name}'s books are closed through ${through}; later changes to that period post on the next day` }
  }

  async #reopenPeriod(ws: WorkspaceId, companyId: EntityId, p: Provenance): Promise<AppliedWrite> {
    const company = await this.#entity(ws, companyId)
    const prev = (await this.engine.periodLocks(ws)).find((l) => l.entityId === companyId)
    if (!prev) throw new WriteRejected(`${company.name}'s books aren't closed`, 'invalid')
    await this.engine.unlockPeriod(ws, companyId)
    await this.#log(ws, p, 'reopen_period', [prev.id], { entityId: companyId, lock: { through: prev.through, note: prev.note } })
    return { recordId: prev.id, recordType: 'period_lock', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `${company.name}'s books are open again (they were closed through ${prev.through})` }
  }

  async #void(ws: WorkspaceId, P: Payload, p: Provenance): Promise<AppliedWrite> {
    const id = str(P, 'recordId') as Id
    const bucket = await this.engine.store.getBucket(ws, id)
    if (bucket) {
      await this.engine.updateBucket(ws, id, { archived: true })
      await this.#log(ws, p, 'void_record', [id], { bucket: true })
      return { recordId: id, recordType: 'bucket', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: `Bucket "${bucket.name}" archived` }
    }
    const rule = await this.engine.store.getRule(ws, id)
    if (rule) {
      await this.engine.setRuleStatus(ws, id, 'disabled')
      await this.#log(ws, p, 'void_record', [id], { rule: rule.status })
      return { recordId: id, recordType: 'rule', cashImpact: [], suggestedLinks: [], possibleDuplicates: [], summary: 'Rule turned off' }
    }
    const r = await this.#record(ws, id)
    if (r.origin === 'connector') throw new WriteRejected('Synced rows cannot be voided. If it is a duplicate, link it as one with update_record.', 'synced')
    if (r.status === 'void') throw new WriteRejected('Already voided', 'invalid')
    // Void every record the original write created (both legs of a transfer).
    const w = await this.engine.store.latestWriteFor(ws, id)
    const ids = w && ['add_entry', 'add_invoice', 'record_payment', 'record_equity_event', 'record_investment'].includes(w.op) ? w.recordIds.filter((x) => x === id || !x.startsWith('lnk')) : [id]
    const cashImpact: AppliedWrite['cashImpact'] = []
    const voided: Id[] = []
    for (const rid of ids) {
      const rec = await this.engine.store.getRecord(ws, rid)
      if (!rec || rec.status === 'void' || rec.origin === 'connector') continue
      cashImpact.push(...(await this.#cashOf(ws, rec, -1)))
      await this.engine.setVoided(ws, rid, true)
      voided.push(rid)
    }
    await this.#log(ws, p, 'void_record', voided)
    return { recordId: id, recordType: r.event.type === 'invoice.upsert' ? 'invoice' : 'entry', cashImpact, suggestedLinks: [], possibleDuplicates: [], summary: 'Voided; it can be restored for 30 days' }
  }

  async #cashOf(ws: WorkspaceId, r: SourceRecord, sign: 1 | -1): Promise<AppliedWrite['cashImpact']> {
    if (r.event.type !== 'txn.upsert' || !r.sourceAccountId || r.status !== 'posted') return []
    const a = await this.engine.directory.getSourceAccount(ws, r.sourceAccountId)
    if (!a?.includeInCash || !a.entityId) return []
    return [{ entityId: a.entityId, amount: { minor: sign * r.event.amount.minor, currency: r.event.amount.currency } }]
  }

  // ---------- revert ----------

  async #revert(ws: WorkspaceId, recordId: Id, p: Provenance): Promise<void> {
    const w = await this.engine.store.latestWriteFor(ws, recordId)
    if (!w) throw new WriteRejected(`Nothing to undo for ${recordId}`, 'not_found')
    const before = (w.before ?? {}) as Record<string, unknown>
    switch (w.op) {
      case 'add_entry':
      case 'add_invoice':
      case 'record_payment':
      case 'record_equity_event':
      case 'record_investment':
        for (const id of w.recordIds) {
          const r = await this.engine.store.getRecord(ws, id)
          if (r && r.status !== 'void') await this.engine.setVoided(ws, id, true)
          const link = r ? null : await this.engine.store.getLink(ws, id)
          if (link && link.status === 'confirmed') await this.engine.decideLink(ws, id, 'rejected', this.#by(p))
        }
        break
      case 'create_bucket':
        for (const id of w.recordIds) {
          if (await this.engine.store.getBucket(ws, id)) await this.engine.updateBucket(ws, id, { archived: true })
          else if (await this.engine.store.getRule(ws, id)) await this.engine.setRuleStatus(ws, id, 'disabled')
        }
        break
      case 'update_bucket': {
        const b = w.before as Bucket
        await this.engine.updateBucket(ws, b.id, { name: b.name, fields: b.fields, values: b.values, schedule: b.schedule, setAside: b.setAside ?? null })
        break
      }
      case 'create_rule':
        await this.engine.setRuleStatus(ws, w.recordIds[0] as Id, 'disabled')
        break
      case 'update_record':
        await this.engine.restoreOverride(ws, w.recordIds[0] as Id, (before['override'] as RecordOverride | null) ?? null)
        for (const id of w.recordIds.slice(1)) {
          const link = await this.engine.store.getLink(ws, id)
          if (link?.status === 'confirmed') await this.engine.decideLink(ws, id, 'rejected', this.#by(p))
        }
        break
      case 'pin_balance':
        for (const id of w.recordIds) await this.engine.removeBalanceAssertion(ws, id)
        break
      case 'close_period':
      case 'reopen_period': {
        // Back to how the books were before this write: the earlier lock, or open.
        const prior = before['lock'] as { through: string; note: string | null } | null
        const entityId = before['entityId'] as EntityId
        if (prior) await this.engine.lockPeriod(ws, { entityId, through: prior.through, note: prior.note, createdBy: this.#by(p), provenance: p })
        else await this.engine.unlockPeriod(ws, entityId)
        break
      }
      case 'resolve_review_item': {
        const id = w.recordIds[0] as Id
        if ('account' in before) throw new WriteRejected('Which company an account belongs to is changed in its connection settings', 'not_supported')
        if ('overrides' in before) {
          for (const [rid, o] of Object.entries(before['overrides'] as Record<string, RecordOverride | null>)) await this.engine.restoreOverride(ws, rid, o)
          break
        }
        if ('link' in before) await this.engine.decideLink(ws, (before['linkId'] as Id | undefined) ?? id, before['link'] as 'proposed', this.#by(p))
        else if ('rule' in before) await this.engine.setRuleStatus(ws, id, before['rule'] as 'suggested')
        else await this.engine.restoreOverride(ws, id, (before['override'] as RecordOverride | null) ?? null)
        break
      }
      case 'void_record':
        for (const id of w.recordIds) {
          if ('bucket' in before) await this.engine.updateBucket(ws, id, { archived: false })
          else if ('rule' in before) await this.engine.setRuleStatus(ws, id, before['rule'] as 'active')
          else await this.engine.setVoided(ws, id, false)
        }
        break
    }
    await this.engine.store.saveWrite({ ...w, revertedAt: this.engine.now() })
  }
}

function fmt(minor: number, currency: string): string {
  const neg = minor < 0
  const abs = Math.abs(minor)
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')} ${currency}`
}

function describeRule(c: RuleConditions, a: { category?: string; bucketId?: string; kind?: string; forEntityId?: string; renameTo?: string; stop?: boolean }): string {
  const when = [c.query, c.textPatterns?.join(' or '), c.counterparty, c.minAbsMinor !== undefined ? `≥ ${c.minAbsMinor}` : '', c.maxAbsMinor !== undefined ? `≤ ${c.maxAbsMinor}` : ''].filter(Boolean).join(', ')
  const then = [a.renameTo ? `call it "${a.renameTo}"` : '', a.category, a.kind, a.bucketId ? `bucket ${a.bucketId}` : '', a.forEntityId ? `company ${a.forEntityId}` : '', a.stop ? 'stop' : ''].filter(Boolean).join(', ')
  return `${when || 'matching rows'} → ${then}`
}

/** Library errors become WriteRejected with a stable code; anything else is a bug and propagates. */
const ROLLBACK = Symbol('preview rollback')

/** The ledger can't preview this write (equity without a preview); the caller still runs its own checks. */
export class PreviewUnavailable extends Error {
  override name = 'PreviewUnavailable'
}

function asRejection(err: unknown): unknown {
  if (err instanceof WriteRejected) return err
  if (err instanceof LinkError) return new WriteRejected(err.message, 'link_rejected')
  if (err instanceof PostingError || err instanceof EventValidationError || err instanceof MoneyError || err instanceof BucketValidationError || err instanceof RuleValidationError) {
    return new WriteRejected(err.message, 'invalid')
  }
  return err
}

export type { Payload }
