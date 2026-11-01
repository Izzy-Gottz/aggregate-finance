// Google Play earnings report (support.google.com/googleplay/android-developer/answer/6135870) → processor rows.
//
// One CSV per month (earnings/earnings_YYYYMM*.zip). Each line is one money movement from the developer's point of
// view, in the merchant (payout) currency: "Amount (Merchant Currency)". "Description" holds the order number
// (GPA.…); some exports call the column "Order Number", and both are accepted. Transaction Date is "Sep 3, 2026" and
// Transaction Time "4:33:17 AM PDT", in Pacific time; we convert to UTC.
//
// Rows are grouped per (order, month, group) into one processor.balance_txn each:
//   charge  ← Charge, Charge rebill (gross) + Google fee, Google fee rebill (fee as a positive cost); net = gross − fee.
//   refund  ← Charge refund (negative gross) + Google fee refund (negative fee: Google returns its fee).
//   tax     ← Tax, Tax rebill, Tax refund: a separate kind 'adjustment' row marked salesTax, fee 0, keeping the file's
//            sign; the ledger posts it to sales tax payable.
//            Google withholds/remits tax itself in many countries (no row, or a net-zero pair); where a Tax row
//            reaches your balance it's money you hold for the tax authority, so it is kept out of the charge's gross
//            (revenue) but still on the balance, so the monthly payout reconciles exactly.
//   other   ← Adjustment and anything unknown: kind 'adjustment', fee 0, file sign.
// Charge and Charge refund amounts are taken by absolute value with the known direction, so the mapping doesn't
// depend on how a particular export signs them; fees likewise.

import { ConnectorError, money, normalizeCurrency } from '@agfn/connector-sdk'

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const s = text.replace(/^﻿/, '')
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++
      row.push(cell)
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (quoted) throw new ConnectorError('invalid_input', 'unterminated quote in earnings CSV', { provider: 'googleplay' })
  row.push(cell)
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const ZONES: Record<string, number> = { PDT: -7, PST: -8, UTC: 0, GMT: 0 }

/** "Sep 3, 2026" + "4:33:17 AM PDT" (Pacific) → UTC ISO timestamp. */
export function playTimestamp(date: string, time: string): string | undefined {
  const d = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(date.trim())
  if (!d) return undefined
  const month = MONTHS[d[1]!.toLowerCase()]
  if (!month) return undefined
  let h = 0
  let m = 0
  let sec = 0
  let offset = -8
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?\s*([A-Z]{3,4})?$/i.exec(time.trim())
  if (t) {
    h = Number(t[1])
    m = Number(t[2])
    sec = Number(t[3] ?? 0)
    const ap = t[4]?.toUpperCase()
    if (ap === 'PM' && h < 12) h += 12
    if (ap === 'AM' && h === 12) h = 0
    const z = t[5]?.toUpperCase()
    if (z && z in ZONES) offset = ZONES[z]!
  }
  const ms = Date.UTC(Number(d[3]), month - 1, Number(d[2]), h - offset, m, sec)
  return new Date(ms).toISOString()
}

export type PlayGroup = 'charge' | 'refund' | 'tax' | 'other'

export interface PlayAggregate {
  externalId: string
  order: string
  group: PlayGroup
  currency: string
  /** Signed minor units into the balance. */
  gross: number
  /** Positive cost; negative when Google returns its fee. */
  fee: number
  at: string
}

function groupOf(type: string): { group: PlayGroup; part: 'gross' | 'fee'; dir: 1 | -1 | 0 } {
  switch (type.trim().toLowerCase()) {
    case 'charge':
      return { group: 'charge', part: 'gross', dir: 1 }
    case 'charge rebill':
      return { group: 'charge', part: 'gross', dir: 0 }
    case 'google fee':
      return { group: 'charge', part: 'fee', dir: 1 }
    case 'google fee rebill':
      return { group: 'charge', part: 'fee', dir: 0 }
    case 'charge refund':
      return { group: 'refund', part: 'gross', dir: -1 }
    case 'google fee refund':
      return { group: 'refund', part: 'fee', dir: -1 }
    case 'tax':
    case 'tax rebill':
    case 'tax refund':
      return { group: 'tax', part: 'gross', dir: 0 }
    default:
      return { group: 'other', part: 'gross', dir: 0 }
  }
}

/** Parse one month's earnings CSV and aggregate it into per-order rows. `month` is YYYYMM from the object name. */
export function aggregateEarnings(csv: string, month: string): PlayAggregate[] {
  const rows = parseCsv(csv)
  const header = rows.shift()
  if (!header) return []
  const idx = new Map(header.map((h, i) => [h.trim().toLowerCase(), i]))
  const col = (r: string[], ...names: string[]) => {
    for (const n of names) {
      const i = idx.get(n)
      if (i !== undefined) return (r[i] ?? '').trim()
    }
    return ''
  }
  if (!idx.has('transaction type') || !idx.has('amount (merchant currency)') || !idx.has('merchant currency')) {
    throw new ConnectorError('invalid_input', 'earnings CSV is missing expected columns', { provider: 'googleplay' })
  }
  const groups = new Map<string, PlayAggregate>()
  rows.forEach((r, i) => {
    const type = col(r, 'transaction type')
    const amount = col(r, 'amount (merchant currency)')
    const currency = normalizeCurrency(col(r, 'merchant currency'))
    if (!type || !amount) return
    const order = col(r, 'order number', 'description') || `row${i + 1}`
    const at = playTimestamp(col(r, 'transaction date'), col(r, 'transaction time')) ?? `${month.slice(0, 4)}-${month.slice(4)}-01T08:00:00.000Z`
    const { group, part, dir } = groupOf(type)
    const minor = money(amount, currency).minor
    // gross: + into the balance. fee: + cost. Known directions use |amount|; the rest keep the file's sign.
    const v = part === 'gross' ? (dir === 0 ? minor : dir * Math.abs(minor)) : dir === 0 ? -minor : dir * Math.abs(minor)
    let key = `${order}:${group}:${month}`
    const existing = groups.get(key)
    if (existing && existing.currency !== currency) key = `${key}:${currency}`
    const g = groups.get(key) ?? { externalId: key, order, group, currency, gross: 0, fee: 0, at }
    if (part === 'gross') g.gross += v
    else g.fee += v
    if (at > g.at) g.at = at
    groups.set(key, g)
  })
  return [...groups.values()].filter((g) => g.gross !== 0 || g.fee !== 0)
}
