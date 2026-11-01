// Investment positions (fund-style portfolios: angels, funds, a company's own stakes), as c6's contract has them
// (packages/contracts: InvestmentEvent, InvestmentView). The demo works them out here from its own events; the server
// does the same arithmetic in core (FinanceReader.investments, investmentTotals).
import type { Money } from '@agfn/contracts'

export type SecurityType = 'safe' | 'convertible_note' | 'preferred_stock' | 'common_stock' | 'warrant' | 'other'

/** What a person records (the contract's InvestmentEvent, minus bookkeeping). convert: a SAFE or note becomes shares in
 *  a priced round; the cost carries over, and securityType / series / shares take the new terms. */
export interface InvestmentInput {
  kind: 'invest' | 'mark' | 'distribution' | 'write_off' | 'exit' | 'convert'
  /** Omitted on a new position's first invest; the server names it. */
  positionId?: string
  issuer: string
  securityType: SecurityType
  date: string
  amount?: Money
  shares?: number
  series?: string
  valuationCap?: Money
  /** Percent as term sheets write it (20 = 20%). */
  discountPct?: number
  markSource?: string
}

/** One position as of a day (the contract's InvestmentView). */
export interface InvestmentView {
  positionId: string
  entityId: string
  issuer: string
  securityType: SecurityType
  series?: string
  firstInvested: string
  invested: Money
  shares?: number
  valuationCap?: Money
  discountPct?: number
  /** Latest mark on or before the day, else cost; 0 once written off or exited. */
  value: Money
  valueSource: 'cost' | 'mark' | 'written_off' | 'exited'
  markedAt?: string
  /** Distributions and exit proceeds. */
  distributed: Money
  /** (value + distributed) ÷ invested; null when nothing was invested. */
  moic: number | null
  status: 'active' | 'written_off' | 'exited'
  recordIds: string[]
  /** Where the position came from when a connection brought it in (e.g. Wefunder's portfolio page); none when added by hand. */
  source?: { name: string; url: string }
}

export const SECURITY: Record<SecurityType, string> = {
  safe: 'SAFE',
  convertible_note: 'Note',
  preferred_stock: 'Priced',
  common_stock: 'Common',
  warrant: 'Warrant',
  other: 'Other',
}

const money = (minor: number, currency: string): Money => ({ minor, currency })

/** Positions from their events, as of `asOf` (YYYY-MM-DD). Events in date order; a position's currency is its first invest's. */
export function positionsFrom(entityId: string, events: Array<InvestmentInput & { positionId: string; recordId: string }>, asOf: string): InvestmentView[] {
  const by = new Map<string, InvestmentView>()
  for (const e of [...events].filter((x) => x.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    let p = by.get(e.positionId)
    if (!p) {
      if (e.kind !== 'invest') continue
      const cur = e.amount?.currency ?? 'USD'
      p = { positionId: e.positionId, entityId, issuer: e.issuer, securityType: e.securityType, firstInvested: e.date, invested: money(0, cur), value: money(0, cur), valueSource: 'cost', distributed: money(0, cur), moic: null, status: 'active', recordIds: [] }
      by.set(e.positionId, p)
    }
    const cur = p.invested.currency
    const amt = e.amount?.minor ?? 0
    p.recordIds.push(e.recordId)
    if (e.kind === 'invest') {
      p.invested = money(p.invested.minor + amt, cur)
      if (e.shares !== undefined) p.shares = (p.shares ?? 0) + e.shares
      if (e.series) p.series = e.series
      if (e.valuationCap) p.valuationCap = e.valuationCap
      if (e.discountPct !== undefined) p.discountPct = e.discountPct
      if (p.valueSource === 'cost') p.value = p.invested
    } else if (e.kind === 'mark' && p.status === 'active') {
      p.value = money(amt, cur)
      p.valueSource = 'mark'
      p.markedAt = e.date
    } else if (e.kind === 'distribution') {
      p.distributed = money(p.distributed.minor + amt, cur)
    } else if (e.kind === 'write_off') {
      p.value = money(0, cur)
      p.valueSource = 'written_off'
      p.status = 'written_off'
    } else if (e.kind === 'convert' && p.status === 'active') {
      p.securityType = e.securityType
      if (e.series) p.series = e.series
      if (e.shares !== undefined) p.shares = e.shares
      delete p.valuationCap
      delete p.discountPct
    } else if (e.kind === 'exit') {
      p.distributed = money(p.distributed.minor + amt, cur)
      p.value = money(0, cur)
      p.valueSource = 'exited'
      p.status = 'exited'
    }
  }
  // Rounded to 2 places, as core's reader rounds it.
  for (const p of by.values()) p.moic = p.invested.minor > 0 ? Math.round(((p.value.minor + p.distributed.minor) / p.invested.minor) * 100) / 100 : null
  return [...by.values()]
}

/** One company's totals in one currency, as the server sends them (core's investmentTotals; never summed here). */
export interface InvestmentTotals {
  entityId: string
  currency: string
  positions: number
  active: number
  invested: Money
  value: Money
  distributed: Money
  writtenOff: Money
  /** (value + distributed) ÷ invested over positions whose multiple is known, 2 places; null when none. */
  moic: number | null
  /** Positions left out of the multiple (exited in kind). */
  moicExcludes: number
}

/** "2.37×", "1.00×": the server's 2-place figure, always shown to 2 places; "—" when there's no cost to measure against. */
export const moicText = (m: number | null) => (m === null ? '—' : `${m.toFixed(2)}×`)
