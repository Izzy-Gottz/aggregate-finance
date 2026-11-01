// Calendar days in the company's own timezone. Accounting systems bucket by the company's
// local date, so "this month" has to be computed there, not in UTC (near midnight on the
// 1st, UTC is already in the next month for US companies and still in the last for Asia-Pacific).

/** YYYY-MM-DD for `now` in an IANA timezone. An unknown or missing zone falls back to UTC. */
export function localDay(now: number, timeZone?: string): string {
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now))
    } catch {
      // RangeError: not a zone this runtime knows.
    }
  }
  return new Date(now).toISOString().slice(0, 10)
}

/** This month so far (from the 1st to `today`) followed by the `months` full months before it. */
export function monthPeriods(today: string, months: number): Array<{ from: string; to: string }> {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7)) - 1
  const periods = [{ from: day(y, m, 1), to: today }]
  for (let i = 1; i <= months; i++) periods.push({ from: day(y, m - i, 1), to: day(y, m - i + 1, 0) })
  return periods
}

/** Date.UTC normalizes month/day overflow, so (2026, -1, 1) is 2025-12-01 and day 0 is the last day of the previous month. */
function day(y: number, m: number, d: number): string {
  return new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10)
}
