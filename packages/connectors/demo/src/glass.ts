// The Glass Ledger (launch): from a start Monday, Harbor Coffee gets one more synthetic week every week on top of its
// ordinary days: two vendor bills and their payments, and one planted case that a bookkeeper (or an agent) has to get
// right. Everything is a pure function of (seed, week), so any week can be regenerated, and the planted cases are
// listed (glassManifest) so the public log can say which were planted.

import type { Money } from '@agfn/contracts'
import { addDays, weekday } from './dates.ts'
import { dice, seedOf } from './rng.ts'
import type { DayContext, Draft } from './profiles.ts'

export type PlantedKind = 'untagged_transfer' | 'near_amount' | 'unexplained_deposit' | 'split_payment'
const ROTATION: readonly PlantedKind[] = ['untagged_transfer', 'near_amount', 'unexplained_deposit', 'split_payment']

export interface PlantedCase {
  week: string
  kind: PlantedKind
  date: string
  /** What happened, in plain words. */
  what: string
  /** What correct books end up with. */
  expected: string
  /** Bank rows (external ids) that carry the case. */
  rowIds: string[]
}

interface Bill {
  id: string
  number: string
  vendor: string
  total: number
  issue: string
  due: string
  /** Bank payments: date, amount, bank text. */
  payments: Array<{ id: string; date: string; minor: number; text: string }>
}

interface Week {
  monday: string
  bills: Bill[]
  rows: Array<{ id: string; account: string; date: string; minor: number; counterparty: string; text: string; category?: string }>
  planted: PlantedCase
}

const USD = (minor: number): Money => ({ minor, currency: 'USD' })
const money = (minor: number) => `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The first Monday on or after `date`. */
export function glassMonday(date: string): string {
  return addDays(date, (8 - weekday(date)) % 7)
}

function weekIndex(start: string, monday: string): number {
  return Math.round((Date.parse(monday) - Date.parse(start)) / (7 * 86_400_000))
}

/** One Glass week, starting on `monday` (a Monday on or after the Glass start). */
export function glassWeek(ctx: DayContext & { glass: string }, monday: string): Week {
  const w = weekIndex(glassMonday(ctx.glass), monday)
  const r = dice(seedOf(ctx.seed, 'harbor-glass', monday))
  const kind = ROTATION[w % ROTATION.length] as PlantedKind
  const a: Bill = { id: `hc-bill-ppc-${monday}`, number: `PPC-${1001 + w}`, vendor: 'Pier Packaging Co', total: r.int(380_00, 920_00), issue: monday, due: addDays(monday, 14), payments: [] }
  const b: Bill = { id: `hc-bill-bbs-${monday}`, number: `BBS-${2001 + w}`, vendor: 'Bayside Bakery Supply', total: r.int(240_00, 610_00), issue: addDays(monday, 2), due: addDays(monday, 16), payments: [] }
  const rows: Week['rows'] = []
  let planted: PlantedCase
  if (kind === 'split_payment') {
    const first = Math.round(a.total / 2)
    a.payments.push({ id: `hc-chk-${addDays(monday, 9)}-ppc1`, date: addDays(monday, 9), minor: first, text: `PIER PACKAGING CO ACH ${a.number}` })
    a.payments.push({ id: `hc-chk-${addDays(monday, 12)}-ppc2`, date: addDays(monday, 12), minor: a.total - first, text: `PIER PACKAGING CO ACH ${a.number}` })
    planted = { week: monday, kind, date: addDays(monday, 12), what: `Bill ${a.number} from Pier Packaging Co (${money(a.total)}) paid in two parts, ${money(first)} and ${money(a.total - first)}`, expected: `Both payments confirmed against ${a.number} (each is only part of it, so each is asked about); nothing left owed`, rowIds: a.payments.map((p) => p.id) }
  } else {
    a.payments.push({ id: `hc-chk-${addDays(monday, 9)}-ppc`, date: addDays(monday, 9), minor: a.total, text: `PIER PACKAGING CO ACH ${a.number}` })
  }
  if (kind === 'near_amount') {
    const short = r.int(5, 95)
    b.payments.push({ id: `hc-chk-${addDays(monday, 11)}-bbs`, date: addDays(monday, 11), minor: b.total - short, text: `BAYSIDE BAKERY SUPPLY INV ${b.number}` })
    planted = { week: monday, kind, date: addDays(monday, 11), what: `Bill ${b.number} from Bayside Bakery Supply is ${money(b.total)}; the bank paid ${money(b.total - short)}`, expected: `Payment confirmed against ${b.number}; the ${money(short)} difference is decided by a person (written off or still owed), not matched silently`, rowIds: [b.payments[0]!.id] }
  } else {
    b.payments.push({ id: `hc-chk-${addDays(monday, 11)}-bbs`, date: addDays(monday, 11), minor: b.total, text: `BAYSIDE BAKERY SUPPLY INV ${b.number}` })
  }
  if (kind === 'untagged_transfer') {
    const date = addDays(monday, 3)
    const amount = r.int(10, 40) * 100_00
    // Alternates direction so savings neither drains nor piles up.
    const toChecking = Math.floor(w / ROTATION.length) % 2 === 0
    const [from, to] = toChecking ? ['hc-savings', 'hc-checking'] : ['hc-checking', 'hc-savings']
    const out = { id: `hc-glass-${date}-xfer-out`, account: from, date, minor: -amount, counterparty: toChecking ? 'Transfer to checking' : 'Transfer to savings', text: toChecking ? 'ONLINE TRANSFER TO CHK XXXX5512' : 'ONLINE TRANSFER TO SAV XXXX5519', category: 'TRANSFER_OUT' }
    const inn = { id: `hc-glass-${date}-xfer-in`, account: to, date, minor: amount, counterparty: toChecking ? 'Transfer from savings' : 'Transfer from checking', text: toChecking ? 'ONLINE TRANSFER FROM SAV XXXX5519' : 'ONLINE TRANSFER FROM CHK XXXX5512', category: 'TRANSFER_IN' }
    rows.push(out, inn)
    planted = { week: monday, kind, date, what: `${money(amount)} moved ${toChecking ? 'from savings to checking' : 'from checking to savings'} with no reference on either side`, expected: 'One transfer between Harbor accounts: no income, no expense', rowIds: [out.id, inn.id] }
  }
  if (kind === 'unexplained_deposit') {
    const date = addDays(monday, 4)
    const amount = r.int(180_00, 650_00)
    const row = { id: `hc-glass-${date}-mobile`, account: 'hc-checking', date, minor: amount, counterparty: 'Mobile deposit', text: 'MOBILE CHECK DEPOSIT' }
    rows.push(row)
    planted = { week: monday, kind, date, what: `A ${money(amount)} mobile check deposit with no name (a catering order paid by check)`, expected: 'Asked about, then recorded as revenue (catering)', rowIds: [row.id] }
  }
  for (const bill of [a, b]) for (const p of bill.payments) rows.push({ id: p.id, account: 'hc-checking', date: p.date, minor: -p.minor, counterparty: bill.vendor, text: p.text, category: 'GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE' })
  return { monday, bills: [a, b], rows, planted: planted! }
}

function mondaysThrough(ctx: DayContext & { glass: string }, to: string): string[] {
  const out: string[] = []
  for (let m = glassMonday(ctx.glass); m <= to; m = addDays(m, 7)) out.push(m)
  return out
}

/** Glass bank rows dated `date` (weeks reach 16 days past their Monday, so the last three weeks can have rows today). */
export function glassDay(ctx: DayContext & { glass: string }, date: string): Draft[] {
  if (date < glassMonday(ctx.glass)) return []
  const out: Draft[] = []
  for (const m of mondaysThrough(ctx, date)) {
    if (addDays(m, 16) < date) continue
    const week = glassWeek(ctx, m)
    for (const row of week.rows) {
      if (row.date !== date) continue
      // On the public log's workspace the planted rows say so, so the log can label them without memory ("never fake a catch").
      const text = ctx.glassTag && week.planted.rowIds.includes(row.id) ? `${row.text} [planted]` : row.text
      out.push({ type: 'txn.upsert', externalId: row.id, accountExternalId: row.account, date, amount: USD(row.minor), status: 'posted', counterparty: row.counterparty, rawText: text, ...(row.category ? { categoryHint: row.category } : {}) })
    }
  }
  return out
}

/**
 * The Glass bills issued by `today`. They stay open at the source, as in a bill inbox that never hears about payments:
 * paying them shows up only in the bank, and tying the two together is the bookkeeping the Glass Ledger shows.
 */
export function glassBills(ctx: DayContext & { glass: string }, today: string): Draft[] {
  return mondaysThrough(ctx, today).flatMap((m) =>
    glassWeek(ctx, m).bills
      .filter((b) => b.issue <= today)
      .map((b): Draft => ({ type: 'invoice.upsert', externalId: b.id, direction: 'payable', number: b.number, counterparty: b.vendor, issueDate: b.issue, dueDate: b.due, total: USD(b.total), amountPaid: USD(0), status: 'open', lines: [{ description: b.vendor === 'Pier Packaging Co' ? 'Cups, lids and sleeves' : 'Pastries and bread', amount: USD(b.total), quantity: 1, category: 'cogs' }] })),
  )
}

/** The planted cases from the Glass start through `to` (for the public log: these were planted, not found). */
export function glassManifest(ctx: DayContext & { glass: string }, to: string): PlantedCase[] {
  return mondaysThrough(ctx, to).map((m) => glassWeek(ctx, m).planted).filter((p) => p.date <= to)
}
