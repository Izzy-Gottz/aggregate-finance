// "What happens at the next priced round?" Converts every outstanding SAFE and note, tops up the option pool to a
// target, and prices the new shares, all at once. The pieces depend on each other (the price depends on the share
// count, which depends on what the SAFEs convert into, which depends on the price), so it solves for a fixed point.
//
// Definitions:
// - Round price = pre-money valuation ÷ pre-money fully diluted shares, where pre-money FD includes the converting
//   SAFEs/notes and any pool increase (the usual "pool shuffle": new money doesn't pay for the new pool).
// - Post-money SAFE (YC): cap price = cap ÷ company capitalization, which includes all converting securities and the
//   existing pool, but not the round's pool increase or new money. So a $1M SAFE at a $10M cap owns 10% before the round.
// - Pre-money SAFE and notes: cap price = cap ÷ pre-round fully diluted shares (excluding converting securities).
// - Discount price = round price × (1 − discount). Each converts at the lowest of round, cap and discount price.
// - Notes convert principal + simple interest accrued to the round date (actual/365).
// Prices are floating-point minor units per share; share counts are whole (rounded down).

import type { Money } from '@agfn/contracts'
import { accruedInterest, fullyDiluted, holders, poolAvailable, type CapState, type ConvertiblePosition } from './captable.ts'
import { convertMinor, inCurrency, type Rates } from './fx.ts'

export interface RoundInput {
  date: string
  preMoney: Money
  investment: Money
  /** Unissued pool as a % of post-money fully diluted shares (e.g. 10). Omit to leave the pool alone. */
  poolTargetPct?: number
  /** Name for the new preferred class. */
  className?: string
  /** Lead investor name, for the table. */
  investorName?: string
  /** Units of the pre-money's currency per one unit of each other currency the cap table or investment uses. */
  rates?: Rates
}

export interface ConversionRow {
  securityId: string
  holder: string
  kind: 'SAFE' | 'NOTE'
  /** Principal plus accrued interest. */
  convertingAmount: Money
  /** Minor units per share, unrounded. */
  pricePerShare: number
  /** Which price won. */
  basis: 'cap' | 'discount' | 'round'
  shares: number
}

export interface RoundResult {
  /** Minor units per share, unrounded. */
  pricePerShare: number
  newShares: number
  poolIncrease: number
  conversions: ConversionRow[]
  preMoneyFullyDiluted: number
  postMoneyFullyDiluted: number
  postMoney: Money
  /** Post-round ownership, largest first (existing holders, converted SAFEs/notes, new investors, pool). */
  table: Array<{ name: string; shares: number; pct: number; kind: 'existing' | 'converted' | 'new' | 'pool' }>
  iterations: number
  warnings: string[]
}

export function modelRound(state: CapState, input: RoundInput): RoundResult {
  const warnings: string[] = []
  const cur = input.preMoney.currency
  // Everything in the round's currency first; a currency with no rate means the round can't be worked out.
  const { state: s, missing } = inCurrency(state, cur, input.rates ?? {})
  const investment = input.investment.currency === cur ? input.investment : input.rates?.[input.investment.currency] ? { minor: Math.round(convertMinor(input.investment.minor, input.investment.currency, cur, input.rates[input.investment.currency]!)), currency: cur } : null
  if (!investment) missing.push(input.investment.currency)
  if (missing.length) throw new RangeError(`There’s no exchange rate from ${[...new Set(missing)].join(', ')} to ${cur} yet, so this round can’t be worked out.`)
  input = { ...input, investment: investment! }
  if (input.preMoney.minor <= 0) throw new RangeError('Pre-money valuation must be above zero.')
  if (input.investment.minor < 0) throw new RangeError('Investment can’t be negative.')
  const fd = fullyDiluted(s)
  const existing = fd.total
  const poolNow = poolAvailable(s)
  const name = (id: string) => s.stakeholders.find((x) => x.id === id)?.name ?? 'Unknown holder'
  const amountOf = (c: ConvertiblePosition): number => c.amount.minor + (c.kind === 'NOTE' ? accruedInterest(c, input.date) : 0)

  let conv = s.convertibles.map(() => 0)
  let q = 0
  let price = input.preMoney.minor / Math.max(1, existing)
  let iterations = 0
  for (; iterations < 200; iterations++) {
    const sumConv = conv.reduce((a, x) => a + x, 0)
    const preFd = existing + sumConv + q
    price = input.preMoney.minor / preFd
    const newShares = input.investment.minor / price
    const postFd = preFd + newShares
    const nextQ = input.poolTargetPct != null ? Math.max(0, (input.poolTargetPct / 100) * postFd - poolNow) : 0
    const nextConv = s.convertibles.map((c) => {
      const candidates: number[] = [price]
      if (c.discountPct) candidates.push(price * (1 - c.discountPct / 100))
      if (c.valuationCap) {
        const capitalization = c.timing === 'POST_MONEY' ? existing + sumConv : existing
        candidates.push(c.valuationCap.minor / capitalization)
      }
      return amountOf(c) / Math.min(...candidates)
    })
    const delta = Math.abs(nextQ - q) + nextConv.reduce((a, x, i) => a + Math.abs(x - (conv[i] ?? 0)), 0)
    conv = nextConv
    q = nextQ
    if (delta < 1e-6) break
  }
  if (iterations >= 200) warnings.push('The round didn’t settle on one answer; numbers are approximate.')

  const conversions: ConversionRow[] = s.convertibles.map((c, i) => {
    const shares = wholeShares(conv[i] ?? 0)
    const amount = amountOf(c)
    const pps = shares ? amount / (conv[i] ?? 1) : price
    const capPrice = c.valuationCap ? c.valuationCap.minor / (c.timing === 'POST_MONEY' ? existing + conv.reduce((a, x) => a + x, 0) : existing) : Infinity
    const discPrice = c.discountPct ? price * (1 - c.discountPct / 100) : Infinity
    const basis: ConversionRow['basis'] = capPrice <= discPrice && capPrice < price ? 'cap' : discPrice < price ? 'discount' : 'round'
    return { securityId: c.securityId, holder: name(c.stakeholderId), kind: c.kind, convertingAmount: { minor: amount, currency: c.amount.currency }, pricePerShare: pps, basis, shares }
  })
  const poolIncrease = wholeShares(q)
  const convShares = conversions.reduce((a, x) => a + x.shares, 0)
  const preFd = existing + convShares + poolIncrease
  const newShares = wholeShares(input.investment.minor / price)
  const postFd = preFd + newShares

  const table: RoundResult['table'] = []
  for (const h of holders(s)) {
    if (h.stakeholderId === null) continue
    table.push({ name: h.name, shares: h.fullyDilutedShares, pct: 0, kind: 'existing' })
  }
  for (const c of conversions) {
    const t = table.find((r) => r.name === c.holder && r.kind === 'converted')
    if (t) t.shares += c.shares
    else table.push({ name: c.holder, shares: c.shares, pct: 0, kind: 'converted' })
  }
  if (newShares > 0) table.push({ name: input.investorName ?? 'New investors', shares: newShares, pct: 0, kind: 'new' })
  const poolAfter = poolNow + poolIncrease
  if (poolAfter > 0) table.push({ name: 'Available option pool', shares: poolAfter, pct: 0, kind: 'pool' })
  for (const r of table) r.pct = postFd ? (r.shares / postFd) * 100 : 0
  table.sort((a, b) => b.shares - a.shares)

  return {
    pricePerShare: price,
    newShares,
    poolIncrease,
    conversions,
    preMoneyFullyDiluted: preFd,
    postMoneyFullyDiluted: postFd,
    postMoney: { minor: input.preMoney.minor + input.investment.minor, currency: cur },
    table,
    iterations,
    warnings,
  }
}

/** Round down to whole shares, forgiving floating-point dust (999,999.9999999 → 1,000,000). */
function wholeShares(x: number): number {
  return Math.floor(x + 1e-6)
}
