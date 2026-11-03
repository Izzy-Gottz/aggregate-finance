// FreshBooks accounting JSON → normalized events. Pure functions; no I/O.
//
// Built from FreshBooks' API documentation alone; no real account has been read. Field shapes the docs leave open are
// listed in the package README.
import type { ConnectionId, Currency, Id, InvoiceUpsert, JournalUpsert, Money, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { isRecord, money, normalizeCurrency, str } from '@agfn/connector-sdk'
import { expenseRoleFor, incomeRoleFor } from '@agfn/invoices'

export type FbObject = Record<string, unknown>

export interface MapContext {
  connectionId: ConnectionId
  baseCurrency: Currency
  rawRef?: Id
  /** Account uuid → ledger role, or 'bank' / 'balance' (see accountRoles). */
  roles?: Readonly<Record<string, string>>
}

function base(ctx: MapContext, externalId: string): { externalId: string; connectionId: ConnectionId; rawRef?: Id } {
  return ctx.rawRef === undefined ? { externalId, connectionId: ctx.connectionId } : { externalId, connectionId: ctx.connectionId, rawRef: ctx.rawRef }
}

/** FreshBooks ids are integers or uuids. */
export const idOf = (v: unknown): string | undefined => (typeof v === 'number' ? String(v) : str(v))
const day = (v: unknown): string | undefined => {
  const s = str(v)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

/** { amount: "10.00", code: "USD" }. Journal amounts come with three decimals ("100.000"). */
function amt(v: unknown, fallback: Currency): Money {
  const o = isRecord(v) ? v : {}
  const currency = normalizeCurrency(str(o.code), fallback)
  const raw = o.amount
  const s = typeof raw === 'number' ? String(raw) : str(raw)
  return s ? money(s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s, currency) : { minor: 0, currency }
}
const cents = (minor: number, currency: Currency): Money => ({ minor, currency })
const list = (v: unknown): FbObject[] => (Array.isArray(v) ? v.filter(isRecord) : [])
const deleted = (o: FbObject): boolean => o.vis_state === 1

// ---------- invoices ----------

/** The customer as FreshBooks shows them: the company, else the person. The processor match needs this real name. */
export function customerName(o: FbObject): string | undefined {
  const person = [str(o.fname), str(o.lname)].filter(Boolean).join(' ')
  return str(o.organization) ?? str(o.current_organization) ?? (person || undefined)
}

const INVOICE_STATUS: Record<number, InvoiceUpsert['status']> = { 0: 'disputed', 1: 'draft', 2: 'open', 3: 'open', 4: 'paid', 5: 'paid', 6: 'open', 7: 'open', 8: 'partially_paid' }

/**
 * `amount` is the gross the customer pays, after discount and tax, so it equals a processor's gross. Tax isn't a field:
 * it's what's left after the lines and the (negative) discount, as the docs' samples work out.
 */
export function mapInvoice(o: FbObject, ctx: MapContext): InvoiceUpsert | null {
  const id = idOf(o.invoiceid) ?? idOf(o.id)
  const issueDate = day(o.create_date)
  if (!id || !issueDate) return null
  const c = normalizeCurrency(str(o.currency_code) ?? (isRecord(o.amount) ? str(o.amount.code) : undefined), ctx.baseCurrency)
  const total = cents(amt(o.amount, c).minor, c)
  const paid = cents(amt(o.paid, c).minor, c)
  let status = typeof o.status === 'number' ? (INVOICE_STATUS[o.status] ?? 'open') : 'open'
  if (status === 'open' && paid.minor > 0) status = 'partially_paid'
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, id),
    direction: 'receivable',
    counterparty: customerName(o) ?? 'Unknown customer',
    issueDate,
    total,
    amountPaid: status === 'paid' && paid.minor === 0 ? total : paid,
    status: deleted(o) ? 'void' : status,
  }
  const number = idOf(o.invoice_number)
  if (number) e.number = number
  const due = day(o.due_date)
  if (due) e.dueDate = due
  const lines = list(o.lines)
  if (lines.length) {
    const out: NonNullable<InvoiceUpsert['lines']> = lines.map((l) => ({ description: str(l.name) ?? str(l.description) ?? 'Line item', amount: cents(amt(l.amount, c).minor, c), category: 'revenue' }))
    const discount = amt(o.discount_total, c).minor
    if (discount) out.push({ description: 'Discount', amount: cents(discount, c), category: 'revenue' })
    const subtotal = out.reduce((s, l) => s + l.amount.minor, 0)
    const tax = total.minor - subtotal
    e.lines = out
    if (tax >= 0 && tax <= Math.abs(total.minor)) {
      e.subtotal = cents(subtotal, c)
      e.tax = cents(tax, c)
    }
  }
  return e
}

// ---------- payments ----------

/**
 * A payment on an invoice. `customer` is that invoice's customer: payments carry only a client id, and the processor
 * match needs the name. A payment drawn from client credit isn't money arriving, so it's not an event.
 */
export function mapPayment(o: FbObject, ctx: MapContext, customer?: string): PaymentApplied | null {
  const id = idOf(o.id) ?? idOf(o.logid)
  const date = day(o.date)
  if (!id || !date || o.from_credit === true) return null
  const amount = amt(o.amount, ctx.baseCurrency)
  const invoice = idOf(o.invoiceid)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, id),
    direction: 'receivable',
    date,
    amount,
    applications: invoice && amount.minor > 0 ? [{ invoiceExternalId: invoice, amount }] : [],
    status: deleted(o) ? 'void' : 'posted',
  }
  if (!invoice && amount.minor > 0) e.unapplied = amount
  if (customer) e.counterparty = customer
  const method = str(o.type)
  if (method) e.method = method
  const note = str(o.note)
  if (note) e.reference = note.slice(0, 140)
  return e
}

// ---------- bills ----------

/** A line's category: FreshBooks says itself whether it's cost of goods; the name decides the rest. */
function spendRole(category: unknown): string {
  const o = isRecord(category) ? category : {}
  if (o.is_cogs === true) return 'cogs'
  const role = expenseRoleFor(str(o.category))
  return role === 'cogs' ? 'other_expense' : role
}

const BILL_STATUS: Record<string, InvoiceUpsert['status']> = { unpaid: 'open', overdue: 'open', partial: 'partially_paid', paid: 'paid' }

export const vendorName = (o: FbObject): string | undefined => (isRecord(o.vendor) ? str(o.vendor.vendor_name) : undefined)

export function mapBill(o: FbObject, ctx: MapContext): InvoiceUpsert | null {
  const id = idOf(o.id)
  const issueDate = day(o.issue_date)
  if (!id || !issueDate) return null
  const c = normalizeCurrency(str(o.currency_code), ctx.baseCurrency)
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, `bill:${id}`),
    direction: 'payable',
    counterparty: vendorName(o) ?? 'Unknown supplier',
    issueDate,
    total: cents(amt(o.total_amount, c).minor, c),
    amountPaid: cents(amt(o.paid, c).minor, c),
    subtotal: cents(amt(o.amount, c).minor, c),
    tax: cents(amt(o.tax_amount, c).minor, c),
    status: deleted(o) ? 'void' : (BILL_STATUS[str(o.status) ?? ''] ?? 'open'),
  }
  const number = str(o.bill_number)
  if (number) e.number = number
  const due = day(o.due_date)
  if (due) e.dueDate = due
  const lines = list(o.lines).map((l) => {
    const tax = amt(l.tax_amount1, c).minor + amt(l.tax_amount2, c).minor
    return { description: str(l.description) ?? 'Line item', amount: cents(amt(l.amount, c).minor, c), category: spendRole(l.category), ...(tax ? { tax: cents(tax, c) } : {}) }
  })
  if (lines.length) e.lines = lines
  return e
}

export function mapBillPayment(o: FbObject, ctx: MapContext, vendor?: string): PaymentApplied | null {
  const id = idOf(o.id)
  const date = day(o.paid_date)
  const bill = idOf(o.billid)
  if (!id || !date || !bill) return null
  const amount = amt(o.amount, ctx.baseCurrency)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, `bp:${id}`),
    direction: 'payable',
    date,
    amount,
    applications: amount.minor > 0 ? [{ invoiceExternalId: `bill:${bill}`, amount }] : [],
    status: deleted(o) ? 'void' : 'posted',
  }
  if (vendor) e.counterparty = vendor
  const method = str(o.payment_type)
  if (method) e.method = method
  return e
}

// ---------- expenses ----------

/**
 * An expense → a paid bill and its payment ("expense:<id>"), as Xero's spend money: the payment clears against the
 * bank row, so a bank feed of the same money links to it instead of counting it twice. One FreshBooks flagged as a
 * duplicate stops counting.
 */
export function mapExpense(o: FbObject, ctx: MapContext): Array<InvoiceUpsert | PaymentApplied> {
  const id = idOf(o.expenseid) ?? idOf(o.id)
  const date = day(o.date)
  if (!id || !date) return []
  const total = amt(o.amount, ctx.baseCurrency)
  const voided = deleted(o) || o.isduplicate === true
  const xid = `expense:${id}`
  const counterparty = str(o.vendor) ?? 'Money spent'
  const doc: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, xid),
    direction: 'payable',
    counterparty,
    issueDate: date,
    total,
    amountPaid: voided ? cents(0, total.currency) : total,
    status: voided ? 'void' : 'paid',
    lines: [{ description: str(o.notes) ?? counterparty, amount: total, category: spendRole(o.category) }],
  }
  const pay: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, xid),
    direction: 'payable',
    date,
    amount: total,
    counterparty,
    applications: total.minor > 0 ? [{ invoiceExternalId: xid, amount: total }] : [],
    status: voided ? 'void' : 'posted',
    method: 'expense',
  }
  return [doc, pay]
}

// ---------- chart of accounts and journals ----------

/** Accounts money sits in. Their journals mirror bank rows, and money at the bank comes only from bank feeds. */
const MONEY_ACCOUNT = /cash|bank|card|clearing|undeposited|processor|loan/i

function accountRole(a: FbObject, inherited: string | undefined): string {
  const name = str(a.account_name)
  const sub = str(a.account_sub_type) ?? inherited ?? ''
  const type = str(a.account_type)
  // Type first: "Bank Fees" or "Loan Interest" is a P&L account, not money.
  if (type === 'income') return incomeRoleFor(name)
  if (type === 'expense') {
    if (/cost of (goods|sales)/i.test(sub)) return 'cogs'
    const role = expenseRoleFor(name)
    return role === 'cogs' ? 'other_expense' : role
  }
  if (MONEY_ACCOUNT.test(sub) || MONEY_ACCOUNT.test(name ?? '') || MONEY_ACCOUNT.test(str(a.system_account_name) ?? '')) return 'bank'
  return 'balance'
}

/** Account uuid → ledger role, 'bank' for accounts money sits in, 'balance' for other balance-sheet accounts. */
export function accountRoles(accounts: FbObject[]): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (a: FbObject, inherited?: string) => {
    const id = str(a.account_uuid)
    if (id) out[id] = accountRole(a, inherited)
    for (const s of list(a.sub_accounts)) walk(s, str(a.account_sub_type) ?? inherited)
  }
  for (const a of accounts) walk(a)
  return out
}

/**
 * An adjustment entry → journal.upsert, when it has a P&L line. One touching a bank-like account mirrors a bank row, and
 * one on an account the chart didn't show can't be shown not to, so both are skipped. Other balance-sheet lines are
 * carried by one balancing line, as QuickBooks and Xero journals are.
 */
export function mapJournal(o: FbObject, ctx: MapContext): JournalUpsert | null {
  const id = idOf(o.id)
  const d = isRecord(o.userEnteredDate) ? o.userEnteredDate : {}
  if (!id || typeof d.year !== 'number' || typeof d.month !== 'number' || typeof d.day !== 'number') return null
  const date = `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`
  const details = list(o.details)
  const c = amt(details[0]?.amount, ctx.baseCurrency).currency
  const lines: JournalUpsert['lines'] = []
  let rest = 0
  let sum = 0
  for (const l of details) {
    const a = amt(l.amount, c)
    if (a.currency !== c) return null
    const signed = str(l.type) === 'TYPE_CREDIT' ? -Math.abs(a.minor) : Math.abs(a.minor)
    const account = str(l.accountId)
    const role = account ? ctx.roles?.[account] : undefined
    if (!role || role === 'bank') return null
    sum += signed
    if (role === 'balance') rest += signed
    else if (signed) lines.push({ role, amount: cents(signed, c), ...(account ? { accountExternalId: account } : {}) })
  }
  if (!lines.length || sum !== 0) return null
  if (rest) lines.push({ role: rest > 0 ? 'other_assets' : 'other_liabilities', amount: cents(rest, c), memo: 'Balance sheet side in FreshBooks' })
  const e: JournalUpsert = { type: 'journal.upsert', ...base(ctx, `je:${id}`), date, status: 'posted', lines }
  const memo = str(o.description) ?? str(o.name)
  if (memo) e.memo = memo.slice(0, 200)
  return e
}

// ---------- reports ----------

/** What FreshBooks' P&L counts that this connector doesn't read. */
export const NOT_COVERED = {
  text: "FreshBooks credit notes and other income aren't read, and a journal entry touching a bank account comes from your bank feed instead",
}

export function mapProfitAndLoss(report: FbObject, ctx: MapContext, period: { from: string; to: string }): ReportSnapshot | null {
  if (!isRecord(report.net_profit) || !isRecord(report.net_profit.total)) return null
  const currency = normalizeCurrency(str(report.currency_code), ctx.baseCurrency)
  const rows: ReportSnapshot['rows'] = []
  const walk = (r: FbObject, section: string, depth: number) => {
    const kids = list(r.children)
    if (kids.length) {
      for (const k of kids) walk(k, section, depth + 1)
      return
    }
    const row: ReportSnapshot['rows'][number] = { account: str(r.description) ?? section, amount: cents(amt(r.total, currency).minor, currency), section, depth }
    const acct = str(r.account_uuid)
    if (acct) row.accountExternalId = acct
    rows.push(row)
  }
  for (const r of list(report.income)) walk(r, 'Income', 1)
  for (const r of list(report.expenses)) walk(r, 'Expenses', 1)
  const total = (v: unknown): Money => cents(amt(isRecord(v) ? v.total : undefined, currency).minor, currency)
  const income = total(report.total_income)
  const expenses = total(report.total_expenses)
  const netIncome = total(report.net_profit)
  rows.push({ account: 'Total Income', amount: income, section: 'Income', depth: 0 }, { account: 'Total Expenses', amount: expenses, section: 'Expenses', depth: 0 }, { account: 'Net Profit', amount: netIncome, section: 'Net Profit', depth: 0 })
  return {
    type: 'report.snapshot',
    ...base(ctx, `pnl:${period.from}:${period.to}:accrual`),
    kind: 'profit_and_loss',
    from: period.from,
    to: period.to,
    basis: 'accrual',
    currency,
    rows,
    // No `expenses` total: FreshBooks' takes in cost of goods, which ours has apart, so the two would read as a gap.
    totals: { income, netIncome },
    notCovered: NOT_COVERED,
  }
}
