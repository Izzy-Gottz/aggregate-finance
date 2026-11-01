// App Store FINANCIAL report (region ZZ = all currencies in one file) → monthly proceeds.
//
// The file is tab-separated; a consolidated report repeats the header per currency section and ends sections with
// Total_Rows / Total_Amount / Total_Units footer lines. Columns are found by header name (case-insensitive), so
// "Country of Sale" and "Country Of Sale" both work. Relevant columns (Apple's "Financial report fields"):
// Start Date, End Date (MM/DD/YYYY, Apple fiscal calendar), Quantity, Partner Share, Extended Partner Share
// (= Quantity × Partner Share), Partner Share Currency, Sale or Return (S/R), Country of Sale.
//
// Money semantics. Partner Share is Apple's payout to you: customer price minus tax and Apple's commission. Apple's
// commission is not itemized in finance reports, so every row has fee 0 and gross = net = Extended Partner Share.
// One processor.balance_txn per (fiscal month, currency, country, sale/return): sales are 'charge' (positive),
// returns are 'refund' (negative). A return is recognized by S/R = 'R' or a negative quantity, and is always booked
// negative whatever sign the file uses (sources disagree on whether R rows carry negative amounts).

import { money, normalizeCurrency } from '@agfn/connector-sdk'

export interface FinanceRow {
  startDate: string
  endDate: string
  quantity: number
  extendedPartnerShare: string
  currency: string
  saleOrReturn: 'S' | 'R'
  country: string
  productType?: string
  appleId?: string
}

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/

/** MM/DD/YYYY → YYYY-MM-DD. */
export function appleDate(v: string): string | undefined {
  const m = DATE.exec(v.trim())
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined
}

export function parseFinanceReport(text: string): FinanceRow[] {
  const rows: FinanceRow[] = []
  let cols: Map<string, number> | undefined
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const cells = rawLine.split('\t').map((c) => c.trim())
    if (cells[0]?.toLowerCase() === 'start date') {
      cols = new Map(cells.map((c, i) => [c.toLowerCase(), i]))
      continue
    }
    if (!cols || /^total_/i.test(cells[0] ?? '')) continue
    const get = (name: string) => {
      const i = cols?.get(name)
      return i === undefined ? '' : (cells[i] ?? '')
    }
    const start = appleDate(get('start date'))
    const end = appleDate(get('end date'))
    if (!start || !end) continue
    const ext = get('extended partner share')
    const currency = get('partner share currency')
    if (!ext || !currency) continue
    const qty = Number(get('quantity') || '0')
    const sr = get('sale or return').toUpperCase()
    const productType = get('product type identifier')
    const appleId = get('apple identifier')
    rows.push({
      startDate: start,
      endDate: end,
      quantity: Number.isFinite(qty) ? qty : 0,
      extendedPartnerShare: ext,
      currency: normalizeCurrency(currency),
      saleOrReturn: sr === 'R' || qty < 0 ? 'R' : 'S',
      country: (get('country of sale') || 'ZZ').toUpperCase(),
      ...(productType ? { productType } : {}),
      ...(appleId ? { appleId } : {}),
    })
  }
  return rows
}

export interface ProceedsGroup {
  key: string
  currency: string
  country: string
  kind: 'charge' | 'refund'
  /** Signed minor units (+ sales, − returns). */
  amount: number
  units: number
  /** Latest End Date in the group (the fiscal month end). */
  endDate: string
}

export function aggregateProceeds(month: string, rows: FinanceRow[]): ProceedsGroup[] {
  const groups = new Map<string, ProceedsGroup>()
  for (const r of rows) {
    const key = `${month}:${r.currency}:${r.country}:${r.saleOrReturn}`
    const minor = money(r.extendedPartnerShare, r.currency).minor
    const signed = r.saleOrReturn === 'R' ? -Math.abs(minor) : minor
    const g = groups.get(key)
    if (g) {
      g.amount += signed
      g.units += Math.abs(r.quantity)
      if (r.endDate > g.endDate) g.endDate = r.endDate
    } else {
      groups.set(key, {
        key,
        currency: r.currency,
        country: r.country,
        kind: r.saleOrReturn === 'R' ? 'refund' : 'charge',
        amount: signed,
        units: Math.abs(r.quantity),
        endDate: r.endDate,
      })
    }
  }
  return [...groups.values()].filter((g) => g.amount !== 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
