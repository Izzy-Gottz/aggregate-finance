// Amounts and dates as US bank statements print them.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')

/** "$1,234.56", "-$12.00", "(12.00)", "12.00-", "12.00 CR", "+$5.00" → signed minor units (CR and brackets negative). */
export function parseMoney(s: string): number | null {
  s = s.replace(/\u2212/g, '-')
  const m = /^(-|\()?\s*\+?\s*\$?\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\s*(\)|-|CR)?$/i.exec(s.trim())
  if (!m) return null
  const minor = Number(m[3]!.replace(/,/g, '')) * 100 + Number(m[4])
  return m[1] || m[2] || m[5] ? -minor : minor
}

/** "September 30, 2026", "Sep 30, 2026", "09/30/26", "09/30/2026" → YYYY-MM-DD. "September 30" takes `year`. */
export function parseDate(s: string, year?: number): string | null {
  const t = s.trim().replace(/\s+/g, ' ')
  let m = /^([A-Za-z]{3,9})\.? (\d{1,2})(?:, (\d{4}))?$/.exec(t)
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase())
    const y = m[3] ? Number(m[3]) : year
    if (mo < 0 || !y) return null
    return valid(y, mo + 1, Number(m[2]))
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t)
  if (m) return valid(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[1]), Number(m[2]))
  return null
}

export function valid(y: number, mo: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null
}

