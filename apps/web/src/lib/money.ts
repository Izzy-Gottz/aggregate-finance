import type { Money } from '@agfn/contracts'

const MINUS = '−'
const digitsCache = new Map<string, number>()

/** Minor-unit exponent for a currency (USD 2, JPY 0, BHD 3), from Intl so we never hard-code a table. */
export function exponent(currency: string): number {
  let d = digitsCache.get(currency)
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    } catch {
      d = 2
    }
    digitsCache.set(currency, d)
  }
  return d
}

export interface FormatOptions {
  /** Show cents. Default: only when the amount has them and is under 1,000. */
  cents?: boolean
  /** Prefix positive amounts with "+" (transaction lists). */
  signed?: boolean
}

/** "$284,410", "−$1,340.22", "€9,800". Integer math until the final Intl call. */
export function fmt(m: Money | null | undefined, o: FormatOptions = {}): string {
  if (!m) return '–'
  const exp = exponent(m.currency)
  const unit = 10 ** exp
  const abs = Math.abs(m.minor)
  const hasCents = abs % unit !== 0
  const cents = o.cents ?? (hasCents && abs < 1000 * unit)
  const value = cents ? abs / unit : Math.round(abs / unit)
  let s: string
  try {
    s = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: m.currency,
      minimumFractionDigits: cents ? exp : 0,
      maximumFractionDigits: cents ? exp : 0,
    }).format(value)
  } catch {
    s = `${value.toLocaleString('en-US')} ${m.currency}`
  }
  if (m.minor < 0) return MINUS + s
  return o.signed && m.minor > 0 ? '+' + s : s
}

/** The currency a typed amount names ("€450,000", "450000 EUR"), or null when it names none or only "$" (which
 *  dollar is ambiguous; the form's own currency applies). The server then refuses a currency a position isn't held in. */
export function typedCurrency(input: string): string | null {
  const t = input.trim()
  const sym: Record<string, string> = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₪': 'ILS', '₣': 'CHF' }
  for (const [k, v] of Object.entries(sym)) if (t.includes(k)) return v
  const code = /^([A-Za-z]{3})\s*[\d.,]|[\d.,]\s*([A-Za-z]{3})$/.exec(t)
  return code ? (code[1] ?? code[2]!).toUpperCase() : null
}

/** An amount in the currency it was typed in, else `fallback`'s. */
export function parseTyped(input: string, fallback: string): Money | null {
  return parseAmount(input.replace(/^[A-Za-z]{3}\s*|\s*[A-Za-z]{3}$/g, ''), typedCurrency(input) ?? fallback)
}

/** Parse what a person types ("1,200", "$1200.5", "1200.50") into minor units. Returns null when it isn't a number. */
export function parseAmount(input: string, currency: string): Money | null {
  const clean = input.replace(/[\s,$€£¥]/g, '').replace(MINUS, '-')
  if (!/^-?\d+(\.\d+)?$/.test(clean)) return null
  const exp = exponent(currency)
  const [whole = '0', frac = ''] = clean.replace('-', '').split('.')
  if (frac.length > exp) return null
  const minor = Number(whole) * 10 ** exp + Number((frac + '0'.repeat(exp)).slice(0, exp) || '0')
  if (!Number.isSafeInteger(minor)) return null
  return { minor: clean.startsWith('-') ? -minor : minor, currency }
}

export const sum = (xs: Money[], currency: string): Money => ({
  minor: xs.reduce((a, x) => a + (x.currency === currency ? x.minor : 0), 0),
  currency,
})
