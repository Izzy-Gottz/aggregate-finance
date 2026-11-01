const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** "just now", "5m ago", "2h ago", "yesterday", "Oct 2". `now` is injectable for tests and screenshots. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const d = now - t
  if (d < MIN) return 'just now'
  if (d < HOUR) return `${Math.floor(d / MIN)} min ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  if (d < 2 * DAY) return 'yesterday'
  return shortDate(iso)
}

export function shortDate(iso: string, withYear = false): string {
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00Z' : iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' })
}

/** Whole days from `now` until an ISO date; negative = in the past. */
export function daysUntil(isoDate: string, now: number = Date.now()): number {
  const t = Date.parse(isoDate.length === 10 ? isoDate + 'T12:00:00Z' : isoDate)
  return Math.round((t - now) / DAY)
}

export function dueWords(isoDate: string, now: number = Date.now()): { text: string; tone: 'red' | 'amber' | 'grey' } {
  const n = daysUntil(isoDate, now)
  if (n < 0) return { text: `${-n} ${-n === 1 ? 'day' : 'days'} overdue`, tone: 'red' }
  if (n === 0) return { text: 'due today', tone: 'amber' }
  if (n <= 7) return { text: `due in ${n} ${n === 1 ? 'day' : 'days'}`, tone: 'amber' }
  return { text: `due ${shortDate(isoDate)}`, tone: 'grey' }
}
