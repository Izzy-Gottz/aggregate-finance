// Money math in integer minor units. Floats never touch an amount: FX conversion runs in BigInt.
import type { Currency, Money, MoneyWire } from '@agfn/contracts'

/** ISO 4217 minor-unit exponents that differ from 2. Everything else is 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
}

export class MoneyError extends Error {
  override name = 'MoneyError'
}

export function exponentOf(currency: Currency): number {
  assertCurrency(currency)
  return EXPONENTS[currency] ?? 2
}

export function assertCurrency(currency: string): asserts currency is Currency {
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`Invalid currency code "${currency}"`)
}

export function assertMinor(minor: number, what = 'amount'): void {
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`${what} must be a safe integer of minor units, got ${minor}`)
}

export function money(minor: number, currency: Currency): Money {
  assertMinor(minor)
  assertCurrency(currency)
  return { minor, currency }
}

export function zero(currency: Currency): Money {
  return money(0, currency)
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`)
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return money(a.minor + b.minor, a.currency)
}

export function sub(a: Money, b: Money): Money {
  sameCurrency(a, b)
  return money(a.minor - b.minor, a.currency)
}

export function neg(a: Money): Money {
  return money(-a.minor || 0, a.currency)
}

export function abs(a: Money): Money {
  return money(Math.abs(a.minor), a.currency)
}

export function sumMinor(values: readonly number[]): number {
  let total = 0
  for (const v of values) {
    total += v
    assertMinor(total, 'sum')
  }
  return total
}

/** Decimal string ("1234.56") → minor units. Rejects more precision than the currency allows. */
export function parseAmount(amount: string, currency: Currency): Money {
  const exp = exponentOf(currency)
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (!m) throw new MoneyError(`Invalid amount "${amount}"`)
  const [, sign, whole = '0', frac = ''] = m
  if (frac.length > exp) throw new MoneyError(`"${amount}" has more than ${exp} decimals for ${currency}`)
  const minor = Number(whole + frac.padEnd(exp, '0'))
  return money(sign ? -minor || 0 : minor, currency)
}

export function toWireMoney(m: Money): MoneyWire {
  const exp = exponentOf(m.currency)
  const negative = m.minor < 0
  const digits = String(Math.abs(m.minor)).padStart(exp + 1, '0')
  const whole = exp > 0 ? digits.slice(0, -exp) : digits
  const frac = exp > 0 ? '.' + digits.slice(-exp) : ''
  return { amount: `${negative ? '-' : ''}${whole}${frac}`, currency: m.currency }
}

export function fromWire(w: MoneyWire): Money {
  return parseAmount(w.amount, w.currency)
}

// ---------- Exact decimals for FX rates ----------

/** A rate as an exact fraction: numerator / 10^scale. */
export interface Decimal {
  num: bigint
  scale: number
}

/** Parse "1.0842", "0.00027", "1e-7" or a JS number into an exact decimal. */
export function parseDecimal(input: string | number): Decimal {
  const text = typeof input === 'number' ? numberToPlain(input) : input.trim()
  const m = /^(-)?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new MoneyError(`Invalid decimal "${text}"`)
  const [, sign, whole = '', frac = '', expText] = m
  let num = BigInt((whole + frac).replace(/^0+(?=\d)/, '') || '0')
  let scale = frac.length - Number(expText ?? 0)
  if (scale < 0) {
    num *= 10n ** BigInt(-scale)
    scale = 0
  }
  return { num: sign ? -num : num, scale }
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`Invalid decimal ${n}`)
  return String(n)
}

export function decimalToString(d: Decimal): string {
  const negative = d.num < 0n
  const digits = (negative ? -d.num : d.num).toString().padStart(d.scale + 1, '0')
  const whole = d.scale > 0 ? digits.slice(0, -d.scale) : digits
  let frac = d.scale > 0 ? digits.slice(-d.scale) : ''
  frac = frac.replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${frac ? '.' + frac : ''}`
}

/** Round num/den to the nearest integer, halves away from zero (the usual accounting convention). */
export function divRound(num: bigint, den: bigint): bigint {
  if (den === 0n) throw new MoneyError('Division by zero')
  if (den < 0n) {
    num = -num
    den = -den
  }
  const negative = num < 0n
  const a = negative ? -num : num
  const q = a / den
  const r = a % den
  const rounded = r * 2n >= den ? q + 1n : q
  return negative ? -rounded : rounded
}

function bigToMinor(b: bigint): number {
  const n = Number(b)
  assertMinor(n, 'converted amount')
  return n
}

/** Convert minor units at `rate` (units of `to` per one unit of `from`). Half away from zero. */
export function convert(m: Money, to: Currency, rate: Decimal | string): Money {
  const r = typeof rate === 'string' ? parseDecimal(rate) : rate
  if (m.currency === to) return m
  const shift = exponentOf(to) - exponentOf(m.currency)
  let num = BigInt(m.minor) * r.num
  let den = 10n ** BigInt(r.scale)
  if (shift >= 0) num *= 10n ** BigInt(shift)
  else den *= 10n ** BigInt(-shift)
  return money(bigToMinor(divRound(num, den)), to)
}

/** Effective rate implied by two amounts, as a decimal string with up to 10 places (for display/audit). */
export function impliedRate(from: Money, to: Money): string {
  if (from.minor === 0) return '0'
  const shift = exponentOf(from.currency) - exponentOf(to.currency)
  let num = BigInt(to.minor) * 10n ** 10n
  let den = BigInt(from.minor)
  if (shift >= 0) num *= 10n ** BigInt(shift)
  else den *= 10n ** BigInt(-shift)
  return decimalToString({ num: divRound(num, den), scale: 10 })
}

/** Split an amount into parts proportional to `weights`, largest remainder so the parts always sum exactly. */
export function allocate(total: number, weights: readonly number[]): number[] {
  assertMinor(total)
  if (weights.length === 0) throw new MoneyError('allocate needs at least one weight')
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) throw new MoneyError('weights must be non-negative integers')
  const sumW = weights.reduce((a, b) => a + b, 0)
  if (sumW === 0) throw new MoneyError('weights sum to zero')
  const t = BigInt(total)
  const negative = t < 0n
  const at = negative ? -t : t
  const parts = weights.map((w) => (at * BigInt(w)) / BigInt(sumW))
  let rest = at - parts.reduce((a, b) => a + b, 0n)
  const order = weights
    .map((w, i) => ({ i, rem: (at * BigInt(w)) % BigInt(sumW) }))
    .sort((x, y) => (y.rem > x.rem ? 1 : y.rem < x.rem ? -1 : x.i - y.i))
  for (const { i } of order) {
    if (rest === 0n) break
    parts[i] = (parts[i] ?? 0n) + 1n
    rest -= 1n
  }
  return parts.map((p) => bigToMinor(negative ? -p : p))
}

/** Minor units as people read them in text (health lines, checks, Review): "$213.12", "€40.00", "¥500". */
export function formatMoney(minor: number, currency: string): string {
  try {
    const exp = exponentOf(currency as Currency)
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp)
  } catch {
    return `${minor} ${currency} (minor units)`
  }
}

/**
 * ISO 4217's "no currency": what connectors record for balances that aren't money here (points, crypto without an ISO
 * code). Rows in it are kept and shown, never posted or converted, and its accounts are never cash.
 */
export const NOT_MONEY = 'XXX'
