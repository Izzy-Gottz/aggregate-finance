// BILL (Bill.com) v3 JSON → normalized events. Pure functions; no I/O.
// Amounts are JSON numbers in dollars; dates are yyyy-MM-dd. BILL list objects carry no currency code, so the
// connection's currency is used (BILL accounts are single-currency unless international payments are enabled).
import type { ConnectionId, CreditNoteUpsert, Currency, Id, InvoiceUpsert, Money, PaymentApplied } from '@agfn/contracts'
import { isRecord, money, str } from '@agfn/connector-sdk'

export type BillObject = Record<string, unknown>

export interface MapContext {
  connectionId: ConnectionId
  currency: Currency
  rawRef?: Id
  customers?: Readonly<Record<string, string>>
  vendors?: Readonly<Record<string, string>>
}

function base(ctx: MapContext, externalId: string): { externalId: string; connectionId: ConnectionId; rawRef?: Id } {
  return ctx.rawRef === undefined ? { externalId, connectionId: ctx.connectionId } : { externalId, connectionId: ctx.connectionId, rawRef: ctx.rawRef }
}

function amt(v: unknown, c: Currency): Money {
  return typeof v === 'number' || (typeof v === 'string' && v !== '') ? money(v, c) : { minor: 0, currency: c }
}

function day(v: unknown): string | undefined {
  const s = str(v)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}

function allocs(list: unknown, idField: string, c: Currency): Array<{ invoiceExternalId: string; amount: Money }> {
  const items = Array.isArray(list) ? list.filter(isRecord) : []
  return items.flatMap((a) => {
    const id = str(a[idField])
    const m = amt(a.amount, c)
    return id && m.minor > 0 ? [{ invoiceExternalId: id, amount: m }] : []
  })
}

/** Trim applications so they never exceed the payment; the rest is unapplied. */
function fit(apps: Array<{ invoiceExternalId: string; amount: Money }>, total: Money): { applications: typeof apps; unapplied?: Money } {
  let left = total.minor
  const applications = apps.flatMap((a) => {
    const take = Math.min(left, a.amount.minor)
    left -= take
    return take > 0 ? [{ invoiceExternalId: a.invoiceExternalId, amount: { minor: take, currency: a.amount.currency } }] : []
  })
  return left > 0 ? { applications, unapplied: { minor: left, currency: total.currency } } : { applications }
}

const BILL_STATUS: Record<string, InvoiceUpsert['status']> = {
  PAID: 'paid',
  PARTIALLY_PAID: 'partially_paid',
  UNPAID: 'open',
  SCHEDULED: 'open',
  IN_PROCESS: 'open',
  UNDEFINED: 'open',
}

export function mapBill(o: BillObject, ctx: MapContext): InvoiceUpsert | null {
  const id = str(o.id)
  const inv = isRecord(o.invoice) ? o.invoice : {}
  const issueDate = day(inv.invoiceDate) ?? day(o.createdTime)
  if (!id || !issueDate) return null
  const c = ctx.currency
  const total = amt(o.amount, c)
  const paid = amt(o.paidAmount, c)
  const credited = amt(o.creditAmount, c)
  const vendorId = str(o.vendorId)
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, id),
    direction: 'payable',
    counterparty: str(o.vendorName) ?? (vendorId ? ctx.vendors?.[vendorId] : undefined) ?? 'Unknown vendor',
    issueDate,
    total,
    amountPaid: paid,
    // Archived or denied bills were never owed.
    status: o.archived === true || str(o.approvalStatus) === 'DENIED' ? 'void' : (BILL_STATUS[str(o.paymentStatus) ?? ''] ?? 'open'),
  }
  if (credited.minor > 0) e.amountCredited = credited
  const number = str(inv.invoiceNumber)
  if (number) e.number = number
  const due = day(o.dueDate)
  if (due) e.dueDate = due
  const items = Array.isArray(o.billLineItems) ? o.billLineItems.filter(isRecord) : []
  if (items.length) {
    e.lines = items.map((l) => {
      const line: NonNullable<InvoiceUpsert['lines']>[number] = { description: str(l.description) ?? 'Bill line', amount: amt(l.amount, c) }
      if (typeof l.quantity === 'number') line.quantity = l.quantity
      return line
    })
  }
  return e
}

const AR_STATUS: Record<string, InvoiceUpsert['status']> = {
  PAID_IN_FULL: 'paid',
  PARTIAL_PAYMENT: 'partially_paid',
  OPEN: 'open',
  SCHEDULED: 'open',
}

export function mapInvoice(o: BillObject, ctx: MapContext): InvoiceUpsert | null {
  const id = str(o.id)
  const issueDate = day(o.invoiceDate)
  if (!id || !issueDate) return null
  const c = ctx.currency
  const total = amt(o.totalAmount, c)
  const due = amt(o.dueAmount, c)
  const customerId = str(o.customerId)
  const e: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(ctx, id),
    direction: 'receivable',
    counterparty: (customerId ? ctx.customers?.[customerId] : undefined) ?? str(o.customerName) ?? 'Unknown customer',
    issueDate,
    total,
    amountPaid: { minor: Math.max(0, total.minor - due.minor), currency: c },
    status: o.archived === true ? 'void' : (AR_STATUS[str(o.status) ?? ''] ?? 'open'),
  }
  const number = str(o.invoiceNumber)
  if (number) e.number = number
  const dueDate = day(o.dueDate)
  if (dueDate) e.dueDate = dueDate
  const items = Array.isArray(o.invoiceLineItems) ? o.invoiceLineItems.filter(isRecord) : []
  if (items.length) {
    e.lines = items.map((l) => {
      const line: NonNullable<InvoiceUpsert['lines']>[number] = { description: str(l.description) ?? 'Invoice line', amount: amt(l.amount, c), category: 'revenue' }
      if (typeof l.quantity === 'number') line.quantity = l.quantity
      return line
    })
  }
  return e
}

/**
 * Payments made (AP). Only money that actually left counts: PAID posts; VOID/CANCELLED/ESCHEATED void an earlier
 * one; APPROVING/SCHEDULED are not payments yet and are skipped (they show as the bill's scheduled amount).
 */
export function mapPaymentMade(o: BillObject, ctx: MapContext): PaymentApplied | null {
  const id = str(o.id)
  const status = str(o.status) ?? ''
  const voided = status === 'VOID' || status === 'CANCELLED' || status === 'ESCHEATED'
  if (!id || (status !== 'PAID' && !voided)) return null
  const date = day(o.processDate) ?? day(o.createdTime)
  if (!date) return null
  const c = ctx.currency
  const amount = amt(o.amount, c)
  let apps = allocs(o.billPayments, 'billId', c)
  const billId = str(o.billId)
  if (apps.length === 0 && billId && amount.minor > 0) apps = [{ invoiceExternalId: billId, amount }]
  const { applications, unapplied } = fit(apps, amount)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, id),
    direction: 'payable',
    date,
    amount,
    applications: voided ? [] : applications,
    status: voided ? 'void' : 'posted',
  }
  if (!voided && unapplied) e.unapplied = unapplied
  if (voided && amount.minor > 0) e.unapplied = amount
  const vendorId = str(o.vendorId)
  const vendor = vendorId ? ctx.vendors?.[vendorId] : undefined
  if (vendor) e.counterparty = vendor
  const ref = str(o.confirmationNumber) ?? str(o.transactionNumber)
  if (ref) e.reference = ref
  e.method = o.onlinePayment === false ? 'offline' : 'bill_pay'
  return e
}

/** Payments received (AR). PAID posts; VOID/CANCELED void; SCHEDULED is skipped. */
export function mapPaymentReceived(o: BillObject, ctx: MapContext): PaymentApplied | null {
  const id = str(o.id)
  const status = str(o.status) ?? ''
  const voided = status === 'VOID' || status === 'CANCELED' || status === 'ESCHEATED'
  if (!id || (status !== 'PAID' && !voided)) return null
  const date = day(o.paymentDate) ?? day(o.createdTime)
  if (!date) return null
  const c = ctx.currency
  const amount = amt(o.amount, c)
  const { applications, unapplied } = fit(allocs(o.invoicePayments, 'invoiceId', c), amount)
  const e: PaymentApplied = {
    type: 'payment.applied',
    ...base(ctx, id),
    direction: 'receivable',
    date,
    amount,
    applications: voided ? [] : applications,
    status: voided ? 'void' : 'posted',
  }
  const left = voided ? amount : unapplied
  if (left && left.minor > 0) e.unapplied = left
  const customerId = str(o.customerId)
  const customer = customerId ? ctx.customers?.[customerId] : undefined
  if (customer) e.counterparty = customer
  const method = str(o.receivablesType)
  if (method) e.method = method.toLowerCase()
  return e
}

export function mapVendorCredit(o: BillObject, ctx: MapContext): CreditNoteUpsert | null {
  const id = str(o.id)
  const date = day(o.creditDate) ?? day(o.createdTime)
  if (!id || !date) return null
  const c = ctx.currency
  const amount = amt(o.amount, c)
  const applications = fit(allocs(o.usage, 'billId', c), amount).applications
  const applied = applications.reduce((s, a) => s + a.amount.minor, 0)
  const e: CreditNoteUpsert = {
    type: 'credit_note.upsert',
    ...base(ctx, id),
    direction: 'payable',
    date,
    amount,
    applications,
    appliedTo: applied >= amount.minor ? 'invoice' : 'customer_credit',
    status: o.archived === true ? 'void' : applied >= amount.minor ? 'applied' : 'open',
  }
  if (applications[0]) e.invoiceExternalId = applications[0].invoiceExternalId
  const number = str(o.referenceNumber)
  if (number) e.number = number
  const vendorId = str(o.vendorId)
  const vendor = vendorId ? ctx.vendors?.[vendorId] : undefined
  if (vendor) e.counterparty = vendor
  return e
}
