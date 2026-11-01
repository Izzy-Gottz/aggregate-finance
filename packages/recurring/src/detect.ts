// Recurring bills and subscriptions from bank and card rows (landscape item 7; approach after Sure's
// recurring_transaction identifier and price-change detector, written fresh here):
//   - group money-out rows by company, counterparty and currency;
//   - within a group, amounts within 7.5% of each other are one charge; their dates must keep a cadence;
//   - 2 occurrences are enough to *suggest* a series, 3 to *act* on it (bills due, upcoming, the Monday note);
//   - a later run of the same charge at a different amount, on the same cadence, is a price change, not a new bill;
//   - a tiny first charge (≤10% of the real price, $0 auths included) shortly before the real one is a trial that
//     converted to paid.
// Pure functions: rows in, series out. No database, no clock (asOf is passed in).

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'

export interface Row {
  id: string
  entityId: string
  date: string // YYYY-MM-DD
  /** Money out is negative, in minor units. */
  minor: number
  currency: string
  counterparty: string | null
}

export type SeriesEvent =
  | { kind: 'price_increase' | 'price_decrease'; date: string; fromMinor: number; toMinor: number; pct: number }
  | { kind: 'trial_converted'; date: string; trialMinor: number; toMinor: number }

export interface Series {
  id: string
  entityId: string
  counterparty: string
  currency: string
  cadence: Cadence
  /** suggested: seen twice; active: three or more times; ended: no charge for two full periods. */
  status: 'suggested' | 'active' | 'ended'
  /** The current price (latest charge), positive minor units. */
  amountMinor: number
  monthlyMinor: number
  occurrences: number
  firstDate: string
  lastDate: string
  /** The next expected charge: one period after the last one seen. */
  nextDue: string
  /** That charge is past due by more than the cadence allows and hasn't shown up (late, or cancelled). */
  late: boolean
  events: SeriesEvent[]
  recordIds: string[]
}

export const AMOUNT_TOLERANCE = 0.075
const TRIAL_RATIO = 0.1
const TRIAL_MAX_DAYS = 35

const CADENCES: Array<[Cadence, number, number]> = [
  ['weekly', 7, 1],
  ['biweekly', 14, 2],
  ['monthly', 30, 4],
  ['quarterly', 91, 8],
  ['yearly', 365, 15],
]

const STOP = new Set(['inc', 'llc', 'ltd', 'co', 'corp', 'com', 'www', 'the', 'payment', 'pmt', 'ach', 'debit', 'pos', 'purchase', 'recurring', 'online', 'autopay', 'bill', 'card'])

/** "ADOBE *CREATIVE CLD 8004" → "adobe creative cld"; "Figma, Inc." → "figma". */
export function counterpartyKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .slice(0, 3)
    .join(' ')
}

function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

export function addCadence(date: string, c: Cadence): string {
  const d = new Date(`${date}T00:00:00Z`)
  if (c === 'weekly' || c === 'biweekly') d.setUTCDate(d.getUTCDate() + (c === 'weekly' ? 7 : 14))
  else {
    const day = d.getUTCDate()
    d.setUTCDate(1)
    d.setUTCMonth(d.getUTCMonth() + (c === 'monthly' ? 1 : c === 'quarterly' ? 3 : 12))
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
    d.setUTCDate(Math.min(day, last))
  }
  return d.toISOString().slice(0, 10)
}

export function monthlyEquivalent(minor: number, c: Cadence): number {
  return Math.round(c === 'weekly' ? (minor * 52) / 12 : c === 'biweekly' ? (minor * 26) / 12 : c === 'monthly' ? minor : c === 'quarterly' ? minor / 3 : minor / 12)
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2)
}

/** The cadence all gaps agree on, if any. */
function cadenceOf(dates: string[]): Cadence | null {
  if (dates.length < 2) return null
  const gaps = dates.slice(1).map((d, i) => days(dates[i] as string, d))
  const med = median(gaps)
  const hit = CADENCES.find(([, n, tol]) => Math.abs(med - n) <= tol)
  if (!hit) return null
  const [c, n, tol] = hit
  return gaps.every((g) => Math.abs(g - n) <= tol) ? c : null
}

function fits(gap: number, c: Cadence): boolean {
  const [, n, tol] = CADENCES.find(([x]) => x === c) as [Cadence, number, number]
  return Math.abs(gap - n) <= tol
}

interface Cluster {
  rows: Row[] // by date
  minor: number // typical amount (median), positive
}

/** Amounts within 7.5% of the cluster's smallest belong together; each cluster is sorted by date. */
function clusterAmounts(rows: Row[]): Cluster[] {
  const byAmount = [...rows].sort((a, b) => Math.abs(a.minor) - Math.abs(b.minor))
  const out: Cluster[] = []
  let cur: Row[] = []
  let base = 0
  for (const r of byAmount) {
    const a = Math.abs(r.minor)
    if (cur.length && a > base * (1 + AMOUNT_TOLERANCE) && !(base === 0 && a === 0)) {
      out.push({ rows: cur, minor: 0 })
      cur = []
    }
    if (!cur.length) base = a
    cur.push(r)
  }
  if (cur.length) out.push({ rows: cur, minor: 0 })
  for (const c of out) {
    c.rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
    c.minor = median(c.rows.map((r) => Math.abs(r.minor)))
  }
  return out
}

/** Detect series in money-out rows. `asOf` decides what has ended and what is next. */
export function detectRecurring(rows: readonly Row[], asOf: string): Series[] {
  const groups = new Map<string, { label: string; rows: Row[] }>()
  for (const r of rows) {
    if (r.minor > 0 || !r.counterparty) continue
    const key = counterpartyKey(r.counterparty)
    if (key.length < 2) continue
    const g = `${r.entityId}|${key}|${r.currency}`
    const cur = groups.get(g) ?? { label: r.counterparty, rows: [] }
    cur.rows.push(r)
    cur.label = r.counterparty // latest wins below once sorted
    groups.set(g, cur)
  }
  const out: Series[] = []
  for (const [g, { rows: rs }] of groups) {
    rs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const clusters = clusterAmounts(rs).sort((a, b) => ((a.rows[0] as Row).date < (b.rows[0] as Row).date ? -1 : 1))
    const used = new Set<Cluster>()
    for (const c of clusters) {
      if (used.has(c)) continue
      const cad = cadenceOf(c.rows.map((r) => r.date))
      if (!cad) continue
      used.add(c)
      let members = [...c.rows]
      const events: SeriesEvent[] = []
      let price = c.minor
      // Follow price changes: a later cluster that starts one period after this one's last charge.
      for (;;) {
        const last = members[members.length - 1] as Row
        const next = clusters.find((o) => !used.has(o) && (o.rows[0] as Row).date > last.date && fits(days(last.date, (o.rows[0] as Row).date), cad) && (o.rows.length < 2 || cadenceOf(o.rows.map((r) => r.date)) === cad))
        if (!next) break
        used.add(next)
        const to = Math.abs((next.rows[0] as Row).minor)
        events.push({ kind: to > price ? 'price_increase' : 'price_decrease', date: (next.rows[0] as Row).date, fromMinor: price, toMinor: to, pct: Math.round(((to - price) / price) * 1000) / 10 })
        members = [...members, ...next.rows]
        price = next.minor
      }
      // A trial that converted: a tiny charge (or $0) shortly before the first full-price one.
      const first = members[0] as Row
      const trial = clusters.find((o) => !used.has(o) && o.rows.length === 1 && Math.abs((o.rows[0] as Row).minor) <= Math.abs(first.minor) * TRIAL_RATIO && (o.rows[0] as Row).date < first.date && days((o.rows[0] as Row).date, first.date) <= TRIAL_MAX_DAYS)
      if (trial) {
        used.add(trial)
        const t = trial.rows[0] as Row
        events.unshift({ kind: 'trial_converted', date: first.date, trialMinor: Math.abs(t.minor), toMinor: Math.abs(first.minor) })
        members = [t, ...members]
      }
      const paid = members.filter((m) => !trial || m !== trial.rows[0])
      const lastRow = members[members.length - 1] as Row
      const amountMinor = Math.abs(lastRow.minor)
      const nextDue = addCadence(lastRow.date, cad)
      const [, n, tol] = CADENCES.find(([x]) => x === cad) as [Cadence, number, number]
      const ended = days(lastRow.date, asOf) > n * 2 + tol
      const [entityId, key, currency] = g.split('|') as [string, string, string]
      out.push({
        id: `rec:${entityId}:${key.replace(/\s+/g, '-')}:${currency}:${(c.rows[0] as Row).date}`,
        entityId,
        counterparty: lastRow.counterparty ?? key,
        currency,
        cadence: cad,
        status: ended ? 'ended' : paid.length >= confirmAfter(cad) ? 'active' : 'suggested',
        amountMinor,
        monthlyMinor: monthlyEquivalent(amountMinor, cad),
        occurrences: paid.length,
        firstDate: (members[0] as Row).date,
        lastDate: lastRow.date,
        nextDue,
        late: !ended && days(nextDue, asOf) > tol,
        events,
        recordIds: members.map((m) => m.id),
      })
    }
  }
  return out.sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : a.counterparty < b.counterparty ? -1 : 1))
}

/** Payments that confirm a series: three, but two for yearly (a third takes more than two years). */
function confirmAfter(c: Cadence): number {
  return c === 'yearly' ? 2 : 3
}

/** Active series whose next charge falls in [from, to]. */
export function dueBetween(series: readonly Series[], from: string, to: string): Series[] {
  return series.filter((s) => s.status === 'active' && s.nextDue >= from && s.nextDue <= to)
}
