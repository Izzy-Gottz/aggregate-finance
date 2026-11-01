// Exit waterfall: who gets what if the company sells for X. Preferred classes take their liquidation preference in
// seniority order (equal seniority shares pro rata); what's left goes to common, converted preferred, participating
// preferred and in-the-money options (each option nets its exercise price). Non-participating preferred converts to
// common when that pays more; participating preferred stops at its cap and may then prefer to convert. The choice is
// solved by iterating until no class wants to switch. SAFEs and notes are not paid here (model the round first).

import type { Money } from '@agfn/contracts'
import { asConverted, outstanding, vestedOutstanding, warrantAsConverted, warrantLive, type CapState } from './captable.ts'
import { inCurrency, type Rates } from './fx.ts'

export interface WaterfallOptions {
  /** Count only vested options and RSUs (default) or every outstanding one (full acceleration). Warrants always count. */
  options?: 'vested' | 'all'
  /** Units of the exit's currency per one unit of each other currency the cap table uses. */
  rates?: Rates
}

export interface WaterfallResult {
  exitValue: Money
  /** Value per common share after preferences. Minor units, unrounded. */
  commonPerShare: number
  classes: Array<{ className: string; preference: number; participation: number; converted: boolean; total: number }>
  holders: Array<{ name: string; amount: Money; pct: number }>
  /** Money left with nobody (only when there are no shares at all). */
  unallocated: Money
  warnings: string[]
  /** Currencies with no rate into the exit's currency. When any are listed nothing is worked out (all amounts 0). */
  missingRates: string[]
}

interface PrefClass {
  id: string
  name: string
  seniority: number
  shares: number
  asConverted: number
  prefAmount: number
  participating: boolean
  capTotal: number | null
}

export function waterfall(state: CapState, exit: Money, opts: WaterfallOptions = {}): WaterfallResult {
  const warnings: string[] = []
  // Preferences and strikes in the exit's currency first. Without a rate the split can't be known: say so, guess nothing.
  const { state: s, missing } = inCurrency(state, exit.currency, opts.rates ?? {})
  if (missing.length) {
    const zero = { minor: 0, currency: exit.currency }
    return { exitValue: { minor: Math.max(0, exit.minor), currency: exit.currency }, commonPerShare: 0, classes: [], holders: [], unallocated: zero, warnings: [`There’s no exchange rate from ${missing.join(', ')} to ${exit.currency} yet, so the split can’t be worked out.`], missingRates: missing }
  }
  const E = Math.max(0, exit.minor)
  const pref: PrefClass[] = s.classes
    .filter((c) => c.classType === 'PREFERRED')
    .map((c) => {
      const shares = s.stock.filter((p) => p.stockClassId === c.id).reduce((a, p) => a + p.quantity, 0)
      const ip = c.pricePerShare?.minor ?? 0
      if (!c.pricePerShare && shares > 0) warnings.push(`${c.name} has no issue price, so its preference is $0.`)
      return {
        id: c.id,
        name: c.name,
        seniority: c.seniority,
        shares,
        asConverted: Math.floor(shares * (c.conversionRatio || 1)),
        prefAmount: Math.round(shares * ip * (c.liquidationPrefMultiple ?? 1)),
        participating: c.participating,
        capTotal: c.participating && c.participationCapMultiple != null ? Math.round(shares * ip * c.participationCapMultiple) : null,
      }
    })
    .filter((c) => c.shares > 0)

  const commonShares = s.stock.filter((p) => s.classes.find((c) => c.id === p.stockClassId)?.classType !== 'PREFERRED').reduce((a, p) => a + asConverted(s, p), 0)
  // Options and RSUs (RSUs have no strike), then live warrants: each as common shares that net their price.
  const options = [
    ...s.grants.map((g) => ({ stakeholderId: g.stakeholderId, shares: opts.options === 'all' ? outstanding(g) : vestedOutstanding(g, s.asOf), strike: g.compensationType === 'RSU' ? 0 : (g.exercisePrice?.minor ?? 0) })),
    ...s.warrants.map((w) => {
      const ratio = s.classes.find((c) => c.id === w.stockClassId)?.conversionRatio || 1
      return { stakeholderId: w.stakeholderId, shares: warrantAsConverted(s, w), strike: (w.exercisePrice?.minor ?? 0) / ratio }
    }),
  ].filter((o) => o.shares > 0)
  if (s.warrants.some((w) => warrantLive(w, s.asOf) && s.classes.find((c) => c.id === w.stockClassId)?.classType === 'PREFERRED'))
    warnings.push('Warrants for preferred shares are counted as if exercised and converted to common; their preference isn’t added until they’re exercised.')

  const converted = new Set<string>()
  // Each class asks: do I get more converted or not, given everyone else's current choice? Repeat until stable.
  const valueIf = (c: PrefClass, convert: boolean): number => {
    const had = converted.has(c.id)
    convert ? converted.add(c.id) : converted.delete(c.id)
    const v = run().classTotals.get(c.id) ?? 0
    had ? converted.add(c.id) : converted.delete(c.id)
    return v
  }
  for (let i = 0; i < 50; i++) {
    let changed = false
    for (const c of pref) {
      if (c.participating && c.capTotal == null) continue // uncapped participation never converts
      const want = valueIf(c, true) > valueIf(c, false)
      if (want !== converted.has(c.id)) {
        want ? converted.add(c.id) : converted.delete(c.id)
        changed = true
      }
    }
    if (!changed) break
  }
  const result = run()

  function run() {
    let left = E
    const classTotals = new Map<string, number>()
    const prefPaid = new Map<string, number>()
    const tiers = [...new Set(pref.filter((c) => !converted.has(c.id)).map((c) => c.seniority))].sort((a, b) => b - a)
    for (const t of tiers) {
      const tier = pref.filter((c) => c.seniority === t && !converted.has(c.id))
      const owed = tier.reduce((a, c) => a + c.prefAmount, 0)
      const pay = Math.min(left, owed)
      for (const c of tier) {
        const got = owed ? (pay * c.prefAmount) / owed : 0
        prefPaid.set(c.id, got)
        classTotals.set(c.id, got)
      }
      left -= pay
    }
    // Residual: common + converted + participating (+ ITM options), solving the per-share value with strikes.
    const participants = pref.filter((c) => converted.has(c.id) || c.participating)
    const capped = new Set<string>()
    let perShare = 0
    let itm = options
    for (let k = 0; k < 50; k++) {
      const partShares = participants.filter((c) => !capped.has(c.id)).reduce((a, c) => a + c.asConverted, 0)
      const cappedTake = participants.filter((c) => capped.has(c.id)).reduce((a, c) => a + Math.max(0, (c.capTotal ?? 0) - (prefPaid.get(c.id) ?? 0)), 0)
      const optShares = itm.reduce((a, o) => a + o.shares, 0)
      const strikes = itm.reduce((a, o) => a + o.shares * o.strike, 0)
      const denom = commonShares + partShares + optShares
      perShare = denom ? Math.max(0, (left - cappedTake + strikes) / denom) : 0
      const nextItm = options.filter((o) => o.strike < perShare)
      let again = nextItm.length !== itm.length
      itm = nextItm
      for (const c of participants) {
        if (!c.participating || converted.has(c.id) || c.capTotal == null || capped.has(c.id)) continue
        if ((prefPaid.get(c.id) ?? 0) + c.asConverted * perShare > c.capTotal) {
          capped.add(c.id)
          again = true
        }
      }
      if (!again) break
    }
    for (const c of participants) {
      const base = converted.has(c.id) ? 0 : (prefPaid.get(c.id) ?? 0)
      const part = capped.has(c.id) ? Math.max(0, (c.capTotal ?? 0) - base) : c.asConverted * perShare
      classTotals.set(c.id, base + part)
    }
    return { perShare, classTotals, prefPaid, itm, left }
  }

  // Spread class totals to holders by shares; common and options by per-share value.
  const byHolder = new Map<string, number>()
  const add = (id: string, v: number) => byHolder.set(id, (byHolder.get(id) ?? 0) + v)
  for (const c of pref) {
    const total = result.classTotals.get(c.id) ?? 0
    for (const p of s.stock.filter((x) => x.stockClassId === c.id)) add(p.stakeholderId, c.shares ? (total * p.quantity) / c.shares : 0)
  }
  for (const p of s.stock) {
    if (s.classes.find((c) => c.id === p.stockClassId)?.classType === 'PREFERRED') continue
    add(p.stakeholderId, asConverted(s, p) * result.perShare)
  }
  for (const o of result.itm) add(o.stakeholderId, o.shares * (result.perShare - o.strike))

  const name = (id: string) => s.stakeholders.find((x) => x.id === id)?.name ?? 'Unknown holder'
  const cur = exit.currency
  // Round holder amounts to minor units so they add up to the exit exactly (largest remainder).
  const raw = [...byHolder.entries()].map(([id, v]) => ({ id, v, floor: Math.floor(v) }))
  const distributed = raw.reduce((a, r) => a + r.v, 0)
  let remainder = Math.round(distributed) - raw.reduce((a, r) => a + r.floor, 0)
  raw.sort((a, b) => b.v - b.floor - (a.v - a.floor))
  for (const r of raw) if (remainder-- > 0) r.floor += 1
  const holdersOut = raw
    .map((r) => ({ name: name(r.id), amount: { minor: r.floor, currency: cur }, pct: E ? (r.floor / E) * 100 : 0 }))
    .sort((a, b) => b.amount.minor - a.amount.minor)
  const paid = holdersOut.reduce((a, h) => a + h.amount.minor, 0)

  return {
    exitValue: { minor: E, currency: cur },
    commonPerShare: result.perShare,
    classes: pref.map((c) => {
      const total = result.classTotals.get(c.id) ?? 0
      const p = converted.has(c.id) ? 0 : (result.prefPaid.get(c.id) ?? 0)
      return { className: c.name, preference: Math.round(p), participation: Math.round(total - p), converted: converted.has(c.id), total: Math.round(total) }
    }),
    holders: holdersOut,
    unallocated: { minor: Math.max(0, E - paid), currency: cur },
    warnings,
    missingRates: [],
  }
}
