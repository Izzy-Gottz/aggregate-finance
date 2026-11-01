// Expensify expenses → bills the ledger already understands (the same shapes as QuickBooks purchases):
//
// - Paid with a company card (or anything not reimbursable): the money already left a card or bank account. Each
//   expense becomes a paid bill to the merchant (its category and the report link on the line) plus its payment. The
//   payment waits in "not yet seen at the bank" until the card or bank row of the same amount links to it, so the
//   spending is counted once, with Expensify's category. A negative expense (a refund or credit) isn't sent.
// - Reimbursable (paid by the employee): one bill per report, owed to the person who submitted it, with a line per
//   expense. Booked once the report is approved; the reimbursement from the company's bank settles it. Expensify's
//   reimbursed date isn't in the export, so a reimbursed report stays open here until the bank row links to it.
// Amounts come in cents, in the report's currency (convertedAmount) when Expensify gives one, else the expense's own.

import type { InvoiceUpsert, Money, NormalizedEvent, PaymentApplied } from '@agfn/contracts'
import { isoDate, normalizeCurrency } from '@agfn/connector-sdk'
import type { ExportRow } from './template.ts'

export const PROVIDER = 'expensify'

/** Expensify's category names → ledger roles. Anything else stays uncategorized (the name is kept on the line). */
const CATEGORIES: Array<[RegExp, string]> = [
  [/airfare|flight|hotel|lodging|travel|taxi|uber|lyft|rideshare|mileage|parking|car rental|rental car|transport|train|toll/i, 'travel'],
  [/meal|food|dining|restaurant|entertainment|coffee|lunch|dinner/i, 'meals'],
  [/software|subscription|saas|app/i, 'software'],
  [/hosting|cloud|server|aws/i, 'cloud'],
  [/advertis|marketing/i, 'marketing'],
  [/phone|internet|utilit|mobile/i, 'utilities'],
  [/rent|office space|cowork/i, 'rent'],
  [/legal|accounting|professional|consult/i, 'professional_fees'],
  [/insurance/i, 'insurance'],
  [/\btax/i, 'taxes'],
  [/bank fee|service charge/i, 'bank_fees'],
  [/contractor/i, 'contractors'],
  [/office supplies|supplies|equipment|hardware/i, 'other_expense'],
]

export function categoryRole(name: string): string {
  for (const [re, role] of CATEGORIES) if (re.test(name)) return role
  return 'uncategorized_expense'
}

/** Expensify Classic's report page (the report's long id). */
export function reportUrl(reportID: string): string {
  return `https://www.expensify.com/report?param=${encodeURIComponent(JSON.stringify({ pageReportID: reportID }))}`
}

export interface Expense {
  id: string
  reportID: string
  reportName: string
  status: 'draft' | 'approved' | 'reimbursed'
  submitter: string
  merchant: string
  date: string
  amount: Money
  category: string
  note: string
  reimbursable: boolean
}

/** Report status → where it stands. Unknown statuses count as not yet approved (nothing is owed on a draft). */
export function reportStatus(s: string): Expense['status'] {
  const v = s.toLowerCase()
  if (v === 'reimbursed' || v === 'paid') return 'reimbursed'
  if (v === 'approved' || v === 'closed' || v === 'done' || v === 'archived') return 'approved'
  return 'draft'
}

const cents = (v: string): number | undefined => (/^-?\d+$/.test(v) ? Number(v) : undefined)

/** One export row as an expense, or null when it has no id or amount. Edited values win over SmartScan's. */
export function toExpense(r: ExportRow): Expense | null {
  if (!r.t || !r.r) return null
  const converted = cents(r.ca)
  const own = cents(r.ma) ?? cents(r.a)
  const [minor, cur] = converted !== undefined && r.rc ? [converted, r.rc] : own !== undefined ? [own, r.c || r.rc] : [undefined, '']
  if (minor === undefined || !cur) return null
  let date: string
  try {
    date = isoDate(r.md || r.d)
  } catch {
    return null
  }
  return {
    id: r.t,
    reportID: r.r,
    reportName: r.rn,
    status: reportStatus(r.rs),
    submitter: r.re || 'Employee',
    merchant: (r.mm || r.m || 'Expense').slice(0, 120),
    date,
    amount: { minor, currency: normalizeCurrency(cur) },
    category: r.cat,
    note: r.note,
    reimbursable: r.reim === '1',
  }
}

const line = (e: Expense, amount: number) => ({
  description: [e.merchant, e.category, e.note, `report ${e.reportName || e.reportID}: ${reportUrl(e.reportID)}`].filter(Boolean).join(' · ').slice(0, 500),
  amount: { minor: amount, currency: e.amount.currency },
  category: categoryRole(e.category),
})

const base = (externalId: string, connectionId: string, rawRef: string) => ({ externalId, connectionId, rawRef })

/** A company-card (non-reimbursable) expense: a paid bill and its payment. */
export function mapCardExpense(e: Expense, connectionId: string, rawRef: string): NormalizedEvent[] {
  const id = `exp:${e.id}`
  if (e.amount.minor === 0) return []
  // A refund or credit on the card (a negative expense) isn't sent: the card row of the money back is asked about as
  // usual, rather than left "not seen at the bank" here.
  if (e.amount.minor < 0) return []
  const bill: InvoiceUpsert = {
    type: 'invoice.upsert',
    ...base(id, connectionId, rawRef),
    direction: 'payable',
    number: e.reportID,
    counterparty: e.merchant,
    issueDate: e.date,
    total: e.amount,
    amountPaid: e.amount,
    status: 'paid',
    lines: [line(e, e.amount.minor)],
  }
  const pay: PaymentApplied = {
    type: 'payment.applied',
    ...base(id, connectionId, rawRef),
    direction: 'payable',
    date: e.date,
    amount: e.amount,
    method: 'card',
    counterparty: e.merchant,
    applications: [{ invoiceExternalId: id, amount: e.amount }],
    reference: e.reportID,
    status: 'posted',
  }
  return [bill, pay]
}

/** A report's reimbursable expenses: one bill owed to the person who paid, booked once the report is approved. */
export function mapReimbursableReport(expenses: Expense[], connectionId: string, rawRef: string): InvoiceUpsert | null {
  const first = expenses[0]
  if (!first) return null
  const cur = first.amount.currency
  const same = expenses.filter((e) => e.amount.currency === cur)
  const total = same.reduce((s, e) => s + e.amount.minor, 0)
  if (total <= 0) return null
  const issueDate = same.map((e) => e.date).sort().pop() as string
  return {
    type: 'invoice.upsert',
    ...base(`report:${first.reportID}`, connectionId, rawRef),
    direction: 'payable',
    number: first.reportID,
    counterparty: first.submitter,
    issueDate,
    total: { minor: total, currency: cur },
    amountPaid: { minor: 0, currency: cur },
    status: first.status === 'draft' ? 'draft' : 'open',
    lines: same.map((e) => line(e, e.amount.minor)),
  }
}
