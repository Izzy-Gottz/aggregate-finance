// Monday note: five plain lines (MASTER §3 / PLAN §2): cash by company, in and out last week, overdue invoices,
// bills due, one odd thing. Read-only; S9 sends it.
import type { EntityId, IsoDate, Money } from '@agfn/contracts'
import { findAnomalies, type Anomaly } from './anomalies.ts'
import { openItems } from './checks.ts'
import { cashFlowSection, isCashLikeRole } from './coa.ts'
import { computeMetric, type MetricContext } from './metrics.ts'
import { addDays, ledgerAccounts, scopeEntities, sumLinesIn, today, todayFor } from './queries.ts'
import type { LineRow } from './store.ts'

export interface WeeklyDigest {
  /** False when nothing is connected yet (the sender skips the email). */
  hasData: boolean
  subject: string
  asOf: IsoDate
  /** Last week, Monday–Sunday before asOf's week. */
  week: { from: IsoDate; to: IsoDate }
  currency: string
  /** Exactly five lines, ready for a plain-text email. */
  lines: [string, string, string, string, string]
  data: {
    cash: Array<{ entityId: EntityId; name: string; cash: Money | null }>
    moneyIn: Money
    moneyOut: Money
    overdue: { count: number; total: Money }
    billsDue: { count: number; total: Money; through: IsoDate }
    odd: Anomaly | null
  }
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', ILS: '₪', JPY: '¥' }

/** "$284,410" — whole units for the note; amounts are rounded, the app has the cents. */
export function shortMoney(m: Money): string {
  const units = Math.round(m.minor / (m.currency === 'JPY' || m.currency === 'KRW' ? 1 : m.currency === 'KWD' || m.currency === 'BHD' ? 1000 : 100))
  const body = Math.abs(units).toLocaleString('en-US')
  const sym = SYMBOLS[m.currency]
  return `${units < 0 ? '-' : ''}${sym ? `${sym}${body}` : `${body} ${m.currency}`}`
}

function weekLabel(monday: IsoDate): string {
  const d = new Date(`${monday}T00:00:00Z`)
  return `week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

/** Monday of the week containing `date` (ISO weeks). */
function mondayOf(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  const dow = (d.getUTCDay() + 6) % 7
  return addDays(date, -dow)
}

export async function weeklyDigest(rc: MetricContext, asOf?: IsoDate, entityIds: EntityId[] | 'all' = 'all'): Promise<WeeklyDigest> {
  const date = asOf ?? (await todayFor(rc))
  const thisMonday = mondayOf(date)
  const week = { from: addDays(thisMonday, -7), to: addDays(thisMonday, -1) }
  const entities = (await scopeEntities(rc, entityIds)).filter((e) => e.kind === 'company' || entityIds !== 'all')
  const ids = entities.map((e) => e.id)
  const currency = await rc.directory.reportingCurrency(rc.ws)
  const memo: MetricContext = { ...rc, memo: rc.memo ?? new Map() }

  // 1) Cash by company.
  const cash: WeeklyDigest['data']['cash'] = []
  for (const e of entities) {
    const a = await computeMetric('cash', { workspaceId: rc.ws, entityIds: [e.id], to: date }, memo)
    cash.push({ entityId: e.id, name: e.name, cash: a.value && typeof a.value === 'object' ? a.value : null })
  }
  const withCash = cash.filter((c) => c.cash)
  let totalCash = 0
  for (const c of withCash) totalCash += (await rc.toCurrency(c.cash as Money, currency, date)).minor
  const parts = withCash.map((c) => `${c.name} ${shortMoney(c.cash as Money)}`).join(' · ')
  const line1 = withCash.length === 0 ? 'Cash: no balances yet' : withCash.length === 1 ? `Cash: ${parts}` : `Cash: ${shortMoney({ minor: totalCash, currency })} across ${withCash.length} companies (${parts})`

  // 2) Money in and out last week: movements of cash, cards and processor balances, internal transfers left out.
  const idx = await ledgerAccounts(rc, ids)
  const lines = ids.length ? await rc.store.listLines(rc.ws, { entityIds: ids, basis: 'cash', fromDate: week.from, toDate: week.to }) : []
  const byEntry = new Map<string, LineRow[]>()
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l])
  // Net per source record, so a reposted row (reversal + new entry) counts once; first-seen balances aren't movements.
  const bySource = new Map<string, LineRow[]>()
  for (const entry of byEntry.values()) {
    const pool = (l: LineRow) => {
      const role = idx.byId.get(l.ledgerAccountId)?.role ?? ''
      return isCashLikeRole(role) || role.startsWith('card:')
    }
    if (!entry.some(pool)) continue
    for (const l of entry) {
      const role = idx.byId.get(l.ledgerAccountId)?.role ?? ''
      if (pool(l) || role === 'opening_balance_equity' || cashFlowSection(role) === 'internal') continue
      bySource.set(l.sourceId, [...(bySource.get(l.sourceId) ?? []), l])
    }
  }
  const byId = new Map(entities.map((e) => [e.id, e]))
  let inMinor = 0
  let outMinor = 0
  for (const group of bySource.values()) {
    const v = await sumLinesIn(rc, group, byId, currency)
    if (v < 0) inMinor += -v
    else outMinor += v
  }
  const moneyIn: Money = { minor: inMinor, currency }
  const moneyOut: Money = { minor: outMinor, currency }
  const line2 = `Last week: ${shortMoney(moneyIn)} in, ${shortMoney(moneyOut)} out`

  // 3) Overdue invoices. 4) Bills due this week (and anything already overdue).
  let overdueCount = 0
  let overdueMinor = 0
  for (const it of await openItems(rc, ids, 'receivable', date)) {
    if (!it.dueDate || it.dueDate >= date) continue
    overdueCount++
    overdueMinor += (await rc.toCurrency({ minor: it.remainingMinor, currency: it.currency }, currency, date)).minor
  }
  const through = addDays(thisMonday, 6)
  let billCount = 0
  let billMinor = 0
  for (const it of await openItems(rc, ids, 'payable', date)) {
    if (it.dueDate && it.dueDate > through) continue
    billCount++
    billMinor += (await rc.toCurrency({ minor: it.remainingMinor, currency: it.currency }, currency, date)).minor
  }
  const line3 = overdueCount ? `Overdue invoices: ${overdueCount}, ${shortMoney({ minor: overdueMinor, currency })}` : 'No overdue invoices'
  const line4 = billCount ? `Bills due this week: ${billCount}, ${shortMoney({ minor: billMinor, currency })}` : 'No bills due this week'

  // 5) One odd thing: the most important finding from the last week.
  const odd = (await findAnomalies(rc, { entityIds: ids, asOf: date, windowDays: 14 }))[0] ?? null
  const line5 = odd ? `Odd: ${odd.title} (${odd.detail})` : 'Nothing odd'

  const hasData = ids.length > 0 && (withCash.length > 0 || lines.length > 0 || overdueCount > 0 || billCount > 0)
  return {
    hasData,
    subject: `Your week in money · ${weekLabel(thisMonday)}`,
    asOf: date,
    week,
    currency,
    lines: [line1, line2, line3, line4, line5],
    data: { cash, moneyIn, moneyOut, overdue: { count: overdueCount, total: { minor: overdueMinor, currency } }, billsDue: { count: billCount, total: { minor: billMinor, currency }, through }, odd },
  }
}
