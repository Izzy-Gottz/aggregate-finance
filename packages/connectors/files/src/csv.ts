// CSV statements from any bank: an RFC 4180 parser (quotes, embedded delimiters and newlines, CRLF, BOM), delimiter
// and header detection (skipping bank preambles), a ColumnMapping that says how to read the columns, and
// suggestMapping() that guesses one from header names and sample values. Amounts go through the SDK's toMinor,
// which throws on anything ambiguous; we never guess an amount.

import type { AccountType, Money } from '@agfn/contracts'
import { isConnectorError, normalizeCurrency, toMinor } from '@agfn/connector-sdk'
import { detectDateFormat, isDateFormat, parseDate, type DateFormat } from './dates.ts'
import type { ParsedRow } from './events.ts'
import { invalid, normalizeLabel, sha256Hex } from './text.ts'

export type { DateFormat } from './dates.ts'

// ---------- RFC 4180 parsing ----------

export type Delimiter = ',' | ';' | '\t' | '|'
export const DELIMITERS: readonly Delimiter[] = [',', ';', '\t', '|']

export interface CsvRecord {
  /** 1-based physical line where the record starts. */
  line: number
  cells: string[]
}

export interface CsvTable {
  delimiter: Delimiter
  /** Non-blank records in file order. */
  records: CsvRecord[]
}

export interface ParseCsvOptions {
  delimiter?: Delimiter
}

/** Parse CSV text. Blank lines are dropped; line numbers are kept. An unterminated quote throws invalid_input. */
export function parseCsv(text: string, opts: ParseCsvOptions = {}): CsvTable {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const delimiter = opts.delimiter ?? detectDelimiter(clean)
  return { delimiter, records: parseRecords(clean, delimiter, Infinity, false) }
}

function parseRecords(text: string, delim: string, limit: number, lenient: boolean): CsvRecord[] {
  const out: CsvRecord[] = []
  let cells: string[] = []
  let field = ''
  let inQuotes = false
  let quotedField = false
  let line = 1
  let recordLine = 1
  let i = 0
  const n = text.length
  const endRecord = () => {
    cells.push(field)
    if (cells.some((c) => c.trim() !== '')) out.push({ line: recordLine, cells })
    cells = []
    field = ''
    quotedField = false
  }
  while (i < n) {
    const ch = text[i] as string
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      if (ch === '\n') line++
      if (ch === '\r' && text[i + 1] !== '\n') line++
      field += ch
      i++
      continue
    }
    if (ch === '"' && field.trim() === '' && !quotedField) {
      // Opening quote (leading spaces before it are dropped, as Excel does).
      field = ''
      inQuotes = true
      quotedField = true
      i++
      continue
    }
    if (ch === delim) {
      cells.push(field)
      field = ''
      quotedField = false
      i++
      continue
    }
    if (ch === '\r' || ch === '\n') {
      endRecord()
      if (ch === '\r' && text[i + 1] === '\n') i++
      i++
      line++
      recordLine = line
      if (out.length >= limit) return out
      continue
    }
    field += ch
    i++
  }
  if (inQuotes && !lenient) throw invalid(`unterminated quoted field starting on line ${recordLine}`, 'csv_unterminated_quote')
  if (field !== '' || cells.length) endRecord()
  return out
}

/** The delimiter that splits the most records into the same number (≥ 2) of fields. Ties keep , ; \t | order. */
export function detectDelimiter(text: string): Delimiter {
  const sample = text.slice(0, 64 * 1024)
  let best: Delimiter = ','
  let bestScore = -1
  for (const d of DELIMITERS) {
    const recs = parseRecords(sample, d, 60, true)
    const counts = new Map<number, number>()
    for (const r of recs) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1)
    let modal = 0
    let freq = 0
    for (const [len, f] of counts) if (f > freq || (f === freq && len > modal)) [modal, freq] = [len, f]
    const score = modal >= 2 ? freq * 1000 + modal : 0
    if (score > bestScore) [best, bestScore] = [d, score]
  }
  return best
}

// ---------- Column mapping ----------

/** A header name (matched exactly, then case/accent-insensitively) or a 0-based column index. */
export type ColumnRef = string | number

export type AmountMapping =
  /** One signed column. Bank exports are usually positive_is_in; card exports (Amex) usually positive_is_out. */
  | { kind: 'signed'; column: ColumnRef; convention: 'positive_is_in' | 'positive_is_out' }
  /** Separate debit (money out) and credit (money in) columns. */
  | { kind: 'split'; debit: ColumnRef; credit: ColumnRef }
  /** An unsigned amount plus a debit/credit marker column (German "Soll/Haben": S/H). */
  | { kind: 'indicator'; column: ColumnRef; indicator: ColumnRef; debitMarkers?: string[]; creditMarkers?: string[] }

export interface ColumnMapping {
  date: ColumnRef
  dateFormat: DateFormat
  amount: AmountMapping
  description?: ColumnRef
  counterparty?: ColumnRef
  category?: ColumnRef
  /** Running balance after each row. Read with the same sign convention as a signed amount. */
  balance?: ColumnRef
  /** Per-row currency column. */
  currency?: ColumnRef
  /** The bank's own transaction id; used as the stable id when present and unique in the file. */
  externalId?: ColumnRef
  /** Pending/posted. */
  status?: ColumnRef
  /** Decimal separator of amounts: '.' (1,234.56) or ',' (1.234,56). */
  decimal: '.' | ','
  /** Currency when there's no currency column (default: the account's currency). */
  defaultCurrency?: string
  /** Physical lines to skip before the header. Absent = detect the header automatically. */
  skipRows?: number
  /** Absent = detect. */
  delimiter?: Delimiter
  /** Default true. With false, every ColumnRef must be an index. */
  hasHeader?: boolean
}

const isRef = (v: unknown): v is ColumnRef => (typeof v === 'string' && v !== '') || (typeof v === 'number' && Number.isInteger(v) && v >= 0)
const optRef = (v: unknown) => v === undefined || isRef(v)

export function isColumnMapping(v: unknown): v is ColumnMapping {
  if (typeof v !== 'object' || v === null) return false
  const x = v as Record<string, unknown>
  const a = x.amount as Record<string, unknown> | undefined
  const amountOk =
    !!a &&
    ((a.kind === 'signed' && isRef(a.column) && (a.convention === 'positive_is_in' || a.convention === 'positive_is_out')) ||
      (a.kind === 'split' && isRef(a.debit) && isRef(a.credit)) ||
      (a.kind === 'indicator' && isRef(a.column) && isRef(a.indicator)))
  return (
    isRef(x.date) &&
    isDateFormat(x.dateFormat) &&
    amountOk &&
    (x.decimal === '.' || x.decimal === ',') &&
    ['description', 'counterparty', 'category', 'balance', 'currency', 'externalId', 'status'].every((k) => optRef(x[k])) &&
    (x.skipRows === undefined || (typeof x.skipRows === 'number' && Number.isInteger(x.skipRows) && x.skipRows >= 0)) &&
    (x.delimiter === undefined || DELIMITERS.includes(x.delimiter as Delimiter))
  )
}

/** sha256 of the normalized header names (lowercased, trimmed, joined): the key for saved import mappings. */
export function headerSignature(headers: string[]): string {
  return sha256Hex(headers.map((h) => h.trim().toLowerCase()).join('\u001f'))
}

// ---------- Header vocabulary ----------

const SYN = {
  date: ['posting date', 'posted date', 'post date', 'transaction date', 'trans. date', 'trans date', 'date', 'booking date',
    'buchungstag', 'buchungsdatum', 'datum', 'date operation', 'date de l operation', 'date comptable', 'fecha', 'fecha operacion',
    'boekdatum', 'value date', 'valuta', 'wertstellung', 'date de valeur'],
  amount: ['amount', 'amt', 'transaction amount', 'betrag', 'umsatz', 'montant', 'importe', 'bedrag', 'amount (usd)', 'betrag (eur)'],
  debit: ['debit', 'debits', 'debit amount', 'withdrawal', 'withdrawals', 'withdrawal amount', 'money out', 'paid out', 'outflow',
    'soll', 'ausgang', 'belastung', 'debit (eur)'],
  credit: ['credit', 'credits', 'credit amount', 'deposit', 'deposits', 'deposit amount', 'money in', 'paid in', 'inflow',
    'haben', 'eingang', 'gutschrift', 'credit (eur)'],
  indicator: ['soll/haben', 's/h', 'debit/credit', 'credit/debit', 'dr/cr', 'cr/dr'],
  balance: ['balance', 'running balance', 'running bal.', 'running bal', 'saldo', 'solde', 'kontostand', 'ledger balance'],
  currency: ['currency', 'currency code', 'wahrung', 'waehrung', 'devise', 'ccy', 'moneda'],
  category: ['category', 'kategorie', 'categorie', 'categoria'],
  status: ['status', 'transaction status'],
  externalId: ['transaction id', 'transaction reference', 'reference number', 'fitid', 'reference', 'ref', 'ref.', 'id'],
  counterparty: ['payee', 'merchant', 'merchant name', 'counterparty', 'name', 'beneficiary',
    'empfanger/zahlungspflichtiger', 'auftraggeber/zahlungsempfanger', 'beguenstigter/zahlungspflichtiger', 'zahlungsempfanger',
    'empfanger', 'auftraggeber', 'beneficiaire', 'tiers'],
  description: ['description', 'transaction description', 'memo', 'narrative', 'particulars', 'details', 'transaction details',
    'verwendungszweck', 'buchungstext', 'vorgang/verwendungszweck', 'beschreibung', 'libelle', 'libelle operation', 'concepto',
    'omschrijving'],
} satisfies Record<string, string[]>

type Field = keyof typeof SYN
const ALL_SYNONYMS = new Set(Object.values(SYN).flat())

function findColumn(headers: string[], field: Field, used: Set<number>): { index: number; fuzzy: boolean } | undefined {
  const norm = headers.map(normalizeLabel)
  for (const syn of SYN[field]) {
    const i = norm.findIndex((h, idx) => !used.has(idx) && h === syn)
    if (i >= 0) return { index: i, fuzzy: false }
  }
  for (const syn of SYN[field]) {
    if (syn.length < 4) continue
    const i = norm.findIndex((h, idx) => !used.has(idx) && (h.startsWith(syn + ' ') || h.startsWith(syn + '(')))
    if (i >= 0) return { index: i, fuzzy: true }
  }
  return undefined
}

/** Index of the header record: the first with ≥ 2 known column names, else the first all-text record of modal width. */
export function findHeaderIndex(records: CsvRecord[]): number {
  const scan = records.slice(0, 40)
  for (let i = 0; i < scan.length; i++) {
    const hits = (scan[i] as CsvRecord).cells.filter((c) => ALL_SYNONYMS.has(normalizeLabel(c))).length
    if (hits >= 2) return i
  }
  const counts = new Map<number, number>()
  for (const r of scan) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1)
  let modal = 0
  let freq = 0
  for (const [len, f] of counts) if (f > freq) [modal, freq] = [len, f]
  const looksLikeValue = (c: string) => /^[\s$€£(+-]*[\d.,]+[)\s]*$/.test(c) || /\d{1,4}[./-]\d{1,2}[./-]\d{1,4}/.test(c)
  const i = scan.findIndex((r) => r.cells.length >= modal && r.cells.every((c) => c.trim() !== '' && !looksLikeValue(c)))
  return i >= 0 ? i : 0
}

// ---------- suggestMapping ----------

export interface MappingSuggestion {
  /** Null when no date or amount column could be found. */
  mapping: ColumnMapping | null
  /** 0..1. Below ~0.7, ask the person to confirm the mapping. */
  confidence: number
  reasons: string[]
}

export interface SuggestHints {
  accountType?: AccountType
  delimiter?: Delimiter
}

const PAYMENT_ROW = /\b(thank you|autopay|auto pay|payment received)\b/i

/** Guess a mapping from header names and a few sample rows. Explains every decision in `reasons`. */
export function suggestMapping(headers: string[], sampleRows: string[][], hints: SuggestHints = {}): MappingSuggestion {
  const reasons: string[] = []
  let confidence = 1
  const used = new Set<number>()
  const take = (field: Field) => {
    const hit = findColumn(headers, field, used)
    if (!hit) return undefined
    used.add(hit.index)
    if (hit.fuzzy) confidence -= 0.05
    reasons.push(`${field}: column "${headers[hit.index]}"${hit.fuzzy ? ' (partial name match)' : ''}`)
    return hit.index
  }
  const col = (i: number) => sampleRows.map((r) => r[i] ?? '')

  const date = take('date')
  if (date === undefined) return { mapping: null, confidence: 0, reasons: [...reasons, 'no date column found'] }

  const amount = take('amount')
  const indicator = take('indicator')
  const debit = amount === undefined ? take('debit') : undefined
  const credit = amount === undefined ? take('credit') : undefined
  const balance = take('balance')

  const amountCells = [amount, debit, credit, balance].filter((i): i is number => i !== undefined).flatMap(col)
  const dec = detectDecimal(amountCells, hints.delimiter)
  reasons.push(dec.reason)
  confidence -= dec.penalty

  const dates = detectDateFormat(col(date), dec.decimal === ',')
  if (!dates) {
    return { mapping: null, confidence: 0, reasons: [...reasons, `no date format matches the samples in "${headers[date]}"`] }
  }
  if (dates.ambiguous) {
    confidence -= 0.25
    reasons.push(`date format ${dates.format}: every sample day is ≤ 12, so month/day order is a guess`)
  } else reasons.push(`date format ${dates.format}`)

  let amountMapping: AmountMapping
  if (amount !== undefined) {
    const values = col(amount).filter((v) => v.trim() !== '')
    const anyNegative = values.some((v) => /^\s*(-|\()|-\s*$/.test(v))
    if (indicator !== undefined && !anyNegative) {
      amountMapping = { kind: 'indicator', column: headers[amount] as string, indicator: headers[indicator] as string }
      reasons.push(`amounts are unsigned; direction comes from "${headers[indicator]}"`)
    } else {
      const convention = signConvention(sampleRows, amount, hints, reasons)
      if (convention.guessed) confidence -= 0.2
      amountMapping = { kind: 'signed', column: headers[amount] as string, convention: convention.value }
    }
  } else if (debit !== undefined && credit !== undefined) {
    amountMapping = { kind: 'split', debit: headers[debit] as string, credit: headers[credit] as string }
    reasons.push('separate debit and credit columns')
  } else {
    return { mapping: null, confidence: 0, reasons: [...reasons, 'no amount column (or debit + credit pair) found'] }
  }

  const currency = take('currency')
  const status = take('status')
  const category = take('category')
  let externalId = take('externalId')
  if (externalId !== undefined && !looksLikeIds(col(externalId))) {
    reasons.push(`"${headers[externalId]}" doesn't look like unique transaction ids; not used as the id`)
    used.delete(externalId)
    externalId = undefined
  }
  const counterparty = take('counterparty')
  const description = take('description')
  if (description === undefined && counterparty === undefined) {
    confidence -= 0.1
    reasons.push('no description column')
  }

  const name = (i: number | undefined) => (i === undefined ? undefined : (headers[i] as string))
  const mapping: ColumnMapping = {
    date: headers[date] as string,
    dateFormat: dates.format,
    amount: amountMapping,
    decimal: dec.decimal,
    ...(name(description) ? { description: name(description) } : {}),
    ...(name(counterparty) ? { counterparty: name(counterparty) } : {}),
    ...(name(category) ? { category: name(category) } : {}),
    ...(name(balance) ? { balance: name(balance) } : {}),
    ...(name(currency) ? { currency: name(currency) } : {}),
    ...(name(externalId) ? { externalId: name(externalId) } : {}),
    ...(name(status) ? { status: name(status) } : {}),
    ...(hints.delimiter ? { delimiter: hints.delimiter } : {}),
  }
  return { mapping, confidence: Math.max(0, Math.round(confidence * 100) / 100), reasons }
}

function signConvention(
  rows: string[][],
  amount: number,
  hints: SuggestHints,
  reasons: string[],
): { value: 'positive_is_in' | 'positive_is_out'; guessed: boolean } {
  const payments = rows.filter((r) => PAYMENT_ROW.test(r.join(' ')))
  const neg = (v: string) => /^\s*(-|\()|-\s*$/.test(v)
  if (payments.length) {
    const paymentNegative = payments.every((r) => neg(r[amount] ?? ''))
    const paymentPositive = payments.every((r) => !neg(r[amount] ?? '') && (r[amount] ?? '').trim() !== '')
    if (paymentNegative) {
      reasons.push('card payment rows are negative, so charges are positive: positive_is_out')
      return { value: 'positive_is_out', guessed: false }
    }
    if (paymentPositive && hints.accountType === 'credit_card') {
      reasons.push('card payment rows are positive: positive_is_in')
      return { value: 'positive_is_in', guessed: false }
    }
  }
  if (hints.accountType === 'credit_card') {
    reasons.push('card export with no payment rows to confirm the sign; assuming charges are positive (positive_is_out)')
    return { value: 'positive_is_out', guessed: true }
  }
  reasons.push('signed amount: positive_is_in (bank convention)')
  return { value: 'positive_is_in', guessed: false }
}

function looksLikeIds(values: string[]): boolean {
  const v = values.map((x) => x.trim().replace(/^'+|'+$/g, '')).filter(Boolean)
  return v.length > 0 && new Set(v).size === v.length && v.every((x) => /^[A-Za-z0-9._:/-]{4,}$/.test(x) && /\d/.test(x))
}

function detectDecimal(values: string[], delimiter?: Delimiter): { decimal: '.' | ','; reason: string; penalty: number } {
  let dot = 0
  let comma = 0
  for (const raw of values) {
    const s = raw.replace(/[\s $€£()+-]/g, '').replace(/[A-Za-z]/g, '')
    if (/^\d{1,3}(\.\d{3})+,\d+$/.test(s) || /^\d+,\d{1,2}$/.test(s)) comma++
    else if (/^\d{1,3}(,\d{3})+\.\d+$/.test(s) || /^\d+\.\d{1,2}$/.test(s)) dot++
  }
  if (dot && comma) {
    return dot >= comma
      ? { decimal: '.', reason: `decimal '.' (but ${comma} sample(s) look comma-decimal)`, penalty: 0.3 }
      : { decimal: ',', reason: `decimal ',' (but ${dot} sample(s) look dot-decimal)`, penalty: 0.3 }
  }
  if (comma) return { decimal: ',', reason: "decimal separator ',' (e.g. 1.234,56)", penalty: 0 }
  if (dot) return { decimal: '.', reason: "decimal separator '.' (e.g. 1,234.56)", penalty: 0 }
  const decimal = delimiter === ';' ? ',' : '.'
  return { decimal, reason: `decimal separator not visible in samples; assuming '${decimal}'`, penalty: 0.15 }
}

// ---------- Rows ----------

export interface CsvRowsResult {
  headers: string[]
  rows: ParsedRow[]
  warnings: string[]
  /** Records after the header that were skipped (bad date, empty amount). */
  skipped: number
}

const DEBIT_MARKERS = ['S', 'D', 'DR', 'DEBIT', 'SOLL', 'DB', '-']
const CREDIT_MARKERS = ['H', 'C', 'CR', 'CREDIT', 'HABEN', '+']

/** Split a table into header + data records according to the mapping (or detection). */
export function splitHeader(table: CsvTable, mapping: Pick<ColumnMapping, 'skipRows' | 'hasHeader'>): { headers: string[]; data: CsvRecord[] } {
  let start: number
  if (mapping.skipRows !== undefined) {
    const skip = mapping.skipRows
    start = table.records.findIndex((r) => r.line > skip)
    if (start < 0) return { headers: [], data: [] }
  } else start = mapping.hasHeader === false ? 0 : findHeaderIndex(table.records)
  if (mapping.hasHeader === false) return { headers: [], data: table.records.slice(start) }
  const header = table.records[start]
  return { headers: header ? header.cells.map((c) => c.trim()) : [], data: table.records.slice(start + 1) }
}

function resolve(headers: string[], ref: ColumnRef, what: string): number {
  if (typeof ref === 'number') return ref
  let i = headers.indexOf(ref)
  if (i < 0) i = headers.map(normalizeLabel).indexOf(normalizeLabel(ref))
  if (i < 0) throw invalid(`mapping: ${what} column ${JSON.stringify(ref)} is not in the header`, 'mapping_column_missing')
  return i
}

/** Read transactions out of a parsed CSV with a mapping. Ambiguous amounts throw invalid_input with the line number. */
export function csvRows(table: CsvTable, mapping: ColumnMapping, accountCurrency: string): CsvRowsResult {
  const { headers, data } = splitHeader(table, mapping)
  const warnings: string[] = []
  const idx = (ref: ColumnRef | undefined, what: string) => (ref === undefined ? undefined : resolve(headers, ref, what))
  const dateI = idx(mapping.date, 'date') as number
  const a = mapping.amount
  const amountI = a.kind === 'split' ? undefined : idx(a.column, 'amount')
  const debitI = a.kind === 'split' ? idx(a.debit, 'debit') : undefined
  const creditI = a.kind === 'split' ? idx(a.credit, 'credit') : undefined
  const indicatorI = a.kind === 'indicator' ? idx(a.indicator, 'indicator') : undefined
  const descI = idx(mapping.description, 'description')
  const cpI = idx(mapping.counterparty, 'counterparty')
  const catI = idx(mapping.category, 'category')
  const balI = idx(mapping.balance, 'balance')
  const curI = idx(mapping.currency, 'currency')
  const idI = idx(mapping.externalId, 'externalId')
  const statusI = idx(mapping.status, 'status')
  const defaultCurrency = normalizeCurrency(mapping.defaultCurrency ?? accountCurrency)
  const outSign = a.kind === 'signed' && a.convention === 'positive_is_out' ? -1 : 1
  const debitMarkers = (a.kind === 'indicator' && a.debitMarkers ? a.debitMarkers : DEBIT_MARKERS).map((x) => x.toUpperCase())
  const creditMarkers = (a.kind === 'indicator' && a.creditMarkers ? a.creditMarkers : CREDIT_MARKERS).map((x) => x.toUpperCase())

  const rows: ParsedRow[] = []
  let skipped = 0
  for (const rec of data) {
    const cell = (i: number | undefined) => (i === undefined ? '' : (rec.cells[i] ?? '').trim())
    const text = (i: number | undefined) => cell(i).replace(/\s+/g, ' ') || undefined
    const date = parseDate(cell(dateI), mapping.dateFormat)
    if (!date) {
      skipped++
      warnings.push(`line ${rec.line}: skipped, date ${JSON.stringify(cell(dateI).slice(0, 30))} doesn't match ${mapping.dateFormat}`)
      continue
    }
    const currency = curI === undefined ? defaultCurrency : normalizeCurrency(cell(curI), defaultCurrency)
    const minor = (v: string, what: string) => {
      try {
        return toMinor(v, currency, { decimal: mapping.decimal })
      } catch (e) {
        if (isConnectorError(e)) throw invalid(`line ${rec.line}: ${what} ${e.message}`, 'ambiguous_amount')
        throw e
      }
    }
    let amount: number | undefined
    if (a.kind === 'signed') {
      const v = cell(amountI)
      if (v) amount = outSign * minor(v, 'amount')
    } else if (a.kind === 'split') {
      const d = cell(debitI)
      const c = cell(creditI)
      // Some banks (Citi) write credits as negative numbers: the column says the direction, not the sign.
      if (d || c) amount = (c ? Math.abs(minor(c, 'credit')) : 0) - (d ? Math.abs(minor(d, 'debit')) : 0)
    } else {
      const v = cell(amountI)
      if (v) {
        const marker = cell(indicatorI).toUpperCase()
        const value = Math.abs(minor(v, 'amount'))
        if (debitMarkers.includes(marker)) amount = -value
        else if (creditMarkers.includes(marker)) amount = value
        else throw invalid(`line ${rec.line}: unknown debit/credit marker ${JSON.stringify(marker.slice(0, 10))}`, 'ambiguous_amount')
      }
    }
    const balRaw = cell(balI)
    const balance: Money | undefined = balRaw ? { minor: normZero(outSign * minor(balRaw, 'balance')), currency } : undefined
    const statusText = cell(statusI).toLowerCase()
    const status = /pend|authori[sz]/.test(statusText) ? 'pending' : /void|cancel|declin|fail|reject/.test(statusText) ? 'void' : 'posted'
    const ref = cell(idI).replace(/^'+|'+$/g, '') || undefined
    const base = {
      line: rec.line,
      date,
      status,
      ...(text(descI) ? { description: text(descI) } : {}),
      ...(text(cpI) ? { counterparty: text(cpI) } : {}),
      ...(text(catI) ? { category: text(catI) } : {}),
      ...(ref ? { ref } : {}),
      ...(balance ? { balance } : {}),
      cells: Object.fromEntries(rec.cells.map((c, i) => [headers[i] || `col${i}`, c])),
    } as const
    if (amount === undefined) {
      if (balance) rows.push({ ...base, kind: 'balance_only', amount: { minor: 0, currency } })
      else {
        skipped++
        warnings.push(`line ${rec.line}: skipped, no amount`)
      }
      continue
    }
    rows.push({ ...base, kind: 'txn', amount: { minor: normZero(amount), currency } })
  }
  if (!rows.length && data.length) {
    throw invalid(`no rows could be read with this mapping (${warnings[0] ?? 'no data'})`, 'mapping_mismatch')
  }
  return { headers, rows, warnings, skipped }
}

const normZero = (n: number) => (n === 0 ? 0 : n)
