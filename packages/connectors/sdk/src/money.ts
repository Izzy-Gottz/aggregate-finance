// Money at the connector boundary: provider amounts (decimal strings, JSON numbers, or already-minor integers)
// become integer minor units with no float arithmetic. Sign conversion (+ = money in) happens here too.

import type { Currency, Money } from '@agfn/contracts'
import { ConnectorError } from './errors.ts'

/** ISO 4217 minor-unit exponents that differ from 2. Everything else is 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0,
  VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
}

export function currencyExponent(currency: Currency): number {
  return EXPONENTS[currency.toUpperCase()] ?? 2
}

export function normalizeCurrency(code: string | null | undefined, fallback = 'USD'): Currency {
  const c = (code ?? '').trim().toUpperCase()
  return /^[A-Z]{3}$/.test(c) ? c : fallback
}

/**
 * Parse a decimal amount into integer minor units, exactly.
 * Accepts "1234.56", "-0.5", "1,234.56", "(12.00)" (accounting negative), "$12", numbers like 12.34 and "1e3".
 * Extra precision beyond the currency exponent is rounded half away from zero (e.g. Plaid's 0.005 rows).
 */
export interface ParseOptions {
  /**
   * Decimal separator of the source. '.' (default): "1,234.56"; commas must form valid thousands groups.
   * ',' (de/fr/nl files): "1.234,56" or "1 234,56"; dots must form valid thousands groups.
   * Anything ambiguous or malformed throws invalid_input instead of guessing.
   */
  decimal?: '.' | ','
}

export function toMinor(value: string | number, currency: Currency, opts: ParseOptions = {}): number {
  const exp = currencyExponent(currency)
  let s = typeof value === 'number' ? numberToPlain(value) : value.trim()
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1).trim()
  }
  s = s.replace(/[\s\u00a0\u202f$€£¥]/g, '')
  const code = currency.toUpperCase()
  if (s.toUpperCase().startsWith(code)) s = s.slice(3)
  else if (s.toUpperCase().endsWith(code)) s = s.slice(0, -3)
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (s.endsWith('-')) {
    neg = !neg
    s = s.slice(0, -1)
  }
  if (typeof value === 'string') s = normalizeSeparators(s, opts.decimal ?? '.', value)
  if (/e/i.test(s)) s = numberToPlain(Number(s))
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) {
    throw new ConnectorError('invalid_input', `not an amount: ${JSON.stringify(String(value).slice(0, 40))}`, {
      provider: 'sdk',
    })
  }
  const [whole = '0', frac = ''] = s.split('.')
  const kept = (frac + '0'.repeat(exp)).slice(0, exp)
  const rest = frac.slice(exp)
  let minor = BigInt((whole || '0') + kept)
  if (rest && Number(rest[0]) >= 5) minor += 1n
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConnectorError('invalid_input', 'amount too large', { provider: 'sdk' })
  }
  const n = Number(minor)
  return neg && n !== 0 ? -n : n
}

/** Remove thousands separators (only when they form valid groups) and make '.' the decimal point. */
function normalizeSeparators(s: string, decimal: '.' | ',', original: string): string {
  const group = decimal === '.' ? ',' : '.'
  const bad = () =>
    new ConnectorError('invalid_input', `ambiguous amount: ${JSON.stringify(original.slice(0, 40))}`, { provider: 'sdk' })
  const parts = s.split(decimal)
  if (parts.length > 2) throw bad()
  const [int = '', frac] = parts
  if (frac !== undefined && frac.includes(group)) throw bad()
  let whole = int
  if (int.includes(group)) {
    if (!new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(int)) throw bad()
    whole = int.split(group).join('')
  }
  return frac === undefined ? whole : `${whole}.${frac}`
}

/** A JSON number as its shortest exact decimal string (no exponent). */
function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new ConnectorError('invalid_input', 'amount is not finite', { provider: 'sdk' })
  const s = String(n)
  if (!/e/i.test(s)) return s
  // toFixed handles up to 100 digits; 20 covers any money value we accept.
  return n.toFixed(20).replace(/\.?0+$/, '')
}

export function money(value: string | number, currency: string, opts?: ParseOptions): Money {
  const c = normalizeCurrency(currency)
  return { minor: toMinor(value, c, opts), currency: c }
}

/** Already-minor integer (Stripe, Square, Paddle cents). Validates it's a safe integer. */
export function minorMoney(minor: number | string, currency: string): Money {
  const n = typeof minor === 'string' ? Number(minor) : minor
  if (!Number.isSafeInteger(n)) {
    throw new ConnectorError('invalid_input', `not an integer minor amount: ${String(minor).slice(0, 40)}`, {
      provider: 'sdk',
    })
  }
  return { minor: n, currency: normalizeCurrency(currency) }
}

export function negate(m: Money): Money {
  return { minor: m.minor === 0 ? 0 : -m.minor, currency: m.currency }
}

export function abs(m: Money): Money {
  return { minor: Math.abs(m.minor), currency: m.currency }
}
