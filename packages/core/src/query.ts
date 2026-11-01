// One small query language for transaction search and rules (after Firefly III's idea that a rule is a saved
// search; no code from it). An AI writes it once and can turn it straight into a rule:
//
//   counterparty:"AWS" amount>500 date:2026-09 -refund
//
// Terms (space separated, all must hold; quote values with spaces):
//   word, "two words", aws*      text in the counterparty or description (case-insensitive; * = anything)
//   -word                        text that must not appear
//   counterparty:X  payee:X      the counterparty is X (same merchant, ignoring "Inc", card noise, case)
//   amount:500  amount>500  amount>=500  amount<500  amount<=500  amount:100..500
//                                absolute amount in major units (500 = 500.00), any direction
//   in  out                      money in or money out (also direction:in / direction:out)
//   date:2026-09  date:2026-09-15  date>=2026-01-01  date<2026-02-01  after:2026-01-01  before:2026-02-01
//   account:X                    an account id, or part of its name or last digits
//   category:software            search only: the row's category
//   currency:EUR
import type { IsoDate } from '@agfn/contracts'
import { globMatch, merchantKey } from './rules.ts'

export class QueryError extends Error {
  override name = 'QueryError'
}

export interface TxnFilter {
  /** All must appear (case-insensitive; * matches anything). */
  words: string[]
  /** None may appear. */
  notWords: string[]
  counterparty?: string
  /** Absolute amount bounds in major units (the matcher converts each row by its currency's decimals). */
  minAbs?: number
  maxAbs?: number
  minExclusive?: boolean
  maxExclusive?: boolean
  direction?: 'in' | 'out'
  from?: IsoDate
  to?: IsoDate
  accounts: string[]
  category?: string
  currency?: string
}

const MAX_QUERY = 500
const DATE = /^\d{4}-\d{2}(-\d{2})?$/

function tokens(q: string): string[] {
  const out: string[] = []
  const re = /(-?[a-z_]+(?:>=|<=|:|>|<))?"([^"]*)"|(\S+)/gi
  for (const m of q.matchAll(re)) {
    if (m[3] !== undefined) out.push(m[3])
    else out.push(`${m[1] ?? ''}\u0000${m[2]}`) // quoted value; \0 marks "keep spaces"
  }
  return out
}

function majorAmount(v: string, term: string): number {
  const n = Number(v.replace(/[$,€£]/g, ''))
  if (!Number.isFinite(n) || n < 0) throw new QueryError(`"${term}": the amount must be a number like 500 or 12.50`)
  return n
}

function monthEndOf(month: string): IsoDate {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

function dayBefore(d: IsoDate): IsoDate {
  return new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

function dayAfter(d: IsoDate): IsoDate {
  return new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
}

export function parseQuery(q: string): TxnFilter {
  if (q.length > MAX_QUERY) throw new QueryError(`Queries are limited to ${MAX_QUERY} characters`)
  const f: TxnFilter = { words: [], notWords: [], accounts: [] }
  for (const raw of tokens(q.trim())) {
    const quoted = raw.includes('\u0000')
    const [head, quotedValue] = quoted ? (raw.split('\u0000') as [string, string]) : [raw, '']
    const m = quoted ? /^(-?[a-z_]+)(>=|<=|:|>|<)$/i.exec(head) : /^(-?[a-z_]+)(>=|<=|:|>|<)(.+)$/i.exec(head)
    if (!m) {
      const word = quoted ? quotedValue : head
      // Every term must hold already, so AND adds nothing; OR would silently search for the word "or" and find nothing.
      if (!quoted && word === 'AND') continue
      if (!quoted && (word === 'OR' || word === '||' || word === '|')) throw new QueryError('OR isn\'t supported: every term must hold. Run one query per alternative (e.g. one with account:Stripe, one with account:Shopify) and add the results')
      if (word === 'in' || word === 'out') f.direction = word
      else if (word.startsWith('-') && word.length > 1 && !quoted) f.notWords.push(word.slice(1).toLowerCase())
      else if (word.trim()) f.words.push(word.toLowerCase())
      continue
    }
    const key = (m[1] as string).toLowerCase()
    const op = m[2] as string
    const value = quoted ? quotedValue : (m[3] as string)
    const term = quoted ? `${head}"${value}"` : head
    switch (key) {
      case 'counterparty':
      case 'payee':
      case 'merchant':
        if (!merchantKey(value)) throw new QueryError(`"${term}": say which counterparty`)
        f.counterparty = value
        break
      case 'amount': {
        if (op === ':' && value.includes('..')) {
          const [lo, hi] = value.split('..') as [string, string]
          f.minAbs = majorAmount(lo, term)
          f.maxAbs = majorAmount(hi, term)
        } else if (op === ':') f.minAbs = f.maxAbs = majorAmount(value, term)
        else if (op === '>' || op === '>=') {
          f.minAbs = majorAmount(value, term)
          f.minExclusive = op === '>'
        } else {
          f.maxAbs = majorAmount(value, term)
          f.maxExclusive = op === '<'
        }
        break
      }
      case 'direction':
        if (value !== 'in' && value !== 'out') throw new QueryError(`"${term}": direction is in or out`)
        f.direction = value
        break
      case 'date':
      case 'after':
      case 'before': {
        if (!DATE.test(value)) throw new QueryError(`"${term}": dates look like 2026-09 or 2026-09-15`)
        const first = value.length === 7 ? `${value}-01` : value
        const last = value.length === 7 ? monthEndOf(value) : value
        if (key === 'after') f.from = dayAfter(last)
        else if (key === 'before') f.to = dayBefore(first)
        else if (op === ':') {
          f.from = first
          f.to = last
        } else if (op === '>=') f.from = first
        else if (op === '>') f.from = dayAfter(last)
        else if (op === '<=') f.to = last
        else f.to = dayBefore(first)
        break
      }
      case 'account':
        f.accounts.push(value.toLowerCase())
        break
      case 'category':
        f.category = value.toLowerCase()
        break
      case 'currency':
        if (!/^[a-z]{3}$/i.test(value)) throw new QueryError(`"${term}": currencies look like USD or EUR`)
        f.currency = value.toUpperCase()
        break
      default:
        throw new QueryError(`"${term}": unknown term "${key}". Use counterparty, amount, in/out, date, account, category or currency`)
    }
  }
  if (f.minAbs !== undefined && f.maxAbs !== undefined && f.minAbs > f.maxAbs) throw new QueryError('The amount range is empty (the low end is above the high end)')
  if (f.from && f.to && f.from > f.to) throw new QueryError('The date range is empty')
  return f
}

/** What a row says about itself, for matching. */
export interface FilterRow {
  text: string
  counterparty: string | null
  amount: { minor: number; currency: string }
  date: IsoDate
  account: { id: string; name: string; mask: string | null } | null
  category?: string | null
}

const MINOR_DIGITS: Record<string, number> = { JPY: 0, KRW: 0, KWD: 3, BHD: 3 }

function glob(word: string, text: string): boolean {
  return word.includes('*') ? globMatch(`*${word}*`, text) : text.includes(word)
}

export function matchesFilter(f: TxnFilter, row: FilterRow): boolean {
  const text = `${row.counterparty ?? ''} ${row.text}`.toLowerCase()
  if (!f.words.every((w) => glob(w, text))) return false
  if (f.notWords.some((w) => glob(w, text))) return false
  if (f.counterparty !== undefined && merchantKey(row.counterparty ?? row.text) !== merchantKey(f.counterparty)) return false
  if (f.direction === 'in' && row.amount.minor <= 0) return false
  if (f.direction === 'out' && row.amount.minor >= 0) return false
  if (f.currency && row.amount.currency !== f.currency) return false
  if (f.minAbs !== undefined || f.maxAbs !== undefined) {
    const abs = Math.abs(row.amount.minor) / 10 ** (MINOR_DIGITS[row.amount.currency] ?? 2)
    if (f.minAbs !== undefined && (f.minExclusive ? abs <= f.minAbs : abs < f.minAbs)) return false
    if (f.maxAbs !== undefined && (f.maxExclusive ? abs >= f.maxAbs : abs > f.maxAbs)) return false
  }
  if (f.from && row.date < f.from) return false
  if (f.to && row.date > f.to) return false
  if (f.accounts.length) {
    const a = row.account
    if (!a || !f.accounts.some((x) => x === a.id.toLowerCase() || a.name.toLowerCase().includes(x) || (a.mask !== null && a.mask === x))) return false
  }
  if (f.category !== undefined && (row.category ?? '').toLowerCase() !== f.category) return false
  return true
}
