// MRR over time: each subscription's monthly value as a dated series, MRR on any day, and the monthly movements
// (new, expansion, reactivation, contraction, churn) per customer, the way ChartMogul and Baremetrics count them.
import type { EntityId, Id, IsoDate, MrrMovementView, SubscriptionUpsert } from '@agfn/contracts'
import type { MetricContext } from './metrics.ts'
import { localDate, zoneOf } from './queries.ts'

export interface MrrSeries {
  recordId: Id
  connectionId: Id
  entityId: EntityId | null
  customer: string
  currency: string
  /** From each date on, the subscription's monthly value (minor units), oldest first. */
  points: Array<{ date: IsoDate; minor: number }>
  /** Its items' product names, each with its share of the subscription's value (shares add up to 1). */
  products: Array<{ name: string; share: number }>
}

/** Product names an item list carries, each with its share of the value (by item amount × quantity, else evenly). */
function productShares(ev: SubscriptionUpsert): Array<{ name: string; share: number }> {
  const items = (ev.items ?? []).filter((i) => i.product?.trim())
  if (items.length === 0) return []
  const weight = new Map<string, number>()
  for (const i of items) weight.set(i.product!.trim(), (weight.get(i.product!.trim()) ?? 0) + Math.max(0, i.amount.minor * (i.quantity || 1)))
  const total = [...weight.values()].reduce((a, b) => a + b, 0)
  return [...weight].map(([name, w]) => ({ name, share: total > 0 ? w / total : 1 / weight.size }))
}

/** Product names behind these (series, value) pairs: by contribution then name, the top 10 and how many more. */
export function productList(parts: Array<{ products: MrrSeries['products']; minor: number }>): { products: string[]; productsMore?: number } {
  const by = new Map<string, number>()
  for (const p of parts) for (const x of p.products) by.set(x.name, (by.get(x.name) ?? 0) + x.share * p.minor)
  const names = [...by].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([n]) => n)
  return names.length > PRODUCTS_SHOWN ? { products: names.slice(0, PRODUCTS_SHOWN), productsMore: names.length - PRODUCTS_SHOWN } : { products: names }
}
const PRODUCTS_SHOWN = 10

export type MrrMonth = MrrMovementView

/** What the subscription counts for now: Stripe's MRR for active and past-due subscriptions, else nothing. */
export function currentMrr(ev: SubscriptionUpsert): number {
  return ev.status === 'active' || ev.status === 'past_due' ? Math.max(0, ev.mrr.minor) : 0
}

/** Monthly value from its items (for a subscription that ended before we saw it, when `mrr` is already zero). */
export function itemsMrr(ev: SubscriptionUpsert): number {
  const per = ev.items?.reduce((s, i) => (i.amount.currency === ev.mrr.currency ? s + i.amount.minor * i.quantity : s), 0) ?? 0
  const n = Math.max(1, ev.intervalCount)
  const monthly = ev.interval === 'month' ? per / n : ev.interval === 'year' ? per / (12 * n) : ev.interval === 'week' ? (per * 52) / (12 * n) : (per * 365) / (12 * n)
  return Math.max(0, Math.round(monthly))
}

function endDate(ev: SubscriptionUpsert, timeZone: string): IsoDate | null {
  const at = ev.endedAt ?? ev.canceledAt
  return at ? localDate(at, timeZone) : null
}

/**
 * The provider's own past values (SubscriptionUpsert.changes) as points: none after `today`, one per day (the last
 * wins), and no point that repeats the value before it.
 */
export function changePoints(ev: SubscriptionUpsert, today: IsoDate, timeZone: string): Array<{ date: IsoDate; minor: number }> {
  const out: Array<{ date: IsoDate; minor: number }> = []
  for (const c of ev.changes ?? []) {
    if (c.mrr.currency !== ev.mrr.currency) continue
    const date = localDate(c.at, timeZone)
    if (date > today) continue
    const minor = Math.max(0, c.mrr.minor)
    const last = out[out.length - 1]
    if (last && date < last.date) continue
    if (last && last.date === date) out.pop()
    if ((out[out.length - 1]?.minor ?? -1) !== minor) out.push({ date, minor })
  }
  return out
}

/** The series implied by a subscription seen for the first time (or recorded before history was kept). */
export function initialPoints(ev: SubscriptionUpsert, timeZone: string, today?: IsoDate): Array<{ date: IsoDate; minor: number }> {
  const start = localDate(ev.startedAt, timeZone)
  const known = today ? changePoints(ev, today, timeZone) : []
  if (known.length) {
    // The provider's history, then how it stands now: ended (dated when it ended) or a value it hasn't listed yet.
    const now = currentMrr(ev)
    const last = known[known.length - 1] as { date: IsoDate; minor: number }
    const ended = now === 0 ? endDate(ev, timeZone) : null
    if (last.minor !== now) known.push({ date: ended && ended > last.date ? ended : (today as IsoDate) < last.date ? last.date : (today as IsoDate), minor: now })
    return known
  }
  const now = currentMrr(ev)
  if (now > 0) return [{ date: start, minor: now }]
  const ended = (ev.status === 'canceled' || ev.status === 'incomplete_expired' || ev.status === 'unpaid') && endDate(ev, timeZone)
  if (ended) {
    const was = itemsMrr(ev)
    return was > 0 && ended > start ? [{ date: start, minor: was }, { date: ended, minor: 0 }] : []
  }
  return []
}

/** The point a change adds: dated when it ended (a cancellation) or today (an upgrade, a trial converting). */
export function nextPoint(prev: Array<{ date: IsoDate; minor: number }>, ev: SubscriptionUpsert, today: IsoDate, timeZone: string): { date: IsoDate; minor: number } | null {
  const last = prev[prev.length - 1]
  const value = currentMrr(ev)
  if ((last?.minor ?? 0) === value) return null
  let date = value === 0 ? (endDate(ev, timeZone) ?? today) : today
  if (last && date < last.date) date = last.date
  return { date, minor: value }
}

export function valueAt(points: ReadonlyArray<{ date: IsoDate; minor: number }>, date: IsoDate): number {
  let v = 0
  for (const p of points) {
    if (p.date > date) break
    v = p.minor
  }
  return v
}

/** Every subscription in scope with its series (stored history, else what its latest state implies). */
export async function mrrSeries(rc: MetricContext, entityIds: EntityId[]): Promise<MrrSeries[]> {
  const recs = (await rc.store.listRecords(rc.ws, { entityIds, eventTypes: ['subscription.upsert'], statuses: ['recorded'] })).filter((r) => r.eventType === 'subscription.upsert')
  if (recs.length === 0) return []
  const stored = await rc.store.listMrrPoints(rc.ws, recs.map((r) => r.id))
  const byRecord = new Map<Id, Array<{ date: IsoDate; minor: number }>>()
  for (const p of stored) byRecord.set(p.recordId, [...(byRecord.get(p.recordId) ?? []), { date: p.date, minor: p.mrr.minor }])
  const tz = await zoneOf(rc)
  return recs.map((r) => {
    const ev = r.event as SubscriptionUpsert
    return { recordId: r.id, connectionId: r.connectionId, entityId: r.entityId, customer: ev.customer, currency: ev.mrr.currency, points: byRecord.get(r.id) ?? initialPoints(ev, tz), products: productShares(ev) }
  })
}

function monthEnd(month: string): IsoDate {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = []
  let [y, m] = from.split('-').map(Number) as [number, number]
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    if (key > to) break
    out.push(key)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/**
 * Month by month: MRR at the start (end of the month before) and end, and what moved it, per customer (a customer
 * with two subscriptions that swaps one for the other is neither new nor churned). start + new + expansion +
 * reactivation − contraction − churn = end, exactly. Amounts in `currency`, converted at each month end.
 */
export async function mrrMovements(rc: MetricContext, opts: { entityIds: EntityId[]; from: string; to: string; currency: string }): Promise<MrrMonth[]> {
  const series = await mrrSeries(rc, opts.entityIds)
  const months = monthsBetween(opts.from.slice(0, 7), opts.to.slice(0, 7))
  const cur = opts.currency
  const at = async (date: IsoDate): Promise<Map<string, number>> => {
    const byCustomer = new Map<string, number>()
    for (const s of series) {
      const v = valueAt(s.points, date)
      if (v === 0) continue
      const minor = s.currency === cur ? v : (await rc.toCurrency({ minor: v, currency: s.currency }, cur, date)).minor
      const key = `${s.entityId ?? ''}|${s.customer}`
      byCustomer.set(key, (byCustomer.get(key) ?? 0) + minor)
    }
    return byCustomer
  }
  // Customers who paid at some point before a date: a return after that is a reactivation, not new business.
  const firstPaid = new Map<string, IsoDate>()
  for (const s of series) {
    const p = s.points.find((x) => x.minor > 0)
    if (!p) continue
    const key = `${s.entityId ?? ''}|${s.customer}`
    const was = firstPaid.get(key)
    if (!was || p.date < was) firstPaid.set(key, p.date)
  }
  const out: MrrMonth[] = []
  let startMap = await at(monthEnd(prevMonth(months[0] ?? opts.from.slice(0, 7))))
  for (const month of months) {
    const startDay = monthEnd(prevMonth(month))
    const endMap = await at(monthEnd(month))
    let nw = 0
    let exp = 0
    let react = 0
    let contr = 0
    let churn = 0
    let newCustomers = 0
    let churnedCustomers = 0
    for (const key of new Set([...startMap.keys(), ...endMap.keys()])) {
      const a = startMap.get(key) ?? 0
      const b = endMap.get(key) ?? 0
      if (a === 0 && b > 0) {
        const first = firstPaid.get(key)
        if (first && first <= startDay) react += b
        else {
          nw += b
          newCustomers++
        }
      } else if (a > 0 && b === 0) {
        churn += a
        churnedCustomers++
      } else if (b > a) exp += b - a
      else if (b < a) contr += a - b
    }
    const start = sum(startMap)
    const end = sum(endMap)
    // Conversion at different month ends can leave a residue for unchanged foreign customers: count it as movement.
    const drift = end - (start + nw + exp + react - contr - churn)
    if (drift > 0) exp += drift
    else if (drift < 0) contr -= drift
    out.push({
      month,
      start: { minor: start, currency: cur },
      new: { minor: nw, currency: cur },
      expansion: { minor: exp, currency: cur },
      reactivation: { minor: react, currency: cur },
      contraction: { minor: contr, currency: cur },
      churn: { minor: churn, currency: cur },
      end: { minor: end, currency: cur },
      customersStart: startMap.size,
      customersEnd: endMap.size,
      newCustomers,
      churnedCustomers,
      revenueChurnRate: start > 0 ? (churn + contr) / start : null,
      customerChurnRate: startMap.size > 0 ? churnedCustomers / startMap.size : null,
      // What MRR at the month's end is made of (none when there are no subscriptions to tell from).
      ...(series.length ? productList(series.map((s) => ({ products: s.products, minor: valueAt(s.points, monthEnd(month)) })).filter((p) => p.minor > 0)) : {}),
    })
    startMap = endMap
  }
  return out
}

function prevMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

function sum(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}
