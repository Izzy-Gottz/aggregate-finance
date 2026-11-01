// Cap tables in more than one currency. Every price and amount stays in the currency it was issued in; anything that
// adds them up (preferences, SAFEs and notes, a round model, an exit) first converts the whole state into one currency
// with the same FX rates the ledger uses. A missing rate is reported, never guessed: the totals that need it are unknown.

import type { Money } from '@agfn/contracts'
import type { CapState } from './captable.ts'

/** Units of the target currency per one unit of each other currency, e.g. { EUR: 1.08 } into USD. */
export type Rates = Record<string, number>

/** Where rates come from (the ledger's RateSource fits): units of `to` per one `from` on `date`, as a decimal string. */
export interface EquityRatePort {
  rate(date: string, from: string, to: string): Promise<string>
}

const digits = new Map<string, number>()
/** Minor-unit exponent: 2 for USD and EUR, 0 for JPY, 3 for KWD. */
export function exponent(currency: string): number {
  let d = digits.get(currency)
  if (d == null) {
    try {
      d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      d = 2
    }
    digits.set(currency, d)
  }
  return d
}

/** Converts minor units (fractional allowed, for share prices) at `rate`, to four decimals of a minor unit. */
export function convertMinor(minor: number, from: string, to: string, rate: number): number {
  if (from === to) return minor
  // Four decimals of a minor unit, like share prices everywhere else (and no floating-point dust).
  return Math.round(minor * rate * 10 ** (exponent(to) - exponent(from)) * 10_000) / 10_000
}

/** Every currency a cap table uses. */
export function currenciesIn(s: CapState): string[] {
  const out = new Set<string>()
  const add = (m?: Money) => m && out.add(m.currency)
  for (const c of s.classes) add(c.pricePerShare)
  for (const v of s.valuations) add(v.pricePerShare)
  for (const p of s.stock) add(p.pricePerShare)
  for (const c of s.convertibles) (add(c.amount), add(c.valuationCap))
  for (const g of s.grants) add(g.exercisePrice)
  for (const w of s.warrants) (add(w.exercisePrice), add(w.purchasePrice))
  return [...out].sort()
}

/** The same cap table with every amount in `to`. `missing` lists currencies with no rate; their amounts are left as they
 *  were, so a caller must treat anything built from them as unknown. */
export function inCurrency(s: CapState, to: string, rates: Rates): { state: CapState; missing: string[] } {
  const missing = new Set<string>()
  const conv = <M extends Money | undefined>(m: M): M => {
    if (!m || m.currency === to) return m
    const r = rates[m.currency]
    if (r == null || !Number.isFinite(r) || r <= 0) {
      missing.add(m.currency)
      return m
    }
    return { minor: convertMinor(m.minor, m.currency, to, r), currency: to } as M
  }
  const opt = <K extends string, T extends Partial<Record<K, Money>>>(x: T, ...keys: K[]): T => {
    const y = { ...x }
    for (const k of keys) if (y[k]) (y as Record<K, Money | undefined>)[k] = conv(y[k] as Money)
    return y
  }
  const state: CapState = {
    ...s,
    classes: s.classes.map((c) => opt(c, 'pricePerShare')),
    valuations: s.valuations.map((v) => ({ ...v, pricePerShare: conv(v.pricePerShare) })),
    stock: s.stock.map((p) => opt(p, 'pricePerShare')),
    convertibles: s.convertibles.map((c) => ({ ...opt(c, 'valuationCap'), amount: conv(c.amount) })),
    grants: s.grants.map((g) => opt(g, 'exercisePrice')),
    warrants: s.warrants.map((w) => opt(w, 'exercisePrice', 'purchasePrice')),
  }
  return { state, missing: [...missing].sort() }
}

/** Sums amounts into `to`; null when any of them has no rate. Whole minor units. */
export function sumIn(amounts: readonly Money[], to: string, rates: Rates): Money | null {
  let total = 0
  for (const m of amounts) {
    if (m.currency === to) total += m.minor
    else {
      const r = rates[m.currency]
      if (r == null || !(r > 0)) return null
      total += convertMinor(m.minor, m.currency, to, r)
    }
  }
  return { minor: Math.round(total), currency: to }
}

/** Rates into `to` for each currency, from a rate port; a currency whose rate can't be had is left out. */
export async function ratesFor(port: EquityRatePort | undefined, currencies: readonly string[], to: string, date: string): Promise<Rates> {
  const out: Rates = {}
  for (const c of currencies) {
    if (c === to) continue
    if (!port) continue
    try {
      const r = Number(await port.rate(date, c, to))
      if (Number.isFinite(r) && r > 0) out[c] = r
    } catch {
      /* unknown: the caller reports it */
    }
  }
  return out
}
