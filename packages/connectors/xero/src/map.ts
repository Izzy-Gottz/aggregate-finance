// Xero Accounting API JSON → normalized events. Pure functions; no I/O.
//
// Xero keeps settlement detail on separate objects: Payments (one invoice each), CreditNotes (with Allocations),
// Overpayments and Prepayments (cash with Allocations). Invoices carry AmountPaid and AmountCredited, which the
// subledger only falls back to when no application detail exists.
import type { ConnectionId, CreditNoteUpsert, Currency, Id, InvoiceUpsert, JournalUpsert, LedgerAccountUpsert, Money, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { isRecord, money, normalizeCurrency, str } from '@agfn/connector-sdk'
import { expenseRoleFor, incomeRoleFor } from '@agfn/invoices'

export type XeroObject = Record<string, unknown>

export interface MapContext {
  connectionId: ConnectionId
  baseCurrency: Currency
  rawRef?: Id
  /** Account code → ledger role, from the chart of accounts. */
  roles?: Readonly<Record<string, string>>
}

function base(ctx: MapContext, externalId: string): { externalId: string; connectionId: ConnectionId; rawRef?: Id } {
  return ctx.rawRef === undefined ? { externalId, connectionId: ctx.connectionId } : { externalId, connectionId: ctx.connectionId, rawRef: ctx.rawRef }
}

/** Xero dates: "2026-08-01T00:00:00" (DateString) or the MS-JSON form "/Date(1785542400000+0000)/". */
export function xeroDate(v: unknown): string | undefined {
  const s = str(v)
  if (!s) return undefined
  const ms = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(s)
  if (ms) return new Date(Number(ms[1])).toISOString().slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

export function xeroTimestamp(v: unknown): number | undefined {
  const s = str(v)
  if (!s) return undefined
  const ms = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(s)
  if (ms) return Number(ms[1])
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + 'Z')
  return Number.isNaN(t) ? undefined : t
}

function cur(o: XeroObject, ctx: MapContext): Currency {
  return normalizeCurrency(str(o.CurrencyCode), ctx.baseCurrency)
}

function amt(v: unknown, currency: Currency): Money {
  if (typeof v !== 'number' && typeof v !== 'string') return { minor: 0, currency }
  if (v === '') return { minor: 0, currency }
  return money(v, currency)
}

function contactName(o: XeroObject): string | undefined {
  return isRecord(o.Contact) ? str(o.Contact.Name) : undefined
}

function allocations(o: XeroObject, currency: Currency): Array<{ invoiceExternalId: string; amount: Money }> {
  const list = Array.isArray(o.Allocations) ? o.Allocations.filter(isRecord) : []
  return list.flatMap((a) => {
    const inv = isRecord(a.Invoice) ? str(a.Invoice.InvoiceID) : undefined
    if (!inv || a.IsDeleted === true) return []
    const m = amt(a.Amount, currency)
    return m.minor > 0 ? [{ invoiceExternalId: inv, amount: m }] : []
  })
}

// ---------- chart of accounts ----------

const CLASS: Record<string, LedgerAccountUpsert['classification']> = {
  ASSET: 'asset',
  LIABILITY: 'liability',
  EQUITY: 'equity',
  REVENUE: 'income',
  EXPENSE: 'expense',
}

export function mapAccount(o: XeroObject, ctx: MapContext): LedgerAccountUpsert | null {
  const id = str(o.AccountID)
  const classification = CLASS[str(o.Class) ?? '']
  if (!id || !classification) return null
  const e: LedgerAccountUpsert = {
    type: 'ledger_account.upsert',
    ...base(ctx, id),
    name: str(o.Name) ?? id,
    classification,
    active: str(o.Status) !== 'ARCHIVED' && str(o.Status) !== 'DELETED',
  }
  const code = str(o.Code)
  if (code) e.code = code
  const t = str(o.Type)
  if (t) e.subtype = t
  const c = str(o.CurrencyCode)
  if (c) e.currency = normalizeCurrency(c, ctx.baseCurrency)
  return e
}

/**
 * Account code → ledger role (kept small enough to live in the sync cursor). P&L accounts take their section from
 * Xero's type (DIRECTCOSTS → COGS, OTHERINCOME → other income); balance-sheet accounts a bill or journal line may use
 * map to inventory, fixed assets, prepaid, other assets or other liabilities. Bank and equity accounts get none.
 */
export function roleForAccount(o: XeroObject): [string, string] | null {
  const code = str(o.Code)
  const klass = str(o.Class)
  const type = str(o.Type) ?? ''
  const name = str(o.Name)
  if (!code) return null
  if (klass === 'REVENUE') return [code, type === 'OTHERINCOME' ? 'other_income' : incomeRoleFor(name)]
  if (klass === 'EXPENSE') {
    if (type === 'DIRECTCOSTS') return [code, 'cogs']
    const role = expenseRoleFor(name)
    // A keyword like "materials" doesn't make an overheads account cost of sales; Xero's type says where it goes.
    return [code, role === 'cogs' ? 'other_expense' : role]
  }
  if (klass === 'ASSET') {
    if (type === 'INVENTORY') return [code, 'inventory']
    if (type === 'FIXED') return [code, 'fixed_assets']
    if (type === 'PREPAYMENT') return [code, 'prepaid']
    if (type === 'CURRENT' || type === 'NONCURRENT') return [code, 'other_assets']
    return null
  }
  if (klass === 'LIABILITY') return type === 'CURRLIAB' || type === 'LIABILITY' || type === 'TERMLIAB' || type === 'PAYGLIABILITY' || type === 'SUPERANNUATIONLIABILITY' ? [code, 'other_liabilities'] : null
  return null
}

const BALANCE_SHEET = new Set(['inventory', 'fixed_assets', 'prepaid', 'other_assets', 'other_liabilities'])

/** Line amount without tax: Xero's "Inclusive" line amounts include it. */
function exTax(l: XeroObject, lineAmountTypes: string | undefined, c: Currency): { amount: Money; tax?: Money } {
  const gross = amt(l.LineAmount, c)
  const tax = l.TaxAmount !== undefined ? amt(l.TaxAmount, c) : undefined
  if (lineAmountTypes === 'Inclusive' && tax) return { amount: { minor: gross.minor - tax.minor, currency: c }, tax }
  return tax ? { amount: gross, tax } : { amount: gross }
}

// ---------- invoices and bills ----------

const STATUS: Record<string, InvoiceUpsert['status']> = {
  DRAFT: 'draft',
  SUBMITTED: 'draft', // awaiting approval: not yet owed
  AUTHORISED: 'open',
  PAID: 'paid',
  VOIDED: 'void',
  DELETED: 'void',
}

export function mapInvoice(o: XeroObject, ctx: MapContext): InvoiceUpsert | null {
  const id = str(o.InvoiceID)
  const issueDate = xeroDate(o.DateString) ?? xeroDate(o.Date)
  const type = str(o.Type)
  if (!id || !issueDate || (type !== 'ACCREC' && type !== 'ACCPAY')) return null
  const c = cur(o, ctx)
  const direction = type === 'ACCREC' ? 'receivable' : 'payable'
  const total = amt(o.Total, c)
  const paid = amt(o.AmountPaid, c)
  const credited = amt(o.AmountCredited, c)
  let status = STATUS[str(o.Status) ?? ''] ?? 'open'
  if (status === 'open' && (paid.minor > 0 || credited.minor > 0)) status = 'partially_paid'
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, id),
    direction,
    counterparty: contactName(o) ?? (direction === 'receivable' ? 'Unknown customer' : 'Unknown supplier'),
    issueDate,
    total,
    amountPaid: paid,
    status,
  }
  if (credited.minor > 0) e.amountCredited = credited
  const number = str(o.InvoiceNumber) ?? str(o.Reference)
  if (number) e.number = number
  const due = xeroDate(o.DueDateString) ?? xeroDate(o.DueDate)
  if (due) e.dueDate = due
  if (o.TotalTax !== undefined) e.tax = amt(o.TotalTax, c)
  if (o.SubTotal !== undefined) e.subtotal = amt(o.SubTotal, c)
  const lines = Array.isArray(o.LineItems) ? o.LineItems.filter(isRecord) : []
  const out: NonNullable<InvoiceUpsert['lines']> = []
  for (const l of lines) {
    const { amount, tax } = exTax(l, str(o.LineAmountTypes), c)
    const line: NonNullable<InvoiceUpsert['lines']>[number] = { description: str(l.Description) ?? str(l.ItemCode) ?? 'Line item', amount }
    if (typeof l.Quantity === 'number') line.quantity = l.Quantity
    if (tax) line.tax = tax
    const code = str(l.AccountCode)
    line.category = (code && ctx.roles?.[code]) || (direction === 'receivable' ? 'revenue' : 'uncategorized_expense')
    out.push(line)
  }
  if (out.length) e.lines = out
  return e
}

// ---------- payments ----------

const PAYMENT_DIRECTION: Record<string, 'receivable' | 'payable'> = { ACCRECPAYMENT: 'receivable', ACCPAYPAYMENT: 'payable' }

/** A Xero Payment settles exactly one invoice. Credit-note refunds and overpayment refunds are skipped here. */
export function mapPayment(o: XeroObject, ctx: MapContext): PaymentApplied | null {
  const id = str(o.PaymentID)
  const day = xeroDate(o.Date)
  const direction = PAYMENT_DIRECTION[str(o.PaymentType) ?? '']
  const inv = isRecord(o.Invoice) ? o.Invoice : undefined
  const invoiceId = inv ? str(inv.InvoiceID) : undefined
  if (!id || !day || !direction || !invoiceId || !inv) return null
  const c = normalizeCurrency(str(inv.CurrencyCode) ?? str(o.CurrencyCode), ctx.baseCurrency)
  const amount = amt(o.Amount, c)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, id),
    direction,
    date: day,
    amount,
    applications: amount.minor > 0 ? [{ invoiceExternalId: invoiceId, amount }] : [],
    status: str(o.Status) === 'DELETED' ? 'void' : 'posted',
  }
  const party = contactName(inv)
  if (party) e.counterparty = party
  const reference = str(o.Reference)
  if (reference) e.reference = reference
  // A batch payment is one bank line for many invoices; the batch id lets the ledger match them as a group.
  const batch = str(o.BatchPaymentID)
  if (batch) e.method = `batch:${batch}`
  return e
}

/** Overpayments and prepayments are cash with allocations to invoices; the rest stays as credit. */
export function mapPrepayment(o: XeroObject, ctx: MapContext, kind: 'overpayment' | 'prepayment'): PaymentApplied | null {
  const id = str(kind === 'overpayment' ? o.OverpaymentID : o.PrepaymentID)
  const day = xeroDate(o.DateString) ?? xeroDate(o.Date)
  const type = str(o.Type) ?? ''
  const direction = /^RECEIVE/.test(type) ? 'receivable' : /^SPEND/.test(type) ? 'payable' : undefined
  if (!id || !day || !direction) return null
  const c = cur(o, ctx)
  const total = amt(o.Total, c)
  const apps = allocations(o, c)
  const applied = apps.reduce((s, a) => s + a.amount.minor, 0)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, `${kind}:${id}`),
    direction,
    date: day,
    amount: total,
    applications: applied <= total.minor ? apps : [],
    status: str(o.Status) === 'VOIDED' || str(o.Status) === 'DELETED' ? 'void' : 'posted',
    method: kind,
  }
  const left = total.minor - (applied <= total.minor ? applied : 0)
  if (left > 0) e.unapplied = { minor: left, currency: c }
  const party = contactName(o)
  if (party) e.counterparty = party
  return e
}

// ---------- credit notes ----------

export function mapCreditNote(o: XeroObject, ctx: MapContext): CreditNoteUpsert | null {
  const id = str(o.CreditNoteID)
  const day = xeroDate(o.DateString) ?? xeroDate(o.Date)
  const type = str(o.Type)
  if (!id || !day || (type !== 'ACCRECCREDIT' && type !== 'ACCPAYCREDIT')) return null
  const c = cur(o, ctx)
  const total = amt(o.Total, c)
  const apps = allocations(o, c)
  const remaining = amt(o.RemainingCredit, c)
  const refunded = Array.isArray(o.Payments) && o.Payments.length > 0
  const status = str(o.Status)
  const e: CreditNoteUpsert = {
    type: 'credit_note.upsert',
    ...base(ctx, id),
    direction: type === 'ACCRECCREDIT' ? 'receivable' : 'payable',
    date: day,
    amount: total,
    applications: apps,
    // Fully used: by allocations (invoice) or partly refunded in cash (refund). Otherwise the rest is credit.
    appliedTo: remaining.minor > 0 ? 'customer_credit' : refunded ? 'refund' : 'invoice',
    status: status === 'VOIDED' || status === 'DELETED' ? 'void' : status === 'DRAFT' || status === 'SUBMITTED' ? 'void' : remaining.minor > 0 ? 'open' : 'applied',
  }
  if (apps[0]) e.invoiceExternalId = apps[0].invoiceExternalId
  const tax = o.TotalTax !== undefined ? amt(o.TotalTax, c) : undefined
  if (tax && tax.minor) e.tax = tax
  const number = str(o.CreditNoteNumber)
  if (number) e.number = number
  const party = contactName(o)
  if (party) e.counterparty = party
  return e
}

// ---------- reports ----------

const optional = <K extends string>(k: K, v: Money | undefined): Partial<Record<K, Money>> => (v ? ({ [k]: v } as Record<K, Money>) : {})

/** Xero gives apps no access to Xero Payroll or expense claims (no journals scope); their P&L lines can't be matched. */
export const NOT_COVERED = {
  text: "Xero payroll and expense claims aren't available to apps; connect Gusto (via Finch) or your bank to include wages",
  withPayroll: "Wages in Xero Payroll and expense claims aren't readable by apps; your payroll connection is counted instead, and the two books differ by that",
}

export function mapProfitAndLoss(body: XeroObject, ctx: MapContext, period: { from: string; to: string }): ReportSnapshot | null {
  const report = Array.isArray(body.Reports) && isRecord(body.Reports[0]) ? (body.Reports[0] as XeroObject) : undefined
  if (!report) return null
  const rows: ReportSnapshot['rows'] = []
  const cellValue = (cells: unknown, i: number): string | undefined => (Array.isArray(cells) && isRecord(cells[i]) ? str(cells[i].Value) : undefined)
  const accountId = (cells: unknown): string | undefined => {
    const first = Array.isArray(cells) && isRecord(cells[0]) ? cells[0] : undefined
    const attrs = first && Array.isArray(first.Attributes) ? first.Attributes.filter(isRecord) : []
    return attrs.map((a) => (str(a.Id) === 'account' ? str(a.Value) : undefined)).find(Boolean)
  }
  const top = Array.isArray(report.Rows) ? report.Rows.filter(isRecord) : []
  for (const section of top) {
    if (str(section.RowType) !== 'Section') continue
    const title = str(section.Title) ?? ''
    const inner = Array.isArray(section.Rows) ? section.Rows.filter(isRecord) : []
    for (const r of inner) {
      const t = str(r.RowType)
      if (t !== 'Row' && t !== 'SummaryRow') continue
      const name = cellValue(r.Cells, 0)
      const lastIdx = Array.isArray(r.Cells) ? r.Cells.length - 1 : 1
      const value = cellValue(r.Cells, lastIdx)
      if (!name || value === undefined || value === '') continue
      const row: ReportSnapshot['rows'][number] = { account: name, amount: money(value, ctx.baseCurrency), section: title || name, depth: t === 'Row' ? 1 : 0 }
      const acct = accountId(r.Cells)
      if (acct) row.accountExternalId = acct
      rows.push(row)
    }
  }
  // Xero's own totals: "Total Income" (or "Total Trading Income"), "Total Cost of Sales", "Total Operating Expenses",
  // "Total Other Income", "Total Other Expenses" and "Net Profit".
  const named = (re: RegExp) => rows.find((r) => re.test(r.account))?.amount
  // UK/AU reports say "Net Profit", US ones "Net Income"; "Total Revenue" or "Total (Trading) Income".
  const net = named(/^net (profit|income)$/i)
  const totals: NonNullable<ReportSnapshot['totals']> | undefined = net
    ? {
        netIncome: net,
        ...optional('income', named(/^total (trading )?(income|revenue)$/i)),
        ...optional('cogs', named(/^total cost of sales$/i)),
        ...optional('expenses', named(/^total operating expenses$/i)),
        ...optional('otherIncome', named(/^total other income$/i)),
        ...optional('otherExpenses', named(/^total other expenses$/i)),
      }
    : undefined
  return {
    ...(totals ? { totals } : {}),
    notCovered: NOT_COVERED,
    type: 'report.snapshot',
    ...base(ctx, `pnl:${period.from}:${period.to}:accrual`),
    kind: 'profit_and_loss',
    from: period.from,
    to: period.to,
    basis: 'accrual',
    currency: ctx.baseCurrency,
    rows,
  }
}

// ---------- spend and receive money; manual journals ----------

/**
 * Spend money → a paid bill and its payment; receive money → a paid invoice and its payment ("banktxn:<id>", so it
 * can't collide with an invoice id). The payment clears against the bank row like any other, so a bank feed of the
 * same money links to it instead of counting it twice. Overpayment, prepayment and transfer types are covered by
 * their own lists (or aren't P&L).
 */
export function mapBankTransaction(o: XeroObject, ctx: MapContext): Array<InvoiceUpsert | PaymentApplied> {
  const id = str(o.BankTransactionID)
  const day = xeroDate(o.DateString) ?? xeroDate(o.Date)
  const type = str(o.Type)
  if (!id || !day || (type !== 'SPEND' && type !== 'RECEIVE')) return []
  const c = cur(o, ctx)
  const direction = type === 'SPEND' ? 'payable' : 'receivable'
  const voided = str(o.Status) === 'DELETED' || str(o.Status) === 'VOIDED'
  const xid = `banktxn:${id}`
  const out: NonNullable<InvoiceUpsert['lines']> = []
  for (const l of Array.isArray(o.LineItems) ? o.LineItems.filter(isRecord) : []) {
    const { amount, tax } = exTax(l, str(o.LineAmountTypes), c)
    const code = str(l.AccountCode)
    const role = code ? ctx.roles?.[code] : undefined
    const line: NonNullable<InvoiceUpsert['lines']>[number] = { description: str(l.Description) ?? 'Line item', amount, category: role ?? (direction === 'receivable' ? 'revenue' : 'uncategorized_expense') }
    if (tax) line.tax = tax
    out.push(line)
  }
  const total = amt(o.Total, c)
  const doc: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, xid),
    direction,
    counterparty: contactName(o) ?? (direction === 'receivable' ? 'Money received' : 'Money spent'),
    issueDate: day,
    total,
    amountPaid: voided ? { minor: 0, currency: c } : total,
    status: voided ? 'void' : 'paid',
  }
  if (o.TotalTax !== undefined) doc.tax = amt(o.TotalTax, c)
  if (out.length) doc.lines = out
  const reference = str(o.Reference)
  if (reference) doc.number = reference
  const pay: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, xid),
    direction,
    date: day,
    amount: total,
    applications: total.minor > 0 ? [{ invoiceExternalId: xid, amount: total }] : [],
    status: voided ? 'void' : 'posted',
  }
  if (doc.counterparty) pay.counterparty = doc.counterparty
  if (reference) pay.reference = reference
  return [doc, pay]
}

/**
 * A manual journal (Xero runs payroll accruals, depreciation and corrections through them) → journal.upsert. Only
 * journals with a P&L line matter here; lines on accounts we can't book (bank, equity) are carried by one balancing
 * line so the journal still sums to zero. Draft, voided and deleted journals are taken out.
 */
export function mapManualJournal(o: XeroObject, ctx: MapContext): JournalUpsert | null {
  const id = str(o.ManualJournalID)
  const day = xeroDate(o.DateString) ?? xeroDate(o.Date)
  if (!id || !day) return null
  const c = cur(o, ctx)
  const lines: JournalUpsert['lines'] = []
  let rest = 0
  let pnl = false
  for (const l of Array.isArray(o.JournalLines) ? o.JournalLines.filter(isRecord) : []) {
    const a = amt(l.LineAmount, c)
    if (!a.minor) continue
    const code = str(l.AccountCode)
    const role = code ? ctx.roles?.[code] : undefined
    if (role && !BALANCE_SHEET.has(role)) pnl = true
    if (role) lines.push({ role, amount: a, ...(str(l.Description) ? { memo: (str(l.Description) as string).slice(0, 140) } : {}), ...(code ? { accountExternalId: code } : {}) })
    else rest += a.minor
  }
  if (!pnl) return null
  if (rest) lines.push({ role: rest > 0 ? 'other_assets' : 'other_liabilities', amount: { minor: rest, currency: c }, memo: 'Bank or equity side in Xero' })
  const status = str(o.Status)
  const e: JournalUpsert = { type: 'journal.upsert', ...base(ctx, `mj:${id}`), date: day, status: status === 'POSTED' ? 'posted' : 'void', lines }
  const memo = str(o.Narration)
  if (memo) e.memo = memo.slice(0, 200)
  return e
}
