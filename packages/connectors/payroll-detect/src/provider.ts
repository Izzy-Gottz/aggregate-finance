// Shared by the payroll provider connectors (Finch, Justworks, Rippling, Deel): date-window paging and one
// builder from provider totals to a PayrollRun, so every provider fills the same fields the same way.
import type { ConnectionId, Currency, Id, IsoDate, Money, PayrollRun } from '@agfn/contracts'
import { addDays, daysBetween } from '@agfn/invoices'

export interface RunInput {
  externalId: string
  connectionId: ConnectionId
  rawRef?: Id
  provider: string
  payDate: IsoDate
  currency: Currency
  /** Integer minor units. */
  gross: number
  net: number
  employerTaxes: number
  employeeTaxes?: number
  employerBenefits?: number
  reimbursements?: number
  companyDebit?: number
  periodStart?: IsoDate
  periodEnd?: IsoDate
  lines?: PayrollRun['lines']
  employeeCount?: number
  /** Provider says the run was voided / reversed. */
  voided?: boolean
  /** Today, for telling scheduled runs from paid ones. */
  today: IsoDate
}

export function providerRun(r: RunInput): PayrollRun {
  const m = (minor: number): Money => ({ minor, currency: r.currency })
  const run: PayrollRun = {
    type: 'payroll.run',
    externalId: r.externalId,
    connectionId: r.connectionId,
    payDate: r.payDate,
    gross: m(r.gross),
    employerTaxes: m(r.employerTaxes),
    net: m(r.net),
    source: 'provider',
    estimated: false,
    status: r.voided ? 'void' : r.payDate > r.today ? 'scheduled' : 'paid',
    provider: r.provider,
  }
  if (r.rawRef !== undefined) run.rawRef = r.rawRef
  if (r.employeeTaxes !== undefined) run.employeeTaxes = m(r.employeeTaxes)
  if (r.employerBenefits !== undefined) run.employerBenefits = m(r.employerBenefits)
  if (r.reimbursements !== undefined) run.reimbursements = m(r.reimbursements)
  if (r.companyDebit !== undefined) run.companyDebit = m(r.companyDebit)
  if (r.periodStart) run.periodStart = r.periodStart
  if (r.periodEnd) run.periodEnd = r.periodEnd
  if (r.lines && r.lines.length) run.lines = r.lines
  if (r.employeeCount !== undefined) run.employeeCount = r.employeeCount
  return run
}

/** Window cursor: sync [from, end] in steps of `days`. */
export interface WindowState {
  from: IsoDate
  end: IsoDate
  /** Next pass starts here minus the lookback (payroll gets corrected and re-run). */
  mark: IsoDate
}

export interface WindowPlan {
  /** Days of history on the first sync. Default 730 (two years). */
  backfillDays?: number
  /** Re-read this many days before the last pass, to catch corrections. Default 45. */
  lookbackDays?: number
  /** Window size per page. Default 90. */
  windowDays?: number
  /** Look this far ahead for scheduled runs. Default 31. */
  aheadDays?: number
}

export function startWindow(prev: WindowState | null, today: IsoDate, plan: WindowPlan = {}): WindowState {
  const from = prev ? addDays(prev.mark, -(plan.lookbackDays ?? 45)) : addDays(today, -(plan.backfillDays ?? 730))
  return { from, end: addDays(today, plan.aheadDays ?? 31), mark: today }
}

/** The current page's [from, to] and the state after it (null = pass complete). */
export function stepWindow(s: WindowState, plan: WindowPlan = {}): { from: IsoDate; to: IsoDate; next: WindowState | null } {
  const days = plan.windowDays ?? 90
  const to = daysBetween(s.from, s.end) < days ? s.end : addDays(s.from, days - 1)
  return { from: s.from, to, next: to >= s.end ? null : { ...s, from: addDays(to, 1) } }
}

export function isWindowState(v: unknown): v is WindowState {
  return typeof v === 'object' && v !== null && typeof (v as WindowState).from === 'string' && typeof (v as WindowState).end === 'string' && typeof (v as WindowState).mark === 'string'
}
