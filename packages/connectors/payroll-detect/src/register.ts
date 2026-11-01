// Payroll register upload (CSV) → PayrollRun events (MASTER.md §5 "payroll report upload").
//
// Accepts the exports payroll tools produce (Gusto "Payroll journal", ADP "Payroll register", Rippling, Justworks,
// or a hand-made sheet): either one row per person per pay date, or one summary row per run. Headers are matched by
// alias, so column order and naming vary freely. Deterministic: the same file yields the same events and ids, and
// a corrected re-upload of the same pay date replaces the earlier run (same externalId).
import type { ConnectionId, Currency, IsoDate, Money, PayrollRun } from '@agfn/contracts'
import { normalizeCurrency, toMinor } from '@agfn/connector-sdk'

type Field =
  | 'payDate'
  | 'periodStart'
  | 'periodEnd'
  | 'person'
  | 'firstName'
  | 'lastName'
  | 'kind'
  | 'gross'
  | 'net'
  | 'employeeTaxes'
  | 'employerTaxes'
  | 'benefits'
  | 'reimbursements'
  | 'currency'

const ALIASES: Record<Field, string[]> = {
  payDate: ['checkdate', 'paydate', 'paymentdate', 'paycheckdate', 'payday', 'date', 'checkdt'],
  periodStart: ['payperiodstart', 'periodstart', 'periodbegin', 'payperiodbegin', 'startdate', 'periodfrom', 'payperiodstartdate'],
  periodEnd: ['payperiodend', 'periodend', 'payperiodenddate', 'enddate', 'periodto'],
  person: ['employee', 'employeename', 'name', 'worker', 'workername', 'fullname', 'payee', 'contractor', 'contractorname'],
  firstName: ['firstname', 'givenname'],
  lastName: ['lastname', 'surname', 'familyname'],
  kind: ['type', 'workertype', 'employmenttype', 'employeetype', 'classification'],
  gross: ['grosspay', 'gross', 'grossearnings', 'totalearnings', 'grosswages', 'grossamount', 'totalgross'],
  net: ['netpay', 'net', 'netamount', 'takehome', 'netwages', 'totalnet', 'netcheck'],
  employeeTaxes: ['employeetaxes', 'eetaxes', 'taxeswithheld', 'employeetax', 'withholdings', 'employeewithholdings', 'totalemployeetaxes'],
  employerTaxes: ['employertaxes', 'ertaxes', 'companytaxes', 'employertax', 'totalemployertaxes'],
  benefits: ['employerbenefits', 'erbenefits', 'companycontributions', 'employercontributions', 'companybenefits', 'employerbenefitcontributions'],
  reimbursements: ['reimbursements', 'reimbursement', 'expensereimbursements'],
  currency: ['currency', 'currencycode'],
}

export interface RegisterOptions {
  connectionId: ConnectionId
  /** Used when the file has no currency column. */
  currency: Currency
  /** How to read slash dates like 03/04/2026. Default 'mdy' (US). */
  dateOrder?: 'mdy' | 'dmy'
  provider?: string
  /** Decimal separator used in the file. Default '.'; with ',' amounts like "10.000,50" are read as 10000.50. */
  decimal?: '.' | ','
  /** Raw record id of the stored upload, set as rawRef on every event. */
  rawRef?: string
}

export interface RegisterIssue {
  row: number
  message: string
}

export interface RegisterResult {
  runs: PayrollRun[]
  issues: RegisterIssue[]
  /** Which column each field was read from, so the UI can show "read Gross pay as gross". */
  columns: Partial<Record<Field, string>>
  rowsRead: number
}

export class RegisterError extends Error {
  override name = 'RegisterError'
}

export function parsePayrollRegister(csv: string, opts: RegisterOptions): RegisterResult {
  const table = parseCsv(csv)
  const headerIdx = table.findIndex((r) => r.filter((c) => c.trim() !== '').length >= 2)
  if (headerIdx < 0) throw new RegisterError('the file has no header row')
  const header = table[headerIdx] as string[]
  const columns: Partial<Record<Field, string>> = {}
  const index: Partial<Record<Field, number>> = {}
  const norm = header.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''))
  for (const f of Object.keys(ALIASES) as Field[]) {
    // Exact alias first, in alias priority order; then "contains" for long headers like "Gross Pay (USD)".
    let i = -1
    for (const a of ALIASES[f]) {
      i = norm.findIndex((h, j) => h === a && !Object.values(index).includes(j))
      if (i >= 0) break
    }
    if (i < 0 && f !== 'payDate' && f !== 'person' && f !== 'net' && f !== 'kind' && f !== 'currency') {
      for (const a of ALIASES[f]) {
        if (a.length < 5) continue
        i = norm.findIndex((h, j) => h.includes(a) && !Object.values(index).includes(j))
        if (i >= 0) break
      }
    }
    if (i >= 0) {
      index[f] = i
      columns[f] = header[i] as string
    }
  }
  if (index.payDate === undefined) throw new RegisterError('no pay date column (looked for "Check date", "Pay date", "Payment date")')
  if (index.gross === undefined) throw new RegisterError('no gross pay column (looked for "Gross pay", "Gross", "Total earnings")')
  if (index.net === undefined) throw new RegisterError('no net pay column (looked for "Net pay", "Net")')

  const issues: RegisterIssue[] = []
  const perPerson = index.person !== undefined || index.firstName !== undefined || index.lastName !== undefined
  interface Acc {
    payDate: IsoDate
    periodStart?: IsoDate
    periodEnd?: IsoDate
    currency: Currency
    gross: number
    net: number
    employeeTaxes: number
    employerTaxes: number
    benefits: number
    reimbursements: number
    lines: NonNullable<PayrollRun['lines']>
    employees: Set<string>
  }
  const runs = new Map<string, Acc>()
  let rowsRead = 0

  for (let r = headerIdx + 1; r < table.length; r++) {
    const row = table[r] as string[]
    const rowNo = r + 1
    if (row.every((c) => c.trim() === '')) continue
    const cell = (f: Field): string => (index[f] === undefined ? '' : (row[index[f] as number] ?? '').trim())
    const person = perPerson ? (cell('person') || `${cell('firstName')} ${cell('lastName')}`.trim()) : ''
    if (/^(grand\s+)?totals?\b|^summary$/i.test(person) || /^(grand\s+)?totals?\b/i.test(cell('payDate'))) continue
    const payDate = parseDate(cell('payDate'), opts.dateOrder ?? 'mdy')
    if (!payDate) {
      issues.push({ row: rowNo, message: `can't read the pay date "${cell('payDate')}"` })
      continue
    }
    const currency = index.currency !== undefined && cell('currency') ? normalizeCurrency(cell('currency'), opts.currency) : opts.currency
    const amt = (f: Field, required: boolean): number | null => {
      const v = cell(f)
      if (v === '' || v === '-') {
        if (required) issues.push({ row: rowNo, message: `${columns[f] ?? f} is empty` })
        return required ? null : 0
      }
      try {
        return toMinor(v, currency, { decimal: opts.decimal ?? '.' })
      } catch {
        issues.push({ row: rowNo, message: `can't read ${columns[f] ?? f} "${v}" as an amount` })
        return null
      }
    }
    const gross = amt('gross', true)
    const net = amt('net', true)
    const eeTax = amt('employeeTaxes', false)
    const erTax = amt('employerTaxes', false)
    const benefits = amt('benefits', false)
    const reimb = amt('reimbursements', false)
    if (gross === null || net === null || eeTax === null || erTax === null || benefits === null || reimb === null) continue
    if (net > gross + reimb) issues.push({ row: rowNo, message: `net pay is more than gross pay${person ? ` for ${person}` : ''}` })
    if (gross < 0 || net < 0) issues.push({ row: rowNo, message: 'negative pay amounts (a correction?) were included as given' })

    const periodStart = parseDate(cell('periodStart'), opts.dateOrder ?? 'mdy') ?? undefined
    const periodEnd = parseDate(cell('periodEnd'), opts.dateOrder ?? 'mdy') ?? undefined
    const key = `${payDate}|${periodStart ?? ''}|${periodEnd ?? ''}|${currency}`
    let acc = runs.get(key)
    if (!acc) {
      acc = { payDate, currency, gross: 0, net: 0, employeeTaxes: 0, employerTaxes: 0, benefits: 0, reimbursements: 0, lines: [], employees: new Set() }
      if (periodStart) acc.periodStart = periodStart
      if (periodEnd) acc.periodEnd = periodEnd
      runs.set(key, acc)
    }
    acc.gross += gross
    acc.net += net
    acc.employeeTaxes += eeTax
    acc.employerTaxes += erTax
    acc.benefits += benefits
    acc.reimbursements += reimb
    if (person) {
      const kind = /contract|1099|freelanc/i.test(cell('kind')) ? 'contractor' : 'employee'
      acc.lines.push({ person, gross: { minor: gross, currency }, net: { minor: net, currency }, kind })
      if (kind === 'employee') acc.employees.add(person.toLowerCase())
    }
    rowsRead++
  }

  const out: PayrollRun[] = []
  for (const a of [...runs.values()].sort((x, y) => (x.payDate < y.payDate ? -1 : x.payDate > y.payDate ? 1 : 0))) {
    const m = (minor: number): Money => ({ minor, currency: a.currency })
    const run: PayrollRun = {
      type: 'payroll.run',
      externalId: `register:${a.payDate}:${a.periodStart ?? ''}:${a.periodEnd ?? ''}:${a.currency}`,
      connectionId: opts.connectionId,
      payDate: a.payDate,
      gross: m(a.gross),
      employerTaxes: m(a.employerTaxes),
      net: m(a.net),
      source: 'register_upload',
      estimated: false,
      status: 'paid',
    }
    if (opts.rawRef !== undefined) run.rawRef = opts.rawRef
    if (opts.provider !== undefined) run.provider = opts.provider
    if (a.periodStart) run.periodStart = a.periodStart
    if (a.periodEnd) run.periodEnd = a.periodEnd
    if (index.employeeTaxes !== undefined) run.employeeTaxes = m(a.employeeTaxes)
    if (index.benefits !== undefined) run.employerBenefits = m(a.benefits)
    if (index.reimbursements !== undefined) run.reimbursements = m(a.reimbursements)
    // What leaves the bank: net + all taxes (employee withholding is remitted by the provider) + benefits + reimbursements.
    if (index.employeeTaxes !== undefined && index.employerTaxes !== undefined) {
      run.companyDebit = m(a.net + a.employeeTaxes + a.employerTaxes + a.benefits + a.reimbursements)
    } else if (index.employerTaxes !== undefined) {
      // No withholding column: everything withheld from gross is still remitted, so the company pays gross + its own costs.
      run.companyDebit = m(a.gross + a.employerTaxes + a.benefits + a.reimbursements)
    }
    if (a.lines.length > 0) {
      run.lines = a.lines
      run.employeeCount = a.employees.size
    }
    out.push(run)
  }
  return { runs: out, issues, columns, rowsRead }
}

/** YYYY-MM-DD, YYYY/MM/DD, M/D/YYYY, M/D/YY (or D/M with dateOrder 'dmy'), and "Oct 9, 2026". */
export function parseDate(s: string, order: 'mdy' | 'dmy' = 'mdy'): IsoDate | null {
  const t = s.trim()
  if (!t) return null
  let y: number, mo: number, d: number
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(t)
  if (m) {
    y = Number(m[1])
    mo = Number(m[2])
    d = Number(m[3])
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t))) {
    const a = Number(m[1])
    const b = Number(m[2])
    ;[mo, d] = order === 'mdy' ? [a, b] : [b, a]
    y = Number(m[3])
    if (y < 100) y += 2000
  } else if ((m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t))) {
    const idx = MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase())
    if (idx < 0) return null
    mo = idx + 1
    d = Number(m[2])
    y = Number(m[3])
  } else return null
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt.toISOString().slice(0, 10)
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** RFC 4180 CSV: quoted fields, escaped quotes, CRLF/LF, BOM. Also accepts ; or tab delimited files. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const nl = src.search(/\r?\n/)
  const firstLine = nl < 0 ? src : src.slice(0, nl)
  const delim = [',', ';', '\t'].map((d) => [d, countOutsideQuotes(firstLine, d)] as const).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delim) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  if (quoted) throw new RegisterError('the file ends inside a quoted field')
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0
  let q = false
  for (const ch of line) {
    if (ch === '"') q = !q
    else if (!q && ch === d) n++
  }
  return n
}
