// Carta Portfolio API objects → investment.event: what one holder (a portfolio) owns in one company (an issuer).
//
// Carta cancels and reissues share certificates on every split, transfer and class exchange, records each as a share
// "sale" at price 0, and doesn't link the new certificate to the old one. So a holder's shares in a company are ONE
// position (portfolio + issuer), and the cost stays with it through any reissue:
//   - invest per acquisition: an exercise's certificate at strike × shares (its pricePerShare isn't what was paid),
//     a reissued certificate at 0, anything else at shares × pricePerShare; shares only on certificates still held;
//   - distribution per completed sale that brought money in (the last one is the exit once nothing is held);
//   - mark from the 409A when every certificate held is common (a common 409A doesn't price preferred).
// Open SAFEs and notes are their own positions at the cash paid; converted, canceled and draft ones aren't positions.
// Unexercised options and unvested RSUs aren't owned yet, and cash never comes from Carta (the bank shows it).
import type { InvestmentEvent, Money } from '@agfn/contracts'
import { isRecord, money, normalizeCurrency, str } from '@agfn/connector-sdk'

export const PROVIDER = 'carta'

/** Carta wraps scalars: { value: "1000" }. */
export function val(v: unknown): string | undefined {
  if (isRecord(v)) return str(v.value)
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

/** Carta money: { currencyCode: { value: "USD" }, amount: { value: "0.05" } }; amounts can be "0E-50". */
export function cartaMoney(v: unknown): { amount: number; currency: string } | undefined {
  if (!isRecord(v)) return undefined
  const amount = Number(val(v.amount))
  if (!Number.isFinite(amount)) return undefined
  return { amount, currency: normalizeCurrency(val(v.currencyCode), 'USD') }
}

const day = (v: unknown): string | undefined => {
  const s = val(v)
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined
}
const num = (v: unknown): number | undefined => {
  const n = Number(val(v))
  return Number.isFinite(n) ? n : undefined
}
/** qty × price, rounded once at the end (Carta prices carry up to 28 decimals). */
const times = (qty: number, price: number, currency: string): Money => money(Math.round(qty * price * 1e6) / 1e6, currency)

export interface IssuerRef {
  portfolioId: string
  issuerId: string
  /** The company's name as Carta shows it. */
  name: string
}

/** Everything Carta lists for one holder in one company. */
export interface IssuerData {
  certificates: Array<Record<string, unknown>>
  restrictedStockAwards: Array<Record<string, unknown>>
  convertibleNotes: Array<Record<string, unknown>>
  securityTransactions: Array<Record<string, unknown>>
  fairMarketValue?: Record<string, unknown>
}

/** Every record of a portfolio starts with this, so a full listing can void what disappeared (listing.complete). */
export const scopeOf = (portfolioId: string) => `carta:${portfolioId}:`
export const sharesPosition = (i: IssuerRef) => `${scopeOf(i.portfolioId)}${i.issuerId}`
export const notePosition = (i: IssuerRef, noteId: string) => `${scopeOf(i.portfolioId)}note:${noteId}`

const isPreferred = (shareClass: string | undefined) => !!shareClass && /prefer/i.test(shareClass)
const completed = (t: Record<string, unknown>) => /COMPLETE/.test(str(t.transactionStatus) ?? '')

/** Shares, notes, marks and sales for one holder in one company. `rawRef` is the raw issuer payload. */
export function mapIssuer(data: IssuerData, issuer: IssuerRef, connectionId: string, rawRef?: string): InvestmentEvent[] {
  const base = { type: 'investment.event' as const, connectionId, ...(rawRef ? { rawRef } : {}), issuer: issuer.name }
  const pos = sharesPosition(issuer)
  const out: InvestmentEvent[] = []

  // What an exercise paid, by the certificate it made; and the days Carta reissued certificates (zero-price transfers).
  const exercised = new Map<string, Money>()
  const reissueDays = new Set<string>()
  /** Shares that left in zero-price "sales" (some come back as reissued certificates; the rest went to someone else). */
  let transferred = 0
  // salePrice is what the whole sale brought in (2, 1 and 3 shares at 20, 10 and 30; 30,000 at 70,500), not per share.
  const sales: Array<{ date: string; qty: number; proceeds: number; currency: string; n: number }> = []
  for (const [n, t] of data.securityTransactions.entries()) {
    if (!completed(t)) continue
    const date = day(str(t.transactionTime)?.slice(0, 10))
    const ex = isRecord(t.optionGrantTransactionDetail) ? t.optionGrantTransactionDetail : undefined
    const sh = isRecord(t.shareTransactionDetail) ? t.shareTransactionDetail : undefined
    if (ex) {
      const cert = str(ex.certificatedId) ?? str(ex.certificateId)
      const qty = num(ex.netExerciseQuantity) ?? num(ex.exerciseQuantity)
      const strike = cartaMoney(ex.exercisePrice)
      if (cert && qty !== undefined && strike) exercised.set(cert, times(qty, strike.amount, strike.currency))
    } else if (sh && date) {
      const qty = num(sh.saleQuantity)
      const price = cartaMoney(sh.salePrice)
      if (!qty || qty <= 0) continue
      if (price && price.amount > 0) sales.push({ date, qty, proceeds: price.amount, currency: price.currency, n })
      else {
        reissueDays.add(date)
        transferred += qty
      }
    }
  }

  // Certificates and restricted stock awards: one position for the company, per currency (a position has one).
  const holdings = [...data.certificates.map((c) => ['cert', c] as const), ...data.restrictedStockAwards.map((a) => ['rsa', a] as const)]
  const curOf = (c: Record<string, unknown>) => exercised.get(str(c.id) ?? '')?.currency ?? cartaMoney(c.pricePerShare)?.currency ?? 'USD'
  const currencies = [...new Set(holdings.map(([, c]) => curOf(c)))]
  const fmv = data.fairMarketValue
  for (const [ci, cur] of currencies.entries()) {
    const positionId = ci === 0 ? pos : `${pos}:${cur}`
    const mine = holdings.filter(([, c]) => curOf(c) === cur)
    // What's held decides; a position that's all gone keeps what it was.
    const live = mine.filter(([, c]) => !day(c.canceledDate))
    const securityType = (live.length ? live : mine).some(([, c]) => isPreferred(val(c.shareClassName))) ? 'preferred_stock' : 'common_stock'
    const held: Array<{ shares: number; common: boolean }> = []
    let invested = false
    let lastCancel: string | undefined
    let reissued = 0
    for (const [kind, c] of mine) {
      const id = str(c.id)
      const date = day(c.issueDate)
      const qty = num(c.quantity)
      if (!id || !date || qty === undefined || qty <= 0) continue
      const canceled = day(c.canceledDate)
      if (canceled && (!lastCancel || canceled > lastCancel)) lastCancel = canceled
      const sharesNow = canceled ? 0 : qty - (num(c.canceledQuantity) ?? 0)
      const reissue = !exercised.has(id) && reissueDays.has(date)
      if (reissue) reissued += qty
      const cost = exercised.get(id) ?? (reissue ? money(0, cur) : times(qty, cartaMoney(c.pricePerShare)?.amount ?? 0, cur))
      if (sharesNow > 0) held.push({ shares: sharesNow, common: !isPreferred(val(c.shareClassName)) })
      // A reissued certificate that's gone again added nothing: no cost, no shares.
      if (cost.minor === 0 && sharesNow <= 0) continue
      invested = true
      const series = val(c.shareClassName)
      out.push({ ...base, externalId: `${positionId}:${kind}:${id}`, kind: 'invest', positionId, securityType, date, amount: cost, ...(sharesNow > 0 ? { shares: sharesNow } : {}), ...(series ? { series } : {}) })
    }
    if (!invested) continue

    // Sales that brought money in are distributions. Once nothing is held, the position closed: on its last sale when
    // every share left by selling; with no amount (out at cost: an in-kind distribution or a transfer, no gain or loss)
    // when shares also left for nothing, or none were sold.
    const mySales = sales.filter((x) => x.currency === cur).sort((x, y) => x.date.localeCompare(y.date) || x.n - y.n)
    const leftForNothing = transferred - reissued > 0
    for (const [i, x] of mySales.entries()) {
      const last = i === mySales.length - 1 && held.length === 0 && !leftForNothing
      out.push({ ...base, externalId: `${positionId}:sale:${x.date}:${x.n}`, kind: last ? 'exit' : 'distribution', positionId, securityType, date: x.date, amount: money(Math.round(x.proceeds * 1e6) / 1e6, cur), shares: x.qty })
    }
    if (!held.length && lastCancel && (leftForNothing || !mySales.length)) {
      const lastSale = mySales.at(-1)?.date
      const date = lastSale && lastSale > lastCancel ? lastSale : lastCancel
      out.push({ ...base, externalId: `${positionId}:gone:${date}`, kind: 'exit', positionId, securityType, date })
    }

    // The 409A values what's held, when all of it is common stock in the 409A's currency.
    const price = fmv ? cartaMoney(fmv.price) : undefined
    const asOf = fmv ? day(fmv.asOfDate) : undefined
    if (price && asOf && price.currency === cur && held.length && held.every((h) => h.common)) {
      const shares = held.reduce((t, h) => t + h.shares, 0)
      out.push({ ...base, externalId: `${positionId}:mark:${asOf}`, kind: 'mark', positionId, securityType, date: asOf, amount: times(shares, price.amount, cur), markSource: `409A as of ${asOf}${fmv?.stale === true ? ' (stale)' : ''}` })
    }
  }

  for (const n of data.convertibleNotes) {
    const e = mapNote(n, issuer, base)
    if (e) out.push(e)
  }
  return out
}

/** Carta writes a discount as a fraction (0.2) or a percent (20); the contract wants the percent. */
export function percent(v: unknown): number | undefined {
  const n = num(v)
  if (n === undefined || n < 0) return undefined
  return n <= 1 ? Math.round(n * 1e6) / 1e4 : n
}

/** An open, executed SAFE or convertible note: an invest of the cash paid, with its terms. */
function mapNote(n: Record<string, unknown>, issuer: IssuerRef, base: Pick<InvestmentEvent, 'type' | 'connectionId' | 'rawRef' | 'issuer'>): InvestmentEvent | undefined {
  const block = isRecord(n.noteBlock) ? n.noteBlock : {}
  const status = str(block.status)
  if (status && status !== 'EXECUTED') return undefined
  if (day(n.conversionDatetime) || day(n.canceledDatetime)) return undefined
  const id = str(n.id)
  const issued = day(n.issueDatetime) ?? day(n.issueDate)
  const cash = cartaMoney(n.cashPaid)
  if (!id || !issued || !cash || cash.amount <= 0) return undefined
  const safe = /safe/i.test(str(block.noteType) ?? '')
  const cap = cartaMoney(n.priceCap)
  const discountPct = percent(n.discountPercentage)
  const interestPct = num(n.interestRate)
  const maturityDate = day(n.maturityDatetime)
  const series = str(block.name)
  const positionId = notePosition(issuer, id)
  return {
    ...base,
    externalId: `${positionId}:invest`,
    kind: 'invest',
    positionId,
    securityType: safe ? 'safe' : 'convertible_note',
    date: issued,
    amount: money(cash.amount, cash.currency),
    ...(series ? { series } : {}),
    ...(cap && cap.amount > 0 && cap.currency === cash.currency ? { valuationCap: money(cap.amount, cap.currency) } : {}),
    ...(discountPct ? { discountPct } : {}),
    ...(!safe && interestPct !== undefined ? { interestPct } : {}),
    ...(!safe && maturityDate ? { maturityDate } : {}),
  }
}
