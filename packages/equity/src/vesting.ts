// Monthly vesting with a cliff, in whole shares. Each month vests floor(total × m / months) cumulatively, so rounding
// never loses or adds a share and the last month lands exactly on the total.

import type { IsoDate, Vesting } from './model.ts'

/** Whole calendar months from `start` to `asOf` (a month counts once its day-of-month is reached). */
export function monthsElapsed(start: IsoDate, asOf: IsoDate): number {
  const [y1, m1, d1] = start.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = asOf.split('-').map(Number) as [number, number, number]
  let m = (y2 - y1) * 12 + (m2 - m1)
  if (d2 < d1) m -= 1
  return Math.max(0, m)
}

export function vestedShares(total: number, v: Vesting | undefined, asOf: IsoDate): number {
  if (!v) return total
  if (asOf < v.start) return 0
  const m = Math.min(v.months, monthsElapsed(v.start, asOf))
  if (m < v.cliffMonths) return 0
  if (v.months <= 0) return total
  return Math.floor((total * m) / v.months)
}

export function vestingText(v: Vesting | undefined): string {
  if (!v) return 'fully vested'
  const years = v.months % 12 === 0 ? `${v.months / 12} ${v.months === 12 ? 'year' : 'years'}` : `${v.months} months`
  return v.cliffMonths ? `${years}, ${v.cliffMonths}-month cliff` : `${years}, monthly`
}

/** The month-by-month schedule (OCF `vestings`): dates and cumulative amounts, cliff month first. */
export function vestingSchedule(total: number, v: Vesting): Array<{ date: IsoDate; amount: number }> {
  const out: Array<{ date: IsoDate; amount: number }> = []
  let prev = 0
  for (let m = Math.max(1, v.cliffMonths); m <= v.months; m++) {
    const cum = Math.floor((total * m) / v.months)
    if (cum > prev) out.push({ date: addMonths(v.start, m), amount: cum - prev })
    prev = cum
  }
  return out
}

export function addMonths(date: IsoDate, n: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1 + n, 1))
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
  t.setUTCDate(Math.min(d, last))
  return t.toISOString().slice(0, 10)
}
