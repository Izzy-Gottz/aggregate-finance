// Buckets: user/AI-defined collections (Rent, Loans, Contractors…) with custom fields, an optional schedule,
// and rules that route matching transactions in. Buckets tag ledger lines; they never replace accounts.
import type { EntityId, Id, IsoDate, Money, TxnUpsert } from '@agfn/contracts'
import { detectRecurring as detectSeries, type Row } from '@agfn/recurring'
import type { Bucket, BucketField, BucketSchedule, Cadence, SourceRecord } from './model.ts'
import { assertCurrency, assertMinor } from './money.ts'
import { addDays, addMonths, daysBetween, type ReadContext } from './queries.ts'

export class BucketValidationError extends Error {
  override name = 'BucketValidationError'
}

const FIELD_KEY = /^[a-z][a-z0-9_]{0,39}$/
const MAX_FIELDS = 40
const MAX_TEXT = 2000

export function validateFields(fields: readonly BucketField[]): void {
  if (fields.length > MAX_FIELDS) throw new BucketValidationError(`At most ${MAX_FIELDS} fields`)
  const seen = new Set<string>()
  for (const f of fields) {
    if (!FIELD_KEY.test(f.key)) throw new BucketValidationError(`Field key "${f.key}" must be lower_snake_case, starting with a letter`)
    if (seen.has(f.key)) throw new BucketValidationError(`Duplicate field "${f.key}"`)
    seen.add(f.key)
    if (!f.label || f.label.length > 100) throw new BucketValidationError(`Field "${f.key}" needs a label (≤ 100 chars)`)
    if (!['text', 'number', 'money', 'date', 'boolean', 'select'].includes(f.type)) throw new BucketValidationError(`Field "${f.key}" has unknown type ${f.type}`)
    if (f.type === 'select' && (!f.options || f.options.length === 0)) throw new BucketValidationError(`Select field "${f.key}" needs options`)
  }
}

/** Validate values against the field schema; returns a cleaned copy (unknown keys rejected). */
export function validateValues(fields: readonly BucketField[], values: Record<string, unknown>): Record<string, unknown> {
  const byKey = new Map(fields.map((f) => [f.key, f]))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(values)) {
    const f = byKey.get(k)
    if (!f) throw new BucketValidationError(`Unknown field "${k}"`)
    if (v === null || v === undefined) continue
    switch (f.type) {
      case 'text':
        if (typeof v !== 'string' || v.length > MAX_TEXT) throw new BucketValidationError(`"${k}" must be text up to ${MAX_TEXT} characters`)
        break
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new BucketValidationError(`"${k}" must be a number`)
        break
      case 'money': {
        const m = v as Money
        if (typeof m !== 'object' || !Number.isSafeInteger(m.minor) || typeof m.currency !== 'string') throw new BucketValidationError(`"${k}" must be {minor, currency}`)
        assertCurrency(m.currency)
        break
      }
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BucketValidationError(`"${k}" must be YYYY-MM-DD`)
        break
      case 'boolean':
        if (typeof v !== 'boolean') throw new BucketValidationError(`"${k}" must be true or false`)
        break
      case 'select':
        if (typeof v !== 'string' || !(f.options ?? []).includes(v)) throw new BucketValidationError(`"${k}" must be one of ${(f.options ?? []).join(', ')}`)
        break
    }
    out[k] = v
  }
  for (const f of fields) if (f.required && out[f.key] === undefined) throw new BucketValidationError(`"${f.key}" is required`)
  return out
}

export function validateSchedule(s: BucketSchedule): void {
  assertMinor(s.amount.minor, 'schedule amount')
  assertCurrency(s.amount.currency)
  if (s.amount.minor <= 0) throw new BucketValidationError('Schedule amount must be positive (direction says in or out)')
  if (!['in', 'out'].includes(s.direction)) throw new BucketValidationError('direction must be in or out')
  if (!['weekly', 'biweekly', 'monthly', 'quarterly', 'annual'].includes(s.cadence)) throw new BucketValidationError(`Unknown cadence ${s.cadence}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.startDate)) throw new BucketValidationError('startDate must be YYYY-MM-DD')
  if (s.endDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(s.endDate) || s.endDate < s.startDate)) throw new BucketValidationError('endDate must be YYYY-MM-DD on or after startDate')
  if (s.dueDay !== undefined && (!Number.isInteger(s.dueDay) || s.dueDay < 1 || s.dueDay > 31)) throw new BucketValidationError('dueDay must be 1-31')
  if (s.graceDays !== undefined && (!Number.isInteger(s.graceDays) || s.graceDays < 0 || s.graceDays > 60)) throw new BucketValidationError('graceDays must be 0-60')
  if (s.toleranceMinor !== undefined && (!Number.isSafeInteger(s.toleranceMinor) || s.toleranceMinor < 0)) throw new BucketValidationError('toleranceMinor must be ≥ 0')
}

const MONTHS: Record<Cadence, number> = { weekly: 0, biweekly: 0, monthly: 1, quarterly: 3, annual: 12 }

/** Due dates from start through `until` (inclusive), capped at 1000. */
export function dueDates(s: BucketSchedule, until: IsoDate): IsoDate[] {
  const out: IsoDate[] = []
  const last = s.endDate && s.endDate < until ? s.endDate : until
  if (s.cadence === 'weekly' || s.cadence === 'biweekly') {
    const step = s.cadence === 'weekly' ? 7 : 14
    for (let d = s.startDate; d <= last && out.length < 1000; d = addDays(d, step)) out.push(d)
    return out
  }
  const day = s.dueDay ?? Number(s.startDate.slice(8, 10))
  const firstMonth = `${s.startDate.slice(0, 7)}-01`
  for (let i = 0; out.length < 1000; i += MONTHS[s.cadence]) {
    const m = addMonths(firstMonth, i)
    const lastDay = Number(addDays(addMonths(m, 1), -1).slice(8, 10))
    const d = `${m.slice(0, 7)}-${String(Math.min(day, lastDay)).padStart(2, '0')}`
    if (d > last) break
    if (d >= s.startDate) out.push(d)
  }
  return out
}

export type OccurrenceStatus = 'paid' | 'partial' | 'upcoming' | 'missed'

export interface Occurrence {
  dueDate: IsoDate
  expected: Money
  status: OccurrenceStatus
  paid: Money
  recordIds: Id[]
}

export interface BucketPayment {
  recordId: Id
  date: IsoDate
  amount: Money
  counterparty: string | null
}

/**
 * Match payments to due dates in order. A payment counts toward the nearest open occurrence whose window
 * (10 days before due, `graceDays` after) contains it. Past-due and unpaid after grace = missed.
 */
export function scheduleStatus(s: BucketSchedule, payments: readonly BucketPayment[], asOf: IsoDate): Occurrence[] {
  const grace = s.graceDays ?? 5
  const tol = s.toleranceMinor ?? 0
  const sign = s.direction === 'out' ? -1 : 1
  const period = s.cadence === 'weekly' ? 7 : s.cadence === 'biweekly' ? 14 : MONTHS[s.cadence] * 30
  const early = Math.min(10, Math.floor(period / 2))
  // Include the next occurrence after asOf so "upcoming" always shows.
  const until = addDays(asOf, period + 1)
  const dates = dueDates(s, until)
  const nextFuture = dates.findIndex((d) => d > asOf)
  const shown = nextFuture >= 0 ? dates.slice(0, nextFuture + 1) : dates
  const pool = payments.filter((p) => p.amount.currency === s.amount.currency && Math.sign(p.amount.minor) === sign).sort((a, b) => (a.date < b.date ? -1 : 1))
  const used = new Set<Id>()
  return shown.map((due) => {
    const window = pool.filter((p) => !used.has(p.recordId) && daysBetween(due, p.date) >= -early && daysBetween(due, p.date) <= grace)
    let paid = 0
    const ids: Id[] = []
    for (const p of window) {
      if (paid >= s.amount.minor - tol) break
      paid += Math.abs(p.amount.minor)
      ids.push(p.recordId)
      used.add(p.recordId)
    }
    let status: OccurrenceStatus
    if (paid >= s.amount.minor - tol) status = 'paid'
    else if (daysBetween(due, asOf) > grace) status = paid > 0 ? 'partial' : 'missed'
    else status = paid > 0 ? 'partial' : 'upcoming'
    return { dueDate: due, expected: s.amount, status, paid: { minor: paid, currency: s.amount.currency }, recordIds: ids }
  })
}

/** Monthly equivalent of a scheduled amount. */
export function monthlyEquivalent(minor: number, cadence: Cadence): number {
  switch (cadence) {
    case 'weekly':
      return Math.round((minor * 52) / 12)
    case 'biweekly':
      return Math.round((minor * 26) / 12)
    case 'monthly':
      return minor
    case 'quarterly':
      return Math.round(minor / 3)
    case 'annual':
      return Math.round(minor / 12)
  }
}

/** Payments tagged into a bucket (lines carrying its id), one per source record. */
export async function bucketPayments(rc: ReadContext, bucket: Bucket): Promise<BucketPayment[]> {
  const lines = await rc.store.listLines(rc.ws, { entityIds: [bucket.entityId], basis: 'cash', bucketId: bucket.id })
  const ids = [...new Set(lines.map((l) => l.sourceId))]
  const out: BucketPayment[] = []
  for (const id of ids) {
    const r = await rc.store.getRecord(rc.ws, id)
    if (!r || !r.amount) continue
    const ev = r.event
    out.push({ recordId: r.id, date: r.date, amount: r.amount, counterparty: ev.type === 'txn.upsert' ? (ev.counterparty ?? null) : null })
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1))
}

export interface BucketView {
  bucket: Bucket
  payments: BucketPayment[]
  occurrences: Occurrence[]
  /** Latest past occurrence's status, or the next upcoming one. */
  status: OccurrenceStatus | null
  totalPaid: Money | null
}

export async function bucketView(rc: ReadContext, bucket: Bucket, asOf: IsoDate): Promise<BucketView> {
  const payments = await bucketPayments(rc, bucket)
  const occurrences = bucket.schedule ? scheduleStatus(bucket.schedule, payments, asOf) : []
  const past = occurrences.filter((o) => o.dueDate <= asOf)
  const status = past.length ? (past[past.length - 1] as Occurrence).status : (occurrences[0]?.status ?? null)
  const cur = bucket.schedule?.amount.currency ?? payments[0]?.amount.currency ?? null
  const totalPaid = cur ? { minor: payments.filter((p) => p.amount.currency === cur).reduce((s, p) => s + p.amount.minor, 0), currency: cur } : null
  return { bucket, payments, occurrences, status, totalPaid }
}

// ---------- Recurring spend (buckets + detected series) ----------

export interface RecurringSeries {
  key: string
  label: string
  cadence: Cadence
  monthlyMinor: number
  currency: string
  lastDate: IsoDate
  source: 'bucket' | 'detected'
  recordIds: Id[]
}

/**
 * Recurring outflows, using the one shared definition in @agfn/recurring (amounts within 7.5%, a steady cadence,
 * acted on from the third charge). Only active series count; suggested and ended ones don't.
 */
export function detectRecurring(records: readonly SourceRecord[], asOf: IsoDate): RecurringSeries[] {
  const rows: Row[] = []
  for (const r of records) {
    if (r.event.type !== 'txn.upsert' || r.status !== 'posted' || !r.entityId) continue
    const ev: TxnUpsert = r.event
    rows.push({ id: r.id, entityId: r.entityId, date: r.date, minor: ev.amount.minor, currency: ev.amount.currency, counterparty: ev.counterparty ?? ev.rawText ?? null })
  }
  return detectSeries(rows, asOf)
    .filter((s) => s.status === 'active')
    .map((s) => ({
      key: s.id,
      label: s.counterparty,
      cadence: s.cadence === 'yearly' ? 'annual' : s.cadence,
      monthlyMinor: s.monthlyMinor,
      currency: s.currency,
      lastDate: s.lastDate,
      source: 'detected' as const,
      recordIds: s.recordIds,
    }))
}

export async function recurringSpend(rc: ReadContext, entityIds: EntityId[], asOf: IsoDate, currency: string): Promise<{ monthlyMinor: number; series: RecurringSeries[]; rowIds: Id[] }> {
  const buckets = (await rc.store.listBuckets(rc.ws, entityIds)).filter((b) => !b.archivedAt && b.schedule?.direction === 'out' && (!b.schedule.endDate || b.schedule.endDate >= asOf))
  const series: RecurringSeries[] = []
  const covered = new Set<Id>()
  for (const b of buckets) {
    const s = b.schedule as BucketSchedule
    const pays = await bucketPayments(rc, b)
    for (const p of pays) covered.add(p.recordId)
    series.push({ key: `bucket:${b.id}`, label: b.name, cadence: s.cadence, monthlyMinor: monthlyEquivalent(s.amount.minor, s.cadence), currency: s.amount.currency, lastDate: pays[pays.length - 1]?.date ?? s.startDate, source: 'bucket', recordIds: pays.map((p) => p.recordId) })
  }
  const records = await rc.store.listRecords(rc.ws, { entityIds, eventTypes: ['txn.upsert'], statuses: ['posted'], toDate: asOf, fromDate: addDays(asOf, -800) })
  for (const d of detectRecurring(records, asOf)) {
    // A detected series already represented by a bucket isn't counted twice.
    if (d.recordIds.some((id) => covered.has(id))) continue
    series.push(d)
  }
  let monthly = 0
  for (const s of series) monthly += (await rc.toCurrency({ minor: s.monthlyMinor, currency: s.currency }, currency, asOf)).minor
  return { monthlyMinor: monthly, series, rowIds: series.flatMap((s) => s.recordIds) }
}
