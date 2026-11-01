// Arm A's files: what a person would download from each provider and upload to a chatbot, rendered from the same
// events Aggregate ingests in arm B. Each file follows its provider's export layout (column names, date formats, sign
// conventions, newest-first bank statements, report headers). Nothing is cleaned up or joined across sources:
// payouts are not matched to deposits, transfers are not paired, and refunds stay where the provider puts them.
import type { NormalizedEvent } from '../../packages/contracts/src/index.ts'
import type { Profile } from '../../packages/connectors/demo/src/profiles.ts'

export type ExportFile = { name: string; body: string }

const dollars = (minor: number) => (minor / 100).toFixed(2)
const csvCell = (v: string | number) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
const csv = (header: string[], rows: Array<Array<string | number>>) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n'
const mdy = (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`
const ts = (iso: string) => iso.slice(0, 19).replace('T', ' ')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
type Ev<T extends NormalizedEvent['type']> = Extract<NormalizedEvent, { type: T }>
const of = <T extends NormalizedEvent['type']>(events: NormalizedEvent[], t: T) => events.filter((e): e is Ev<T> => e.type === t)
/** The latest version of each object (providers export current state, not history). */
const latest = <T extends { externalId: string }>(xs: T[]): T[] => { const m = new Map<string, T>(); for (const x of xs) m.set(x.externalId, x); return [...m.values()] }

export function renderExports(profile: Profile, events: NormalizedEvent[], asOf: string): ExportFile[] {
  const files: ExportFile[] = []
  const txns = latest(of(events, 'txn.upsert')).filter((t) => t.status === 'posted' && t.date <= asOf)

  // Bank and card statements: one CSV per account, newest first. Bank accounts carry a running balance.
  for (const a of profile.accounts.filter((a) => a.type === 'depository' || a.type === 'credit_card' || a.type === 'cash_on_hand')) {
    const rows = txns.filter((t) => t.accountExternalId === a.id).sort((x, y) => x.date.localeCompare(y.date) || x.externalId.localeCompare(y.externalId))
    let bal = a.opening
    const withBal = rows.map((t) => { bal += t.amount.minor; return { t, bal } }).reverse()
    const name = `${slug(a.institution)}-${slug(a.name)}${a.mask ? '-' + a.mask : ''}.csv`
    if (a.type === 'credit_card') {
      // Card exports (Chase layout): purchases negative, payments positive, no balance column.
      files.push({ name, body: csv(['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'],
        withBal.map(({ t }) => [mdy(t.date), mdy(t.date), t.rawText ?? t.counterparty ?? '', chaseCategory(t.categoryHint), t.amount.minor < 0 ? 'Sale' : 'Payment', dollars(t.amount.minor)])) })
    } else if (a.type === 'cash_on_hand') {
      // A cash drawer has no provider: the shop's own count sheet.
      files.push({ name: `cash-drawer-log.csv`, body: csv(['Date', 'Entry', 'Amount', 'Drawer balance'], withBal.map(({ t, bal }) => [t.date, t.rawText ?? t.counterparty ?? '', dollars(t.amount.minor), dollars(bal)])) })
    } else {
      files.push({ name, body: csv(['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance'],
        withBal.map(({ t, bal }) => [t.amount.minor < 0 ? 'DEBIT' : 'CREDIT', mdy(t.date), t.rawText ?? t.counterparty ?? '', dollars(t.amount.minor), bankType(t.rawText ?? '', t.amount.minor), dollars(bal)])) })
    }
  }

  // Processors. Stripe: Balance > "Balance history" and Payouts exports. Shopify and others: a Shopify Payments export.
  const ptx = latest(of(events, 'processor.balance_txn')).filter((p) => p.at.slice(0, 10) <= asOf)
  for (const a of profile.accounts.filter((a) => a.type === 'processor_balance')) {
    const rows = ptx.filter((p) => p.accountExternalId === a.id).sort((x, y) => x.at.localeCompare(y.at))
    if (/stripe/i.test(a.institution)) {
      // Stripe reports fees as positive numbers; Amount is gross and Net = Amount - Fee.
      files.push({ name: 'stripe-balance-history.csv', body: csv(['id', 'Type', 'Source', 'Amount', 'Fee', 'Net', 'Currency', 'Created (UTC)', 'Available On (UTC)', 'Description', 'Customer ID', 'Customer Name', 'Transfer'],
        rows.map((p) => [`txn_${hash(p.externalId)}`, p.kind, p.sourceExternalId ?? (p.kind === 'payout' ? p.payoutExternalId ?? '' : ''), dollars(p.gross.minor), dollars(Math.abs(p.fee.minor)), dollars(p.net.minor), 'usd',
          ts(p.at), availableOn(p, rows), p.description ?? '', p.customer ?? '', p.counterparty ?? '', p.payoutExternalId ?? ''])) })
      files.push({ name: 'stripe-payouts.csv', body: csv(['id', 'Amount', 'Currency', 'Arrival Date (UTC)', 'Created (UTC)', 'Status', 'Type', 'Destination'],
        rows.filter((p) => p.kind === 'payout').map((p) => [p.payoutExternalId ?? `po_${hash(p.externalId)}`, dollars(Math.abs(p.net.minor)), 'usd', (p.arrivalDate ?? p.at.slice(0, 10)) + ' 00:00:00', ts(p.at), 'paid', 'bank_account', 'Bank account'])) })
    } else {
      files.push({ name: `${slug(a.institution)}-payments-transactions.csv`, body: csv(['Transaction Date', 'Type', 'Order', 'Amount', 'Fee', 'Net', 'Payout Date', 'Payout ID', 'Currency'],
        rows.map((p) => [ts(p.at) + ' -0000', p.kind === 'charge' ? 'charge (day total)' : p.kind, p.sourceExternalId ?? '', dollars(p.gross.minor), dollars(Math.abs(p.fee.minor)), dollars(p.net.minor), payoutDay(p, rows), p.payoutExternalId ?? '', 'USD'])) })
    }
  }

  // Subscriptions (Stripe Billing export, current state).
  const subs = latest(of(events, 'subscription.upsert'))
  if (subs.length) files.push({ name: 'stripe-subscriptions.csv', body: csv(['id', 'Customer', 'Status', 'Plan Amount', 'Plan Interval', 'Plan Interval Count', 'Created (UTC)', 'Canceled At (UTC)', 'Ended At (UTC)', 'Current Period End (UTC)', 'Cancel At Period End'],
    subs.map((s) => [`sub_${hash(s.externalId)}`, s.customer, s.status, dollars(s.items?.[0]?.amount.minor ?? s.mrr.minor), s.interval, s.intervalCount, ts(s.startedAt), s.canceledAt ? ts(s.canceledAt) : '', s.endedAt ? ts(s.endedAt) : '', s.currentPeriodEnd ? ts(s.currentPeriodEnd) : '', s.cancelAtPeriodEnd ? 'true' : 'false'])) })

  // Bills. Harbor's bills arrive by email and are paid from the bank, so the owner's export is the list of bills
  // received (no paid status: payments are only in the bank statement). Receivable invoices, if any, are a QuickBooks list.
  const inv = latest(of(events, 'invoice.upsert')).filter((i) => i.issueDate <= asOf).sort((a, b) => a.issueDate.localeCompare(b.issueDate) || (a.number ?? '').localeCompare(b.number ?? ''))
  const bills = inv.filter((i) => i.direction === 'payable'), invoices = inv.filter((i) => i.direction === 'receivable')
  if (bills.length) files.push({ name: 'bills-received.csv', body: csv(['Bill no.', 'Vendor', 'Bill date', 'Due date', 'Amount', 'Description'],
    bills.map((b) => [b.number ?? '', b.counterparty, b.issueDate, b.dueDate ?? '', dollars(b.total.minor), (b.lines ?? []).map((l) => l.description).join('; ')])) })
  if (invoices.length) files.push({ name: 'quickbooks-invoice-list.csv', body: `${profile.entityName}\nInvoice List\nAll Dates\n\n` + csv(['Date', 'Num', 'Customer', 'Due date', 'Amount', 'Open balance'],
    invoices.map((i) => [mdy(i.issueDate), i.number ?? '', i.counterparty, i.dueDate ? mdy(i.dueDate) : '', dollars(i.total.minor), dollars(i.total.minor - i.amountPaid.minor - (i.amountCredited?.minor ?? 0))])) })

  // Card statement: the summary box of the latest statement (APR, statement balance, minimum, due date), which a card's
  // transaction CSV doesn't carry.
  for (const a of latest(of(events, 'account.upsert')).filter((a) => a.liability?.lastStatementDate)) {
    const l = a.liability!
    files.push({ name: `${slug(a.institution ?? 'card')}-${slug(a.name)}-statement-${l.lastStatementDate}.txt`, body: [
      `${a.institution ?? ''} ${a.name} ending in ${a.mask ?? ''}`.trim(), `Statement closing date: ${mdy(l.lastStatementDate!)}`,
      ...(l.lastStatementBalance ? [`New balance: $${dollars(l.lastStatementBalance.minor)}`] : []),
      ...(l.minimumPayment ? [`Minimum payment due: $${dollars(l.minimumPayment.minor)}`] : []),
      ...(l.nextPaymentDueDate ? [`Payment due date: ${mdy(l.nextPaymentDueDate)}`] : []),
      ...(l.apr ? [`Purchase APR: ${l.apr}%`] : []), '',
    ].join('\n') })
  }

  // Payroll (the provider's "Payroll history" report: one row per run).
  const runs = latest(of(events, 'payroll.run')).filter((r) => r.payDate <= asOf && r.status !== 'void')
  if (runs.length) {
    const provider = slug(runs.find((r) => r.provider)?.provider ?? 'payroll')
    files.push({ name: `${provider}-payroll-history.csv`, body: csv(['Check Date', 'Pay Period Start', 'Pay Period End', 'Employees', 'Gross Earnings', 'Employee Taxes', 'Employer Taxes', 'Net Pay', 'Reimbursements', 'Total Company Debit'],
      runs.sort((a, b) => a.payDate.localeCompare(b.payDate)).map((r) => [mdy(r.payDate), r.periodStart ? mdy(r.periodStart) : '', r.periodEnd ? mdy(r.periodEnd) : '', r.employeeCount ?? '', dollars(r.gross.minor), dollars(r.employeeTaxes?.minor ?? 0),
        dollars(r.employerTaxes.minor), dollars(r.net.minor), dollars(r.reimbursements?.minor ?? 0), dollars(r.companyDebit?.minor ?? r.net.minor + r.employerTaxes.minor + (r.employeeTaxes?.minor ?? 0))])) })
  }

  // Cap table (Carta "Securities ledger" export).
  const eq = latest(of(events, 'equity.event')).filter((e) => e.date <= asOf)
  if (eq.length) files.push({ name: 'carta-securities-ledger.csv', body: csv(['Issue Date', 'Stakeholder', 'Security Type', 'Shares', 'Cash Paid', 'Status'],
    eq.sort((a, b) => a.date.localeCompare(b.date)).map((e) => [mdy(e.date), e.stakeholder, { issuance: 'Common', safe: 'SAFE', convertible_note: 'Convertible Note', option_grant: 'Option', exercise: 'Exercise', transfer: 'Transfer', cancellation: 'Cancellation', conversion: 'Conversion' }[e.kind], e.shares ?? '', e.amount ? dollars(e.amount.minor) : '', e.kind === 'cancellation' ? 'Canceled' : 'Outstanding'])) })

  return files
}

function bankType(raw: string, minor: number): string {
  if (/ACH|GUSTO|ADP|STRIPE|SHOPIFY|PAYROLL/i.test(raw)) return minor < 0 ? 'ACH_DEBIT' : 'ACH_CREDIT'
  if (/WIRE/i.test(raw)) return 'WIRE'
  if (/TRANSFER|XFER/i.test(raw)) return 'ACCT_XFER'
  if (/CHECK/i.test(raw)) return 'CHECK'
  return minor < 0 ? 'DEBIT_CARD' : 'MISC_CREDIT'
}
function hash(s: string): string { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0).toString(36).padStart(7, '0') + s.length.toString(36) }

/** The day a row's payout arrives (its payout row's arrival date), as the provider shows it. */
function payoutDay(p: { payoutExternalId?: string; arrivalDate?: string; at: string; kind: string }, rows: Array<{ kind: string; payoutExternalId?: string; arrivalDate?: string; at: string }>): string {
  if (!p.payoutExternalId) return ''
  const po = rows.find((r) => r.kind === 'payout' && r.payoutExternalId === p.payoutExternalId)
  return po ? (po.arrivalDate ?? po.at.slice(0, 10)) : ''
}
function availableOn(p: { payoutExternalId?: string; arrivalDate?: string; at: string; kind: string }, rows: Array<{ kind: string; payoutExternalId?: string; arrivalDate?: string; at: string }>): string {
  const day = p.kind === 'payout' ? (p.arrivalDate ?? p.at.slice(0, 10)) : payoutDay(p, rows) || p.at.slice(0, 10)
  return `${day} 00:00:00` < ts(p.at) ? ts(p.at) : `${day} 00:00:00`
}
/** Chase's card categories (what its CSV says), from a provider category code. */
function chaseCategory(code?: string): string {
  const c = (code ?? '').toUpperCase()
  if (!c) return ''
  if (/SOFTWARE|SUBSCRIPTION|UTILIT|TELECOM|INTERNET|PHONE/.test(c)) return 'Bills & Utilities'
  if (/FOOD|RESTAURANT|COFFEE|DRINK/.test(c)) return 'Food & Drink'
  if (/TRAVEL|TRANSPORT|TAXI|AIR|LODGING/.test(c)) return 'Travel'
  if (/GAS|FUEL/.test(c)) return 'Gas'
  if (/LOAN|CREDIT_CARD_PAYMENT|TRANSFER/.test(c)) return ''
  if (/SERVICE|PROFESSIONAL|ADVERTIS|MARKETING/.test(c)) return 'Professional Services'
  if (/OFFICE|SUPPL|MERCHANDISE|SHOP/.test(c)) return 'Shopping'
  if (/HEALTH|MEDICAL/.test(c)) return 'Health & Wellness'
  return 'Miscellaneous'
}
