// QuickBooks Online entity JSON → normalized events. Pure functions; no I/O.
//
// Credit memos and vendor credits: QBO applies them through a Payment / BillPayment whose lines link both the
// invoices and the credit. We split that into
//   - payment.applied: only the cash part (TotalAmt), applied to the invoices after the credit has been allocated;
//   - credit_note.upsert "<creditId>~<paymentId>": the credit amount consumed by that payment, applied to the
//     same invoices (oldest line first);
//   - credit_note.upsert "<creditId>" from the CreditMemo itself: only its RemainingCredit (still unapplied).
// The three always add up to the credit memo's total, so the ledger sees each dollar once.
import type {
  ConnectionId,
  CreditNoteUpsert,
  Currency,
  Id,
  InvoiceUpsert,
  JournalUpsert,
  LedgerAccountUpsert,
  Money,
  PaymentApplied,
  ReportSnapshot,
} from '@agfn/contracts'
import { isRecord, money, normalizeCurrency, str } from '@agfn/connector-sdk'
import { expenseRoleFor, incomeRoleFor } from '@agfn/invoices'

export type QboObject = Record<string, unknown>

export interface MapContext {
  connectionId: ConnectionId
  homeCurrency: Currency
  rawRef?: Id
  /**
   * Account id → name, classification and QBO AccountType ("Cost of Goods Sold", "Other Expense", "Other Income"…),
   * so each line lands in the P&L section QuickBooks puts it in, and lines on balance-sheet accounts stay out of it.
   */
  accounts?: ReadonlyMap<string, QboAccountInfo>
  /** Item id → type and purchase cost: inventory items are bought into Inventory and cost COGS when sold. */
  items?: ReadonlyMap<string, QboItemInfo>
}

export interface QboItemInfo {
  type: string
  /** QuickBooks tracks quantity and cost from this date: earlier sales cost nothing, earlier purchases are expenses. */
  invStartDate?: string
  /** Per unit, in the home currency's minor units. */
  purchaseCostMinor?: number
  expenseAccount?: { value?: string; name?: string }
}

/** Is this an inventory item QuickBooks tracks on `day`? */
function tracked(item: QboItemInfo | undefined, day: string): boolean {
  return item?.type === 'Inventory' && (!item.invStartDate || day >= item.invStartDate)
}

/** Item rows → the lookup MapContext.items wants. */
export function itemIndex(rows: QboObject[], currency: Currency): Map<string, QboItemInfo> {
  const out = new Map<string, QboItemInfo>()
  for (const o of rows) {
    const id = str(o.Id)
    const type = str(o.Type)
    if (!id || !type) continue
    const info: QboItemInfo = { type }
    const start = date(o.InvStartDate)
    if (start) info.invStartDate = start
    if (typeof o.PurchaseCost === 'number' || typeof o.PurchaseCost === 'string') info.purchaseCostMinor = money(o.PurchaseCost, currency).minor
    const exp = ref(o.ExpenseAccountRef)
    if (exp.value || exp.name) info.expenseAccount = exp
    out.set(id, info)
  }
  return out
}

export interface QboAccountInfo {
  name: string
  classification: LedgerAccountUpsert['classification']
  accountType?: string
  subtype?: string
}

/** Chart-of-accounts rows → the lookup MapContext.accounts wants. */
export function accountIndex(rows: QboObject[]): Map<string, QboAccountInfo> {
  const out = new Map<string, QboAccountInfo>()
  for (const o of rows) {
    const id = str(o.Id)
    const classification = CLASSIFICATION[str(o.Classification) ?? '']
    if (!id || !classification) continue
    const info: QboAccountInfo = { name: str(o.FullyQualifiedName) ?? str(o.Name) ?? id, classification }
    const t = str(o.AccountType)
    if (t) info.accountType = t
    const st = str(o.AccountSubType)
    if (st) info.subtype = st
    out.set(id, info)
  }
  return out
}

type LineSide = 'income' | 'expense'

/**
 * Where a bill or purchase line on a balance-sheet account goes (inventory bought, a truck, a loan paid down), or
 * null when it can't be a bill line at all (bank, card, receivable, payable, equity): those lines stay out.
 */
function balanceSheetRole(info: QboAccountInfo): string | null {
  const t = info.accountType ?? ''
  if (/inventory/i.test(info.subtype ?? '') || /inventory/i.test(info.name)) return 'inventory'
  if (t === 'Fixed Asset') return 'fixed_assets'
  if (t === 'Other Current Asset' || t === 'Other Asset') return /prepaid/i.test(info.subtype ?? info.name) ? 'prepaid' : 'other_assets'
  if (isSalesTaxAccount(info)) return 'sales_tax_payable'
  if (t === 'Other Current Liability' || t === 'Long Term Liability') return 'other_liabilities'
  return null
}

/** A sales tax agency's payable account: a filing paid by hand (a check, an expense, a journal) lowers what's owed. */
const isSalesTaxAccount = (info: QboAccountInfo) => info.subtype === 'SalesTaxPayable' || info.subtype === 'GlobalTaxPayable'

/**
 * The ledger role for one line on account `acct`, or null when that account isn't on the P&L (an asset, liability or
 * equity account: buying equipment, paying down a loan). QBO's account type decides the section; the name only
 * picks the expense category inside "Expenses".
 */
export function lineRole(acct: { value?: string; name?: string }, ctx: MapContext, side: LineSide, itemBased = false): string | null {
  const info = acct.value ? ctx.accounts?.get(acct.value) : undefined
  const name = acct.name ?? info?.name
  if (info && info.classification !== 'income' && info.classification !== 'expense') return side === 'expense' ? balanceSheetRole(info) : null
  const t = info?.accountType
  if (t === 'Cost of Goods Sold') return 'cogs'
  if (t === 'Other Expense') return 'other_expense'
  if (t === 'Other Income') return 'other_income'
  if (info?.classification === 'income' || (!info && side === 'income')) return incomeRoleFor(name)
  if (itemBased && !info) return 'cogs'
  const role = expenseRoleFor(name)
  // A keyword match on "materials" doesn't make an Expense account cost of goods sold; QBO's type said Expense.
  return role === 'cogs' && t === 'Expense' ? 'other_expense' : role
}

function base(ctx: MapContext, externalId: string): { externalId: string; connectionId: ConnectionId; rawRef?: Id } {
  return ctx.rawRef === undefined ? { externalId, connectionId: ctx.connectionId } : { externalId, connectionId: ctx.connectionId, rawRef: ctx.rawRef }
}

function ref(o: unknown): { value?: string; name?: string } {
  if (!isRecord(o)) return {}
  const out: { value?: string; name?: string } = {}
  const v = str(o.value)
  const n = str(o.name)
  if (v !== undefined) out.value = v
  if (n !== undefined) out.name = n
  return out
}

function currencyOf(o: QboObject, ctx: MapContext): Currency {
  return normalizeCurrency(ref(o.CurrencyRef).value, ctx.homeCurrency)
}

function amt(v: unknown, currency: Currency): Money {
  if (v === undefined || v === null || v === '') return { minor: 0, currency }
  if (typeof v !== 'number' && typeof v !== 'string') return { minor: 0, currency }
  return money(v, currency)
}

function date(v: unknown): string | undefined {
  const s = str(v)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

function lines(o: QboObject): QboObject[] {
  return Array.isArray(o.Line) ? (o.Line.filter(isRecord) as QboObject[]) : []
}

function linked(line: QboObject): Array<{ id: string; type: string }> {
  const l = Array.isArray(line.LinkedTxn) ? line.LinkedTxn.filter(isRecord) : []
  return l.flatMap((t) => {
    const id = str(t.TxnId)
    const type = str(t.TxnType)
    return id && type ? [{ id, type }] : []
  })
}

function isVoided(o: QboObject): boolean {
  // QBO voids zero the amounts and stamp the private note; there is no status field.
  const total = Number(o.TotalAmt ?? 0)
  return total === 0 && /\bvoided\b/i.test(str(o.PrivateNote) ?? '')
}

// ---------- chart of accounts ----------

const CLASSIFICATION: Record<string, LedgerAccountUpsert['classification']> = {
  Asset: 'asset',
  Liability: 'liability',
  Equity: 'equity',
  Revenue: 'income',
  Expense: 'expense',
}

export function mapAccount(o: QboObject, ctx: MapContext): LedgerAccountUpsert | null {
  const id = str(o.Id)
  const classification = CLASSIFICATION[str(o.Classification) ?? '']
  if (!id || !classification) return null
  const e: LedgerAccountUpsert = {
    type: 'ledger_account.upsert',
    ...base(ctx, id),
    name: str(o.FullyQualifiedName) ?? str(o.Name) ?? id,
    classification,
    active: o.Active !== false,
  }
  const code = str(o.AcctNum)
  if (code) e.code = code
  const subtype = str(o.AccountSubType) ?? str(o.AccountType)
  if (subtype) e.subtype = subtype
  const cur = ref(o.CurrencyRef).value
  if (cur) e.currency = normalizeCurrency(cur, ctx.homeCurrency)
  return e
}

// ---------- invoices and bills ----------

function docStatus(total: Money, balance: Money, voided: boolean): InvoiceUpsert['status'] {
  if (voided) return 'void'
  if (balance.minor <= 0 && total.minor > 0) return 'paid'
  if (balance.minor < total.minor) return 'partially_paid'
  return 'open'
}

export function mapInvoice(o: QboObject, ctx: MapContext): InvoiceUpsert | null {
  return mapDoc(o, ctx, 'receivable')
}

/** An invoice plus, when it sells inventory items, their cost moving from Inventory to COGS ("cogs:<id>"). */
export function mapInvoiceEvents(o: QboObject, ctx: MapContext): Array<InvoiceUpsert | JournalUpsert> {
  const doc = mapDoc(o, ctx, 'receivable')
  return doc ? [doc, ...cogsOfSale(doc.externalId, o, ctx, doc.issueDate, doc.status === 'void')] : []
}

/**
 * Cost of inventory items sold on a sales document: quantity × the item's purchase cost, debit COGS, credit
 * Inventory, on the sale's date. QuickBooks values inventory FIFO; the purchase cost equals it while an item's
 * cost doesn't change.
 */
export function cogsOfSale(docId: string, o: QboObject, ctx: MapContext, day: string, voided: boolean): JournalUpsert[] {
  let cost = 0
  for (const l of lines(o)) {
    if (str(l.DetailType) !== 'SalesItemLineDetail') continue
    const d = isRecord(l.SalesItemLineDetail) ? (l.SalesItemLineDetail as QboObject) : {}
    const item = ctx.items?.get(ref(d.ItemRef).value ?? '')
    if (!tracked(item, day) || !item?.purchaseCostMinor) continue
    const qty = typeof d.Qty === 'number' ? d.Qty : Number(d.Qty ?? 0)
    cost += Math.round(qty * item.purchaseCostMinor)
  }
  if (!cost) return []
  const currency = currencyOf(o, ctx)
  return [
    {
      type: 'journal.upsert',
      ...base(ctx, `cogs:${docId}`),
      date: day,
      memo: `Cost of items sold${str(o.DocNumber) ? ` · ${str(o.DocNumber)}` : ''}`,
      status: voided ? 'void' : 'posted',
      lines: [
        { role: 'cogs', amount: { minor: cost, currency } },
        { role: 'inventory', amount: { minor: -cost, currency } },
      ],
    },
  ]
}

export function mapBill(o: QboObject, ctx: MapContext): InvoiceUpsert | null {
  return mapDoc(o, ctx, 'payable')
}

/**
 * A bill plus, when some of its lines are booked to an income account (QuickBooks then reports them as less income),
 * a customer-side credit "<id>~income" for those lines.
 */
export function mapBillEvents(o: QboObject, ctx: MapContext): Array<InvoiceUpsert | CreditNoteUpsert> {
  const parts = docParts(o, ctx, 'payable')
  if (!parts) return []
  return [parts.doc, ...incomeContra(parts, ctx)]
}

function incomeContra(parts: { doc: InvoiceUpsert; contraIncome: number }, ctx: MapContext): CreditNoteUpsert[] {
  if (!parts.contraIncome) return []
  const d = parts.doc
  const e: CreditNoteUpsert = {
    type: 'credit_note.upsert',
    ...base(ctx, `${d.externalId}~income`),
    direction: 'receivable',
    date: d.issueDate,
    amount: { minor: parts.contraIncome, currency: d.total.currency },
    // Money out like the purchase itself: it clears with the same bank row ("not yet seen at the bank").
    appliedTo: 'refund',
    status: d.status === 'void' ? 'void' : 'applied',
    applications: [],
    counterparty: d.counterparty,
  }
  if (d.number) e.number = d.number
  return [e]
}

function mapDoc(o: QboObject, ctx: MapContext, direction: 'receivable' | 'payable'): InvoiceUpsert | null {
  return docParts(o, ctx, direction)?.doc ?? null
}

function docParts(o: QboObject, ctx: MapContext, direction: 'receivable' | 'payable'): { doc: InvoiceUpsert; contraIncome: number } | null {
  const id = str(o.Id)
  const issueDate = date(o.TxnDate)
  if (!id || !issueDate) return null
  const cur = currencyOf(o, ctx)
  const total = amt(o.TotalAmt, cur)
  const balance = amt(o.Balance, cur)
  const voided = isVoided(o)
  const party = ref(direction === 'receivable' ? o.CustomerRef : o.VendorRef)
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, id),
    direction,
    counterparty: party.name ?? (direction === 'receivable' ? 'Unknown customer' : 'Unknown vendor'),
    issueDate,
    total,
    amountPaid: { minor: Math.max(0, total.minor - balance.minor), currency: cur },
    status: docStatus(total, balance, voided),
  }
  const number = str(o.DocNumber)
  if (number) e.number = number
  const due = date(o.DueDate)
  if (due) e.dueDate = due
  const taxDetail = isRecord(o.TxnTaxDetail) ? o.TxnTaxDetail : undefined
  if (taxDetail && taxDetail.TotalTax !== undefined) {
    e.tax = amt(taxDetail.TotalTax, cur)
    e.subtotal = { minor: total.minor - e.tax.minor, currency: cur }
  }
  const out: NonNullable<InvoiceUpsert['lines']> = []
  let offBooks = 0
  let contraIncome = 0
  for (const l of lines(o)) {
    const kind = str(l.DetailType)
    if (!kind || kind === 'SubTotalLineDetail' || kind === 'DescriptionOnly') continue
    const detail = isRecord(l[kind]) ? (l[kind] as QboObject) : {}
    const line: NonNullable<InvoiceUpsert['lines']>[number] = {
      description: str(l.Description) ?? ref(detail.ItemRef).name ?? ref(detail.AccountRef).name ?? kind.replace(/LineDetail$/, ''),
      amount: amt(kind === 'DiscountLineDetail' ? -Math.abs(Number(l.Amount ?? 0)) : l.Amount, cur),
    }
    const qty = detail.Qty
    if (typeof qty === 'number') line.quantity = qty
    if (direction === 'receivable') {
      const acct = ref(detail.ItemAccountRef)
      line.category = acct.value || acct.name ? (lineRole(acct, ctx, 'income') ?? 'revenue') : incomeRoleFor(ref(detail.ItemRef).name)
    } else {
      const itemBased = kind === 'ItemBasedExpenseLineDetail'
      const item = itemBased ? ctx.items?.get(ref(detail.ItemRef).value ?? '') : undefined
      // Item lines: an inventory item is bought into Inventory (it costs COGS when it sells); any other item books to
      // its expense account.
      const acct = itemBased && !ref(detail.AccountRef).value && item?.expenseAccount ? item.expenseAccount : ref(detail.AccountRef)
      const role = tracked(item, issueDate) ? 'inventory' : lineRole(acct, ctx, 'expense', itemBased)
      line.category = role ?? (itemBased ? 'cogs' : 'uncategorized_expense')
      const onIncome = acct.value !== undefined && ctx.accounts?.get(acct.value)?.classification === 'income'
      if (onIncome) contraIncome += line.amount.minor
      else if (role === null && !(itemBased && !acct.value)) offBooks += line.amount.minor
      else out.push(line)
      continue
    }
    out.push(line)
  }
  if (out.length) e.lines = out
  // Lines that can't be on a bill (bank, card, equity accounts) stay out, and lines on income accounts become a
  // separate credit against income: the document covers the rest.
  const moved = offBooks + contraIncome
  if (moved) {
    e.total = { minor: e.total.minor - moved, currency: cur }
    e.amountPaid = { minor: Math.max(0, Math.min(e.total.minor, e.amountPaid.minor - moved)), currency: cur }
  }
  return { doc: e, contraIncome }
}

// ---------- payments and credits ----------

export interface PaymentMapping {
  payment: PaymentApplied
  /** Portions of credit memos / vendor credits consumed by this payment ("<creditId>~<paymentId>"). */
  creditPortions: CreditNoteUpsert[]
}

/** Payment (received) or BillPayment (made). */
export function mapPayment(o: QboObject, ctx: MapContext, direction: 'receivable' | 'payable'): PaymentMapping | null {
  const id = str(o.Id)
  const day = date(o.TxnDate)
  if (!id || !day) return null
  const cur = currencyOf(o, ctx)
  const docType = direction === 'receivable' ? 'Invoice' : 'Bill'
  const creditType = direction === 'receivable' ? 'CreditMemo' : 'VendorCredit'

  // Line amounts per linked document, in line order.
  const docs: Array<{ id: string; amount: Money }> = []
  const credits: Array<{ id: string; amount: Money }> = []
  for (const l of lines(o)) {
    const a = amt(l.Amount, cur)
    for (const t of linked(l)) {
      if (t.type === docType) docs.push({ id: t.id, amount: a })
      else if (t.type === creditType) credits.push({ id: t.id, amount: a })
      // JournalEntry / Deposit links are rare; they stay in unapplied.
    }
  }
  const total = amt(o.TotalAmt, cur)
  const party = ref(direction === 'receivable' ? o.CustomerRef : o.VendorRef)

  // Allocate each credit to the documents in order; what's left of each document is paid in cash.
  const remainingDoc = docs.map((d) => d.amount.minor)
  const creditPortions: CreditNoteUpsert[] = []
  for (const c of credits) {
    let left = c.amount.minor
    const apps: Array<{ invoiceExternalId: string; amount: Money }> = []
    for (let i = 0; i < docs.length && left > 0; i++) {
      const take = Math.min(left, remainingDoc[i] as number)
      if (take <= 0) continue
      remainingDoc[i] = (remainingDoc[i] as number) - take
      left -= take
      apps.push({ invoiceExternalId: (docs[i] as { id: string }).id, amount: { minor: take, currency: cur } })
    }
    const portion: CreditNoteUpsert = {
      type: 'credit_note.upsert',
      ...base(ctx, `${c.id}~${id}`),
      direction,
      date: day,
      amount: c.amount,
      appliedTo: 'invoice',
      status: 'applied',
      applications: apps,
    }
    if (apps[0]) portion.invoiceExternalId = apps[0].invoiceExternalId
    if (party.name) portion.counterparty = party.name
    creditPortions.push(portion)
  }

  const applications = docs
    .map((d, i) => ({ invoiceExternalId: d.id, amount: { minor: remainingDoc[i] as number, currency: cur } }))
    .filter((a) => a.amount.minor > 0)
  const applied = applications.reduce((s, a) => s + a.amount.minor, 0)
  // QBO's UnappliedAmt can be absent; derive it so applications + unapplied = amount always holds.
  const unappliedMinor = total.minor - applied
  const payment: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, id),
    direction,
    date: day,
    amount: total,
    applications: unappliedMinor >= 0 ? applications : scaleDown(applications, total),
    status: isVoided(o) ? 'void' : 'posted',
  }
  if (unappliedMinor > 0) payment.unapplied = { minor: unappliedMinor, currency: cur }
  if (party.name) payment.counterparty = party.name
  const refNum = str(o.PaymentRefNum) ?? str(o.DocNumber)
  if (refNum) payment.reference = refNum
  const method = ref(o.PaymentMethodRef).name ?? str(o.PayType)
  if (method) payment.method = method
  return { payment, creditPortions }
}

/** Defensive: if QBO lines exceed the payment total (shouldn't happen), trim the last applications to fit. */
function scaleDown(apps: PaymentApplied['applications'], total: Money): PaymentApplied['applications'] {
  let left = total.minor
  return apps.flatMap((a) => {
    const take = Math.min(left, a.amount.minor)
    left -= take
    return take > 0 ? [{ invoiceExternalId: a.invoiceExternalId, amount: { minor: take, currency: a.amount.currency } }] : []
  })
}

/** CreditMemo (receivable) or VendorCredit (payable): only the still-unapplied remainder. */
export function mapCredit(o: QboObject, ctx: MapContext, direction: 'receivable' | 'payable'): CreditNoteUpsert | null {
  const id = str(o.Id)
  const day = date(o.TxnDate)
  if (!id || !day) return null
  const cur = currencyOf(o, ctx)
  const total = amt(o.TotalAmt, cur)
  // VendorCredit has Balance; CreditMemo has RemainingCredit (Balance is also present on newer minor versions).
  const remaining = o.RemainingCredit !== undefined ? amt(o.RemainingCredit, cur) : o.Balance !== undefined ? amt(o.Balance, cur) : total
  const party = ref(direction === 'receivable' ? o.CustomerRef : o.VendorRef)
  const e: CreditNoteUpsert = {
    type: 'credit_note.upsert',
    ...base(ctx, id),
    direction,
    date: day,
    amount: remaining,
    appliedTo: 'customer_credit',
    status: isVoided(o) ? 'void' : remaining.minor === 0 ? 'applied' : 'open',
    applications: [],
  }
  const number = str(o.DocNumber)
  if (number) e.number = number
  if (party.name) e.counterparty = party.name
  return e
}

// ---------- money that moved without an invoice or bill ----------
//
// Purchase (expense, check, card charge), SalesReceipt, RefundReceipt and Deposit are on QuickBooks' P&L but have no
// separate document and payment. Each becomes the pair the books already understand, under its own id space
// ("purchase:<Id>", "salesreceipt:<Id>", …) so it can't collide with a Bill or Invoice of the same number:
//   Purchase      → a paid bill + its payment (a card credit, Credit=true, → a vendor credit refunded);
//   SalesReceipt  → a paid invoice + its payment;
//   RefundReceipt → a customer refund (credit note, refund);
//   Deposit       → the lines not linked to a received Payment: income lines as a paid invoice + its payment,
//                   expense lines (e.g. a fee taken out) as a vendor credit. Linked lines are payments already counted.
// The payment passes through "not yet seen at the bank" like any other, so a bank feed of the same money links to it
// instead of counting it again.

export type CashEntity = 'Purchase' | 'SalesReceipt' | 'RefundReceipt' | 'Deposit'
export const CASH_ENTITIES: readonly CashEntity[] = ['Purchase', 'SalesReceipt', 'RefundReceipt', 'Deposit']
const CASH_PREFIX: Record<CashEntity, string> = { Purchase: 'purchase', SalesReceipt: 'salesreceipt', RefundReceipt: 'refundreceipt', Deposit: 'deposit' }
export const cashId = (entity: CashEntity, id: string) => `${CASH_PREFIX[entity]}:${id}`

type CashEvent = InvoiceUpsert | PaymentApplied | CreditNoteUpsert | JournalUpsert

function paidPair(doc: InvoiceUpsert, ctx: MapContext, method: string | undefined): CashEvent[] {
  if (doc.total.minor <= 0) return doc.total.minor === 0 && doc.status !== 'void' ? [] : [doc]
  const pay: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, doc.externalId),
    direction: doc.direction,
    date: doc.issueDate,
    amount: doc.total,
    applications: [{ invoiceExternalId: doc.externalId, amount: doc.total }],
    counterparty: doc.counterparty,
    status: doc.status === 'void' ? 'void' : 'posted',
  }
  if (doc.number) pay.reference = doc.number
  if (method) pay.method = method
  return [{ ...doc, status: doc.status === 'void' ? 'void' : 'paid', amountPaid: doc.status === 'void' ? doc.amountPaid : doc.total }, pay]
}

function refundNote(id: string, direction: 'receivable' | 'payable', day: string, amount: Money, party: string | undefined, number: string | undefined, voided: boolean, ctx: MapContext): CreditNoteUpsert {
  const e: CreditNoteUpsert = { type: 'credit_note.upsert', ...base(ctx, id), direction, date: day, amount, appliedTo: 'refund', status: voided ? 'void' : 'applied', applications: [] }
  if (party) e.counterparty = party
  if (number) e.number = number
  return e
}

export function mapCashEntity(entity: CashEntity, o: QboObject, ctx: MapContext): CashEvent[] {
  const id = str(o.Id)
  const day = date(o.TxnDate)
  if (!id || !day) return []
  const xid = cashId(entity, id)
  const cur = currencyOf(o, ctx)
  const voided = isVoided(o)
  const number = str(o.DocNumber)
  switch (entity) {
    case 'Purchase': {
      const party = ref(o.EntityRef).name
      const parts = docParts({ ...o, Id: xid, VendorRef: o.EntityRef, Balance: 0 }, ctx, 'payable')
      if (!parts) return []
      const doc = parts.doc
      if (o.Credit === true) {
        // A card refund or credit from the vendor: less spending. (A credit on an income account is rare; not mapped.)
        return doc.total.minor > 0 ? [refundNote(xid, 'payable', day, doc.total, party, number, voided, ctx)] : []
      }
      return [...paidPair(doc, ctx, str(o.PaymentType)), ...incomeContra(parts, ctx)]
    }
    case 'SalesReceipt': {
      const doc = mapDoc({ ...o, Id: xid, Balance: 0 }, ctx, 'receivable')
      return doc ? [...paidPair(doc, ctx, ref(o.PaymentMethodRef).name), ...cogsOfSale(xid, o, ctx, day, voided)] : []
    }
    case 'RefundReceipt': {
      const doc = mapDoc({ ...o, Id: xid, Balance: 0 }, ctx, 'receivable')
      if (!doc) return []
      if (doc.total.minor <= 0) return []
      // What left the bank, tax included: the books take the tax off what's owed, the rest off revenue.
      const note = refundNote(xid, 'receivable', day, doc.total, ref(o.CustomerRef).name, number, voided, ctx)
      return [doc.tax?.minor ? { ...note, tax: doc.tax } : note]
    }
    case 'Deposit': {
      let income = 0
      let expense = 0
      const docLines: NonNullable<InvoiceUpsert['lines']> = []
      const fees: NonNullable<InvoiceUpsert['lines']> = []
      for (const l of lines(o)) {
        if (linked(l).length) continue
        const detail = isRecord(l.DepositLineDetail) ? (l.DepositLineDetail as QboObject) : {}
        const acct = ref(detail.AccountRef)
        const role = lineRole(acct, ctx, 'income')
        if (!role) continue
        const a = amt(l.Amount, cur)
        const info = acct.value ? ctx.accounts?.get(acct.value) : undefined
        if (info?.classification === 'expense') {
          // Negative = a fee taken out of the deposit (spending); positive = money back on an expense.
          if (a.minor < 0) fees.push({ description: str(l.Description) ?? acct.name ?? info.name, amount: { minor: -a.minor, currency: cur }, category: role })
          else expense += a.minor
        } else {
          income += a.minor
          docLines.push({ description: str(l.Description) ?? acct.name ?? info?.name ?? 'Deposit', amount: a, category: role })
        }
      }
      const out: CashEvent[] = []
      // Deposit has no payer of its own: it's on each line (DepositLineDetail.Entity).
      const from = ref(o.EntityRef).name ?? lines(o).map((l) => (isRecord(l.DepositLineDetail) ? ref((l.DepositLineDetail as QboObject).Entity).name : undefined)).find(Boolean)
      if (income) {
        const doc: InvoiceUpsert = {
          type: 'invoice.upsert',
          ...base(ctx, xid),
          direction: 'receivable',
          counterparty: from ?? 'Deposit',
          issueDate: day,
          total: { minor: income, currency: cur },
          amountPaid: { minor: 0, currency: cur },
          status: voided ? 'void' : 'open',
          lines: docLines,
        }
        if (number) doc.number = number
        out.push(...paidPair(doc, ctx, undefined))
      }
      if (fees.length) {
        const total = fees.reduce((t, f) => t + f.amount.minor, 0)
        const fee: InvoiceUpsert = { type: 'invoice.upsert', ...base(ctx, `${xid}~fee`), direction: 'payable', counterparty: from ?? 'Deposit fees', issueDate: day, total: { minor: total, currency: cur }, amountPaid: { minor: 0, currency: cur }, status: voided ? 'void' : 'open', lines: fees }
        out.push(...paidPair(fee, ctx, undefined))
      }
      if (expense) out.push(refundNote(`${xid}~expense`, 'payable', day, { minor: expense, currency: cur }, from, number, voided, ctx))
      return out
    }
  }
}

/**
 * Sales tax paid from QuickBooks' US sales tax centre. The API lists no object for it (TaxPayment is non-US only), so
 * these come from the TransactionList report's "Sales Tax Payment" rows: owed goes down, through "not yet seen at the
 * bank" like a bill paid. QuickBooks shows a payment as a positive amount; a row of any other sign isn't posted, and is
 * counted so the sync can say so rather than guess.
 */
export function mapSalesTaxPayments(report: QboObject, ctx: MapContext): { events: CashEvent[]; unposted: number } {
  const cols = isRecord(report.Columns) && Array.isArray(report.Columns.Column) ? report.Columns.Column.filter(isRecord) : []
  const key = (c: QboObject) => (Array.isArray(c.MetaData) ? c.MetaData.filter(isRecord).find((m) => m.Name === 'ColKey')?.Value : undefined)
  const at = (k: string) => cols.findIndex((c) => key(c) === k)
  const [iDate, iType, iAmount, iMemo, iNoPost] = ['tx_date', 'txn_type', 'subt_nat_amount', 'memo', 'is_no_post'].map(at) as [number, number, number, number, number]
  const rows = isRecord(report.Rows) && Array.isArray(report.Rows.Row) ? report.Rows.Row.filter(isRecord) : []
  const out: CashEvent[] = []
  let unposted = 0
  if (iDate < 0 || iType < 0 || iAmount < 0) return { events: out, unposted }
  for (const r of rows) {
    const cd = Array.isArray(r.ColData) ? r.ColData.filter(isRecord) : []
    if (str(cd[iType]?.value) !== 'Sales Tax Payment' || (iNoPost >= 0 && str(cd[iNoPost]?.value) === 'Yes')) continue
    const id = str(cd[iType]?.id)
    const day = date(cd[iDate]?.value)
    const a = amt(cd[iAmount]?.value, ctx.homeCurrency)
    if (!id || !day || a.minor <= 0) {
      unposted++
      continue
    }
    const doc: InvoiceUpsert = {
      type: 'invoice.upsert',
      ...base(ctx, `salestaxpayment:${id}`),
      direction: 'payable',
      counterparty: 'Sales tax',
      issueDate: day,
      total: a,
      amountPaid: { minor: 0, currency: a.currency },
      status: 'open',
      lines: [{ description: (iMemo >= 0 && str(cd[iMemo]?.value)) || 'Sales tax payment', amount: a, category: 'sales_tax_payable' }],
    }
    out.push(...paidPair(doc, ctx, undefined))
  }
  return { events: out, unposted }
}

/**
 * A manual JournalEntry (depreciation, accruals, payroll postings) → journal.upsert, debits + and credits −. Only
 * journals that touch the P&L are kept, like Xero's manual journals: lines on P&L accounts keep their section, and
 * whatever sits on balance-sheet accounts is one balancing line, so the journal still sums to zero.
 */
export function mapJournalEntry(o: QboObject, ctx: MapContext): JournalUpsert | null {
  const id = str(o.Id)
  const day = date(o.TxnDate)
  if (!id || !day) return null
  const cur = currencyOf(o, ctx)
  const out: JournalUpsert['lines'] = []
  let rest = 0
  let tax = 0
  for (const l of lines(o)) {
    if (str(l.DetailType) !== 'JournalEntryLineDetail' || !isRecord(l.JournalEntryLineDetail)) continue
    const d = l.JournalEntryLineDetail as QboObject
    const a = amt(l.Amount, cur)
    if (!a.minor) continue
    const signed = str(d.PostingType) === 'Credit' ? -Math.abs(a.minor) : Math.abs(a.minor)
    const acct = ref(d.AccountRef)
    const info = acct.value ? ctx.accounts?.get(acct.value) : undefined
    const onPnl = info ? info.classification === 'income' || info.classification === 'expense' : false
    const role = onPnl ? lineRole(acct, ctx, info!.classification === 'income' ? 'income' : 'expense') : null
    if (role) out.push({ role, amount: { minor: signed, currency: cur }, ...(str(l.Description) ? { memo: str(l.Description)!.slice(0, 140) } : {}), ...(acct.value ? { accountExternalId: acct.value } : {}) })
    else if (info && isSalesTaxAccount(info)) tax += signed
    else rest += signed
  }
  if (!out.length) return null
  if (tax) out.push({ role: 'sales_tax_payable', amount: { minor: tax, currency: cur }, memo: 'Sales tax in QuickBooks' })
  if (rest) out.push({ role: rest > 0 ? 'other_assets' : 'other_liabilities', amount: { minor: rest, currency: cur }, memo: 'Balance sheet side in QuickBooks' })
  const e: JournalUpsert = { type: 'journal.upsert', ...base(ctx, `je:${id}`), date: day, status: 'posted', lines: out }
  const memo = str(o.PrivateNote)
  if (memo) e.memo = memo.slice(0, 200)
  return e
}

/** A deleted JournalEntry: its journal stops counting. */
export function deletedJournal(id: string, ctx: MapContext, day: string): JournalUpsert {
  const zero = { minor: 0, currency: ctx.homeCurrency }
  return { type: 'journal.upsert', ...base(ctx, `je:${id}`), date: day, status: 'void', lines: [{ role: 'other_expense', amount: zero }, { role: 'other_assets', amount: zero }] }
}

/** Takes a sale's cost-of-items journal out (the sale was deleted). */
export function voidCogs(docId: string, ctx: MapContext, day: string): JournalUpsert {
  const zero = { minor: 0, currency: ctx.homeCurrency }
  return { type: 'journal.upsert', ...base(ctx, `cogs:${docId}`), date: day, status: 'void', lines: [{ role: 'cogs', amount: zero }, { role: 'inventory', amount: zero }] }
}

/** A deleted Purchase, SalesReceipt, RefundReceipt or Deposit: void everything it produced. */
export function deletedCashEvents(entity: CashEntity, id: string, ctx: MapContext, day: string): CashEvent[] {
  const xid = cashId(entity, id)
  const zero = { minor: 0, currency: ctx.homeCurrency }
  const direction = entity === 'Purchase' ? 'payable' : 'receivable'
  const doc: InvoiceUpsert = { type: 'invoice.upsert', ...base(ctx, xid), direction, counterparty: 'Deleted in QuickBooks', issueDate: day, total: zero, amountPaid: zero, status: 'void' }
  const pay: PaymentApplied = { type: 'payment.applied', ...base(ctx, xid), direction, date: day, amount: zero, applications: [], status: 'void' }
  const note = (x: string, d: 'receivable' | 'payable'): CreditNoteUpsert => ({ type: 'credit_note.upsert', ...base(ctx, x), direction: d, date: day, amount: zero, appliedTo: 'refund', status: 'void' })
  switch (entity) {
    case 'Purchase':
      return [doc, pay, note(xid, 'payable')]
    case 'SalesReceipt':
      return [doc, pay, voidCogs(xid, ctx, day)]
    case 'RefundReceipt':
      return [note(xid, 'receivable')]
    case 'Deposit': {
      const fee = { ...base(ctx, `${xid}~fee`) }
      return [doc, pay, { ...doc, ...fee, direction: 'payable' }, { ...pay, ...fee, direction: 'payable' }, note(`${xid}~expense`, 'payable')]
    }
  }
}

// ---------- deletions (CDC) ----------

export function deletedEvent(
  entity: string,
  id: string,
  ctx: MapContext,
  issueDate: string,
): InvoiceUpsert | PaymentApplied | CreditNoteUpsert | null {
  const zero = { minor: 0, currency: ctx.homeCurrency }
  switch (entity) {
    case 'Invoice':
    case 'Bill':
      return {
        type: 'invoice.upsert',
        ...base(ctx, id),
        direction: entity === 'Invoice' ? 'receivable' : 'payable',
        counterparty: 'Deleted in QuickBooks',
        issueDate,
        total: zero,
        amountPaid: zero,
        status: 'void',
      }
    case 'Payment':
    case 'BillPayment':
      return {
        type: 'payment.applied',
        ...base(ctx, id),
        direction: entity === 'Payment' ? 'receivable' : 'payable',
        date: issueDate,
        amount: zero,
        applications: [],
        status: 'void',
      }
    case 'CreditMemo':
    case 'VendorCredit':
      return {
        type: 'credit_note.upsert',
        ...base(ctx, id),
        direction: entity === 'CreditMemo' ? 'receivable' : 'payable',
        date: issueDate,
        amount: zero,
        appliedTo: 'customer_credit',
        status: 'void',
      }
  }
  return null
}

// ---------- reports ----------

/** ProfitAndLoss report JSON → report.snapshot (the "Books" view). Keeps sections and depth. */
export function mapProfitAndLoss(
  report: QboObject,
  ctx: MapContext,
  period: { from: string; to: string; basis: 'cash' | 'accrual' },
): ReportSnapshot {
  const header = isRecord(report.Header) ? report.Header : {}
  const cur = normalizeCurrency(str(header.Currency), ctx.homeCurrency)
  const rows: ReportSnapshot['rows'] = []
  // The amount is the last Money column. A period with no activity comes back with the Account column alone, and its
  // summary rows then carry only their labels ("Total Income"): no amounts, so no rows and no totals.
  const columns = isRecord(report.Columns) && Array.isArray(report.Columns.Column) ? report.Columns.Column.filter(isRecord) : undefined
  const at = columns ? columns.map((c) => str(c.ColType)).lastIndexOf('Money') : -2
  const amountOf = (cols: unknown[]): string | undefined => {
    const i = at === -2 ? cols.length - 1 : at
    const c = i > 0 ? cols[i] : undefined
    return isRecord(c) ? str(c.value) : undefined
  }
  const walk = (node: unknown, section: string, depth: number): void => {
    const list = isRecord(node) && Array.isArray(node.Row) ? node.Row.filter(isRecord) : []
    for (const r of list) {
      const hdr = isRecord(r.Header) && Array.isArray(r.Header.ColData) ? r.Header.ColData : undefined
      const sec = (hdr && isRecord(hdr[0]) ? str(hdr[0].value) : undefined) || str(r.group) || section
      if (Array.isArray(r.ColData)) pushCols(r.ColData, section, depth)
      if (isRecord(r.Rows)) walk(r.Rows, depth === 0 ? sec : section, depth + 1)
      if (isRecord(r.Summary) && Array.isArray(r.Summary.ColData)) pushCols(r.Summary.ColData, depth === 0 ? sec : section, depth)
    }
  }
  const pushCols = (cols: unknown[], section: string, depth: number): void => {
    const name = isRecord(cols[0]) ? str(cols[0].value) : undefined
    const value = amountOf(cols)
    if (!name || value === undefined || value === '') return
    const row: ReportSnapshot['rows'][number] = { account: name, amount: money(value, cur), section, depth }
    const id = isRecord(cols[0]) ? str(cols[0].id) : undefined
    if (id) row.accountExternalId = id
    rows.push(row)
  }
  walk(report.Rows, '', 0)
  // QuickBooks' own summary rows (group Income, COGS, Expenses, OtherIncome, OtherExpenses, NetIncome).
  const sums: Record<string, Money> = {}
  for (const r of isRecord(report.Rows) && Array.isArray(report.Rows.Row) ? report.Rows.Row.filter(isRecord) : []) {
    const g = str(r.group)
    const cols = isRecord(r.Summary) && Array.isArray(r.Summary.ColData) ? r.Summary.ColData : []
    const v = amountOf(cols)
    if (g && v !== undefined && v !== '') sums[g] = money(v, cur)
  }
  const totals: NonNullable<ReportSnapshot['totals']> | undefined = sums.NetIncome
    ? {
        netIncome: sums.NetIncome,
        ...(sums.Income ? { income: sums.Income } : {}),
        ...(sums.COGS ? { cogs: sums.COGS } : {}),
        ...(sums.Expenses ? { expenses: sums.Expenses } : {}),
        ...(sums.OtherIncome ? { otherIncome: sums.OtherIncome } : {}),
        ...(sums.OtherExpenses ? { otherExpenses: sums.OtherExpenses } : {}),
      }
    : undefined
  return {
    ...(totals ? { totals } : {}),
    type: 'report.snapshot',
    ...base(ctx, `pnl:${period.from}:${period.to}:${period.basis}`),
    kind: 'profit_and_loss',
    from: period.from,
    to: period.to,
    basis: period.basis,
    currency: cur,
    rows,
  }
}
