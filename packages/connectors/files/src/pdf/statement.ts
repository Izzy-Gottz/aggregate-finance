// A PDF statement from a known bank → account, rows and balances, only when it adds up. The layout (layouts.ts) says
// where the summary figures and the transaction sections are; this file reads them from the rebuilt lines and checks
// opening + rows = closing to the cent, and every section's printed total. A statement that doesn't reconcile is not
// imported: a missed or doubled row would be wrong money, so the person's AI reads it instead.
import type { AccountType, Money } from '@agfn/contracts'
import type { ClosingBalance, FileAccount, ParsedRow } from '../events.ts'
import type { PdfLine } from './lines.ts'
import { PDF_LAYOUTS, type Figure, type PdfLayout } from './layouts.ts'
import { parseDate, parseMoney, valid } from './values.ts'

export interface PdfStatement {
  layout: { id: string; label: string; institution: string; accountType: AccountType }
  account: FileAccount
  rows: ParsedRow[]
  /** Signed like the rows (owed on a card = negative). */
  opening: Money
  closing: ClosingBalance
  period: { from?: string; to: string }
}

export type PdfStatementResult = { ok: true; statement: PdfStatement } | { ok: false; layout?: string; reason: string; diffMinor?: number }

const ROW_DATE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/
const NAMED_DATE = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.? (\d{1,2})$/i
const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const isRowDate = (cell: string) => ROW_DATE.test(cell) || NAMED_DATE.test(cell)

/** A row's MM/DD, MM/DD/YY or "Sep 3" in the statement's period: a December row in a January statement is last year. */
function rowDate(cell: string, to: string): string | null {
  const [ty, tm] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))]
  const named = NAMED_DATE.exec(cell)
  if (named) {
    const mo = MON.indexOf(named[1]!.slice(0, 3).toLowerCase()) + 1
    return valid(mo > tm ? ty - 1 : ty, mo, Number(named[2]))
  }
  const m = ROW_DATE.exec(cell)
  if (!m) return null
  if (m[3]) return parseDate(cell)
  const mo = Number(m[1])
  return valid(mo > tm ? ty - 1 : ty, mo, Number(m[2]))
}

/** A summary figure: the amount after its label, or the layout's own reader. */
function figure(f: Figure, text: string, lines: PdfLine[]): number | null {
  return typeof f === 'function' ? f(lines) : amountAfter(f, text)
}

const lineText = (l: PdfLine) => l.cells.map((c) => c.text).join(' ')

/** Which known layout this statement is, if exactly one matches. */
export function detectLayout(lines: PdfLine[]): PdfLayout | 'ambiguous' | null {
  const head = lines.filter((l) => l.page <= 2).map(lineText).join('\n')
  const hits = PDF_LAYOUTS.filter((l) => l.match.every((r) => r.test(head)))
  return hits.length === 1 ? hits[0]! : hits.length > 1 ? 'ambiguous' : null
}

export function parsePdfStatement(lines: PdfLine[]): PdfStatementResult {
  const layout = detectLayout(lines)
  if (!layout) return { ok: false, reason: 'not a statement layout we know' }
  if (layout === 'ambiguous') return { ok: false, reason: 'looks like more than one bank’s statement' }
  const text = lines.map(lineText).join('\n')
  const fail = (reason: string, diffMinor?: number): PdfStatementResult => ({ ok: false, layout: layout.id, reason, ...(diffMinor !== undefined ? { diffMinor } : {}) })

  const period = layout.period(text)
  if (!period) return fail('no statement period')
  const last4 = layout.account.exec(text)?.[1]?.replace(/\D/g, '').slice(-4)
  if (!last4 || last4.length !== 4) return fail('no account number')
  const openAmt = figure(layout.opening, text, lines)
  const closeAmt = figure(layout.closing, text, lines)
  if (openAmt === null || closeAmt === null) return fail('no opening or closing balance')

  // Cards print what is owed (positive); our balances are signed like money (owed = negative).
  const card = layout.accountType === 'credit_card'
  const opening = card ? -openAmt : openAmt
  const closingMinor = card ? -closeAmt : closeAmt

  const rows: ParsedRow[] = []
  let section: PdfLayout['sections'][number] | null = null
  let sectionRows: ParsedRow[] = []
  let lastRow: ParsedRow | null = null
  let continued = 0
  const sectionTotals: Array<{ name: string; printed: number; rows: ParsedRow[] }> = []
  // Rows since each section's last printed total, by section name. A section can restart before its total: Capital One
  // prints one "Transactions" list per card holder, then a single "Total Transactions for This Period" for all of them.
  const pending = new Map<string, ParsedRow[]>()
  let cols: Columns = null
  const closeSection = () => {
    section = null
    lastRow = null
  }

  for (const [i, l] of lines.entries()) {
    const t = lineText(l)
    const starts = layout.sections.find((s) => s.start.test(t))
    if (starts) {
      closeSection()
      section = starts
      sectionRows = pending.get(starts.name) ?? []
      pending.set(starts.name, sectionRows)
      continue
    }
    if (!section) continue
    const s: PdfLayout['sections'][number] = section
    if (s.total?.test(t)) {
      const printed = amountAfter(s.total, t)
      if (printed !== null) sectionTotals.push({ name: s.name, printed: Math.abs(printed), rows: sectionRows })
      pending.delete(s.name)
      closeSection()
      continue
    }
    if (s.end?.test(t) || layout.stop?.test(t)) {
      closeSection()
      continue
    }
    // A money-in / money-out table: its header line says where each column is.
    if (s.sign === 'columns' && s.columns) {
      const at = (re: RegExp) => l.cells.find((c) => re.test(c.text))?.x
      const [xin, xout] = [at(s.columns.in), at(s.columns.out)]
      if (xin !== undefined && xout !== undefined) {
        const xbal = s.columns.balance ? at(s.columns.balance) : undefined
        cols = { in: xin, out: xout, ...(xbal !== undefined ? { balance: xbal } : {}) }
        continue
      }
    }
    if (layout.skip?.some((r) => r.test(t))) continue
    const parsed = rowsOf(l, i, s, layout, period.to, cols)
    if (parsed.length) {
      for (const r of parsed) {
        rows.push(r)
        sectionRows.push(r)
      }
      lastRow = parsed[parsed.length - 1]!
      continued = 0
    } else if (l.cells.some((c) => parseMoney(c.text) !== null || ENDS_IN_AMOUNT.test(c.text))) {
      // An amount on a line that isn't a row (a card holder's subtotal): what follows doesn't belong to the last row.
      lastRow = null
    } else if (lastRow && continued < 3) {
      // A merchant name that wrapped onto the next line.
      lastRow.description = `${lastRow.description ?? ''} ${t}`.trim().slice(0, 300)
      continued++
    }
  }

  if (!rows.length) return fail('no transactions found')
  for (const st of sectionTotals) {
    const sum = st.rows.reduce((a, r) => a + Math.abs(r.amount.minor), 0)
    if (sum !== st.printed) return fail(`${st.name} rows don’t add up to the printed total`, st.printed - sum)
  }
  const sum = rows.reduce((a, r) => a + r.amount.minor, 0)
  if (opening + sum !== closingMinor) return fail('opening balance plus the rows isn’t the closing balance', closingMinor - (opening + sum))

  const usd = (minor: number): Money => ({ minor, currency: 'USD' })
  const account: FileAccount = {
    externalId: `pdf:${layout.institution.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${layout.accountType}:${last4}`,
    name: `${layout.accountName} ••${last4}`,
    accountType: layout.accountType,
    currency: 'USD',
    mask: last4,
    institution: layout.institution,
    source: { layout: layout.id, period },
  }
  return {
    ok: true,
    statement: {
      layout: { id: layout.id, label: layout.label, institution: layout.institution, accountType: layout.accountType },
      account,
      rows,
      opening: usd(opening),
      closing: { current: usd(closingMinor), at: `${period.to}T23:59:59.000Z`, date: period.to },
      period,
    },
  }
}

/** The first amount after a label match: "Beginning Balance $1,234.56". */
/**
 * The amount printed right after a label. The first mention isn't always the figure: Capital One's summary box puts
 * "New Balance" in a heading row of other labels before the "New Balance = $…" line. So each mention is tried in order
 * and the first one followed by an amount wins.
 */
/** A cell that ends in an amount, e.g. "TRANSACTIONS THIS CYCLE (CARD 4321) $135.25". */
const ENDS_IN_AMOUNT = /\s[-+(]?\$?\s?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?$|\s[-+(]?\$?\s?-?\d+\.\d{2}\)?-?$/

function amountAfter(re: RegExp, text: string): number | null {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (const m of text.matchAll(all)) {
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 60)
    const a = /^[\s:=]*([-+(]?\s*\$?\s*-?\d{1,3}(?:,\d{3})*\.\d{2}\)?-?|[-+(]?\s*\$?\s*-?\d+\.\d{2}\)?-?)/.exec(rest)
    if (a) return parseMoney(a[1]!)
  }
  return null
}

/** One line → its rows (a line can hold two, side by side, like a bank's check list). */
type Columns = { in: number; out: number; balance?: number } | null

function rowsOf(l: PdfLine, index: number, s: PdfLayout['sections'][number], layout: PdfLayout, to: string, cols: Columns = null): ParsedRow[] {
  // "09/03 Coffee Shop" set close together arrives as one cell: split the date off.
  const cells = l.cells.flatMap((c) => {
    const m = /^(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.? \d{1,2}) (.+)$/i.exec(c.text)
    return m ? [{ x: c.x, text: m[1]! }, { x: c.x + 1, text: m[2]! }] : [c]
  })
  if (!rowDate(cells[0]?.text ?? '', to)) return []
  // A second date starts a second row only once the first has its amount; before that it is the posting date.
  const starts = [0]
  let priced = false
  for (const [i, c] of cells.entries()) {
    if (i === 0) continue
    if (priced && rowDate(c.text, to)) {
      starts.push(i)
      priced = false
    } else if (parseMoney(c.text) !== null) priced = true
  }
  const out: ParsedRow[] = []
  for (const [k, st] of starts.entries()) {
    const seg = cells.slice(st, starts[k + 1] ?? cells.length)
    const date = rowDate(seg[0]!.text, to)!
    const rest = seg.slice(1)
    const money = rest.map((c) => parseMoney(c.text))
    const idx = money.flatMap((v, i) => (v !== null ? [i] : []))
    const pick = s.sign === 'columns' ? idx.find((i) => ['in', 'out'].includes(columnOf(rest[i]!.x, cols) ?? '')) : s.balanceColumn ? idx[idx.length - 2] : idx[idx.length - 1]
    if (pick === undefined) continue
    const printed = money[pick]!
    // A trailing posting/reference date column ("09/04") isn't part of the description.
    const description = rest.filter((c, i) => money[i] === null && !isRowDate(c.text)).map((c) => c.text).join(' ').slice(0, 300)
    let signed: number
    if (s.sign === 'columns') {
      // Under which header does this amount sit? A row without a known column isn't guessed.
      const side = columnOf(rest[pick]!.x, cols)
      if (side !== 'in' && side !== 'out') continue
      signed = side === 'in' ? Math.abs(printed) : -Math.abs(printed)
    } else signed = s.sign === 'in' ? Math.abs(printed) : s.sign === 'out' ? -Math.abs(printed) : layout.printedPositiveIs === 'out' ? -printed : printed
    out.push({ line: index + 1, kind: 'txn', date, amount: { minor: signed, currency: 'USD' }, status: 'posted', ...(description ? { description } : {}), cells: seg.map((c) => c.text) })
  }
  return out
}

/** The column an amount at `x` belongs to: the nearest header, if it is within reach. */
function columnOf(x: number, cols: Columns): 'in' | 'out' | 'balance' | null {
  if (!cols) return null
  const sides = (Object.entries(cols) as Array<['in' | 'out' | 'balance', number]>).map(([k, hx]) => [k, Math.abs(hx - x)] as const).sort((a, b) => a[1] - b[1])
  const [best] = sides
  return best && best[1] < 60 ? best[0] : null
}
