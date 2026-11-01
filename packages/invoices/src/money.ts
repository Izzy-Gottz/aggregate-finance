// Integer minor-unit money math. No floats ever touch an amount.
import type { Currency, Money } from '@agfn/contracts'

/** ISO 4217 minor-unit exponents that differ from 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

export function exponentOf(currency: Currency): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2
}

export class MoneyError extends Error {
  override name = 'MoneyError'
}

export function money(minor: number, currency: Currency): Money {
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`minor units must be a safe integer, got ${minor}`)
  return { minor, currency: currency.toUpperCase() }
}

export function zero(currency: Currency): Money {
  return money(0, currency)
}

/**
 * Parse a decimal amount ("1234.5", "-0.07", "1,234.56", 12.3) into minor units without float math.
 * Numbers are formatted with toString first; more decimals than the currency allows are rejected
 * unless they are zeros, because silently rounding money hides errors.
 */
export function parseAmount(input: string | number, currency: Currency): Money {
  const exp = exponentOf(currency)
  let s = typeof input === 'number' ? numberToPlain(input) : input.trim()
  if (s.includes(',')) {
    // Only US-style thousands grouping is accepted; "10.000,00" must not quietly become 10.00.
    if (!/^[(+-]?\d{1,3}(,\d{3})+(\.\d*)?\)?$/.test(s)) throw new MoneyError(`ambiguous separators in ${JSON.stringify(input)}`)
    s = s.replace(/,/g, '')
  }
  if (s.startsWith('(') && s.endsWith(')')) s = '-' + s.slice(1, -1) // accounting negatives
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new MoneyError(`not a decimal amount: ${JSON.stringify(input)}`)
  const sign = m[1] === '-' ? -1 : 1
  const whole = m[2] || '0'
  let frac = m[3] ?? ''
  if (frac.length > exp) {
    if (/[^0]/.test(frac.slice(exp))) throw new MoneyError(`${JSON.stringify(input)} has more than ${exp} decimals for ${currency}`)
    frac = frac.slice(0, exp)
  }
  frac = frac.padEnd(exp, '0')
  const minor = Number(whole + frac)
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount out of range: ${JSON.stringify(input)}`)
  return money(minor === 0 ? 0 : sign * minor, currency)
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError(`not a finite number: ${n}`)
  // Providers send JSON numbers like 12.3; toString is exact for the shortest round-trip form.
  const s = String(n)
  if (/e/i.test(s)) {
    // e.g. 1e-7 or 1e21: format via toFixed with enough digits, then trim.
    return n.toFixed(20).replace(/\.?0+$/, '')
  }
  return s
}

export function formatAmount(m: Money): string {
  const exp = exponentOf(m.currency)
  const neg = m.minor < 0
  const abs = String(Math.abs(m.minor)).padStart(exp + 1, '0')
  const whole = exp > 0 ? abs.slice(0, -exp) : abs
  const frac = exp > 0 ? '.' + abs.slice(-exp) : ''
  return `${neg ? '-' : ''}${whole}${frac}`
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`)
}

export function add(a: Money, b: Money): Money {
  same(a, b)
  return money(a.minor + b.minor, a.currency)
}

export function sub(a: Money, b: Money): Money {
  same(a, b)
  return money(a.minor - b.minor, a.currency)
}

export function sum(items: Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), zero(currency))
}

export function cmp(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b)
  return a.minor < b.minor ? -1 : a.minor > b.minor ? 1 : 0
}

export function min(a: Money, b: Money): Money {
  return cmp(a, b) <= 0 ? a : b
}

export function max(a: Money, b: Money): Money {
  return cmp(a, b) >= 0 ? a : b
}

export function neg(a: Money): Money {
  return money(a.minor === 0 ? 0 : -a.minor, a.currency)
}

export function abs(a: Money): Money {
  return money(Math.abs(a.minor), a.currency)
}

export function isZero(a: Money): boolean {
  return a.minor === 0
}
