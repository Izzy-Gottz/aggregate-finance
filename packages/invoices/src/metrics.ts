// AR/AP metrics in code, never by the AI (finance-model.md §8). Each returns the value plus the row ids behind it.
import type { Currency, IsoDate, Money } from '@agfn/contracts'
import { addDays, daysBetween } from './dates.ts'
import { add, zero } from './money.ts'
import type { Direction, InvoiceView, Subledger } from './subledger.ts'

export interface MoneyByCurrency {
  /** One entry per currency; never summed across currencies here (FX is the ledger's job). */
  totals: Money[]
  rowIds: string[]
  formula: string
}

function totalBy(views: InvoiceView[], pick: (v: InvoiceView) => Money, formula: string): MoneyByCurrency {
  const map = new Map<Currency, Money>()
  for (const v of views) {
    const m = pick(v)
    map.set(m.currency, add(map.get(m.currency) ?? zero(m.currency), m))
  }
  return {
    totals: [...map.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
    rowIds: views.map((v) => v.key),
    formula,
  }
}

function openDocs(ledger: Subledger, direction: Direction, asOf: IsoDate): InvoiceView[] {
  return ledger.list({ direction, asOf, openOnly: true }).filter((v) => v.remaining.minor > 0)
}

/** ar_open: remaining on open receivables (open, partially paid, disputed). */
export function arOpen(ledger: Subledger, asOf: IsoDate): MoneyByCurrency {
  return totalBy(openDocs(ledger, 'receivable', asOf), (v) => v.remaining, 'sum(total − paid − credited − written off) over open receivables')
}

/** ar_overdue: open receivables with due_date < as_of. */
export function arOverdue(ledger: Subledger, asOf: IsoDate): MoneyByCurrency {
  return totalBy(
    openDocs(ledger, 'receivable', asOf).filter((v) => v.overdue),
    (v) => v.remaining,
    'sum(remaining) over open receivables with due_date < as_of',
  )
}

export interface ApDue {
  open: MoneyByCurrency
  overdue: MoneyByCurrency
  dueNext7: MoneyByCurrency
  dueNext30: MoneyByCurrency
  /** Bills due in the next 30 days (or overdue), soonest first, for "Bills & you owe soon". */
  upcoming: InvoiceView[]
}

/** ap_due: open bills, plus what's overdue and what's due in the next 7 and 30 days. */
export function apDue(ledger: Subledger, asOf: IsoDate): ApDue {
  const open = openDocs(ledger, 'payable', asOf)
  const dueBy = (d: number): InvoiceView[] => open.filter((v) => !v.overdue && daysBetween(asOf, v.dueDate ?? v.issueDate) <= d)
  const in30 = dueBy(30)
  return {
    open: totalBy(open, (v) => v.remaining, 'sum(remaining) over open bills'),
    overdue: totalBy(open.filter((v) => v.overdue), (v) => v.remaining, 'sum(remaining) over open bills with due_date < as_of'),
    dueNext7: totalBy(dueBy(7), (v) => v.remaining, 'sum(remaining) over open bills due within 7 days'),
    dueNext30: totalBy(in30, (v) => v.remaining, 'sum(remaining) over open bills due within 30 days'),
    upcoming: [...open.filter((v) => v.overdue), ...in30],
  }
}

export interface DaysOutstanding {
  currency: Currency
  /** null when hidden (fewer than `minDocs` documents issued in the window). */
  days: number | null
  open: Money
  issued: Money
  issuedCount: number
  windowDays: number
  rowIds: string[]
  formula: string
}

/**
 * DSO (receivable) / DPO (payable): open amount at as_of ÷ amount issued over the trailing window × window days.
 * Only invoice-based sales count. Hidden when fewer than 3 documents were issued in the window.
 */
export function daysOutstanding(ledger: Subledger, direction: Direction, asOf: IsoDate, windowDays = 90, minDocs = 3): DaysOutstanding[] {
  const from = addDays(asOf, -windowDays + 1)
  const all = ledger.list({ direction, asOf })
  const currencies = [...new Set(all.map((v) => v.total.currency))].sort()
  return currencies.map((currency) => {
    const inCur = all.filter((v) => v.total.currency === currency)
    const issued = inCur.filter((v) => v.issueDate >= from && v.issueDate <= asOf && v.status !== 'void' && v.status !== 'draft')
    const open = inCur.filter((v) => (v.status === 'open' || v.status === 'partially_paid' || v.status === 'disputed') && v.remaining.minor > 0)
    const openSum = open.reduce((acc, v) => add(acc, v.remaining), zero(currency))
    const issuedSum = issued.reduce((acc, v) => add(acc, v.total), zero(currency))
    const show = issued.length >= minDocs && issuedSum.minor > 0
    return {
      currency,
      days: show ? Math.round((openSum.minor / issuedSum.minor) * windowDays * 10) / 10 : null,
      open: openSum,
      issued: issuedSum,
      issuedCount: issued.length,
      windowDays,
      rowIds: [...new Set([...open, ...issued].map((v) => v.key))],
      formula: `(open ${direction === 'receivable' ? 'AR' : 'AP'} at as_of ÷ issued over trailing ${windowDays} days) × ${windowDays}; hidden under ${minDocs} documents`,
    }
  })
}
