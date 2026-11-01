// Carta / Pulley / spreadsheet cap-table import. Both export a "securities" or "ledger" table with one row per
// security (a CSV, or a tab of an .xlsx — see workbook.ts); column names differ between tools and versions, so columns
// are matched by meaning (see COLUMNS). Each row becomes stakeholder + class/plan (found or created) + one transaction.
// Rows we can't place are reported, never guessed.

import type { Money } from '@agfn/contracts'
import { looksInstitutional, type EquityObject, type IsoDate, type StakeholderObj } from './model.ts'
import { exponent } from './fx.ts'

const COLUMNS = {
  holder: ['stakeholder', 'stakeholder name', 'holder', 'holder name', 'name', 'shareholder', 'investor', 'grantee', 'optionholder', 'security holder', 'investor name', 'grantee name', 'holder legal name', 'legal name'],
  type: ['security type', 'type', 'security', 'instrument', 'award type', 'grant type', 'equity type', 'stock type', 'option type'],
  className: ['share class', 'class', 'stock class', 'security class', 'series', 'class of stock'],
  quantity: ['shares', 'quantity', 'shares outstanding', 'outstanding', 'number of shares', 'quantity issued', 'options granted', 'granted', 'shares granted', 'quantity granted', 'shares issued', 'issued shares', 'outstanding shares', 'number of options', 'options', 'units', 'number of units'],
  date: ['issue date', 'date', 'grant date', 'issued', 'date issued', 'investment date', 'date of issuance', 'issuance date', 'date of grant'],
  price: ['price per share', 'issue price', 'original issue price', 'exercise price', 'strike', 'strike price', 'share price', 'exercise price per share', 'cost per share', 'purchase price per share'],
  amount: ['principal', 'investment', 'investment amount', 'amount', 'purchase amount', 'cash paid', 'principal amount', 'amount invested', 'purchase price'],
  cap: ['valuation cap', 'cap', 'post-money valuation cap', 'pre-money valuation cap'],
  discount: ['discount', 'discount rate', 'discount %'],
  interest: ['interest', 'interest rate', 'interest %'],
  vestingStart: ['vesting start', 'vesting start date', 'vesting commencement date', 'vcd'],
  vestingMonths: ['vesting months', 'vesting term', 'vesting period (months)', 'vesting duration'],
  vestingSchedule: ['vesting schedule', 'vesting', 'vesting terms', 'vesting plan'],
  cliff: ['cliff', 'cliff months', 'cliff (months)'],
  exercised: ['exercised', 'shares exercised', 'quantity exercised', 'options exercised', 'exercised shares'],
  released: ['released', 'shares released', 'settled', 'shares settled'],
  expiration: ['expiration date', 'expiration', 'expires', 'expiry date', 'expiry'],
  currency: ['currency', 'currency code'],
  cancelled: ['cancelled', 'canceled', 'forfeited', 'shares cancelled', 'shares canceled', 'quantity cancelled', 'quantity canceled', 'cancelled shares', 'canceled shares', 'forfeited shares'],
  relationship: ['relationship', 'stakeholder type', 'role'],
  email: ['email', 'email address'],
} as const

type Col = keyof typeof COLUMNS

export interface CsvImportResult {
  objects: EquityObject[]
  notes: string[]
  rows: number
}

/** RFC 4180-ish parser: quotes, escaped quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const out: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  const t = text.replace(/^﻿/, '')
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!
    if (q) {
      if (c === '"' && t[i + 1] === '"') (cell += '"'), i++
      else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === ',') row.push(cell), (cell = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((x) => x.trim() !== '')) out.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some((x) => x.trim() !== '')) out.push(row)
  return out
}

export const norm = (s: string) => s.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')

export function number(s: string | undefined): number | undefined {
  if (!s) return undefined
  const neg = /^\(.*\)$/.test(s.trim())
  const n = Number(s.replace(/[$€£,%\s()]/g, ''))
  return Number.isFinite(n) && s.trim() !== '' ? (neg ? -n : n) : undefined
}

export function dateOf(s: string | undefined): IsoDate | undefined {
  if (!s) return undefined
  const t = s.trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/) // US m/d/y
  if (m) {
    const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return `${y}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  }
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
}

/** A release can only settle vested units, so a ledger's "released" count is dated when the schedule ends (or today, if
 *  sooner): the replay then never refuses units the file says were released. */
function lastDate(grantDate: IsoDate, v: { start: IsoDate; months: number }): IsoDate {
  const [y, m, d] = v.start.split('-').map(Number) as [number, number, number]
  const end = new Date(Date.UTC(y, m - 1 + v.months, d)).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)
  const at = end < today ? end : today
  return at < grantDate ? grantDate : at
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x'

const UNIT = String.raw`(\d+(?:\.\d+)?)\s*-?\s*(years?|yrs?|months?|mos?)\b`
const span = (m: RegExpMatchArray | null) => (m ? Number(m[1]) * (/^y/.test(m[2]!) ? 12 : 1) : undefined)

/** "4 years, 1 year cliff", "48 months / 12 month cliff", "1/48 monthly": the term and cliff in months, if it says. */
export function parseVestingText(s: string | undefined): { months: number; cliffMonths: number } | undefined {
  if (!s) return undefined
  const t = s.toLowerCase()
  const before = new RegExp(String.raw`${UNIT}\s*cliff`)
  const after = new RegExp(String.raw`cliff\D{0,12}${UNIT}`)
  const cliff = span(t.match(before)) ?? span(t.match(after))
  const rest = t.replace(before, '').replace(after, '')
  const monthly = t.match(/1\s*\/\s*(\d+)\s*(monthly|per month|months?)/)
  const months = span(rest.match(new RegExp(UNIT))) ?? (monthly ? Number(monthly[1]) : undefined)
  return months ? { months, cliffMonths: cliff ?? 0 } : undefined
}

/** Footer and summary rows a sheet puts under its holders. */
const FOOTER = /^(grand\s+)?totals?\b|^sub-?totals?\b|remaining for (issuance|grant)|available for (issuance|grant)|^unallocated|^unissued|^(option )?pool (available|remaining)/i
const AVAILABLE = /remaining for (issuance|grant)|available for (issuance|grant)|^unallocated|^unissued|^(option )?pool (available|remaining)/i

export interface RowsImportOptions {
  currency?: string
  idPrefix?: string
  existing?: readonly EquityObject[]
  /** What the rows are when they don't say (a Pulley tab named "Incentive Plan" holds options): 'option', 'safe', 'warrant', 'preferred'. */
  typeHint?: string
  /** How notes name a row: "Options, row 7". Defaults to "Row 7". */
  where?: string
  /** How many top rows to look through for the column names (sheets put titles above them). */
  headerSearch?: number
}

/** The first of the top rows that names a holder column and a shares (or amount) column; -1 when none does. */
export function findHeader(rows: readonly string[][], search = 1): number {
  for (let i = 0; i < Math.min(search, rows.length); i++) {
    const h = (rows[i] ?? []).map(norm)
    const has = (k: Col) => h.some((x) => (COLUMNS[k] as readonly string[]).includes(x))
    if (has('holder') && (has('quantity') || has('amount'))) return i
  }
  return -1
}

export function importCapTableCsv(text: string, opts: Omit<RowsImportOptions, 'headerSearch'> = {}): CsvImportResult {
  return importCapTableRows(parseCsv(text), { ...opts, headerSearch: 1 })
}

export function importCapTableRows(all: readonly string[][], opts: RowsImportOptions = {}): CsvImportResult {
  const cur = opts.currency ?? 'USD'
  const pre = opts.idPrefix ?? 'csv'
  const notes: string[] = []
  const at = findHeader(all, opts.headerSearch ?? 15)
  const rows = at < 0 ? all : all.slice(at)
  const where = (line: number) => (opts.where ? `${opts.where}, row ${line}` : `Row ${line}`)
  if (rows.length < 2) return { objects: [], notes: ['This file has no rows.'], rows: 0 }
  const header = rows[0]!.map(norm)
  const idx = {} as Record<Col, number>
  for (const k of Object.keys(COLUMNS) as Col[]) idx[k] = header.findIndex((h) => (COLUMNS[k] as readonly string[]).includes(h))
  if (at < 0 || idx.holder < 0 || (idx.quantity < 0 && idx.amount < 0)) {
    return { objects: [], notes: ['Couldn’t find the holder and shares (or amount) columns. Expected headers like “Stakeholder”, “Security type”, “Shares”.'], rows: rows.length - 1 }
  }
  const get = (r: readonly string[], k: Col) => (idx[k] >= 0 ? r[idx[k]]?.trim() : undefined)
  let available = 0
  // A currency column, when there is one, wins over the import's currency (one row can be in euros, the next in dollars).
  let rowCur = cur
  const money = (amount: number): Money => ({ minor: Math.round(amount * 10 ** exponent(rowCur) * 10_000) / 10_000, currency: rowCur })

  const objects: EquityObject[] = []
  const existing = opts.existing ?? []
  const people = new Map<string, string>()
  const classes = new Map<string, string>()
  for (const o of existing) {
    if (o.type === 'STAKEHOLDER') people.set(o.name.toLowerCase(), o.id)
    if (o.type === 'STOCK_CLASS') classes.set(o.name.toLowerCase(), o.id)
  }
  let planId = existing.find((o) => o.type === 'STOCK_PLAN')?.id
  let planNeeded = 0

  const personId = (name: string, rel?: string, email?: string): string => {
    const k = name.toLowerCase()
    let id = people.get(k)
    if (!id) {
      id = `${pre}-sh-${slug(name)}`
      people.set(k, id)
      const r = (rel ?? '').toUpperCase()
      const relationship: StakeholderObj['relationship'] | undefined = /FOUNDER/.test(r) ? 'FOUNDER' : /EMPLOY/.test(r) ? 'EMPLOYEE' : /INVEST/.test(r) ? 'INVESTOR' : /ADVIS/.test(r) ? 'ADVISOR' : /BOARD|DIRECTOR/.test(r) ? 'BOARD_MEMBER' : /CONSULT|CONTRACT/.test(r) ? 'CONSULTANT' : undefined
      objects.push({ type: 'STAKEHOLDER', id, name, stakeholderType: looksInstitutional(name) ? 'INSTITUTION' : 'INDIVIDUAL', ...(relationship ? { relationship } : {}), ...(email ? { email } : {}) })
    }
    return id
  }
  const classId = (name: string, preferred: boolean, price?: Money): string => {
    const k = name.toLowerCase()
    let id = classes.get(k)
    if (!id) {
      id = `${pre}-cls-${slug(name)}`
      classes.set(k, id)
      objects.push({ type: 'STOCK_CLASS', id, name, classType: preferred ? 'PREFERRED' : 'COMMON', authorized: null, seniority: preferred ? 1 : 0, ...(preferred && price ? { pricePerShare: price } : {}), liquidationPrefMultiple: preferred ? 1 : 0, participating: false, participationCapMultiple: null, conversionRatio: 1 })
      if (preferred) notes.push(`Created ${name} as 1x non-participating preferred. Change it if the terms differ.`)
    }
    return id
  }

  rows.slice(1).forEach((r, i) => {
    const line = at + i + 2
    if (!r.some((x) => x.trim() !== '')) return
    const c = get(r, 'currency')?.toUpperCase()
    rowCur = c && /^[A-Z]{3}$/.test(c) ? c : cur
    const holder = get(r, 'holder')
    // Footers label themselves in the holder column or in a column before it (Pulley puts them under Security ID).
    const label = holder || r.slice(0, Math.max(idx.holder, 0)).join(' ').trim()
    if (FOOTER.test(label)) {
      // "Available for issuance" under a grants table is the pool's unissued part; totals are just sums.
      if (AVAILABLE.test(label)) available += number(get(r, 'quantity')) ?? 0
      return
    }
    if (!holder) return notes.push(`${where(line)}: no holder name, skipped.`)
    const type = norm(get(r, 'type') || opts.typeHint || '')
    const cls = get(r, 'className')
    const qty = number(get(r, 'quantity'))
    const price = number(get(r, 'price'))
    const amount = number(get(r, 'amount'))
    const date = dateOf(get(r, 'date')) ?? '1970-01-01'
    if (date === '1970-01-01') notes.push(`${where(line)}: no date; used 1970-01-01.`)
    const start = dateOf(get(r, 'vestingStart'))
    const sched = parseVestingText(get(r, 'vestingSchedule'))
    const months = number(get(r, 'vestingMonths')) ?? sched?.months
    const vesting = start && months ? { start, months, cliffMonths: number(get(r, 'cliff')) ?? sched?.cliffMonths ?? 0 } : undefined
    const who = personId(holder, get(r, 'relationship'), get(r, 'email'))
    const id = `${pre}-${line}`

    if (/safe|note|convertible/.test(type) || (!qty && amount)) {
      if (!amount) return notes.push(`${where(line)}: a SAFE or note needs an amount, skipped.`)
      const cap = number(get(r, 'cap'))
      const disc = number(get(r, 'discount'))
      const int = number(get(r, 'interest'))
      const note = /note/.test(type)
      objects.push({
        type: 'TX_CONVERTIBLE_ISSUANCE', id, date, securityId: id, stakeholderId: who, kind: note ? 'NOTE' : 'SAFE', amount: money(amount),
        ...(cap ? { valuationCap: money(cap) } : {}),
        ...(disc ? { discountPct: disc < 1 ? disc * 100 : disc } : {}),
        ...(int ? { interestPct: int < 1 ? int * 100 : int } : {}),
        timing: note || /pre/.test(norm(header[idx.cap] ?? '')) ? 'PRE_MONEY' : 'POST_MONEY',
      })
      return
    }
    if (!qty || qty <= 0) return notes.push(`${where(line)}: no share count, skipped.`)
    if (/warrant/.test(type)) {
      // Warrants sit outside the option pool and turn into their own class (often preferred).
      const preferred = /prefer|series/i.test(cls ?? '')
      const expires = dateOf(get(r, 'expiration'))
      objects.push({ type: 'TX_WARRANT_ISSUANCE', id, date, securityId: id, stakeholderId: who, stockClassId: classId(cls || 'Common', preferred), quantity: qty, ...(price ? { exercisePrice: money(price) } : {}), ...(expires ? { expirationDate: expires } : {}) })
      const ex = number(get(r, 'exercised'))
      if (ex && ex > 0) objects.push({ type: 'TX_WARRANT_EXERCISE', id: `${id}-x`, date, securityId: id, quantity: ex, resultingSecurityId: `${id}-xs` })
      const cn = number(get(r, 'cancelled'))
      if (cn && cn > 0) objects.push({ type: 'TX_WARRANT_CANCELLATION', id: `${id}-c`, date, securityId: id, quantity: cn })
      return
    }
    if (/option|iso|nso|rsu|award/.test(type)) {
      planNeeded += qty
      if (!planId) {
        planId = `${pre}-plan`
        const commonId = classId('Common', false)
        objects.push({ type: 'STOCK_PLAN', id: planId, name: 'Option pool', stockClassId: commonId, size: 0 })
      }
      const ct = /rsu/.test(type) ? 'RSU' : /iso/.test(type) ? 'OPTION_ISO' : 'OPTION_NSO'
      objects.push({
        type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id, date, securityId: id, stakeholderId: who, stockPlanId: planId, stockClassId: classId('Common', false), compensationType: ct, quantity: qty,
        ...(price ? { exercisePrice: money(price) } : {}),
        ...(vesting ? { vesting } : {}),
      })
      // RSUs settle ("released"); options are exercised. Each becomes shares on the row's date.
      const ex = number(get(r, ct === 'RSU' ? 'released' : 'exercised')) ?? (ct === 'RSU' ? number(get(r, 'exercised')) : undefined)
      if (ex && ex > 0)
        objects.push(ct === 'RSU' ? { type: 'TX_EQUITY_COMPENSATION_RELEASE', id: `${id}-x`, date: vesting ? lastDate(date, vesting) : date, securityId: id, quantity: ex, resultingSecurityId: `${id}-xs` } : { type: 'TX_EQUITY_COMPENSATION_EXERCISE', id: `${id}-x`, date, securityId: id, quantity: ex, resultingSecurityId: `${id}-xs` })
      const cn = number(get(r, 'cancelled'))
      if (cn && cn > 0) objects.push({ type: 'TX_EQUITY_COMPENSATION_CANCELLATION', id: `${id}-c`, date, securityId: id, quantity: cn })
      return
    }
    const preferred = /prefer|series/.test(type) || /prefer|series/i.test(cls ?? '')
    const name = cls || (preferred ? 'Preferred' : 'Common')
    objects.push({ type: 'TX_STOCK_ISSUANCE', id, date, securityId: id, stakeholderId: who, stockClassId: classId(name, preferred, price ? money(price) : undefined), quantity: qty, ...(price ? { pricePerShare: money(price) } : {}), ...(vesting ? { vesting } : {}) })
  })

  // The CSV lists grants, not the pool size: size the pool to what was granted and say so.
  const plan = objects.find((o) => o.type === 'STOCK_PLAN' && o.id === planId)
  if (plan && plan.type === 'STOCK_PLAN' && plan.size === 0) {
    plan.size = planNeeded + available
    if (available) notes.push(`The option pool was set to ${plan.size.toLocaleString('en-US')} shares: ${planNeeded.toLocaleString('en-US')} granted plus ${available.toLocaleString('en-US')} the file lists as available.`)
    else notes.push(`The file doesn’t say how big the option pool is, so it was set to the ${planNeeded.toLocaleString('en-US')} shares granted. Change it if there’s more unissued.`)
  }
  return { objects, notes, rows: rows.length - 1 }
}
