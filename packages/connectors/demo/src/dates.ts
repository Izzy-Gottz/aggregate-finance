export const DAY = 86_400_000

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10)
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY)
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay()
}

export function dayOfMonth(date: string): number {
  return Number(date.slice(8, 10))
}

export function lastDayOfMonth(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
}

export function isMonthEnd(date: string): boolean {
  return lastDayOfMonth(date) === date
}

export function monthKey(date: string): string {
  return date.slice(0, 7)
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}
