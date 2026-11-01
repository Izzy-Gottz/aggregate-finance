// "Anything odd" (MASTER §3, company drawer): deterministic detectors over posted rows. No AI.
// duplicate charges · a subscription price rise · one charge billed to two companies · an unusually large expense ·
// a missed recurring payment. Each finding names the rows behind it.
import type { EntityId, Id, IsoDate, Money, TxnUpsert } from '@agfn/contracts'
import { bucketView } from './buckets.ts'
import { isExpenseRole } from './coa.ts'
import type { EntityInfo, SourceRecord } from './model.ts'
import { addDays, daysBetween, ledgerAccounts, scopeEntities, today, type ReadContext, todayFor } from './queries.ts'
import { merchantKey } from './rules.ts'

export type AnomalyKind = 'duplicate_charge' | 'price_increase' | 'billed_twice' | 'large_expense' | 'missed_payment'

export interface Anomaly {
  /** Stable across runs: "<kind>:<record ids>" so the UI can remember dismissals. */
  id: string
  kind: AnomalyKind
  entityId: EntityId
  date: IsoDate
  /** Plain words, built from Aggregate's own data; may name a counterparty (third-party text). */
  title: string
  detail: string
  amount: Money | null
  recordIds: Id[]
  severity: 'info' | 'warn'
}

export interface AnomalyOptions {
  entityIds?: EntityId[] | 'all'
  asOf?: IsoDate
  /** How far back to look for new findings. Default 45 days. */
  windowDays?: number
}

interface Row {
  r: SourceRecord
  ev: TxnUpsert
  key: string
  abs: number
  /** True when the row is spending (counter account is an expense), not a transfer, payout or owner money. */
  spending: boolean
}

const fmt = (m: Money): string => {
  const neg = m.minor < 0
  const abs = Math.abs(m.minor)
  return `${neg ? '-' : ''}${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')} ${m.currency}`
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
}

export async function findAnomalies(rc: ReadContext, opts: AnomalyOptions = {}): Promise<Anomaly[]> {
  const entities = await scopeEntities(rc, opts.entityIds ?? 'all')
  const ids = entities.map((e) => e.id)
  if (ids.length === 0) return []
  const asOf = opts.asOf ?? (await todayFor(rc))
  const windowStart = addDays(asOf, -(opts.windowDays ?? 45))
  const historyStart = addDays(asOf, -400)

  const records = await rc.store.listRecords(rc.ws, { entityIds: ids, eventTypes: ['txn.upsert'], statuses: ['posted'], fromDate: historyStart, toDate: asOf })
  // What each row was booked as (cash view): spending vs transfers/payouts/owner money.
  const idx = await ledgerAccounts(rc, ids)
  const lines = await rc.store.listLines(rc.ws, { entityIds: ids, basis: 'cash', fromDate: historyStart, toDate: asOf })
  const spendNet = new Map<Id, number>()
  for (const l of lines) {
    const role = idx.byId.get(l.ledgerAccountId)?.role ?? ''
    if (isExpenseRole(role)) spendNet.set(l.sourceId, (spendNet.get(l.sourceId) ?? 0) + l.debitMinor - l.creditMinor)
  }
  const links = await rc.store.listLinks(rc.ws, { statuses: ['confirmed'] })
  const linkedDup = new Set(links.filter((l) => l.type === 'duplicate' || l.type === 'pending_posted').flatMap((l) => [l.fromId, l.toId]))

  const rows: Row[] = []
  for (const r of records) {
    if (r.event.type !== 'txn.upsert' || r.event.amount.minor >= 0 || !r.entityId) continue
    const ev = r.event
    const key = merchantKey(ev.counterparty ?? ev.rawText ?? '')
    if (key.length < 3) continue
    rows.push({ r, ev, key, abs: -ev.amount.minor, spending: (spendNet.get(r.id) ?? 0) > 0 })
  }
  const byName = new Map<string, EntityInfo>(entities.map((e) => [e.id, e]))
  const out: Anomaly[] = []
  const recent = (row: Row) => row.r.date >= windowStart

  // 1) Duplicate charges: same company, merchant and amount within 2 days, not already explained as one event.
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const g = `${row.r.entityId}|${row.key}|${row.ev.amount.currency}|${row.abs}`
    groups.set(g, [...(groups.get(g) ?? []), row])
  }
  for (const g of groups.values()) {
    g.sort((a, b) => (a.r.date < b.r.date ? -1 : a.r.date > b.r.date ? 1 : a.r.id < b.r.id ? -1 : 1))
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1] as Row
      const b = g[i] as Row
      if (!recent(b) || daysBetween(a.r.date, b.r.date) > 2) continue
      if (linkedDup.has(a.r.id) || linkedDup.has(b.r.id) || a.r.sourceAccountId === null) continue
      out.push({
        id: `duplicate_charge:${a.r.id}:${b.r.id}`,
        kind: 'duplicate_charge',
        entityId: b.r.entityId as EntityId,
        date: b.r.date,
        title: `Charged twice? ${b.ev.counterparty ?? b.key}`,
        detail: `${fmt({ minor: b.abs, currency: b.ev.amount.currency })} on ${a.r.date} and ${b.r.date}`,
        amount: { minor: b.abs, currency: b.ev.amount.currency },
        recordIds: [a.r.id, b.r.id],
        severity: 'warn',
      })
    }
  }

  // 2) The same charge billed to two companies (same merchant and amount within 3 days, different companies).
  const cross = new Map<string, Row[]>()
  for (const row of rows) {
    const g = `${row.key}|${row.ev.amount.currency}|${row.abs}`
    cross.set(g, [...(cross.get(g) ?? []), row])
  }
  for (const g of cross.values()) {
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        const a = g[i] as Row
        const b = g[j] as Row
        if (a.r.entityId === b.r.entityId || Math.abs(daysBetween(a.r.date, b.r.date)) > 3 || (!recent(a) && !recent(b))) continue
        // Earlier charge first (then id), so the wording and id are stable.
        const [first, second] = a.r.date < b.r.date || (a.r.date === b.r.date && a.r.id < b.r.id) ? [a, b] : [b, a]
        out.push({
          id: `billed_twice:${first.r.id}:${second.r.id}`,
          kind: 'billed_twice',
          entityId: second.r.entityId as EntityId,
          date: second.r.date > first.r.date ? second.r.date : first.r.date,
          title: `${second.ev.counterparty ?? second.key} billed two companies`,
          detail: `${fmt({ minor: second.abs, currency: second.ev.amount.currency })} in ${byName.get(first.r.entityId as EntityId)?.name ?? 'one company'} and ${byName.get(second.r.entityId as EntityId)?.name ?? 'another'}`,
          amount: { minor: second.abs, currency: second.ev.amount.currency },
          recordIds: [first.r.id, second.r.id],
          severity: 'warn',
        })
      }
    }
  }

  // 3) Recurring charges: price rises and missed payments.
  const series = new Map<string, Row[]>()
  for (const row of rows) {
    const g = `${row.r.entityId}|${row.key}|${row.ev.amount.currency}`
    series.set(g, [...(series.get(g) ?? []), row])
  }
  for (const s of series.values()) {
    s.sort((a, b) => (a.r.date < b.r.date ? -1 : 1))
    // Collapse same-period repeats (duplicates are reported above).
    const uniq = s.filter((row, i) => i === 0 || daysBetween((s[i - 1] as Row).r.date, row.r.date) > 5)
    if (uniq.length < 4) continue
    const prior = uniq.slice(0, -1)
    const gaps = prior.slice(1).map((row, i) => daysBetween((prior[i] as Row).r.date, row.r.date))
    const gap = median(gaps)
    const cadence = Math.abs(gap - 30.4) <= 4 ? 'monthly' : Math.abs(gap - 365) <= 10 ? 'annual' : Math.abs(gap - 7) <= 1 ? 'weekly' : null
    if (!cadence || !gaps.every((g2) => Math.abs(g2 - gap) <= (cadence === 'annual' ? 10 : cadence === 'weekly' ? 2 : 5))) continue
    const priorAmounts = prior.slice(-3).map((row) => row.abs)
    if (!priorAmounts.every((a) => a === priorAmounts[0])) continue // only steady prices can "rise"
    const steady = priorAmounts[0] as number
    const last = uniq[uniq.length - 1] as Row
    const lastGap = daysBetween((prior[prior.length - 1] as Row).r.date, last.r.date)
    if (recent(last) && Math.abs(lastGap - gap) <= 10 && last.abs > steady && last.abs - steady >= Math.max(100, Math.round(steady * 0.05))) {
      const pct = Math.round(((last.abs - steady) / steady) * 100)
      out.push({
        id: `price_increase:${last.r.id}`,
        kind: 'price_increase',
        entityId: last.r.entityId as EntityId,
        date: last.r.date,
        title: `${last.ev.counterparty ?? last.key} went up ${pct}%`,
        detail: `${fmt({ minor: steady, currency: last.ev.amount.currency })} → ${fmt({ minor: last.abs, currency: last.ev.amount.currency })} per ${cadence === 'annual' ? 'year' : cadence === 'weekly' ? 'week' : 'month'}`,
        amount: { minor: last.abs - steady, currency: last.ev.amount.currency },
        recordIds: [last.r.id],
        severity: 'info',
      })
    }
    // Missed: the next charge should have arrived (plus a grace period) and hasn't.
    const grace = cadence === 'annual' ? 14 : cadence === 'weekly' ? 3 : 7
    const expected = addDays(last.r.date, Math.round(gap))
    const overdueBy = daysBetween(expected, asOf)
    if (overdueBy > grace && overdueBy <= grace + (opts.windowDays ?? 45)) {
      out.push({
        id: `missed_payment:${last.r.id}`,
        kind: 'missed_payment',
        entityId: last.r.entityId as EntityId,
        date: expected,
        title: `${last.ev.counterparty ?? last.key} didn't charge as usual`,
        detail: `Expected around ${expected} (${cadence}); last seen ${last.r.date}. Cancelled, failed card, or moved?`,
        amount: { minor: last.abs, currency: last.ev.amount.currency },
        recordIds: [last.r.id],
        severity: 'info',
      })
    }
  }

  // Scheduled buckets (rent, loans) with a missed occurrence in the window.
  for (const b of await rc.store.listBuckets(rc.ws, ids)) {
    if (b.archivedAt || !b.schedule) continue
    const v = await bucketView(rc, b, asOf)
    for (const o of v.occurrences) {
      if (o.status !== 'missed' || o.dueDate < windowStart) continue
      out.push({
        id: `missed_payment:bucket:${b.id}:${o.dueDate}`,
        kind: 'missed_payment',
        entityId: b.entityId,
        date: o.dueDate,
        title: `${b.name} wasn't paid`,
        detail: `${fmt(o.expected)} was due ${o.dueDate}`,
        amount: o.expected,
        recordIds: o.recordIds,
        severity: 'warn',
      })
    }
  }

  // 4) Unusually large spending: ≥ 4× the company's usual large charge (90th percentile, prior 180 days), floor 500.00.
  for (const e of entities) {
    const spend = rows.filter((row) => row.r.entityId === e.id && row.spending)
    for (const row of spend.filter(recent)) {
      const before = spend.filter((x) => x.r.date < row.r.date && x.r.date >= addDays(row.r.date, -180) && x.ev.amount.currency === row.ev.amount.currency)
      if (before.length < 10) continue
      const sorted = before.map((x) => x.abs).sort((a, b) => a - b)
      const p90 = sorted[Math.floor(sorted.length * 0.9)] as number
      const seenBefore = before.some((x) => x.key === row.key && x.abs >= row.abs * 0.8)
      if (row.abs >= Math.max(50_000, p90 * 4) && !seenBefore) {
        out.push({
          id: `large_expense:${row.r.id}`,
          kind: 'large_expense',
          entityId: e.id,
          date: row.r.date,
          title: `Unusually large: ${row.ev.counterparty ?? row.key}`,
          detail: `${fmt({ minor: row.abs, currency: row.ev.amount.currency })}, about ${Math.round(row.abs / Math.max(1, p90))}× a typical large charge`,
          amount: { minor: row.abs, currency: row.ev.amount.currency },
          recordIds: [row.r.id],
          severity: 'warn',
        })
      }
    }
  }

  const rank: Record<AnomalyKind, number> = { duplicate_charge: 0, billed_twice: 1, missed_payment: 2, large_expense: 3, price_increase: 4 }
  return out.sort((a, b) => (a.severity !== b.severity ? (a.severity === 'warn' ? -1 : 1) : b.date.localeCompare(a.date) || rank[a.kind] - rank[b.kind]))
}
