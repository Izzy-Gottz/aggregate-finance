// Money at the MCP/REST boundary: decimal strings in, integer minor units inside.
import type { Currency, Money, MoneyWire } from '@agfn/contracts'
import { toWire } from '@agfn/contracts'

const exponentCache = new Map<string, number>()

/** ISO 4217 minor-unit exponent (USD 2, JPY 0, KWD 3). Throws for codes Intl doesn't know. */
export function currencyExponent(currency: Currency): number {
  const code = currency.toUpperCase()
  const cached = exponentCache.get(code)
  if (cached !== undefined) return cached
  if (!/^[A-Z]{3}$/.test(code)) throw new MoneyError(`"${currency}" is not a 3-letter currency code`)
  let exp: number
  try {
    exp = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    throw new MoneyError(`unknown currency "${currency}"`)
  }
  exponentCache.set(code, exp)
  return exp
}

export class MoneyError extends Error {
  override name = 'MoneyError'
}

/**
 * Parse a decimal string ("1234.56", "-0.5", "1,234.56") into integer minor units without floats.
 * Rejects more fraction digits than the currency allows rather than rounding silently.
 */
export function parseMoney(input: MoneyWire): Money {
  const currency = input.currency.toUpperCase()
  const exp = currencyExponent(currency)
  const raw = input.amount.trim().replace(/,/g, '')
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!m) throw new MoneyError(`"${input.amount}" is not a decimal amount like "1234.56"`)
  const [, sign, whole = '0', frac = ''] = m
  if (frac.length > exp) throw new MoneyError(`${currency} allows ${exp} decimal places; got "${input.amount}"`)
  const minorStr = whole + frac.padEnd(exp, '0')
  const minor = Number(minorStr)
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount "${input.amount}" is too large`)
  return { minor: sign && minor !== 0 ? -minor : minor, currency }
}

/**
 * A per-share price: up to two more decimals than the currency ("0.0125" USD), kept as fractional minor units (1.25),
 * the way the cap table stores them.
 */
export function parsePrice(input: MoneyWire): Money {
  const currency = input.currency.toUpperCase()
  const exp = currencyExponent(currency)
  const raw = input.amount.trim().replace(/,/g, '')
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!m) throw new MoneyError(`"${input.amount}" is not a decimal amount like "0.0125"`)
  const [, sign, whole = '0', frac = ''] = m
  if (frac.length > exp + 2) throw new MoneyError(`A ${currency} price per share allows ${exp + 2} decimal places; got "${input.amount}"`)
  const hundredths = Number(whole + frac.padEnd(exp + 2, '0'))
  if (!Number.isSafeInteger(hundredths)) throw new MoneyError(`price "${input.amount}" is too large`)
  const minor = hundredths / 100
  return { minor: sign && minor !== 0 ? -minor : minor, currency }
}

export function wire(m: Money): MoneyWire {
  return toWire(m, currencyExponent(m.currency))
}

/** Absolute value, for ">10% of cash" style comparisons. */
export function absMinor(m: Money): number {
  return Math.abs(m.minor)
}

const symbolCache = new Map<string, string>()

/**
 * A wire amount the way the app shows money, for summaries: "$756,470.81", "−$1,340.22", "€9,800.00". Exact (string
 * math, no floats) and always with cents; structured data keeps the plain decimal string and currency code.
 */
export function say(amount: string | null | undefined, currency: Currency): string {
  if (amount == null) return 'unknown'
  const code = currency.toUpperCase()
  const neg = amount.startsWith('-')
  const [whole = '0', frac = ''] = amount.replace(/^-/, '').split('.')
  let exp = 2
  try {
    exp = currencyExponent(code)
  } catch {
    /* unknown code: two places */
  }
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (exp ? '.' + frac.padEnd(exp, '0').slice(0, exp) : '')
  let sym = symbolCache.get(code)
  if (sym === undefined) {
    try {
      sym = new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).formatToParts(1).find((p) => p.type === 'currency')?.value ?? ''
    } catch {
      sym = ''
    }
    symbolCache.set(code, sym)
  }
  return `${neg ? '−' : ''}${sym ? sym + digits : `${digits} ${code}`}`
}
