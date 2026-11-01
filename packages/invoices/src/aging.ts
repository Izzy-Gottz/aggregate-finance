// AR/AP aging (finance-model.md §8): open amounts bucketed by days past due as of a date.
import type { Currency, IsoDate, Money } from '@agfn/contracts'
import { daysBetween } from './dates.ts'
import { add, zero } from './money.ts'
import { normalizeName, type Direction, type InvoiceView, type Subledger } from './subledger.ts'

export type AgingBucket = 'current' | '1_30' | '31_60' | '61_90' | '90_plus'
export const AGING_BUCKETS: readonly AgingBucket[] = ['current', '1_30', '31_60', '61_90', '90_plus']

export function bucketFor(daysPastDue: number): AgingBucket {
  if (daysPastDue <= 0) return 'current'
  if (daysPastDue <= 30) return '1_30'
  if (daysPastDue <= 60) return '31_60'
  if (daysPastDue <= 90) return '61_90'
  return '90_plus'
}

export interface AgingRow {
  counterparty: string
  buckets: Record<AgingBucket, Money>
  total: Money
  disputed: Money
  invoiceKeys: string[]
}

export interface AgingReport {
  direction: Direction
  asOf: IsoDate
  currency: Currency
  buckets: Record<AgingBucket, Money>
  total: Money
  /** Disputed amounts stay inside their buckets and are also flagged here. */
  disputed: Money
  byCounterparty: AgingRow[]
  invoiceKeys: string[]
}

/** Days past due. Documents without a due date age from the issue date (due on receipt). */
export function daysPastDue(v: Pick<InvoiceView, 'dueDate' | 'issueDate'>, asOf: IsoDate): number {
  return daysBetween(v.dueDate ?? v.issueDate, asOf)
}

/**
 * One report per currency: amounts in different currencies are never added together here.
 * Home-currency totals are the ledger's job (FX rates live there).
 */
export function aging(ledger: Subledger, direction: Direction, asOf: IsoDate): AgingReport[] {
  const open = ledger.list({ direction, asOf, openOnly: true }).filter((v) => v.remaining.minor > 0)
  const byCurrency = new Map<Currency, InvoiceView[]>()
  for (const v of open) {
    const list = byCurrency.get(v.remaining.currency) ?? []
    list.push(v)
    byCurrency.set(v.remaining.currency, list)
  }
  const reports: AgingReport[] = []
  for (const [currency, views] of [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const report: AgingReport = {
      direction,
      asOf,
      currency,
      buckets: emptyBuckets(currency),
      total: zero(currency),
      disputed: zero(currency),
      byCounterparty: [],
      invoiceKeys: [],
    }
    const rows = new Map<string, AgingRow>()
    for (const v of views) {
      const b = bucketFor(daysPastDue(v, asOf))
      const id = normalizeName(v.counterparty) || v.counterparty
      let row = rows.get(id)
      if (!row) {
        row = { counterparty: v.counterparty, buckets: emptyBuckets(currency), total: zero(currency), disputed: zero(currency), invoiceKeys: [] }
        rows.set(id, row)
      }
      for (const target of [report, row]) {
        target.buckets[b] = add(target.buckets[b], v.remaining)
        target.total = add(target.total, v.remaining)
        if (v.status === 'disputed') target.disputed = add(target.disputed, v.remaining)
        target.invoiceKeys.push(v.key)
      }
    }
    report.byCounterparty = [...rows.values()].sort((a, b) => b.total.minor - a.total.minor || (a.counterparty < b.counterparty ? -1 : 1))
    reports.push(report)
  }
  return reports
}

function emptyBuckets(currency: Currency): Record<AgingBucket, Money> {
  return { current: zero(currency), '1_30': zero(currency), '31_60': zero(currency), '61_90': zero(currency), '90_plus': zero(currency) }
}
