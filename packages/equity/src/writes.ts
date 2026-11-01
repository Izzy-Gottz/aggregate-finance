// record_equity_event → cap-table objects, duplicate detection, and the money events for the ledger. Pure (no
// database), so the browser demo and tests use the exact same rules as the server.

import type { EquityEvent, Id, Money } from '@agfn/contracts'
import { WriteRejected } from '@agfn/contracts'
import { last409a, netExerciseShares, outstanding, vestedOutstanding, warrantLive, warrantOutstanding, type CapState } from './captable.ts'
import { dayWords } from './view.ts'
import { looksInstitutional, type EquityObject, type IsoDate, type StakeholderObj, type StockClassObj, type Vesting } from './model.ts'
import { toOcfObject } from './ocf.ts'

// ---------------------------------------------------------------------------------------------
// Money events for the ledger
// ---------------------------------------------------------------------------------------------

/** EquityEvents (without connectionId) for the objects in `changed` that move money. `context` resolves names. */
export function cashEvents(context: readonly EquityObject[], changed: readonly EquityObject[]): Array<Omit<EquityEvent, 'connectionId'>> {
  const name = (id: string) => (context.find((o) => o.type === 'STAKEHOLDER' && o.id === id) as StakeholderObj | undefined)?.name ?? 'Unknown holder'
  const out: Array<Omit<EquityEvent, 'connectionId'>> = []
  for (const o of changed) {
    switch (o.type) {
      case 'TX_CONVERTIBLE_ISSUANCE':
        out.push({ type: 'equity.event', externalId: o.id, kind: o.kind === 'SAFE' ? 'safe' : 'convertible_note', date: o.date, stakeholder: name(o.stakeholderId), amount: o.amount, ocf: toOcfObject(o) })
        break
      case 'TX_STOCK_ISSUANCE': {
        if (o.noCash || !o.pricePerShare) break
        const minor = Math.round(o.quantity * o.pricePerShare.minor)
        if (minor > 0) out.push({ type: 'equity.event', externalId: o.id, kind: 'issuance', date: o.date, stakeholder: name(o.stakeholderId), amount: { minor, currency: o.pricePerShare.currency }, shares: o.quantity, ocf: toOcfObject(o) })
        break
      }
      case 'TX_WARRANT_ISSUANCE':
        if (o.purchasePrice && o.purchasePrice.minor > 0) out.push({ type: 'equity.event', externalId: o.id, kind: 'issuance', date: o.date, stakeholder: name(o.stakeholderId), amount: o.purchasePrice, ocf: toOcfObject(o) })
        break
      case 'TX_WARRANT_EXERCISE': {
        // A cashless exercise pays in shares: no money moves.
        if (o.netFairValue) break
        const w = context.find((x) => (x.type === 'TX_WARRANT_ISSUANCE' || x.type === 'TX_EQUITY_COMPENSATION_ISSUANCE') && x.securityId === o.securityId)
        const price = w && (w.type === 'TX_WARRANT_ISSUANCE' || w.type === 'TX_EQUITY_COMPENSATION_ISSUANCE') ? w.exercisePrice : undefined
        if (!w || !price || !('stakeholderId' in w)) break
        const minor = Math.round(o.quantity * price.minor)
        if (minor > 0) out.push({ type: 'equity.event', externalId: o.id, kind: 'exercise', date: o.date, stakeholder: name(w.stakeholderId), amount: { minor, currency: price.currency }, shares: o.quantity, ocf: toOcfObject(o) })
        break
      }
      case 'TX_EQUITY_COMPENSATION_EXERCISE': {
        const g = context.find((x) => x.type === 'TX_EQUITY_COMPENSATION_ISSUANCE' && x.securityId === o.securityId)
        if (!g || g.type !== 'TX_EQUITY_COMPENSATION_ISSUANCE' || !g.exercisePrice) break
        const minor = Math.round(o.quantity * g.exercisePrice.minor)
        if (minor > 0) out.push({ type: 'equity.event', externalId: o.id, kind: 'exercise', date: o.date, stakeholder: name(g.stakeholderId), amount: { minor, currency: g.exercisePrice.currency }, shares: o.quantity, ocf: toOcfObject(o) })
        break
      }
      case 'TX_CONVERTIBLE_CONVERSION': {
        const c = context.find((x) => x.type === 'TX_CONVERTIBLE_ISSUANCE' && x.securityId === o.securityId)
        if (!c || c.type !== 'TX_CONVERTIBLE_ISSUANCE') break
        out.push({ type: 'equity.event', externalId: o.id, kind: 'conversion', date: o.date, stakeholder: name(c.stakeholderId), amount: c.amount, ocf: { ...toOcfObject(o), from: c.kind === 'SAFE' ? 'safe' : 'convertible_note' } })
        break
      }
      default:
        break
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// record_equity_event → objects
// ---------------------------------------------------------------------------------------------

export interface EquityWritePayload {
  kind: 'issuance' | 'safe' | 'convertible_note' | 'option_grant' | 'exercise' | 'transfer' | 'cancellation'
  date: IsoDate
  stakeholder: string
  shares: number | null
  shareClass: string | null
  amount: Money | null
  pricePerShare: Money | null
  valuationCap: Money | null
  discountPct: number | null
  interestPct: number | null
  vesting: Vesting | null
  toStakeholder: string | null
  bankTransactionId: string | null
  /** option_grant, exercise and cancellation: which kind of grant. Left out = stock options (as before). */
  grantType?: 'iso' | 'nso' | 'rsu' | 'warrant' | null
  /** Warrants: when it lapses. */
  expirationDate?: IsoDate | null
  /** Warrant exercise: pay the price in shares instead of cash. */
  netExercise?: boolean | null
  /** Cashless exercise: the fair value per share it's worked out at (default: the latest 409A). */
  fairValuePerShare?: Money | null
  /** RSU release: units kept back to cover tax. */
  withheldShares?: number | null
}

const KINDS = new Set(['issuance', 'safe', 'convertible_note', 'option_grant', 'exercise', 'transfer', 'cancellation'])

export function parsePayload(p: Record<string, unknown>): EquityWritePayload {
  const kind = String(p.kind)
  if (!KINDS.has(kind)) throw new WriteRejected(`Unknown equity event kind “${kind}”.`, 'invalid')
  const date = String(p.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new WriteRejected('The date must look like 2026-10-09.', 'invalid')
  const stakeholder = String(p.stakeholder ?? '').trim()
  if (!stakeholder) throw new WriteRejected('Say who this is for.', 'invalid')
  const m = (v: unknown): Money | null => {
    if (!v || typeof v !== 'object') return null
    const x = v as { minor?: unknown; currency?: unknown }
    return typeof x.minor === 'number' && typeof x.currency === 'string' ? { minor: x.minor, currency: x.currency } : null
  }
  const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const v = p.vesting as { start?: string; months?: number; cliff_months?: number; cliffMonths?: number } | null | undefined
  return {
    kind: kind as EquityWritePayload['kind'],
    date,
    stakeholder,
    shares: n(p.shares),
    shareClass: typeof p.shareClass === 'string' && p.shareClass.trim() ? p.shareClass.trim() : null,
    amount: m(p.amount),
    pricePerShare: m(p.pricePerShare),
    valuationCap: m(p.valuationCap),
    discountPct: n(p.discountPct),
    interestPct: n(p.interestPct),
    vesting: v && v.start && v.months ? { start: v.start, months: v.months, cliffMonths: v.cliffMonths ?? v.cliff_months ?? 0 } : null,
    toStakeholder: typeof p.toStakeholder === 'string' && p.toStakeholder.trim() ? p.toStakeholder.trim() : null,
    bankTransactionId: typeof p.bankTransactionId === 'string' ? p.bankTransactionId : null,
    grantType: typeof p.grantType === 'string' && ['iso', 'nso', 'rsu', 'warrant'].includes(p.grantType) ? (p.grantType as 'iso') : null,
    expirationDate: typeof p.expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.expirationDate) ? p.expirationDate : null,
    netExercise: p.netExercise === true,
    fairValuePerShare: m(p.fairValuePerShare),
    withheldShares: n(p.withheldShares),
  }
}

let sid: () => string = () => globalThis.crypto.randomUUID()
/** Tests can make ids predictable. */
export function setIdGenerator(f: () => string): void {
  sid = f
}

/** Turns one plain request ("Kite put $250k in on a SAFE at an $8M cap") into cap-table objects. Pure apart from ids. */
export function planWrite(s: CapState, existing: readonly EquityObject[], p: EquityWritePayload): { objects: EquityObject[]; summary: string } {
  const objects: EquityObject[] = []
  const findPerson = (name: string) => s.stakeholders.find((x) => x.name.toLowerCase() === name.toLowerCase())
  const person = (name: string, relationship?: StakeholderObj['relationship']): string => {
    const found = findPerson(name) ?? (objects.find((o) => o.type === 'STAKEHOLDER' && o.name.toLowerCase() === name.toLowerCase()) as StakeholderObj | undefined)
    if (found) return found.id
    const id = sid()
    objects.push({ type: 'STAKEHOLDER', id, name, stakeholderType: looksInstitutional(name) ? 'INSTITUTION' : 'INDIVIDUAL', ...(relationship ? { relationship } : {}) })
    return id
  }
  const stockClass = (name: string | null): StockClassObj => {
    const want = name ?? 'Common'
    const found = s.classes.find((c) => c.name.toLowerCase() === want.toLowerCase()) ?? (objects.find((o) => o.type === 'STOCK_CLASS' && o.name.toLowerCase() === want.toLowerCase()) as StockClassObj | undefined)
    if (found) return found
    const preferred = /prefer|series/i.test(want)
    const c: StockClassObj = { type: 'STOCK_CLASS', id: sid(), name: want, classType: preferred ? 'PREFERRED' : 'COMMON', authorized: null, seniority: preferred ? 1 : 0, ...(preferred && p.pricePerShare ? { pricePerShare: p.pricePerShare } : {}), liquidationPrefMultiple: preferred ? 1 : 0, participating: false, participationCapMultiple: null, conversionRatio: 1 }
    objects.push(c)
    return c
  }
  const sharesNeeded = (what: string) => {
    if (!p.shares || p.shares <= 0 || !Number.isInteger(p.shares)) throw new WriteRejected(`${what} needs a whole number of shares.`, 'invalid')
    return p.shares
  }
  const fmtN = (n: number) => n.toLocaleString('en-US')
  const fmtM = (m: Money) => new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency, maximumFractionDigits: m.minor % 100 ? 2 : 0 }).format(m.minor / 100)

  switch (p.kind) {
    case 'issuance': {
      const q = sharesNeeded('An issuance')
      const cls = stockClass(p.shareClass)
      const who = person(p.stakeholder, p.pricePerShare && cls.classType === 'PREFERRED' ? 'INVESTOR' : undefined)
      const id = sid()
      objects.push({ type: 'TX_STOCK_ISSUANCE', id, date: p.date, securityId: id, stakeholderId: who, stockClassId: cls.id, quantity: q, ...(p.pricePerShare ? { pricePerShare: p.pricePerShare } : {}), ...(p.vesting ? { vesting: p.vesting } : {}) })
      return { objects, summary: `Issued ${fmtN(q)} ${cls.name} shares to ${p.stakeholder}${p.pricePerShare ? ` at ${fmtM(p.pricePerShare)}` : ''}.` }
    }
    case 'safe':
    case 'convertible_note': {
      if (!p.amount || p.amount.minor <= 0) throw new WriteRejected(`A ${p.kind === 'safe' ? 'SAFE' : 'note'} needs an amount.`, 'invalid')
      const who = person(p.stakeholder, 'INVESTOR')
      const id = sid()
      const note = p.kind === 'convertible_note'
      objects.push({
        type: 'TX_CONVERTIBLE_ISSUANCE', id, date: p.date, securityId: id, stakeholderId: who, kind: note ? 'NOTE' : 'SAFE', amount: p.amount,
        ...(p.valuationCap ? { valuationCap: p.valuationCap } : {}),
        ...(p.discountPct ? { discountPct: p.discountPct } : {}),
        ...(note && p.interestPct ? { interestPct: p.interestPct } : {}),
        timing: note ? 'PRE_MONEY' : 'POST_MONEY',
      })
      return { objects, summary: `Recorded a ${fmtM(p.amount)} ${note ? 'convertible note' : 'SAFE'} from ${p.stakeholder}${p.valuationCap ? ` at a ${fmtM(p.valuationCap)} cap` : ''}${p.discountPct ? `, ${p.discountPct}% discount` : ''}.` }
    }
    case 'option_grant': {
      if (p.grantType === 'warrant') {
        const q = sharesNeeded('A warrant')
        const cls = stockClass(p.shareClass)
        const who = person(p.stakeholder, 'INVESTOR')
        const id = sid()
        objects.push({ type: 'TX_WARRANT_ISSUANCE', id, date: p.date, securityId: id, stakeholderId: who, stockClassId: cls.id, quantity: q, ...(p.pricePerShare ? { exercisePrice: p.pricePerShare } : {}), ...(p.amount && p.amount.minor > 0 ? { purchasePrice: p.amount } : {}), ...(p.expirationDate ? { expirationDate: p.expirationDate } : {}) })
        return { objects, summary: `Issued a warrant to ${p.stakeholder} for ${fmtN(q)} ${cls.name} shares${p.pricePerShare ? ` at ${fmtM(p.pricePerShare)}` : ''}${p.expirationDate ? `, expiring ${dayWords(p.expirationDate)}` : ''}${p.amount && p.amount.minor > 0 ? `; ${fmtM(p.amount)} paid for it` : ''}.` }
      }
      const rsu = p.grantType === 'rsu'
      const q = sharesNeeded(rsu ? 'An RSU grant' : 'An option grant')
      const cls = stockClass(p.shareClass && !/prefer|series/i.test(p.shareClass) ? p.shareClass : null)
      let plan = s.plans[0] ?? (objects.find((o) => o.type === 'STOCK_PLAN') as (typeof s.plans)[number] | undefined)
      let note = ''
      if (!plan) {
        const id = sid()
        objects.push({ type: 'STOCK_PLAN', id, name: 'Option pool', stockClassId: cls.id, size: q })
        plan = { type: 'STOCK_PLAN', id, name: 'Option pool', stockClassId: cls.id, size: q, returned: 0 }
        note = ' There was no option pool, so one was created at the size of this grant; set its real size.'
      }
      const who = person(p.stakeholder, 'EMPLOYEE')
      const rel = findPerson(p.stakeholder)?.relationship ?? 'EMPLOYEE'
      const id = sid()
      const type = rsu ? 'RSU' : p.grantType === 'iso' ? 'OPTION_ISO' : p.grantType === 'nso' ? 'OPTION_NSO' : rel === 'EMPLOYEE' ? 'OPTION_ISO' : 'OPTION_NSO'
      objects.push({ type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id, date: p.date, securityId: id, stakeholderId: who, stockPlanId: plan.id, stockClassId: cls.id, compensationType: type, quantity: q, ...(p.pricePerShare && !rsu ? { exercisePrice: p.pricePerShare } : {}), ...(p.vesting ? { vesting: p.vesting } : {}), ...(p.expirationDate && !rsu ? { expirationDate: p.expirationDate } : {}) })
      return { objects, summary: rsu ? `Granted ${fmtN(q)} RSUs to ${p.stakeholder}.${note}` : `Granted ${fmtN(q)} options to ${p.stakeholder}${p.pricePerShare ? ` at a ${fmtM(p.pricePerShare)} strike` : ''}.${note}` }
    }
    case 'exercise': {
      let left = sharesNeeded('An exercise')
      const sh = findPerson(p.stakeholder)
      const options = sh ? s.grants.filter((g) => g.stakeholderId === sh.id && g.compensationType !== 'RSU' && outstanding(g) > 0) : []
      const rsus = sh ? s.grants.filter((g) => g.stakeholderId === sh.id && g.compensationType === 'RSU' && outstanding(g) > 0) : []
      const wts = sh ? s.warrants.filter((w) => w.stakeholderId === sh.id && warrantLive(w, p.date)) : []
      // Which kind: as asked, else stock options, else whatever this person holds.
      const kind = p.grantType === 'rsu' ? 'rsu' : p.grantType === 'warrant' ? 'warrant' : options.length ? 'option' : wts.length ? 'warrant' : rsus.length ? 'rsu' : 'option'
      if (kind === 'rsu') {
        const byDate = [...rsus].sort((a, b) => a.date.localeCompare(b.date))
        const vested = byDate.reduce((a, g) => a + vestedOutstanding(g, p.date), 0)
        if (vested < left) throw new WriteRejected(`${p.stakeholder} has ${vested.toLocaleString('en-US')} vested RSUs to release on ${p.date}, not ${left.toLocaleString('en-US')}.`, 'insufficient')
        let withheld = Math.max(0, Math.min(left, Math.floor(p.withheldShares ?? 0)))
        const total = left
        const held = withheld
        for (const g of byDate) {
          if (!left) break
          const q = Math.min(left, vestedOutstanding(g, p.date))
          if (!q) continue
          const w = Math.min(withheld, q)
          const id = sid()
          objects.push({ type: 'TX_EQUITY_COMPENSATION_RELEASE', id, date: p.date, securityId: g.securityId, quantity: q, ...(w ? { withheld: w } : {}), resultingSecurityId: id + ':stock' })
          left -= q
          withheld -= w
        }
        return { objects, summary: `Released ${fmtN(total)} RSUs to ${p.stakeholder}${held ? ` (${fmtN(held)} kept back for tax, ${fmtN(total - held)} shares issued)` : ''}.` }
      }
      if (kind === 'warrant') {
        const byDate = [...wts].sort((a, b) => a.date.localeCompare(b.date))
        const have = byDate.reduce((a, w) => a + warrantOutstanding(w), 0)
        if (have < left) throw new WriteRejected(`${p.stakeholder} has warrants for ${have.toLocaleString('en-US')} shares left, not ${left.toLocaleString('en-US')}.`, 'insufficient')
        let fair: Money | null = null
        if (p.netExercise) {
          fair = p.fairValuePerShare ?? last409a(s)?.pricePerShare ?? null
          if (!fair) throw new WriteRejected('A cashless exercise needs the fair value per share (there’s no 409A to use).', 'invalid')
        }
        const total = left
        // What the toast says: the shares a cashless exercise actually issues, or the cash a cash exercise brings in.
        let issued = 0
        let paidMinor = 0
        const paidCurrency = byDate.find((w) => w.exercisePrice)?.exercisePrice?.currency ?? fair?.currency ?? 'USD'
        for (const w of byDate) {
          if (!left) break
          const q = Math.min(left, warrantOutstanding(w))
          const id = sid()
          objects.push({ type: 'TX_WARRANT_EXERCISE', id, date: p.date, securityId: w.securityId, quantity: q, ...(fair ? { netFairValue: fair } : {}), resultingSecurityId: id + ':stock' })
          issued += fair ? netExerciseShares(q, w.exercisePrice?.minor ?? 0, fair.minor) : q
          if (!fair && w.exercisePrice?.currency === paidCurrency) paidMinor += Math.round(q * w.exercisePrice.minor)
          left -= q
        }
        return {
          objects,
          summary: fair
            ? `${p.stakeholder} exercised warrants for ${fmtN(total)} shares, cashless at ${fmtM(fair)} a share: ${fmtN(issued)} shares issued, no cash.`
            : `${p.stakeholder} exercised warrants for ${fmtN(total)} shares${paidMinor ? `, paying ${fmtM({ minor: paidMinor, currency: paidCurrency })}` : ''}.`,
        }
      }
      const grants = [...options].sort((a, b) => a.date.localeCompare(b.date))
      const available = grants.reduce((a, g) => a + outstanding(g), 0)
      if (available < left) throw new WriteRejected(`${p.stakeholder} has ${available.toLocaleString('en-US')} options left, not ${left.toLocaleString('en-US')}.`, 'insufficient')
      for (const g of grants) {
        if (!left) break
        const q = Math.min(left, outstanding(g))
        const id = sid()
        objects.push({ type: 'TX_EQUITY_COMPENSATION_EXERCISE', id, date: p.date, securityId: g.securityId, quantity: q, resultingSecurityId: id + ':stock' })
        left -= q
      }
      return { objects, summary: `${p.stakeholder} exercised ${fmtN(p.shares!)} options.` }
    }
    case 'transfer': {
      let left = sharesNeeded('A transfer')
      if (!p.toStakeholder) throw new WriteRejected('Say who the shares go to.', 'invalid')
      const sh = findPerson(p.stakeholder)
      const cls = p.shareClass ? s.classes.find((c) => c.name.toLowerCase() === p.shareClass!.toLowerCase()) : undefined
      const positions = sh ? s.stock.filter((x) => x.stakeholderId === sh.id && (!cls || x.stockClassId === cls.id)).sort((a, b) => a.date.localeCompare(b.date)) : []
      const held = positions.reduce((a, x) => a + x.quantity, 0)
      if (held < left) throw new WriteRejected(`${p.stakeholder} holds ${held.toLocaleString('en-US')}${cls ? ' ' + cls.name : ''} shares, not ${left.toLocaleString('en-US')}.`, 'insufficient')
      const to = person(p.toStakeholder)
      for (const x of positions) {
        if (!left) break
        const q = Math.min(left, x.quantity)
        objects.push({ type: 'TX_STOCK_TRANSFER', id: sid(), date: p.date, securityId: x.securityId, quantity: q, toStakeholderId: to })
        left -= q
      }
      return { objects, summary: `${p.stakeholder} transferred ${fmtN(p.shares!)} shares to ${p.toStakeholder}.` }
    }
    case 'cancellation': {
      let left = sharesNeeded('A cancellation')
      const sh = findPerson(p.stakeholder)
      if (!sh) throw new WriteRejected(`${p.stakeholder} isn’t on the cap table.`, 'unknown_stakeholder')
      const cls = p.shareClass ? s.classes.find((c) => c.name.toLowerCase() === p.shareClass!.toLowerCase()) : undefined
      if (p.grantType === 'warrant') {
        const wts = s.warrants.filter((w) => w.stakeholderId === sh.id && warrantOutstanding(w) > 0).sort((a, b) => b.date.localeCompare(a.date))
        const have = wts.reduce((a, w) => a + warrantOutstanding(w), 0)
        if (have < left) throw new WriteRejected(`${p.stakeholder} has warrants for ${have.toLocaleString('en-US')} shares left, not ${left.toLocaleString('en-US')}.`, 'insufficient')
        for (const w of wts) {
          if (!left) break
          const q = Math.min(left, warrantOutstanding(w))
          objects.push({ type: 'TX_WARRANT_CANCELLATION', id: sid(), date: p.date, securityId: w.securityId, quantity: q })
          left -= q
        }
        return { objects, summary: `Cancelled warrants for ${fmtN(p.shares!)} of ${p.stakeholder}’s shares.` }
      }
      const grants = s.grants.filter((g) => g.stakeholderId === sh.id && outstanding(g) > 0 && (p.grantType === 'rsu' ? g.compensationType === 'RSU' : p.grantType ? g.compensationType !== 'RSU' : true))
      const useGrants = !p.shareClass && grants.length > 0
      if (useGrants) {
        const have = grants.reduce((a, g) => a + outstanding(g), 0)
        if (have < left) throw new WriteRejected(`${p.stakeholder} has ${have.toLocaleString('en-US')} options left, not ${left.toLocaleString('en-US')}.`, 'insufficient')
        for (const g of [...grants].sort((a, b) => b.date.localeCompare(a.date))) {
          if (!left) break
          const q = Math.min(left, outstanding(g))
          objects.push({ type: 'TX_EQUITY_COMPENSATION_CANCELLATION', id: sid(), date: p.date, securityId: g.securityId, quantity: q })
          left -= q
        }
        return { objects, summary: `Cancelled ${fmtN(p.shares!)} of ${p.stakeholder}’s options; they return to the pool.` }
      }
      const positions = s.stock.filter((x) => x.stakeholderId === sh.id && (!cls || x.stockClassId === cls.id)).sort((a, b) => b.date.localeCompare(a.date))
      const held = positions.reduce((a, x) => a + x.quantity, 0)
      if (held < left) throw new WriteRejected(`${p.stakeholder} holds ${held.toLocaleString('en-US')} shares, not ${left.toLocaleString('en-US')}.`, 'insufficient')
      for (const x of positions) {
        if (!left) break
        const q = Math.min(left, x.quantity)
        objects.push({ type: 'TX_STOCK_CANCELLATION', id: sid(), date: p.date, securityId: x.securityId, quantity: q })
        left -= q
      }
      void existing
      return { objects, summary: `Cancelled ${fmtN(p.shares!)} of ${p.stakeholder}’s shares.` }
    }
  }
}

/** Same holder, same kind, same amount or shares within 7 days → probably the same event told twice. */
export function possibleDuplicates(existing: readonly EquityObject[], fresh: readonly EquityObject[]): Id[] {
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= 7 * 86_400_000
  const out: Id[] = []
  for (const f of fresh) {
    for (const e of existing) {
      if (e.type !== f.type) continue
      if (f.type === 'TX_CONVERTIBLE_ISSUANCE' && e.type === 'TX_CONVERTIBLE_ISSUANCE' && e.stakeholderId === f.stakeholderId && e.amount.minor === f.amount.minor && near(e.date, f.date)) out.push(e.id)
      if (f.type === 'TX_STOCK_ISSUANCE' && e.type === 'TX_STOCK_ISSUANCE' && e.stakeholderId === f.stakeholderId && e.quantity === f.quantity && near(e.date, f.date)) out.push(e.id)
      if (f.type === 'TX_EQUITY_COMPENSATION_ISSUANCE' && e.type === 'TX_EQUITY_COMPENSATION_ISSUANCE' && e.stakeholderId === f.stakeholderId && e.quantity === f.quantity && near(e.date, f.date)) out.push(e.id)
      if (f.type === 'TX_WARRANT_ISSUANCE' && e.type === 'TX_WARRANT_ISSUANCE' && e.stakeholderId === f.stakeholderId && e.quantity === f.quantity && near(e.date, f.date)) out.push(e.id)
    }
  }
  return [...new Set(out)]
}
