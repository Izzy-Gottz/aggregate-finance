// Posting rules: a source record (+ its confirmed links, overrides and rules) → planned journal entries.
// Pure and deterministic: the engine can throw the ledger away and rebuild it from the same inputs.
//
// Each record is planned once per view (cash, accrual). Identical plans become one 'both' entry; different plans
// (an invoice payment is revenue on a cash basis but settles AR on an accrual basis) become one entry per view.
import type {
  CreditNoteUpsert,
  EntityId,
  EquityEvent,
  Id,
  InvestmentEvent,
  JournalUpsert,
  InvoiceUpsert,
  IsoDate,
  NormalizedEvent,
  ProviderFx,
  Money,
  PaymentApplied,
  PayrollRun,
  ProcessorBalanceTxn,
  TxnKind,
  TxnUpsert,
} from '@agfn/contracts'
import { BILL_BALANCE_SHEET_ROLES, cashRole, defineRole, isExpenseRole, isFixedRole, isIncomeRole } from './coa.ts'
import type { Basis, EntityInfo, Link, RecordOverride, SourceAccountInfo, SourceRecord } from './model.ts'
import { allocate } from './money.ts'
import type { RuleResult } from './rules.ts'

/** A planned line. `amount` is signed: positive = debit, negative = credit. */
export interface PlannedLine {
  role: string
  amount: Money
  /** Explicit base-currency amount (signed). Used where history fixes the rate (AR at the invoice-date rate). */
  baseMinor?: number
  bucketId?: string | null
  memo?: string | null
}

export interface PlannedEntry {
  entityId: EntityId
  date: string
  kind: TxnKind
  memo: string | null
  lines: PlannedLine[]
  /** The source document's own rate (QuickBooks, Xero): its currency's lines convert at it when it fits the entity. */
  fx?: DocumentFx
}

/** A provider's rate for a document: `rate` units of `home` per 1 unit of `currency`. */
export interface DocumentFx {
  rate: string
  home: string
  currency: string
}

/** The provider rate an event carries, with the document currency it converts (null when none or nothing foreign). */
export function documentFx(ev: NormalizedEvent): DocumentFx | null {
  const fx = (ev as { fx?: ProviderFx }).fx
  if (!fx) return null
  let currency: string | undefined
  if (ev.type === 'journal.upsert') currency = ev.lines.find((l) => l.amount.currency !== fx.home)?.amount.currency
  else currency = ((ev as { amount?: Money }).amount ?? (ev as { total?: Money }).total)?.currency
  return currency && currency !== fx.home ? { rate: fx.rate, home: fx.home, currency } : null
}

/** A document rate applies to an amount when it's in the document's currency and the entity keeps books in its home. */
export function fxFits(fx: DocumentFx | null | undefined, amountCurrency: string, baseCurrency: string): fx is DocumentFx {
  return !!fx && fx.home === baseCurrency && fx.currency === amountCurrency && amountCurrency !== baseCurrency
}

export interface LinkedRecord {
  link: Link
  other: SourceRecord
  otherAccount: SourceAccountInfo | null
}

export interface PlanContext {
  record: SourceRecord
  entity: EntityInfo
  account: SourceAccountInfo | null
  entities: ReadonlyMap<EntityId, EntityInfo>
  override: RecordOverride | null
  rules: RuleResult | null
  /** Confirmed links touching this record. */
  links: LinkedRecord[]
  /** Probably a copy of a row another source already reported (a pending duplicate suggestion): post nothing yet. */
  heldAsCopy?: boolean
  entityHasCard(entityId: EntityId): boolean
  entityHasProcessor(entityId: EntityId): boolean
  /** The workspace's single personal entity, when there is exactly one (default "owner" for founder money). */
  soleOwnerEntityId: EntityId | null
  /**
   * Base-currency value (signed minor) of `amount` at the rate on `date`, for the entity's base currency; at the
   * document's own provider rate when one is given and fits.
   */
  baseAt(amount: Money, date: string, entityId: EntityId, fx?: DocumentFx | null): Promise<number>
  /** Classification of another record, for refunds that mirror the original. */
  classify(record: SourceRecord): Promise<Classification | null>
  /** The day an entity's money history starts (its earliest bank, card or processor row), null before any. */
  booksStart?(entityId: EntityId): Promise<IsoDate | null>
  /** Every live investment.event of one position in an entity (this record included), for cost left before it. */
  position?(entityId: EntityId, positionId: string): Promise<SourceRecord[]>
  /** The invoice or bill a payment from the same connection applies to (cash basis books it in the document's category). */
  document?(connectionId: Id, externalId: string): Promise<SourceRecord | null>
}

export class PostingError extends Error {
  override name = 'PostingError'
}

export interface Classification {
  kind: TxnKind
  counterRole: string
  bucketId: string | null
  forEntityId: EntityId | null
  ownerEntityId: EntityId | null
  /** True when the default had to be used (unexplained inflow, uncategorized spend). */
  defaulted: boolean
}

const line = (role: string, minor: number, currency: string, extra: Partial<PlannedLine> = {}): PlannedLine => ({
  role,
  amount: { minor, currency },
  ...extra,
})

// ---------- Classification of a bank/card transaction (no links) ----------

/** Plaid RENT_AND_UTILITIES_* other than the rent itself (and the bare primary category, which could be either). */
export const UTILITY_HINT = /^rent[_ ]and[_ ]utilities[_ ](?!rent$)|^utilities$|gas[_ ]and[_ ]electricity|sewage|internet[_ ]and[_ ]cable|telephone/i

/** Provider category hints → expense role. Only ever used for spending, never decides kind. */
const HINTS: Array<[RegExp, string]> = [
  [/bank[_ ]?fee|service[_ ]?charge|overdraft/i, 'bank_fees'],
  // Power, water, internet and phone are utilities; the rent itself stays rent.
  [UTILITY_HINT, 'utilities'],
  [/rent|utilities/i, 'rent'],
  [/travel|airline|lodging|hotel|taxi|rideshare|^transportation_/i, 'travel'],
  // A store purchase (Plaid FOOD_AND_DRINK_GROCERIES, ..._BEER_WINE_AND_LIQUOR) isn't eating out.
  [/groceries|supermarket|beer[_ ]?wine[_ ]?and[_ ]?liquor/i, 'groceries'],
  [/restaurant|fast[_ ]?food|food[_ ]?and[_ ]?drink|meal|coffee/i, 'meals'],
  // A mortgage payment, when no loan account takes it (a person's books): housing, as people count it.
  [/mortgage/i, 'housing'],
  [/general[_ ]?merchandise|shopping/i, 'shopping'],
  [/entertainment|streaming|tv[_ ]?and[_ ]?movies|music[_ ]?and[_ ]?audio/i, 'entertainment'],
  [/software|subscription|saas/i, 'software'],
  [/advertising|marketing/i, 'marketing'],
  [/insurance/i, 'insurance'],
  [/legal|accounting|professional/i, 'professional_fees'],
  [/payroll/i, 'payroll_expense'],
  [/tax/i, 'taxes'],
]

function hintRole(hint: string | undefined): string | null {
  if (!hint) return null
  for (const [re, role] of HINTS) if (re.test(hint)) return role
  return null
}

function inflowHintRole(hint: string | undefined): string | null {
  if (!hint) return null
  if (/(^|_)INTEREST_EARNED$|^interest(_income)?$/i.test(hint)) return 'interest_income'
  if (/(^|_)DIVIDENDS$/i.test(hint)) return 'other_income'
  // A paycheck (Plaid INCOME_WAGES; PFC v2 INCOME_SALARY, military pay) is income to whoever receives it, usually
  // Personal: not a question.
  if (/^INCOME_(WAGES|SALARY|MILITARY)$/i.test(hint)) return 'wages_income'
  // Benefits and support (PFC v2) are income too. Contractor, gig and rental income stay asked about: they may be a
  // business's revenue.
  if (/^INCOME_(LONG_TERM_DISABILITY|CHILD_SUPPORT)$/i.test(hint)) return 'other_income'
  // Sales a connector knows are sales (a till's counted cash). Broad provider codes such as INCOME_OTHER_INCOME are
  // left alone: those deposits may be owner money or transfers, so they're still asked about.
  if (hint === 'INCOME_SALES') return 'revenue'
  return null
}

/**
 * Money back from a kind of spending the provider names (Plaid TRAVEL_FLIGHTS on a deposit: a flight refund) lowers
 * that spending. Only for spending people get refunds on: rent, payroll, fees for services and the like may be someone's
 * income (a landlord's rent), so those deposits are still asked about.
 */
const REFUNDABLE = new Set(['travel', 'meals', 'groceries', 'shopping', 'entertainment', 'software', 'cloud'])
function refundHintRole(hint: string | undefined): string | null {
  const role = hintRole(hint)
  return role && REFUNDABLE.has(role) ? role : null
}

function kindForRole(role: string, inflow: boolean): TxnKind {
  if (role === 'revenue') return 'revenue'
  if (role === 'refunds') return 'refund'
  if (role.startsWith('payroll') || role === 'contractors') return 'payroll'
  if (role === 'taxes') return 'tax'
  if (role === 'bank_fees' || role === 'processor_fees') return 'fee'
  if (isExpenseRole(role)) return 'expense'
  if (isIncomeRole(role)) return inflow ? 'revenue' : 'refund'
  if (role === 'owner_contributions' || role === 'owner_draws') return 'owner_contribution'
  if (role === 'owner_money_unspecified') return 'owner_money_unspecified'
  if (role.startsWith('owner_payable:')) return 'owner_loan'
  if (role === 'paid_in_capital' || role === 'safes' || role === 'convertible_notes') return 'equity_financing'
  if (role.startsWith('due_')) return 'intercompany'
  if (role.startsWith('clearing_')) return 'transfer'
  return 'other'
}

/** Kind (+ context) → counter-account role, when no explicit category was given. */
function roleForKind(kind: TxnKind, inflow: boolean, c: { ownerEntityId: EntityId | null; counterEntityId: EntityId | null; entityId: EntityId; hasCard: boolean; hasProcessor: boolean; hint: string | null }): { role: string; defaulted: boolean } {
  switch (kind) {
    case 'revenue':
    case 'cash_income':
      return { role: 'revenue', defaulted: false }
    case 'expense':
      return { role: c.hint ?? 'uncategorized_expense', defaulted: c.hint === null }
    case 'fee':
      return { role: 'bank_fees', defaulted: false }
    case 'payroll':
      return { role: 'payroll_expense', defaulted: false }
    case 'tax':
      return { role: 'taxes', defaulted: false }
    case 'refund':
      return { role: inflow ? (c.hint ?? 'uncategorized_expense') : 'refunds', defaulted: false }
    case 'owner_loan':
    case 'reimbursement':
      return c.ownerEntityId ? { role: `owner_payable:${c.ownerEntityId}`, defaulted: false } : { role: 'suspense', defaulted: true }
    case 'owner_contribution':
      return { role: inflow ? 'owner_contributions' : 'owner_draws', defaulted: false }
    case 'owner_money_unspecified':
      return { role: 'owner_money_unspecified', defaulted: false }
    case 'equity_financing':
      return { role: 'paid_in_capital', defaulted: false }
    case 'intercompany':
      return c.counterEntityId && c.counterEntityId !== c.entityId
        ? { role: inflow ? `due_to:${c.counterEntityId}` : `due_from:${c.counterEntityId}`, defaulted: false }
        : { role: 'suspense', defaulted: true }
    case 'transfer':
      return { role: 'clearing_transfers', defaulted: false }
    case 'card_payment':
      // A card that isn't connected: the payment is the only sighting of that spending.
      return c.hasCard ? { role: 'clearing_transfers', defaulted: false } : { role: 'uncategorized_expense', defaulted: true }
    case 'payout':
      // Without the processor connected, the deposit is the only sighting of those sales (net of fees).
      return c.hasProcessor ? { role: 'clearing_payouts', defaulted: false } : { role: 'revenue', defaulted: false }
    case 'other':
      return inflow ? { role: 'suspense', defaulted: true } : { role: 'uncategorized_expense', defaulted: true }
  }
}

export function classifyTxn(ctx: Pick<PlanContext, 'record' | 'override' | 'rules' | 'entityHasCard' | 'entityHasProcessor' | 'soleOwnerEntityId'>, ev: TxnUpsert): Classification {
  const o = ctx.override
  const r = ctx.rules?.actions
  const inflow = ev.amount.minor > 0
  const entityId = ctx.record.entityId as EntityId
  const forEntityId = o?.forEntityId ?? r?.forEntityId ?? null
  const ownerEntityId = o?.ownerEntityId ?? ctx.soleOwnerEntityId
  const category = o?.category ?? r?.category
  const kindGiven = o?.kind ?? r?.kind
  const bucketId = o?.bucketId ?? r?.bucketId ?? null
  if (category) {
    defineRole(category) // throws on unknown role keys
    return { kind: kindGiven ?? kindForRole(category, inflow), counterRole: category, bucketId, forEntityId, ownerEntityId, defaulted: false }
  }
  // Money in that the provider itself calls interest or dividends (e.g. Plaid INCOME_INTEREST_EARNED) is income,
  // not "what is this money?".
  const incomeHint = inflow && !kindGiven ? inflowHintRole(ev.categoryHint) : null
  if (incomeHint) return { kind: 'revenue', counterRole: incomeHint, bucketId, forEntityId, ownerEntityId, defaulted: false }
  // Money a connector knows went back to a customer for a sale (a Square refund paid from the cash drawer): it lowers
  // sales, not an expense.
  if (!inflow && !kindGiven && ev.categoryHint === 'SALES_REFUND') return { kind: 'refund', counterRole: 'refunds', bucketId, forEntityId, ownerEntityId, defaulted: false }
  // Crypto bought or sold from an exchange's cash wallet (Coinbase): the money became, or came back from, crypto still
  // owned. Other assets, at what was paid: not spending or income. The crypto itself is shown as holdings, never posted.
  if (!kindGiven && ev.categoryHint === 'CRYPTO_TRADE') return { kind: 'other', counterRole: 'other_assets', bucketId, forEntityId, ownerEntityId, defaulted: false }
  const refundHint = inflow && !kindGiven ? refundHintRole(ev.categoryHint) : null
  if (refundHint) return { kind: 'refund', counterRole: refundHint, bucketId, forEntityId, ownerEntityId, defaulted: false }
  const kind: TxnKind = kindGiven ?? (inflow ? 'other' : 'expense')
  const { role, defaulted } = roleForKind(kind, inflow, {
    ownerEntityId,
    counterEntityId: forEntityId ?? ownerEntityId,
    entityId,
    hasCard: ctx.entityHasCard(entityId),
    hasProcessor: ctx.entityHasProcessor(entityId),
    hint: inflow ? null : hintRole(ev.categoryHint),
  })
  return { kind: kindGiven ?? (role === 'suspense' ? 'other' : kind), counterRole: role, bucketId, forEntityId, ownerEntityId, defaulted }
}

// ---------- Cross-entity helpers ----------

/**
 * The account entity X uses for money between X and Y.
 * Company ↔ person: the company's owner_payable:<person> (credit = company owes the owner).
 * Otherwise due_from:<Y> for X's debit side, due_to:<Y> for X's credit side.
 */
export function interEntityRole(x: EntityInfo, y: EntityInfo, xDebit: boolean): string {
  if (x.kind === 'company' && y.kind === 'personal') return `owner_payable:${y.id}`
  return xDebit ? `due_from:${y.id}` : `due_to:${y.id}`
}

function entityOrThrow(ctx: PlanContext, id: EntityId): EntityInfo {
  const e = ctx.entities.get(id)
  if (!e) throw new PostingError(`Unknown entity ${id}`)
  return e
}

// ---------- Plans per event type ----------

export async function plan(ctx: PlanContext, view: Basis): Promise<PlannedEntry[]> {
  const planned = await planByType(ctx, view)
  const fx = documentFx(ctx.record.event)
  return fx ? planned.map((p) => ({ ...p, fx })) : planned
}

async function planByType(ctx: PlanContext, view: Basis): Promise<PlannedEntry[]> {
  const ev = ctx.record.event
  if (ctx.override?.excluded) return []
  switch (ev.type) {
    case 'txn.upsert':
      return planTxn(ctx, ev, view)
    case 'processor.balance_txn':
      return planProcessor(ctx, ev, view)
    case 'invoice.upsert':
      return planInvoice(ctx, ev, view)
    case 'payment.applied':
      return await planPayment(ctx, ev, view)
    case 'credit_note.upsert':
      return planCreditNote(ctx, ev, view)
    case 'payroll.run':
      return planPayroll(ctx, ev, view)
    case 'equity.event':
      return await planEquity(ctx, ev)
    case 'investment.event':
      return await planInvestment(ctx, ev)
    case 'journal.upsert':
      return planJournal(ctx, ev)
    default:
      return []
  }
}

/** Groups lines into one entry per entity, merging nothing (each line keeps its own memo/bucket). */
function entries(ctx: PlanContext, date: string, kind: TxnKind, memo: string | null, pieces: Array<{ entityId: EntityId; lines: PlannedLine[] }>): PlannedEntry[] {
  const byEntity = new Map<EntityId, PlannedLine[]>()
  for (const p of pieces) {
    const list = byEntity.get(p.entityId) ?? []
    list.push(...p.lines)
    byEntity.set(p.entityId, list)
  }
  const out: PlannedEntry[] = []
  for (const [entityId, lines] of byEntity) {
    const nonZero = lines.filter((l) => l.amount.minor !== 0 || (l.baseMinor ?? 0) !== 0)
    if (nonZero.length === 0) continue
    out.push({ entityId, date, kind, memo, lines: nonZero })
  }
  void ctx
  return out
}

function txnMemo(ev: TxnUpsert): string | null {
  return ev.counterparty ?? (ev.rawText ? ev.rawText.slice(0, 140) : null)
}

/** Remainder pieces for an amount classified without links (handles "whose money"). */
function classifiedPieces(ctx: PlanContext, cls: Classification, cashSide: string, minor: number, currency: string, memo: string | null): Array<{ entityId: EntityId; lines: PlannedLine[] }> {
  const payer = ctx.entity
  const bucketId = cls.bucketId
  if (!cls.forEntityId || cls.forEntityId === payer.id) {
    return [{ entityId: payer.id, lines: [line(cashSide, minor, currency, { memo }), line(cls.counterRole, -minor, currency, { bucketId, memo })] }]
  }
  // Whose money: the money moved in the payer's account but the spending/income belongs to `for`.
  const forE = entityOrThrow(ctx, cls.forEntityId)
  // Payer side: cash line, plus a receivable/payable with `for`. Money out → payer is owed (debit).
  const payerInter = interEntityRole(payer, forE, minor < 0)
  // For side: the real counter line, plus the mirror of the payer's position.
  const forInter = interEntityRole(forE, payer, minor > 0)
  let counter = cls.counterRole
  if (counter.startsWith('cash:') || counter.startsWith('card:') || counter.startsWith('processor:') || counter.startsWith('loan:')) {
    throw new PostingError(`Category ${counter} can't be used for another entity's money`)
  }
  if (counter === 'suspense' && minor < 0) counter = 'uncategorized_expense'
  return [
    { entityId: payer.id, lines: [line(cashSide, minor, currency, { memo }), line(payerInter, -minor, currency, { memo })] },
    { entityId: forE.id, lines: [line(forInter, minor, currency, { memo }), line(counter, -minor, currency, { bucketId, memo })] },
  ]
}

function portionOf(total: number, link: Link): number {
  if (!link.amount) return total
  const p = Math.abs(link.amount.minor)
  return total < 0 ? -p : p
}

async function planTxn(ctx: PlanContext, ev: TxnUpsert, view: Basis): Promise<PlannedEntry[]> {
  if (ev.status !== 'posted' || ctx.heldAsCopy) return []
  const account = ctx.account
  if (!account) throw new PostingError('Transaction without a source account')
  const cur = ev.amount.currency
  const cashSide = cashRole(account.id, account.accountType)
  const memo = ctx.rules?.actions.renameTo ?? txnMemo(ev)
  const me = ctx.record.id
  const total = ev.amount.minor
  let remaining = total
  let kind: TxnKind | null = null
  const pieces: Array<{ entityId: EntityId; lines: PlannedLine[] }> = []
  const cls = classifyTxn(ctx, ev)

  for (const { link, other, otherAccount } of ctx.links) {
    if (link.type === 'duplicate' && link.toId === me) return [] // this sighting is the copy
    if (link.type === 'duplicate' || link.type === 'pending_posted') continue
    if (link.type === 'cash_deposit' && link.fromId === me) continue // the cash-in-hand side is unchanged
    const p = portionOf(total, link)
    if (Math.abs(p) > Math.abs(remaining)) throw new PostingError(`Links on ${me} exceed its amount`)
    remaining -= p
    const lines = await linkedLines(ctx, view, link, other, otherAccount, p, cur, memo, cls)
    kind ??= lines.kind
    pieces.push(...lines.pieces.map((pc) => ({ entityId: pc.entityId, lines: [...(pc.entityId === ctx.entity.id && pc.withCash ? [line(cashSide, p, cur, { memo })] : []), ...pc.lines] })))
  }
  if (remaining !== 0) {
    pieces.push(...classifiedPieces(ctx, cls, cashSide, remaining, cur, memo))
    kind ??= cls.kind
  }
  return entries(ctx, ev.date, kind ?? cls.kind, memo, pieces)
}

interface LinkedPieces {
  kind: TxnKind
  /** withCash: prepend this record's cash line for the portion (only on this record's entity). */
  pieces: Array<{ entityId: EntityId; withCash: boolean; lines: PlannedLine[] }>
}

/** Counter lines for the portion `p` of a bank/card/processor row that a confirmed link explains. */
async function linkedLines(
  ctx: PlanContext,
  view: Basis,
  link: Link,
  other: SourceRecord,
  otherAccount: SourceAccountInfo | null,
  p: number,
  cur: string,
  memo: string | null,
  ownCls: Classification,
): Promise<LinkedPieces> {
  const me = ctx.entity
  const one = (role: string, kind: TxnKind, extra: Partial<PlannedLine> = {}): LinkedPieces => ({
    kind,
    pieces: [{ entityId: me.id, withCash: true, lines: [line(role, -p, cur, { memo, ...extra })] }],
  })
  const otherEntity = other.entityId ? ctx.entities.get(other.entityId) ?? null : null

  switch (link.type) {
    case 'transfer':
    case 'card_payment':
    case 'cash_deposit':
    case 'intercompany':
    case 'reimbursement': {
      if (otherEntity && otherEntity.id !== me.id) return crossEntity(ctx, link, otherEntity, p, cur, memo)
      if (link.type === 'cash_deposit' && otherAccount?.accountType === 'cash_on_hand') {
        return one(cashRole(otherAccount.id, otherAccount.accountType), 'transfer')
      }
      const isCard = ctx.account?.accountType === 'credit_card' || otherAccount?.accountType === 'credit_card'
      // Cross-currency: the money-in leg clears transit at the money-out leg's booked value; the difference is realized FX.
      if (p > 0 && other.amount && other.amount.currency !== cur) {
        const outBase = await ctx.baseAt({ minor: Math.abs(other.amount.minor), currency: other.amount.currency }, other.date, me.id, documentFx(other.event))
        return one('clearing_transfers', isCard ? 'card_payment' : 'transfer', { baseMinor: -outBase })
      }
      return one('clearing_transfers', isCard ? 'card_payment' : 'transfer')
    }
    case 'payout':
      return one('clearing_payouts', 'payout')
    case 'equity_cash':
      return one('clearing_equity', 'equity_financing')
    case 'investment_cash':
      return one('clearing_investments', 'other')
    case 'invoice_payment': {
      if (other.event.type === 'payment.applied') return one('clearing_unmatched_receipts', p > 0 ? 'revenue' : 'expense')
      if (other.event.type !== 'invoice.upsert') throw new PostingError(`invoice_payment link to a ${other.event.type}`)
      const inv = other.event
      if (view === 'accrual') {
        const control = inv.direction === 'receivable' ? 'ar' : 'ap'
        // Settle AR/AP at the rate it was booked at; the difference is realized FX (added by the engine).
        const baseMinor = cur === me.baseCurrency ? undefined : -(await ctx.baseAt({ minor: p, currency: cur }, inv.issueDate, me.id, documentFx(inv)))
        return one(control, p > 0 ? 'revenue' : 'expense', baseMinor === undefined ? {} : { baseMinor })
      }
      return { kind: p > 0 ? 'revenue' : 'expense', pieces: [{ entityId: me.id, withCash: true, lines: invoiceCashLines(inv, p, cur, memo, other.id, ctx) }] }
    }
    case 'payroll_settlement': {
      if (other.event.type !== 'payroll.run') throw new PostingError(`payroll_settlement link to a ${other.event.type}`)
      const run = other.event
      const accrued = payrollAccrues(run)
      const text = ctx.record.event.type === 'txn.upsert' ? `${ctx.record.event.counterparty ?? ''} ${ctx.record.event.rawText ?? ''}` : ''
      const role = view === 'accrual' && accrued ? 'payroll_liabilities' : /\btax/i.test(text) ? 'payroll_taxes' : 'payroll_expense'
      return one(role, 'payroll')
    }
    case 'refund': {
      if (other.event.type === 'credit_note.upsert') {
        return one(view === 'accrual' ? 'clearing_unmatched_receipts' : 'refunds', 'refund')
      }
      const oc = await ctx.classify(other)
      const role = oc && oc.counterRole !== 'suspense' ? oc.counterRole : p > 0 ? 'uncategorized_expense' : 'refunds'
      return one(role, 'refund', { bucketId: oc?.bucketId ?? null })
    }
    case 'duplicate':
    case 'pending_posted':
      return { kind: ownCls.kind, pieces: [] }
  }
}

function crossEntity(ctx: PlanContext, link: Link, other: EntityInfo, p: number, cur: string, memo: string | null): LinkedPieces {
  const me = ctx.entity
  const o = ctx.override
  if (me.kind === 'company' && other.kind === 'personal') {
    // Founder money. In: unspecified until the person says loan or investment. Out: repays what the company owes.
    let role: string
    let kind: TxnKind
    if (p > 0) {
      if (o?.kind === 'owner_loan') [role, kind] = [`owner_payable:${other.id}`, 'owner_loan']
      else if (o?.kind === 'owner_contribution') [role, kind] = ['owner_contributions', 'owner_contribution']
      else if (o?.kind === 'equity_financing') [role, kind] = [o.category ?? 'paid_in_capital', 'equity_financing']
      else [role, kind] = ['owner_money_unspecified', 'owner_money_unspecified']
    } else if (o?.kind === 'owner_contribution') {
      ;[role, kind] = ['owner_draws', 'owner_contribution']
    } else {
      ;[role, kind] = [`owner_payable:${other.id}`, link.type === 'reimbursement' ? 'reimbursement' : 'owner_loan']
    }
    return { kind, pieces: [{ entityId: me.id, withCash: true, lines: [line(role, -p, cur, { memo })] }] }
  }
  if (me.kind === 'personal') {
    // The person's side always tracks what the company owes them (or they owe it).
    return { kind: 'intercompany', pieces: [{ entityId: me.id, withCash: true, lines: [line(`due_from:${other.id}`, -p, cur, { memo })] }] }
  }
  return { kind: 'intercompany', pieces: [{ entityId: me.id, withCash: true, lines: [line(interEntityRole(me, other, p < 0), -p, cur, { memo })] }] }
}

function invoiceCashLines(inv: InvoiceUpsert, p: number, cur: string, memo: string | null, invoiceRecordId: string, ctx: PlanContext): PlannedLine[] {
  void invoiceRecordId
  const tax = inv.tax?.minor ?? 0
  const total = inv.total.minor
  if (inv.direction === 'receivable') {
    if (tax > 0 && total > 0) {
      const [rev = 0, taxPart = 0] = allocate(p, [total - tax, tax])
      return [line('revenue', -rev, cur, { memo }), line('sales_tax_payable', -taxPart, cur, { memo })]
    }
    return [line('revenue', -p, cur, { memo })]
  }
  // The whole bill paid: each line's own category (an expense report's travel and meals); part of it: the bill's.
  if (-p === total && total > 0) return billExpenseLines(inv, ctx.override, total, cur, memo)
  const role = invoiceExpenseRole(inv, ctx.override)
  return [line(role, -p, cur, { memo })]
}

function invoiceExpenseRole(inv: InvoiceUpsert, o: RecordOverride | null): string {
  if (o?.category && isFixedRole(o.category)) return o.category
  const first = inv.lines?.[0] as { category?: string } | undefined
  if (first?.category && isFixedRole(first.category) && isExpenseRole(first.category)) return first.category
  return 'uncategorized_expense'
}

async function planProcessor(ctx: PlanContext, ev: ProcessorBalanceTxn, view: Basis): Promise<PlannedEntry[]> {
  const account = ctx.account
  if (!account) throw new PostingError('Processor transaction without a source account')
  const cur = ev.net.currency
  if (ev.gross.currency !== cur || ev.fee.currency !== cur) throw new PostingError('Processor gross, fee and net must share a currency')
  if (ev.gross.minor - ev.fee.minor !== ev.net.minor) {
    throw new PostingError(`Processor txn ${ev.externalId}: gross ${ev.gross.minor} - fee ${ev.fee.minor} != net ${ev.net.minor}`)
  }
  const date = ctx.record.date
  const memo = ev.counterparty ?? ev.customer ?? ev.kind
  const balance = cashRole(account.id, account.accountType)
  const lines: PlannedLine[] = [line(balance, ev.net.minor, cur, { memo }), line('processor_fees', ev.fee.minor, cur, { memo })]
  const gross = ev.gross.minor
  let kind: TxnKind
  const invLink = ctx.links.find((l) => l.link.type === 'invoice_payment' && l.other.event.type === 'invoice.upsert')
  const refundLink = ctx.links.find((l) => l.link.type === 'refund')
  if (invLink && invLink.other.event.type === 'invoice.upsert' && (ev.kind === 'charge' || ev.kind === 'refund')) {
    const inv = invLink.other.event
    kind = gross >= 0 ? 'revenue' : 'refund'
    if (view === 'accrual') {
      const baseMinor = cur === ctx.entity.baseCurrency ? undefined : -(await ctx.baseAt({ minor: gross, currency: cur }, inv.issueDate, ctx.entity.id, documentFx(inv)))
      lines.push(line(inv.direction === 'receivable' ? 'ar' : 'ap', -gross, cur, baseMinor === undefined ? { memo } : { memo, baseMinor }))
    } else {
      lines.push(...invoiceCashLines(inv, gross, cur, memo, invLink.other.id, ctx))
    }
  } else if (refundLink && refundLink.other.event.type === 'credit_note.upsert' && ev.kind === 'refund') {
    kind = 'refund'
    lines.push(line(view === 'accrual' ? 'clearing_unmatched_receipts' : 'refunds', -gross, cur, { memo }))
  } else {
    const byKind: Record<ProcessorBalanceTxn['kind'], [string, TxnKind]> = {
      charge: ['revenue', 'revenue'],
      refund: ['refunds', 'refund'],
      dispute: ['refunds', 'refund'],
      fee: ['processor_fees', 'fee'],
      payout: ['clearing_payouts', 'payout'],
      transfer: ['clearing_transfers', 'transfer'],
      // Tax a processor passes to the merchant (Google Play's Tax rows) is owed to the tax authority, either sign.
      adjustment: ev.salesTax ? ['sales_tax_payable', 'other'] : [gross >= 0 ? 'suspense' : 'uncategorized_expense', 'other'],
      other: [gross >= 0 ? 'suspense' : 'uncategorized_expense', 'other'],
    }
    const [role, k]: [string, TxnKind] = ev.balanceRole ? [ev.balanceRole, 'other'] : byKind[ev.kind]
    kind = k
    lines.push(line(ctx.override?.category ?? role, -gross, cur, { memo, bucketId: ctx.override?.bucketId ?? null }))
  }
  return entries(ctx, date, kind, memo, [{ entityId: ctx.entity.id, lines }])
}

function invoiceIsBooked(inv: InvoiceUpsert): boolean {
  return inv.status !== 'draft' && inv.status !== 'void'
}

function planInvoice(ctx: PlanContext, inv: InvoiceUpsert, view: Basis): PlannedEntry[] {
  if (view === 'cash' || !invoiceIsBooked(inv)) return []
  const cur = inv.total.currency
  const total = inv.total.minor
  const tax = inv.tax?.minor ?? 0
  if (tax < 0 || tax > Math.abs(total)) throw new PostingError(`Invoice ${inv.externalId}: tax ${tax} outside 0..total`)
  const memo = [inv.number, inv.counterparty].filter(Boolean).join(' · ') || null
  const lines: PlannedLine[] = []
  if (inv.direction === 'receivable') {
    lines.push(line('ar', total, cur, { memo }), line('revenue', -(total - tax), cur, { memo }))
    if (tax) lines.push(line('sales_tax_payable', -tax, cur, { memo }))
  } else {
    lines.push(line('ap', -total, cur, { memo }))
    lines.push(...billExpenseLines(inv, ctx.override, total, cur, memo))
  }
  const out = entries(ctx, inv.issueDate, inv.direction === 'receivable' ? 'revenue' : 'expense', memo, [{ entityId: ctx.entity.id, lines }])
  if (inv.status === 'uncollectible') {
    const remaining = total - inv.amountPaid.minor
    if (remaining > 0) {
      const wo = inv.direction === 'receivable'
        ? [line('bad_debt', remaining, cur, { memo }), line('ar', -remaining, cur, { memo })]
        : [line('ap', remaining, cur, { memo }), line('other_income', -remaining, cur, { memo })]
      out.push(...entries(ctx, inv.dueDate ?? inv.issueDate, 'expense', `Written off: ${memo ?? ''}`.trim(), [{ entityId: ctx.entity.id, lines: wo }]))
    }
  }
  return out
}

/** Bill lines: per-line expense roles when lines carry categories and sum to the total; else one line. */
function billExpenseLines(inv: InvoiceUpsert, o: RecordOverride | null, total: number, cur: string, memo: string | null): PlannedLine[] {
  const ls = (inv.lines ?? []) as Array<{ amount: Money; category?: string; tax?: Money }>
  const lineSum = ls.reduce((s, l) => s + l.amount.minor + (l.tax?.minor ?? 0), 0)
  if (!o?.category && ls.length > 0 && lineSum === total && ls.every((l) => l.amount.currency === cur)) {
    return ls.map((l) => {
      // Spending, or something the company now owns or owes less of (inventory, equipment, a prepayment).
      const role = l.category && isFixedRole(l.category) && (isExpenseRole(l.category) || BILL_BALANCE_SHEET_ROLES.includes(l.category)) ? l.category : 'uncategorized_expense'
      return line(role, l.amount.minor + (l.tax?.minor ?? 0), cur, { memo })
    })
  }
  return [line(invoiceExpenseRole(inv, o), total, cur, { memo, bucketId: o?.bucketId ?? null })]
}

async function planPayment(ctx: PlanContext, pay: PaymentApplied, view: Basis): Promise<PlannedEntry[]> {
  // Every payment passes through "not yet seen at the bank"; the bank row clears it when linked.
  const cur = pay.amount.currency
  const memo = pay.counterparty ?? pay.method ?? null
  const receivable = pay.direction === 'receivable'
  const applied = pay.applications.reduce((s, a) => s + a.amount.minor, 0)
  const unapplied = pay.amount.minor - applied
  if (unapplied < 0) throw new PostingError(`Payment ${pay.externalId}: applications exceed the amount`)
  const sign = receivable ? 1 : -1
  const lines: PlannedLine[] = [line('clearing_unmatched_receipts', sign * pay.amount.minor, cur, { memo })]
  if (applied && view === 'accrual') lines.push(line(receivable ? 'ar' : 'ap', -sign * applied, cur, { memo }))
  else if (applied) {
    // Cash basis: what the paid document was for (a bill's expense category, an invoice's revenue and tax), when it's
    // known from the same connection; else plain revenue or uncategorized spending.
    for (const a of pay.applications) {
      const doc = ctx.document && ctx.record.connectionId ? await ctx.document(ctx.record.connectionId, a.invoiceExternalId) : null
      if (doc?.event.type === 'invoice.upsert' && doc.event.total.currency === cur && doc.status !== 'void' && doc.status !== 'excluded') {
        lines.push(...invoiceCashLines(doc.event, sign * a.amount.minor, cur, memo, doc.id, ctx))
      } else lines.push(line(receivable ? 'revenue' : 'uncategorized_expense', -sign * a.amount.minor, cur, { memo }))
    }
  }
  if (unapplied) lines.push(line(receivable ? 'customer_deposits' : 'prepaid', -sign * unapplied, cur, { memo }))
  return entries(ctx, pay.date, receivable ? 'revenue' : 'expense', memo, [{ entityId: ctx.entity.id, lines }])
}

function planCreditNote(ctx: PlanContext, cn: CreditNoteUpsert, view: Basis): PlannedEntry[] {
  if (view === 'cash') return []
  const cur = cn.amount.currency
  const a = cn.amount.minor
  const memo = cn.number ?? null
  const counter =
    cn.appliedTo === 'refund' ? 'clearing_unmatched_receipts' : cn.appliedTo === 'customer_credit' ? 'customer_deposits' : cn.direction === 'receivable' ? 'ar' : 'ap'
  // A customer credit gives back revenue net of sales tax, and the tax itself (as planInvoice credited it).
  const tax = cn.direction === 'receivable' ? (cn.tax?.minor ?? 0) : 0
  if (cn.direction === 'receivable' && cn.tax && (cn.tax.currency !== cur || tax < 0 || tax > Math.abs(a))) {
    throw new PostingError(`Credit note ${cn.externalId}: tax ${tax} ${cn.tax.currency} outside 0..amount`)
  }
  const lines =
    cn.direction === 'receivable'
      ? [line('revenue', a - tax, cur, { memo }), ...(tax ? [line('sales_tax_payable', tax, cur, { memo })] : []), line(counter, -a, cur, { memo })]
      : [line(counter === 'customer_deposits' ? 'prepaid' : counter, a, cur, { memo }), line('uncategorized_expense', -a, cur, { memo })]
  return entries(ctx, cn.date, 'refund', memo, [{ entityId: ctx.entity.id, lines }])
}

export function payrollAccrues(run: PayrollRun): boolean {
  if (run.estimated || run.source === 'bank_detected') return false
  return run.status !== 'scheduled' && run.status !== 'void'
}

function planPayroll(ctx: PlanContext, run: PayrollRun, view: Basis): PlannedEntry[] {
  if (view === 'cash' || !payrollAccrues(run)) return []
  const cur = run.gross.currency
  const memo = `Payroll ${run.payDate}`
  const benefits = run.employerBenefits?.minor ?? 0
  const lines = [
    line('payroll_expense', run.gross.minor, cur, { memo }),
    line('payroll_taxes', run.employerTaxes.minor, cur, { memo }),
    line('payroll_benefits', benefits, cur, { memo }),
    line('payroll_liabilities', -(run.gross.minor + run.employerTaxes.minor + benefits), cur, { memo }),
  ]
  return entries(ctx, run.payDate, 'payroll', memo, [{ entityId: ctx.entity.id, lines }])
}

/** A journal from the books posts as given, on both bases: validation already kept it off money accounts. */
function planJournal(ctx: PlanContext, je: JournalUpsert): PlannedEntry[] {
  const memo = je.memo ?? null
  const lines = je.lines.map((l) => line(l.role, l.amount.minor, l.amount.currency, { memo: l.memo ?? memo }))
  return entries(ctx, je.date, 'other', memo, [{ entityId: ctx.entity.id, lines }])
}

/**
 * Events of one position in the order they happened: by day; on a day, invests first and what ends the position
 * (exit, write-off) last, whatever order they were sent in (Carta sends a day's sales and the closing exit apart);
 * then as added.
 */
const DAY_RANK: Record<InvestmentEvent['kind'], number> = { invest: 0, convert: 1, mark: 1, distribution: 2, write_off: 3, exit: 3 }
export function positionOrder(a: SourceRecord, b: SourceRecord): number {
  const rank = (r: SourceRecord) => (r.event.type === 'investment.event' ? DAY_RANK[r.event.kind] : 2)
  return a.date < b.date ? -1 : a.date > b.date ? 1 : rank(a) - rank(b) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Cost still in a position before `upTo` (exclusive, in positionOrder): invested, less cost returned or written off. */
export function costBefore(events: SourceRecord[], upTo: SourceRecord): number {
  let cost = 0
  for (const r of [...events].sort(positionOrder)) {
    if (r.id === upTo.id || positionOrder(r, upTo) >= 0) break
    if (r.event.type !== 'investment.event') continue
    const a = r.event.amount?.minor ?? 0
    if (r.event.kind === 'invest') cost += a
    else if (r.event.kind === 'distribution') cost -= Math.min(a, cost)
    else if (r.event.kind === 'write_off' || r.event.kind === 'exit') cost = 0
  }
  return cost
}

/**
 * Investments book at cost (contract: InvestmentEvent). invest: Dr the position, Cr money in transit until the bank
 * row is linked (investment_cash). distribution: Dr money in transit; cost back first (Cr the position), the rest is a
 * realized gain. exit: the same, then any cost not recovered is a realized loss; the position ends (an exit with no
 * amount left without money, in kind or transferred: out at cost to the owners, no gain or loss). write_off: the
 * cost left goes to write-offs (not spending: excluded from burn). mark and convert post nothing.
 */
async function planInvestment(ctx: PlanContext, ev: InvestmentEvent): Promise<PlannedEntry[]> {
  if (ev.kind === 'mark' || ev.kind === 'convert') return []
  const siblings = (await ctx.position?.(ctx.entity.id, ev.positionId)) ?? [ctx.record]
  const first = [...siblings].sort(positionOrder).find((r) => r.event.type === 'investment.event' && r.event.kind === 'invest' && r.event.amount)
  const cur = (first?.event as InvestmentEvent | undefined)?.amount?.currency ?? ev.amount?.currency
  if (!cur) return []
  if (ev.amount && ev.amount.currency !== cur) throw new PostingError(`Investment ${ev.positionId} is in ${cur}; this event is in ${ev.amount.currency}`)
  const pos = `investment:${ev.positionId}`
  const memo = `${ev.kind} · ${ev.issuer}`
  const a = ev.amount?.minor ?? 0
  const cost = costBefore(siblings, ctx.record)
  const kind: TxnKind = 'other'
  const out = (lines: PlannedLine[]) => entries(ctx, ev.date, kind, memo, [{ entityId: ctx.entity.id, lines: lines.filter((l) => l.amount.minor !== 0) }])
  // Money paid or received before the bank history we have is inside the opening balances; otherwise it waits in
  // transit for the bank row.
  const start = ctx.links.length === 0 ? ((await ctx.booksStart?.(ctx.entity.id)) ?? null) : null
  const transit = start !== null && ev.date < start ? 'opening_balance_equity' : 'clearing_investments'
  switch (ev.kind) {
    case 'invest':
      return a > 0 ? out([line(pos, a, cur, { memo }), line(transit, -a, cur, { memo })]) : []
    case 'distribution':
    case 'exit': {
      // An exit with no amount left without money (shares distributed in kind, transferred away): out at cost to the
      // owners, no gain or loss.
      if (ev.kind === 'exit' && !ev.amount) return cost > 0 ? out([line('owner_draws', cost, cur, { memo }), line(pos, -cost, cur, { memo })]) : []
      const back = Math.min(a, cost)
      const gain = a - back
      const lost = ev.kind === 'exit' ? cost - back : 0
      if (a === 0 && lost === 0) return []
      return out([line(transit, a, cur, { memo }), line(pos, -(back + lost), cur, { memo }), line('investment_gains', -(gain - lost), cur, { memo })])
    }
    case 'write_off':
      return cost > 0 ? out([line('investment_writeoffs', cost, cur, { memo }), line(pos, -cost, cur, { memo })]) : []
  }
  return []
}

async function planEquity(ctx: PlanContext, eq: EquityEvent): Promise<PlannedEntry[]> {
  if (!eq.amount || eq.amount.minor === 0) return []
  const cur = eq.amount.currency
  const a = eq.amount.minor
  const memo = `${eq.kind} · ${eq.stakeholder}`
  const credit: Partial<Record<EquityEvent['kind'], string>> = {
    issuance: 'paid_in_capital',
    exercise: 'paid_in_capital',
    safe: 'safes',
    convertible_note: 'convertible_notes',
  }
  if (eq.kind === 'conversion') {
    const from = (eq.ocf?.['from'] as string | undefined) === 'convertible_note' ? 'convertible_notes' : 'safes'
    return entries(ctx, eq.date, 'equity_financing', memo, [{ entityId: ctx.entity.id, lines: [line(from, a, cur, { memo }), line('paid_in_capital', -a, cur, { memo })] }])
  }
  const role = credit[eq.kind]
  if (!role) return []
  // Money raised before the bank history we have is already inside the opening balances: no deposit will ever come
  // to match it, so it isn't "in transit". Otherwise it waits in clearing for the bank inflow.
  const start = ctx.links.length === 0 ? ((await ctx.booksStart?.(ctx.entity.id)) ?? null) : null
  const debit = start !== null && eq.date < start ? 'opening_balance_equity' : 'clearing_equity'
  return entries(ctx, eq.date, 'equity_financing', memo, [{ entityId: ctx.entity.id, lines: [line(debit, a, cur, { memo }), line(role, -a, cur, { memo })] }])
}
