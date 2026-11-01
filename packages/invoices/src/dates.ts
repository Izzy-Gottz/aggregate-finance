// Calendar-day math on ISO dates (YYYY-MM-DD) in UTC, so time zones never shift a due date.
import type { IsoDate } from '@agfn/contracts'

const DAY = 86_400_000

export function toDay(d: IsoDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d)
  if (!m) throw new RangeError(`not an ISO date: ${d}`)
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const back = new Date(t)
  if (back.getUTCDate() !== Number(m[3])) throw new RangeError(`not a calendar date: ${d}`)
  return Math.floor(t / DAY)
}

export function fromDay(n: number): IsoDate {
  return new Date(n * DAY).toISOString().slice(0, 10)
}

/** Whole days from a to b (b − a). */
export function daysBetween(a: IsoDate, b: IsoDate): number {
  return toDay(b) - toDay(a)
}

export function addDays(d: IsoDate, n: number): IsoDate {
  return fromDay(toDay(d) + n)
}

export function isIsoDate(d: unknown): d is IsoDate {
  if (typeof d !== 'string') return false
  try {
    toDay(d)
    return true
  } catch {
    return false
  }
}
