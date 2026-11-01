// Replay cap-table objects into the current state, then derive the fully diluted table. Pure, deterministic, and
// JSON-serializable (no Maps in the output), so the browser can run "what if" modeling on the same state.

import type { Money } from '@agfn/contracts'
import { FACT_TYPES, objectDate, type EquityObject, type IsoDate, type StakeholderObj, type StockClassObj, type StockPlanObj, type ValuationObj, type Vesting } from './model.ts'
import { vestedShares } from './vesting.ts'

export interface StockPosition {
  securityId: string
  stakeholderId: string
  stockClassId: string
  quantity: number
  date: IsoDate
  pricePerShare?: Money
  vesting?: Vesting
  /** The object that created it (issuance, transfer, exercise). */
  sourceId: string
}

export interface ConvertiblePosition {
  securityId: string
  stakeholderId: string
  kind: 'SAFE' | 'NOTE'
  amount: Money
  valuationCap?: Money
  discountPct?: number
  interestPct?: number
  maturityDate?: IsoDate
  timing: 'POST_MONEY' | 'PRE_MONEY'
  date: IsoDate
  sourceId: string
}

export interface GrantPosition {
  securityId: string
  stakeholderId: string
  stockPlanId?: string
  stockClassId: string
  compensationType: 'OPTION_ISO' | 'OPTION_NSO' | 'RSU' | 'WARRANT'
  /** Originally granted. */
  granted: number
  exercised: number
  /** RSU units settled (withheld ones included). */
  released: number
  cancelled: number
  exercisePrice?: Money
  vesting?: Vesting
  expirationDate?: IsoDate
  date: IsoDate
  sourceId: string
}

export interface WarrantPosition {
  securityId: string
  stakeholderId: string
  /** The class it turns into. */
  stockClassId: string
  granted: number
  exercised: number
  cancelled: number
  exercisePrice?: Money
  purchasePrice?: Money
  expirationDate?: IsoDate
  date: IsoDate
  sourceId: string
}

export interface PlanPosition extends StockPlanObj {
  /** Shares that came back from cancelled grants (they return to the pool). */
  returned: number
}

export interface CapState {
  asOf: IsoDate
  stakeholders: StakeholderObj[]
  classes: StockClassObj[]
  plans: PlanPosition[]
  valuations: ValuationObj[]
  stock: StockPosition[]
  convertibles: ConvertiblePosition[]
  grants: GrantPosition[]
  warrants: WarrantPosition[]
  /** Plain-language problems found while replaying (over-transfer, unknown security…). Never thrown. */
  warnings: string[]
}

/** Sort: facts first, then transactions by date, keeping insertion order within a day. */
export function ordered(objects: readonly EquityObject[]): EquityObject[] {
  return objects
    .map((o, i) => ({ o, i }))
    .sort((a, b) => {
      const fa = FACT_TYPES.has(a.o.type) ? 0 : 1
      const fb = FACT_TYPES.has(b.o.type) ? 0 : 1
      if (fa !== fb) return fa - fb
      const d = objectDate(a.o).localeCompare(objectDate(b.o))
      return d !== 0 ? d : a.i - b.i
    })
    .map((x) => x.o)
}

export function replay(objects: readonly EquityObject[], asOf: IsoDate = '9999-12-31'): CapState {
  const s: CapState = { asOf, stakeholders: [], classes: [], plans: [], valuations: [], stock: [], convertibles: [], grants: [], warrants: [], warnings: [] }
  const stock = new Map<string, StockPosition>()
  const conv = new Map<string, ConvertiblePosition>()
  const grants = new Map<string, GrantPosition>()
  const warrants = new Map<string, WarrantPosition>()
  const plans = new Map<string, PlanPosition>()
  const holderName = (id: string) => s.stakeholders.find((x) => x.id === id)?.name ?? 'someone'
  const exerciseWarrant = (w: WarrantPosition, quantity: number, netFairValue: Money | undefined, resultId: string, date: IsoDate, sourceId: string) => {
    if (w.expirationDate && date > w.expirationDate) s.warnings.push(`${holderName(w.stakeholderId)}’s warrant was exercised on ${date}, after it expired on ${w.expirationDate}.`)
    const q = Math.min(quantity, warrantOutstanding(w))
    if (q < quantity) s.warnings.push(`${holderName(w.stakeholderId)} exercised more warrant shares than were left.`)
    w.exercised += q
    const shares = netFairValue ? netExerciseShares(q, w.exercisePrice?.minor ?? 0, netFairValue.minor) : q
    if (netFairValue && shares === 0) s.warnings.push(`${holderName(w.stakeholderId)}’s cashless exercise on ${date} was out of the money; no shares were issued.`)
    if (shares > 0) stock.set(resultId, { securityId: resultId, stakeholderId: w.stakeholderId, stockClassId: w.stockClassId, quantity: shares, date, ...(w.exercisePrice && !netFairValue ? { pricePerShare: w.exercisePrice } : {}), sourceId })
  }

  for (const o of ordered(objects)) {
    if (!FACT_TYPES.has(o.type) && objectDate(o) > asOf) continue
    switch (o.type) {
      case 'STAKEHOLDER':
        s.stakeholders.push(o)
        break
      case 'STOCK_CLASS':
        s.classes.push(o)
        break
      case 'STOCK_PLAN':
        plans.set(o.id, { ...o, returned: 0 })
        break
      case 'VALUATION':
        if (o.date <= asOf) s.valuations.push(o)
        break
      case 'TX_STOCK_ISSUANCE':
        if (stock.has(o.securityId)) s.warnings.push(`Security ${o.securityId} was issued twice; kept the first.`)
        else
          stock.set(o.securityId, {
            securityId: o.securityId,
            stakeholderId: o.stakeholderId,
            stockClassId: o.stockClassId,
            quantity: o.quantity,
            date: o.date,
            ...(o.pricePerShare ? { pricePerShare: o.pricePerShare } : {}),
            ...(o.vesting ? { vesting: o.vesting } : {}),
            sourceId: o.id,
          })
        break
      case 'TX_STOCK_TRANSFER': {
        const from = stock.get(o.securityId)
        if (!from) {
          s.warnings.push(`A transfer on ${o.date} refers to shares that aren’t on the cap table.`)
          break
        }
        const q = Math.min(o.quantity, from.quantity)
        if (q < o.quantity) s.warnings.push(`${holderName(from.stakeholderId)} transferred ${o.quantity.toLocaleString('en-US')} shares but held ${from.quantity.toLocaleString('en-US')}.`)
        from.quantity -= q
        const id = `${o.id}:to`
        stock.set(id, { ...from, securityId: id, stakeholderId: o.toStakeholderId, quantity: q, date: o.date, sourceId: o.id })
        break
      }
      case 'TX_STOCK_CANCELLATION': {
        const p = stock.get(o.securityId)
        if (!p) {
          s.warnings.push(`A cancellation on ${o.date} refers to shares that aren’t on the cap table.`)
          break
        }
        p.quantity -= Math.min(o.quantity, p.quantity)
        break
      }
      case 'TX_CONVERTIBLE_ISSUANCE':
        conv.set(o.securityId, {
          securityId: o.securityId,
          stakeholderId: o.stakeholderId,
          kind: o.kind,
          amount: o.amount,
          ...(o.valuationCap ? { valuationCap: o.valuationCap } : {}),
          ...(o.discountPct != null ? { discountPct: o.discountPct } : {}),
          ...(o.interestPct != null ? { interestPct: o.interestPct } : {}),
          ...(o.maturityDate ? { maturityDate: o.maturityDate } : {}),
          timing: o.timing,
          date: o.date,
          sourceId: o.id,
        })
        break
      case 'TX_CONVERTIBLE_CONVERSION':
      case 'TX_CONVERTIBLE_CANCELLATION':
        if (!conv.delete(o.securityId)) s.warnings.push(`A SAFE or note change on ${o.date} refers to one that isn’t outstanding.`)
        break
      case 'TX_EQUITY_COMPENSATION_ISSUANCE':
        // Older records kept warrants as a compensation type: they're warrants all the same.
        if (o.compensationType === 'WARRANT') {
          warrants.set(o.securityId, { securityId: o.securityId, stakeholderId: o.stakeholderId, stockClassId: o.stockClassId, granted: o.quantity, exercised: 0, cancelled: 0, ...(o.exercisePrice ? { exercisePrice: o.exercisePrice } : {}), ...(o.expirationDate ? { expirationDate: o.expirationDate } : {}), date: o.date, sourceId: o.id })
          break
        }
        grants.set(o.securityId, {
          securityId: o.securityId,
          stakeholderId: o.stakeholderId,
          ...(o.stockPlanId ? { stockPlanId: o.stockPlanId } : {}),
          stockClassId: o.stockClassId,
          compensationType: o.compensationType,
          granted: o.quantity,
          exercised: 0,
          released: 0,
          cancelled: 0,
          ...(o.exercisePrice ? { exercisePrice: o.exercisePrice } : {}),
          ...(o.vesting ? { vesting: o.vesting } : {}),
          ...(o.expirationDate ? { expirationDate: o.expirationDate } : {}),
          date: o.date,
          sourceId: o.id,
        })
        break
      case 'TX_EQUITY_COMPENSATION_EXERCISE': {
        const w = warrants.get(o.securityId)
        if (w) {
          exerciseWarrant(w, o.quantity, undefined, o.resultingSecurityId, o.date, o.id)
          break
        }
        const g = grants.get(o.securityId)
        if (g?.compensationType === 'RSU') {
          s.warnings.push(`RSUs aren’t exercised; they’re released when they vest (${o.date}).`)
          break
        }
        if (!g) {
          s.warnings.push(`An exercise on ${o.date} refers to a grant that isn’t on the cap table.`)
          break
        }
        const q = Math.min(o.quantity, outstanding(g))
        if (q < o.quantity) s.warnings.push(`${holderName(g.stakeholderId)} exercised more options than were left.`)
        g.exercised += q
        stock.set(o.resultingSecurityId, {
          securityId: o.resultingSecurityId,
          stakeholderId: g.stakeholderId,
          stockClassId: g.stockClassId,
          quantity: q,
          date: o.date,
          ...(g.exercisePrice ? { pricePerShare: g.exercisePrice } : {}),
          sourceId: o.id,
        })
        break
      }
      case 'TX_EQUITY_COMPENSATION_RELEASE': {
        const g = grants.get(o.securityId)
        if (!g || g.compensationType !== 'RSU') {
          s.warnings.push(`A release on ${o.date} refers to RSUs that aren’t on the cap table.`)
          break
        }
        // Only vested units can settle.
        const vestedLeft = Math.max(0, Math.min(outstanding(g), vestedShares(g.granted, g.vesting, o.date) - g.released))
        const q = Math.min(o.quantity, vestedLeft)
        if (q < o.quantity) s.warnings.push(`${holderName(g.stakeholderId)}: ${o.quantity.toLocaleString('en-US')} RSUs released on ${o.date}, but only ${vestedLeft.toLocaleString('en-US')} had vested.`)
        g.released += q
        const issued = q - Math.min(q, Math.max(0, o.withheld ?? 0))
        if (issued > 0) stock.set(o.resultingSecurityId, { securityId: o.resultingSecurityId, stakeholderId: g.stakeholderId, stockClassId: g.stockClassId, quantity: issued, date: o.date, sourceId: o.id })
        break
      }
      case 'TX_WARRANT_ISSUANCE':
        if (warrants.has(o.securityId)) s.warnings.push(`Warrant ${o.securityId} was issued twice; kept the first.`)
        else warrants.set(o.securityId, { securityId: o.securityId, stakeholderId: o.stakeholderId, stockClassId: o.stockClassId, granted: o.quantity, exercised: 0, cancelled: 0, ...(o.exercisePrice ? { exercisePrice: o.exercisePrice } : {}), ...(o.purchasePrice ? { purchasePrice: o.purchasePrice } : {}), ...(o.expirationDate ? { expirationDate: o.expirationDate } : {}), date: o.date, sourceId: o.id })
        break
      case 'TX_WARRANT_EXERCISE': {
        const w = warrants.get(o.securityId)
        if (!w) {
          s.warnings.push(`A warrant exercise on ${o.date} refers to a warrant that isn’t on the cap table.`)
          break
        }
        exerciseWarrant(w, o.quantity, o.netFairValue, o.resultingSecurityId, o.date, o.id)
        break
      }
      case 'TX_WARRANT_CANCELLATION': {
        const w = warrants.get(o.securityId)
        if (!w) {
          s.warnings.push(`A warrant cancellation on ${o.date} refers to a warrant that isn’t on the cap table.`)
          break
        }
        w.cancelled += Math.min(o.quantity, warrantOutstanding(w))
        break
      }
      case 'TX_EQUITY_COMPENSATION_CANCELLATION': {
        const w = warrants.get(o.securityId)
        if (w) {
          w.cancelled += Math.min(o.quantity, warrantOutstanding(w))
          break
        }
        const g = grants.get(o.securityId)
        if (!g) {
          s.warnings.push(`A grant cancellation on ${o.date} refers to a grant that isn’t on the cap table.`)
          break
        }
        const q = Math.min(o.quantity, outstanding(g))
        g.cancelled += q
        const plan = g.stockPlanId ? plans.get(g.stockPlanId) : undefined
        if (plan) plan.returned += q
        break
      }
      case 'TX_STOCK_PLAN_POOL_ADJUSTMENT': {
        const p = plans.get(o.stockPlanId)
        if (p) p.size = o.size
        else s.warnings.push(`A pool change on ${o.date} refers to a plan that doesn’t exist.`)
        break
      }
      case 'TX_STOCK_CLASS_AUTHORIZED_SHARES_ADJUSTMENT': {
        const c = s.classes.find((x) => x.id === o.stockClassId)
        if (c) c.authorized = o.authorized
        break
      }
    }
  }
  s.stock = [...stock.values()].filter((p) => p.quantity > 0)
  s.convertibles = [...conv.values()]
  s.grants = [...grants.values()]
  s.warrants = [...warrants.values()]
  s.plans = [...plans.values()]
  s.valuations.sort((a, b) => a.date.localeCompare(b.date))
  for (const c of s.classes) {
    const issued = s.stock.filter((p) => p.stockClassId === c.id).reduce((a, p) => a + p.quantity, 0)
    if (c.authorized != null && issued > c.authorized) s.warnings.push(`${c.name}: ${issued.toLocaleString('en-US')} shares issued but only ${c.authorized.toLocaleString('en-US')} authorized.`)
  }
  for (const p of s.plans) {
    const used = poolUsed(s, p.id)
    if (used > p.size) s.warnings.push(`${p.name}: ${used.toLocaleString('en-US')} granted but the pool is ${p.size.toLocaleString('en-US')}.`)
  }
  return s
}

// ---------- Derived numbers ----------

export const outstanding = (g: GrantPosition) => g.granted - g.exercised - g.released - g.cancelled

export const warrantOutstanding = (w: WarrantPosition) => w.granted - w.exercised - w.cancelled

/** A warrant still counts until the day after it expires. */
export const warrantLive = (w: WarrantPosition, asOf: IsoDate) => warrantOutstanding(w) > 0 && !(w.expirationDate && asOf > w.expirationDate)

/** Vested and not yet exercised or released. */
export function vestedOutstanding(g: GrantPosition, asOf: IsoDate): number {
  return Math.max(0, Math.min(outstanding(g), vestedShares(g.granted, g.vesting, asOf) - g.exercised - g.released))
}

/** Cashless exercise: the exercise price is paid in shares worth `fairValue` each, so q × (fair value − price) / fair
 *  value shares come out (rounded down). Nothing when the price is at or above fair value. */
export function netExerciseShares(quantity: number, priceMinor: number, fairValueMinor: number): number {
  if (fairValueMinor <= 0 || fairValueMinor <= priceMinor) return 0
  return Math.floor((quantity * (fairValueMinor - priceMinor)) / fairValueMinor)
}

/** Common-equivalent shares a live warrant would become (its class's conversion ratio applies). */
export function warrantAsConverted(s: CapState, w: WarrantPosition): number {
  return warrantLive(w, s.asOf) ? asConverted(s, { stockClassId: w.stockClassId, quantity: warrantOutstanding(w) }) : 0
}

/** Shares a plan has used: outstanding grants plus exercised ones (cancelled shares return to the pool). */
export function poolUsed(s: CapState, planId: string): number {
  return s.grants.filter((g) => g.stockPlanId === planId).reduce((a, g) => a + g.granted - g.cancelled, 0)
}

export function poolAvailable(s: CapState): number {
  return s.plans.reduce((a, p) => a + Math.max(0, p.size - poolUsed(s, p.id)), 0)
}

const classOf = (s: CapState, id: string) => s.classes.find((c) => c.id === id)

/** Common-equivalent shares of a stock position (preferred × conversion ratio). */
export function asConverted(s: CapState, p: Pick<StockPosition, 'stockClassId' | 'quantity'>): number {
  const c = classOf(s, p.stockClassId)
  return c && c.classType === 'PREFERRED' ? Math.floor(p.quantity * (c.conversionRatio || 1)) : p.quantity
}

export interface FullyDiluted {
  /** Outstanding stock, as converted to common. */
  issued: number
  /** Outstanding options, RSUs and warrants (the three below together). */
  options: number
  /** Of those: stock options. */
  stockOptions: number
  /** Of those: RSUs not yet released (vested or not). */
  rsus: number
  /** Of those: live warrants, as converted to common. */
  warrants: number
  /** Unissued shares left in option pools. */
  poolAvailable: number
  total: number
}

/** Standard fully diluted count: stock (as converted) + outstanding options/RSUs/warrants + unissued pool. SAFEs and
 *  notes are not shares until they convert; model them with conversion.ts. */
export function fullyDiluted(s: CapState): FullyDiluted {
  const issued = s.stock.reduce((a, p) => a + asConverted(s, p), 0)
  const stockOptions = s.grants.filter((g) => g.compensationType !== 'RSU').reduce((a, g) => a + outstanding(g), 0)
  const rsus = s.grants.filter((g) => g.compensationType === 'RSU').reduce((a, g) => a + outstanding(g), 0)
  const warrants = s.warrants.reduce((a, w) => a + warrantAsConverted(s, w), 0)
  const options = stockOptions + rsus + warrants
  const pool = poolAvailable(s)
  return { issued, options, stockOptions, rsus, warrants, poolAvailable: pool, total: issued + options + pool }
}

export interface HolderRow {
  stakeholderId: string | null
  name: string
  relationship?: StakeholderObj['relationship']
  /** Shares by class name (as issued, not converted). */
  byClass: Array<{ className: string; shares: number }>
  /** Options, RSUs and warrants together (as today); the split is below. */
  options: number
  vestedOptions: number
  rsus: number
  vestedRsus: number
  warrants: number
  fullyDilutedShares: number
  /** 0–100. */
  fullyDilutedPct: number
}

/** One row per stakeholder (plus "Available option pool"), largest first. */
export function holders(s: CapState): HolderRow[] {
  const fd = fullyDiluted(s)
  const rows = new Map<string, HolderRow>()
  const row = (id: string): HolderRow => {
    let r = rows.get(id)
    if (!r) {
      const sh = s.stakeholders.find((x) => x.id === id)
      r = { stakeholderId: id, name: sh?.name ?? 'Unknown holder', ...(sh?.relationship ? { relationship: sh.relationship } : {}), byClass: [], options: 0, vestedOptions: 0, rsus: 0, vestedRsus: 0, warrants: 0, fullyDilutedShares: 0, fullyDilutedPct: 0 }
      rows.set(id, r)
    }
    return r
  }
  for (const p of s.stock) {
    const r = row(p.stakeholderId)
    const name = classOf(s, p.stockClassId)?.name ?? 'Unknown class'
    const b = r.byClass.find((x) => x.className === name)
    if (b) b.shares += p.quantity
    else r.byClass.push({ className: name, shares: p.quantity })
    r.fullyDilutedShares += asConverted(s, p)
  }
  for (const g of s.grants) {
    const left = outstanding(g)
    if (left <= 0) continue
    const r = row(g.stakeholderId)
    const vested = vestedOutstanding(g, s.asOf)
    r.options += left
    if (g.compensationType === 'RSU') {
      r.rsus += left
      r.vestedRsus += vested
    } else r.vestedOptions += vested
    r.fullyDilutedShares += left
  }
  for (const w of s.warrants) {
    const n = warrantAsConverted(s, w)
    if (n <= 0) continue
    const r = row(w.stakeholderId)
    r.options += n
    r.warrants += n
    r.fullyDilutedShares += n
  }
  const out = [...rows.values()]
  if (fd.poolAvailable > 0) out.push({ stakeholderId: null, name: 'Available option pool', byClass: [], options: 0, vestedOptions: 0, rsus: 0, vestedRsus: 0, warrants: 0, fullyDilutedShares: fd.poolAvailable, fullyDilutedPct: 0 })
  for (const r of out) r.fullyDilutedPct = fd.total ? (r.fullyDilutedShares / fd.total) * 100 : 0
  return out.sort((a, b) => b.fullyDilutedShares - a.fullyDilutedShares || a.name.localeCompare(b.name))
}

/** The latest 409A on or before asOf. */
export function last409a(s: CapState): ValuationObj | null {
  const v = s.valuations.filter((x) => x.kind === '409A')
  return v[v.length - 1] ?? null
}

/** Simple interest on a note from its date to `asOf`, actual/365. Minor units, rounded down. */
export function accruedInterest(c: Pick<ConvertiblePosition, 'amount' | 'interestPct' | 'date'>, asOf: IsoDate): number {
  if (!c.interestPct) return 0
  const days = Math.max(0, (Date.parse(asOf + 'T00:00:00Z') - Date.parse(c.date + 'T00:00:00Z')) / 86_400_000)
  return Math.floor((c.amount.minor * c.interestPct * days) / (100 * 365))
}
