// Views of the cap table: the contracts CapTableView (for the ledger's FinanceReader and MCP), and the richer
// EquityDetail the web app's Equity drawer shows.

import type { CapTableView, EntityId, Money } from '@agfn/contracts'
import { accruedInterest, fullyDiluted, holders, last409a, outstanding, poolAvailable, poolUsed, vestedOutstanding, warrantLive, warrantOutstanding, type CapState, type FullyDiluted, type HolderRow } from './captable.ts'
import { vestedShares, vestingText } from './vesting.ts'
import { currenciesIn, sumIn, type Rates } from './fx.ts'

export function capTableView(entityId: EntityId, s: CapState, home?: { currency: string; rates: Rates }): CapTableView {
  const fd = fullyDiluted(s)
  const rows: CapTableView['holders'] = []
  for (const h of holders(s)) {
    if (h.stakeholderId === null) continue
    for (const b of h.byClass) rows.push({ name: h.name, class: b.className, shares: b.shares, fullyDilutedPct: round2(fd.total ? (sharesFd(s, h, b.className) / fd.total) * 100 : 0) })
    const pct = (n: number) => round2(fd.total ? (n / fd.total) * 100 : 0)
    const stockOptions = h.options - h.rsus - h.warrants
    if (stockOptions) rows.push({ name: h.name, class: 'Options', shares: stockOptions, fullyDilutedPct: pct(stockOptions) })
    if (h.rsus) rows.push({ name: h.name, class: 'RSUs', shares: h.rsus, fullyDilutedPct: pct(h.rsus) })
    if (h.warrants) rows.push({ name: h.name, class: 'Warrants', shares: h.warrants, fullyDilutedPct: pct(h.warrants) })
  }
  const v = last409a(s)
  const pool = s.plans.length ? { size: s.plans.reduce((a, p) => a + p.size, 0), granted: s.plans.reduce((a, p) => a + poolUsed(s, p.id), 0), available: poolAvailable(s) } : null
  return {
    entityId,
    asOf: s.asOf === '9999-12-31' ? new Date().toISOString().slice(0, 10) : s.asOf,
    fullyDilutedShares: fd.total,
    holders: rows,
    classes: s.classes.map((c) => ({ name: c.name, authorized: c.authorized, issued: s.stock.filter((p) => p.stockClassId === c.id).reduce((a, p) => a + p.quantity, 0) })),
    safesAndNotes: s.convertibles.map((c) => ({
      holder: name(s, c.stakeholderId),
      kind: c.kind === 'SAFE' ? 'safe' : 'convertible_note',
      amount: c.amount,
      ...(c.valuationCap ? { cap: c.valuationCap } : {}),
      ...(c.discountPct ? { discountPct: c.discountPct } : {}),
      ...(home ? { amountHome: sumIn([c.amount], home.currency, home.rates) } : {}),
    })),
    optionPool: pool,
    last409a: v ? { date: v.date, pricePerShare: v.pricePerShare } : null,
    ...(home ? { homeCurrency: home.currency } : {}),
    ...rsuAndWarrants(s),
  }
}

/** The RSU totals and warrant list for CapTableView; left out when there are none. */
function rsuAndWarrants(s: CapState): Pick<CapTableView, 'rsus' | 'warrants'> {
  const asOf = s.asOf === '9999-12-31' ? new Date().toISOString().slice(0, 10) : s.asOf
  const rsus = s.grants.filter((g) => g.compensationType === 'RSU')
  return {
    ...(rsus.length
      ? {
          rsus: {
            granted: rsus.reduce((a, g) => a + g.granted, 0),
            vested: rsus.reduce((a, g) => a + Math.min(g.granted - g.cancelled, vestedShares(g.granted, g.vesting, asOf)), 0),
            released: rsus.reduce((a, g) => a + g.released, 0),
            outstanding: rsus.reduce((a, g) => a + outstanding(g), 0),
          },
        }
      : {}),
    ...(s.warrants.length
      ? { warrants: s.warrants.map((w) => ({ holder: name(s, w.stakeholderId), class: s.classes.find((c) => c.id === w.stockClassId)?.name ?? 'Unknown class', shares: warrantOutstanding(w), exercisePrice: w.exercisePrice ?? null, expires: w.expirationDate ?? null, expired: !warrantLive(w, asOf) && warrantOutstanding(w) > 0 })) }
      : {}),
  }
}

function sharesFd(s: CapState, h: HolderRow, className: string): number {
  const c = s.classes.find((x) => x.name === className)
  const shares = h.byClass.find((b) => b.className === className)?.shares ?? 0
  return c?.classType === 'PREFERRED' ? Math.floor(shares * (c.conversionRatio || 1)) : shares
}
const round2 = (x: number) => Math.round(x * 100) / 100
const name = (s: CapState, id: string) => s.stakeholders.find((x) => x.id === id)?.name ?? 'Unknown holder'

/** Everything the Equity drawer shows. JSON-safe; `state` lets the browser model rounds and exits locally. */
export interface EquityDetail {
  entityId: EntityId
  asOf: string
  fullyDiluted: FullyDiluted
  holders: Array<{ id: string | null; name: string; role: string; shares: number; options: number; vestedOptions: number; rsus: number; vestedRsus: number; warrants: number; fullyDilutedShares: number; pct: number; line: string }>
  classes: Array<{ id: string; name: string; type: 'COMMON' | 'PREFERRED'; authorized: number | null; issued: number; line: string }>
  convertibles: Array<{ id: string; holder: string; kind: 'SAFE' | 'NOTE'; amount: Money; accrued: Money; date: string; line: string }>
  pool: { size: number; used: number; available: number } | null
  grants: Array<{ id: string; holder: string; type: string; quantity: number; outstanding: number; vested: number; exercisePrice: Money | null; date: string; line: string }>
  warrants: Array<{ id: string; holder: string; className: string; quantity: number; outstanding: number; exercisePrice: Money | null; expirationDate: string | null; live: boolean; date: string; line: string }>
  valuations: Array<{ id: string; date: string; pricePerShare: Money; provider: string | null }>
  warnings: string[]
  /** The company's own currency, rates into it (as of today), and totals in it. Null amounts: a rate is missing. */
  home: { currency: string; rates: Rates; missing: string[]; safesAndNotes: Money | null; preferences: Money | null } | null
  state: CapState
}

const ROLE: Record<string, string> = { FOUNDER: 'Founder', EMPLOYEE: 'Employee', INVESTOR: 'Investor', ADVISOR: 'Advisor', BOARD_MEMBER: 'Board', CONSULTANT: 'Consultant', OTHER: '' }
const COMP: Record<string, string> = { OPTION_ISO: 'ISO options', OPTION_NSO: 'NSO options', RSU: 'RSUs', WARRANT: 'Warrants' }

export function equityDetail(entityId: EntityId, s: CapState, fmtMoney: (m: Money) => string = defaultFmt, homeIn?: { currency: string; rates: Rates }): EquityDetail {
  const fd = fullyDiluted(s)
  const today = s.asOf === '9999-12-31' ? new Date().toISOString().slice(0, 10) : s.asOf
  const home = homeIn ? homeTotals(s, homeIn.currency, homeIn.rates, today) : null
  return {
    entityId,
    asOf: today,
    fullyDiluted: fd,
    holders: holders(s).map((h) => ({
      id: h.stakeholderId,
      name: h.name,
      role: h.stakeholderId === null ? 'Unissued' : (ROLE[h.relationship ?? 'OTHER'] ?? ''),
      shares: h.byClass.reduce((a, b) => a + b.shares, 0),
      options: h.options,
      vestedOptions: h.vestedOptions,
      rsus: h.rsus,
      vestedRsus: h.vestedRsus,
      warrants: h.warrants,
      fullyDilutedShares: h.fullyDilutedShares,
      // Rounded as capTableView rounds (2 places), so this page and get_cap_table say the same percent.
      pct: round2(h.fullyDilutedPct),
      line: [
        ...h.byClass.map((b) => `${b.shares.toLocaleString('en-US')} ${b.className}`),
        h.options - h.rsus - h.warrants ? `${(h.options - h.rsus - h.warrants).toLocaleString('en-US')} options (${h.vestedOptions.toLocaleString('en-US')} vested)` : '',
        h.rsus ? `${h.rsus.toLocaleString('en-US')} RSUs (${h.vestedRsus.toLocaleString('en-US')} ready to release)` : '',
        h.warrants ? `warrants for ${h.warrants.toLocaleString('en-US')}` : '',
        h.stakeholderId === null ? `${h.fullyDilutedShares.toLocaleString('en-US')} not yet granted` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
    classes: s.classes.map((c) => {
      const issued = s.stock.filter((p) => p.stockClassId === c.id).reduce((a, p) => a + p.quantity, 0)
      const bits = [
        c.authorized != null ? `${issued.toLocaleString('en-US')} of ${c.authorized.toLocaleString('en-US')} issued` : `${issued.toLocaleString('en-US')} issued`,
        c.classType === 'PREFERRED' && c.pricePerShare ? `${fmtPrice(c.pricePerShare)} a share` : '',
        c.classType === 'PREFERRED' ? `${c.liquidationPrefMultiple}x ${c.participating ? 'participating' + (c.participationCapMultiple ? ` to ${c.participationCapMultiple}x` : '') : 'non-participating'}` : '',
      ]
      return { id: c.id, name: c.name, type: c.classType, authorized: c.authorized, issued, line: bits.filter(Boolean).join(' · ') }
    }),
    convertibles: s.convertibles.map((c) => {
      const accrued = { minor: accruedInterest(c, today), currency: c.amount.currency }
      const terms = [
        c.valuationCap ? `${fmtMoney(c.valuationCap)} ${c.timing === 'POST_MONEY' ? 'post-money' : 'pre-money'} cap` : 'no cap',
        c.discountPct ? `${c.discountPct}% discount` : '',
        c.interestPct ? `${c.interestPct}% interest` : '',
        c.maturityDate ? `matures ${c.maturityDate}` : '',
      ]
      return { id: c.securityId, holder: name(s, c.stakeholderId), kind: c.kind, amount: c.amount, accrued, date: c.date, line: terms.filter(Boolean).join(' · ') }
    }),
    pool: s.plans.length ? { size: s.plans.reduce((a, p) => a + p.size, 0), used: s.plans.reduce((a, p) => a + poolUsed(s, p.id), 0), available: poolAvailable(s) } : null,
    grants: s.grants.map((g) => {
      const left = outstanding(g)
      const vested = Math.max(0, Math.min(g.granted, vestedShares(g.granted, g.vesting, today)))
      const rsu = g.compensationType === 'RSU'
      return {
        id: g.securityId,
        holder: name(s, g.stakeholderId),
        type: COMP[g.compensationType] ?? g.compensationType,
        quantity: g.granted,
        outstanding: left,
        vested,
        exercisePrice: g.exercisePrice ?? null,
        date: g.date,
        line: [
          `${vested.toLocaleString('en-US')} of ${g.granted.toLocaleString('en-US')} vested`,
          vestingText(g.vesting),
          g.exercisePrice ? `${fmtPrice(g.exercisePrice)} strike` : '',
          g.exercised ? `${g.exercised.toLocaleString('en-US')} exercised` : '',
          rsu && g.released ? `${g.released.toLocaleString('en-US')} released` : '',
          rsu && vestedOutstanding(g, today) ? `${vestedOutstanding(g, today).toLocaleString('en-US')} ready to release` : '',
          g.cancelled ? `${g.cancelled.toLocaleString('en-US')} cancelled` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }
    }),
    warrants: s.warrants.map((w) => {
      const left = warrantOutstanding(w)
      const live = warrantLive(w, today)
      const className = s.classes.find((c) => c.id === w.stockClassId)?.name ?? 'Unknown class'
      return {
        id: w.securityId,
        holder: name(s, w.stakeholderId),
        className,
        quantity: w.granted,
        outstanding: left,
        exercisePrice: w.exercisePrice ?? null,
        expirationDate: w.expirationDate ?? null,
        live,
        date: w.date,
        line: [
          `${left.toLocaleString('en-US')} ${className}`,
          w.exercisePrice ? `${fmtPrice(w.exercisePrice)} a share` : 'no exercise price',
          w.expirationDate ? (live || !left ? `expires ${dayWords(w.expirationDate)}` : `expired ${dayWords(w.expirationDate)}`) : '',
          w.exercised ? `${w.exercised.toLocaleString('en-US')} exercised` : '',
          w.cancelled ? `${w.cancelled.toLocaleString('en-US')} cancelled` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      }
    }),
    valuations: s.valuations.map((v) => ({ id: v.id, date: v.date, pricePerShare: v.pricePerShare, provider: v.provider ?? null })),
    warnings: s.warnings,
    home,
    state: s,
  }
}

/** Totals in the company's currency: SAFEs and notes (with interest) and the liquidation preference stack. */
export function homeTotals(s: CapState, currency: string, rates: Rates, asOf: string): NonNullable<EquityDetail['home']> {
  const used = currenciesIn(s)
  const missing = used.filter((c) => c !== currency && !(rates[c]! > 0))
  const convertibles = s.convertibles.map((c) => ({ minor: c.amount.minor + accruedInterest(c, asOf), currency: c.amount.currency }))
  const prefs: Money[] = []
  for (const c of s.classes) {
    if (c.classType !== 'PREFERRED' || !c.pricePerShare) continue
    const shares = s.stock.filter((p) => p.stockClassId === c.id).reduce((a, p) => a + p.quantity, 0)
    if (shares) prefs.push({ minor: Math.round(shares * c.pricePerShare.minor * (c.liquidationPrefMultiple ?? 1)), currency: c.pricePerShare.currency })
  }
  return { currency, rates, missing, safesAndNotes: convertibles.length ? sumIn(convertibles, currency, rates) : null, preferences: prefs.length ? sumIn(prefs, currency, rates) : null }
}

/** "$1.2345" for share prices (the currency's decimals, up to two more: ¥125, KWD 1.25). */
export function fmtPrice(m: Money | number, currency = 'USD'): string {
  const minor = typeof m === 'number' ? m : m.minor
  const cur = typeof m === 'number' ? currency : m.currency
  const exp = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits ?? 2
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, minimumFractionDigits: Math.min(exp, 2), maximumFractionDigits: exp + 2 }).format(minor / 10 ** exp)
}

function defaultFmt(m: Money): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, notation: m.minor >= 100_000_000 ? 'compact' : 'standard', maximumFractionDigits: m.minor % 100 ? 2 : 0 }).format(m.minor / 100)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Dec 8, 2032" from "2032-12-08", read as a calendar day (no time zone can move it). */
export function dayWords(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso
}
