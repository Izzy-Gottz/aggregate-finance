// Statement date formats. A format names the field order and separator; month/day may be 1 or 2 digits.
// Parsing is strict: an impossible date (31.02.2026) or a wrong shape returns undefined, never a guess.

export type DateFormat =
  | 'YYYY-MM-DD'
  | 'YYYY/MM/DD'
  | 'YYYYMMDD'
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'MM-DD-YYYY'
  | 'DD-MM-YYYY'
  | 'DD.MM.YYYY'
  | 'M/D/YY'
  | 'D/M/YY'
  | 'D.M.YY'
  | 'DD MMM YYYY'
  | 'MMM D, YYYY'

interface Spec {
  re: RegExp
  y: number
  m: number
  d: number
  twoDigitYear?: boolean
  monthName?: boolean
}

const SPECS: Record<DateFormat, Spec> = {
  'YYYY-MM-DD': { re: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, y: 1, m: 2, d: 3 },
  'YYYY/MM/DD': { re: /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/, y: 1, m: 2, d: 3 },
  YYYYMMDD: { re: /^(\d{4})(\d{2})(\d{2})$/, y: 1, m: 2, d: 3 },
  'MM/DD/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, y: 3, m: 1, d: 2 },
  'DD/MM/YYYY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, y: 3, m: 2, d: 1 },
  'MM-DD-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, y: 3, m: 1, d: 2 },
  'DD-MM-YYYY': { re: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, y: 3, m: 2, d: 1 },
  'DD.MM.YYYY': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/, y: 3, m: 2, d: 1 },
  'M/D/YY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, y: 3, m: 1, d: 2, twoDigitYear: true },
  'D/M/YY': { re: /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/, y: 3, m: 2, d: 1, twoDigitYear: true },
  'D.M.YY': { re: /^(\d{1,2})\.(\d{1,2})\.(\d{2})$/, y: 3, m: 2, d: 1, twoDigitYear: true },
  'DD MMM YYYY': { re: /^(\d{1,2})[ -]([a-z]{3,4})\.?[ -](\d{4})$/, y: 3, m: 2, d: 1, monthName: true },
  'MMM D, YYYY': { re: /^([a-z]{3,9})\.? (\d{1,2}),? (\d{4})$/, y: 3, m: 1, d: 2, monthName: true },
}

export const DATE_FORMATS = Object.keys(SPECS) as DateFormat[]

/** Pairs that read the same strings with month and day swapped. */
const SWAPPED: Array<[DateFormat, DateFormat]> = [
  ['MM/DD/YYYY', 'DD/MM/YYYY'],
  ['M/D/YY', 'D/M/YY'],
  ['MM-DD-YYYY', 'DD-MM-YYYY'],
]

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, mrz: 3, apr: 4, may: 5, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, okt: 10, nov: 11, dec: 12, dez: 12,
}

export function isDateFormat(v: unknown): v is DateFormat {
  return typeof v === 'string' && v in SPECS
}

/** "01/05/2026" + 'MM/DD/YYYY' → "2026-01-05". Trailing time ("2026-01-05 13:22", "…T13:22:00Z") is ignored. */
export function parseDate(raw: string, format: DateFormat): string | undefined {
  const spec = SPECS[format]
  let s = raw.trim().replace(/^'/, '')
  if (spec.monthName) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  else s = s.split(/[ T]/)[0] ?? ''
  const m = spec.re.exec(s)
  if (!m) return undefined
  let year = Number(m[spec.y])
  if (spec.twoDigitYear) year += year < 70 ? 2000 : 1900
  const monthRaw = m[spec.m] ?? ''
  const month = spec.monthName ? MONTHS[monthRaw.slice(0, 3)] ?? MONTHS[monthRaw] : Number(monthRaw)
  const day = Number(m[spec.d])
  if (!month || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export interface DateDetection {
  format: DateFormat
  /** Month/day order could not be decided from the samples (every day ≤ 12). */
  ambiguous: boolean
}

/** The format that parses every non-empty sample. Day-first wins ties when `preferDayFirst` (European exports). */
export function detectDateFormat(samples: string[], preferDayFirst = false): DateDetection | undefined {
  const values = samples.map((s) => s.trim()).filter((s) => s !== '')
  if (!values.length) return undefined
  const ok = DATE_FORMATS.filter((f) => values.every((v) => parseDate(v, f) !== undefined))
  if (!ok.length) return undefined
  for (const [monthFirst, dayFirst] of SWAPPED) {
    if (ok.includes(monthFirst) && ok.includes(dayFirst)) {
      return { format: preferDayFirst ? dayFirst : monthFirst, ambiguous: true }
    }
  }
  return { format: ok[0] as DateFormat, ambiguous: false }
}
