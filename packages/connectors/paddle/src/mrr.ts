// MRR normalization with exact integer math (BigInt fractions), rounded half away from zero ONCE at the end.
// Per line: unit amount × quantity per billing interval → monthly (year ÷ 12, week × 52 ÷ 12, day × 365 ÷ 12),
// divided by the interval count. Percent discounts scale the total; amount discounts are spread monthly and subtracted.
// Metered/usage lines must not be passed in. The result is clamped at 0.

export type Interval = 'day' | 'week' | 'month' | 'year'

export interface RecurringLine {
  /** Unit price in minor units per billing interval. */
  unitAmount: number
  quantity: number
  interval: Interval
  intervalCount: number
}

export type MrrDiscount =
  /** Percent off in basis points (12.5% = 1250). */
  | { kind: 'percent'; basisPoints: number }
  /** Fixed amount off (minor units) per billing interval. */
  | { kind: 'amount'; amount: number; interval: Interval; intervalCount: number }

interface Frac {
  n: bigint
  d: bigint
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y) [x, y] = [y, x % y]
  return x || 1n
}

const norm = (f: Frac): Frac => {
  const g = gcd(f.n, f.d)
  return { n: f.n / g, d: f.d / g }
}

const add = (a: Frac, b: Frac): Frac => norm({ n: a.n * b.d + b.n * a.d, d: a.d * b.d })

/** amount per (count × interval) → amount per month, as an exact fraction. */
export function monthlyFraction(amount: bigint, interval: Interval, intervalCount: number): Frac {
  const c = BigInt(Math.max(1, Math.trunc(intervalCount)))
  switch (interval) {
    case 'month':
      return norm({ n: amount, d: c })
    case 'year':
      return norm({ n: amount, d: 12n * c })
    case 'week':
      return norm({ n: amount * 52n, d: 12n * c })
    case 'day':
      return norm({ n: amount * 365n, d: 12n * c })
  }
}

/** Round a fraction half away from zero. */
export function roundHalfAway(f: Frac): number {
  const neg = f.n < 0n !== f.d < 0n
  const n = f.n < 0n ? -f.n : f.n
  const d = f.d < 0n ? -f.d : f.d
  const q = (2n * n + d) / (2n * d)
  return Number(neg ? -q : q)
}

export function computeMrr(lines: RecurringLine[], discounts: MrrDiscount[] = []): number {
  let total: Frac = { n: 0n, d: 1n }
  for (const l of lines) {
    total = add(total, monthlyFraction(BigInt(l.unitAmount) * BigInt(l.quantity), l.interval, l.intervalCount))
  }
  for (const disc of discounts) {
    if (disc.kind === 'percent') {
      const bp = BigInt(Math.min(10_000, Math.max(0, Math.round(disc.basisPoints))))
      total = norm({ n: total.n * (10_000n - bp), d: total.d * 10_000n })
    }
  }
  for (const disc of discounts) {
    if (disc.kind === 'amount') {
      const m = monthlyFraction(BigInt(disc.amount), disc.interval, disc.intervalCount)
      total = add(total, { n: -m.n, d: m.d })
    }
  }
  const r = roundHalfAway(total)
  return r > 0 ? r : 0
}

/** "12.5" → 1250 basis points, exactly (up to 2 decimals; more is rounded half up). */
export function percentToBasisPoints(pct: string): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(pct.trim())
  if (!m) return 0
  const whole = Number(m[1])
  const frac = (m[2] ?? '').padEnd(3, '0')
  let bp = whole * 100 + Number(frac.slice(0, 2))
  if (Number(frac[2]) >= 5) bp += 1
  return Math.min(10_000, bp)
}
