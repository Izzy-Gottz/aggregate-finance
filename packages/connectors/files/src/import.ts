// importFile: one uploaded statement file → NormalizedEvents + balance check + warnings. Deterministic, no network.

import type { AccountType, Money, NormalizedEvent, RawSink } from '@agfn/contracts'
import { isoTimestamp, normalizeCurrency, nullRawSink } from '@agfn/connector-sdk'
import { csvRows, parseCsv, splitHeader, suggestMapping, type ColumnMapping, type MappingSuggestion } from './csv.ts'
import { ingestDocument, sniffDocument, type DocumentDescriptor } from './document.ts'
import {
  buildEvents,
  chronological,
  openingClosingCheck,
  runningBalanceCheck,
  type BalanceCheck,
  type ClosingBalance,
  type FileAccount,
  type PriorRows,
} from './events.ts'
import { matchPreset, type BankPreset } from './presets.ts'
import { camtStatementRows, looksLikeCamt, parseCamt } from './camt.ts'
import { looksLikeOfx, ofxDeclaredCharset, ofxStatementRows, parseOfx } from './ofx.ts'
import { decodeText, invalid, sha256Hex } from './text.ts'
import { extractPdfText } from './pdf/extract.ts'
import { parsePdfStatement, type PdfStatement } from './pdf/statement.ts'

export type DetectedFormat = 'csv' | 'ofx' | 'qfx' | 'qbo' | 'camt.053' | 'camt.052' | 'pdf' | 'png' | 'jpeg' | 'heic'

/** Max size for a text statement (CSV/OFX/camt). Documents have their own 25 MB limit. */
export const MAX_TEXT_BYTES = 25 * 1024 * 1024

export interface FileAccountSettings {
  name: string
  accountType: AccountType
  currency: string
  institution?: string
}

export interface ImportOptions {
  connectionId: string
  /** Raw capture sink (default: hash-only sink that stores nothing). */
  raw?: RawSink
  /** CSV: the connection's file account. Required for CSV (CSV files don't say which account they are). */
  accountExternalId?: string
  /** CSV: name/type/currency of that account. */
  account?: FileAccountSettings
  /**
   * OFX/QFX: post a single-account file to `accountExternalId` instead of the account the file names. Set when the
   * person said which account the statement is for (it's the same real account as one already synced). Also applies
   * to a camt file for one account.
   */
  ofxIntoFileAccount?: boolean
  /**
   * CSV: a known bank's export (Chase card, Amex…) goes to its own account (`csv:<preset>`) instead of
   * `accountExternalId`, like an OFX file goes to the account it names. For a catch-all upload connection only.
   */
  presetAccounts?: boolean
  /** CSV: how to read the columns. Absent = suggestMapping(), used only at ≥ minConfidence. */
  mapping?: ColumnMapping
  /** Default 0.7. */
  minConfidence?: number
  /** OFX: the balance before this file (e.g. the previous statement's closing) to verify opening + rows = closing. */
  openingBalance?: Money
  /** Earlier imports of this connection, so a bank that re-issues FITIDs doesn't count a row twice. */
  prior?: PriorRows
  /** OFX: flip every sign, for a bank known to violate the OFX sign rule. Never applied automatically. */
  invertOfxSign?: boolean
  /** PDF: import statements from known banks that reconcile (default). false = always keep a PDF as a document. */
  pdfStatements?: boolean
}

export interface ImportResult {
  detectedFormat: DetectedFormat
  fileSha256: string
  events: NormalizedEvent[]
  balanceCheck: BalanceCheck[]
  warnings: string[]
  /** PDF/image statements: stored as an unread document, no events. */
  document?: DocumentDescriptor
  /** A PDF statement imported from a known bank's layout. */
  pdf?: { layout: PdfStatement['layout']; period: PdfStatement['period'] }
  /** CSV: the mapping used and where it came from. */
  mapping?: {
    mapping: ColumnMapping
    source: 'provided' | 'suggested' | 'preset'
    /** source 'preset': the bank export it was recognised as. */
    preset?: { id: string; label: string; institution: string; accountType: AccountType }
    confidence?: number
    reasons?: string[]
    headers: string[]
  }
}

const DOC_FORMAT: Record<string, DetectedFormat> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/heic': 'heic',
  'image/heif': 'heic',
}

export async function importFile(bytes: Uint8Array, filename: string, options: ImportOptions): Promise<ImportResult> {
  const fileSha256 = sha256Hex(bytes)
  const raw = options.raw ?? nullRawSink
  if (!bytes.length) throw invalid('file is empty', 'empty_file')

  const docMime = sniffDocument(bytes)
  if (docMime || /\.(pdf|png|jpe?g|heic|heif)$/i.test(filename)) {
    const document = ingestDocument(bytes, filename)
    // A PDF statement from a bank we know imports like OFX, but only when it reconciles (pdf/statement.ts).
    if (document.mime === 'application/pdf' && options.pdfStatements !== false) {
      const text = await extractPdfText(bytes)
      const parsed = text.status === 'text' ? parsePdfStatement(text.lines) : null
      if (parsed?.ok) return importPdfStatement(parsed.statement, fileSha256, raw, options)
    }
    return {
      detectedFormat: DOC_FORMAT[document.mime] ?? 'pdf',
      fileSha256,
      events: [],
      balanceCheck: [],
      warnings: [],
      document,
    }
  }
  if (bytes.length > MAX_TEXT_BYTES) throw invalid('statement file is larger than 25 MB', 'file_too_large')

  const asciiHead = String.fromCharCode(...bytes.subarray(0, 1024))
  if (looksLikeOfx(asciiHead) || /\.(ofx|qfx|qbo)$/i.test(filename)) {
    const decoded = decodeText(bytes, ofxDeclaredCharset(asciiHead))
    if (!looksLikeOfx(decoded.text)) throw invalid(`${filename} is not an OFX file`, 'ofx_malformed')
    return importOfx(decoded.text, filename, fileSha256, raw, options, decoded.warnings)
  }

  if (looksLikeCamt(asciiHead) || /\.xml$/i.test(filename)) {
    const decoded = decodeText(bytes)
    if (!looksLikeCamt(decoded.text.slice(0, 4096))) throw invalid(`${filename} isn't an ISO 20022 bank statement (camt.053)`, 'camt_unsupported')
    return importCamt(decoded.text, fileSha256, raw, options, decoded.warnings)
  }

  const decoded = decodeText(bytes)
  return importCsv(decoded.text, fileSha256, raw, options, decoded.warnings)
}

async function importOfx(
  text: string,
  filename: string,
  fileSha256: string,
  raw: RawSink,
  options: ImportOptions,
  warnings: string[],
): Promise<ImportResult> {
  const doc = parseOfx(text)
  warnings.push(...doc.warnings)
  const detectedFormat: DetectedFormat = /\.qbo$/i.test(filename)
    ? 'qbo'
    : /\.qfx$/i.test(filename) || doc.intuBid
      ? 'qfx'
      : 'ofx'
  const events: NormalizedEvent[] = []
  const balanceCheck: BalanceCheck[] = []
  const single = doc.statements.length === 1
  for (const st of doc.statements) {
    const parsed = ofxStatementRows(doc, st, { invertSign: options.invertOfxSign ?? false })
    const into = single && options.ofxIntoFileAccount && options.accountExternalId ? options.accountExternalId : undefined
    const s = into ? { ...parsed, account: { ...parsed.account, externalId: into, ...(options.account?.name ? { name: options.account.name } : {}) } } : parsed
    warnings.push(...s.warnings)
    const opening = single ? options.openingBalance : undefined
    balanceCheck.push(openingClosingCheck(s.account.externalId, s.rows, s.closing?.current, opening))
    events.push(
      ...(await buildEvents({
        connectionId: options.connectionId,
        ...(options.prior ? { prior: options.prior } : {}),
        raw,
        fileSha256,
        format: detectedFormat,
        account: s.account,
        rows: s.rows,
        ...(s.closing ? { closing: s.closing } : {}),
        warnings,
      })),
    )
  }
  return { detectedFormat, fileSha256, events, balanceCheck, warnings }
}

async function importPdfStatement(st: PdfStatement, fileSha256: string, raw: RawSink, options: ImportOptions): Promise<ImportResult> {
  // The person said which account this is (the same real account a feed already syncs): post into that one.
  const into = options.ofxIntoFileAccount && options.accountExternalId ? options.accountExternalId : undefined
  const account = into ? { ...st.account, externalId: into, ...(options.account?.name ? { name: options.account.name } : {}) } : st.account
  const warnings: string[] = []
  const balanceCheck = [openingClosingCheck(account.externalId, st.rows, st.closing.current, st.opening)]
  const events = await buildEvents({ connectionId: options.connectionId, ...(options.prior ? { prior: options.prior } : {}), raw, fileSha256, format: 'pdf', account, rows: st.rows, closing: st.closing, warnings })
  return { detectedFormat: 'pdf', fileSha256, events, balanceCheck, warnings, pdf: { layout: st.layout, period: st.period } }
}

async function importCamt(text: string, fileSha256: string, raw: RawSink, options: ImportOptions, warnings: string[]): Promise<ImportResult> {
  const doc = parseCamt(text)
  warnings.push(...doc.warnings)
  const events: NormalizedEvent[] = []
  const balanceCheck: BalanceCheck[] = []
  const single = new Set(doc.statements.map((st) => `${st.iban ?? st.otherId}|${st.currency}`)).size === 1
  const currencies = new Map<string, Set<string>>()
  for (const st of doc.statements) currencies.set(st.iban ?? st.otherId ?? '', (currencies.get(st.iban ?? st.otherId ?? '') ?? new Set()).add(st.currency))
  for (const st of doc.statements) {
    const parsed = camtStatementRows(doc, st, { sameNumberCount: currencies.get(st.iban ?? st.otherId ?? '')?.size ?? 1 })
    const into = single && options.ofxIntoFileAccount && options.accountExternalId ? options.accountExternalId : undefined
    const s = into ? { ...parsed, account: { ...parsed.account, externalId: into, ...(options.account?.name ? { name: options.account.name } : {}) } } : parsed
    warnings.push(...s.warnings)
    // Booked rows only: pending entries aren't in the booked closing balance.
    const opening = s.opening ?? (single && doc.statements.length === 1 ? options.openingBalance : undefined)
    balanceCheck.push(openingClosingCheck(s.account.externalId, s.rows.filter((r) => r.status === 'posted'), s.closing?.current, opening))
    events.push(...(await buildEvents({ connectionId: options.connectionId,
        ...(options.prior ? { prior: options.prior } : {}), raw, fileSha256, format: doc.kind, account: s.account, rows: s.rows, ...(s.closing ? { closing: s.closing } : {}), warnings })))
  }
  // Several statements for one account (daily statements in one file) repeat its account line: keep the first.
  const seen = new Set<string>()
  const deduped = events.filter((e) => e.type !== 'account.upsert' || (!seen.has(e.externalId) && !!seen.add(e.externalId)))
  return { detectedFormat: doc.kind, fileSha256, events: deduped, balanceCheck, warnings }
}

async function importCsv(
  text: string,
  fileSha256: string,
  raw: RawSink,
  options: ImportOptions,
  warnings: string[],
): Promise<ImportResult> {
  if (!options.accountExternalId) throw invalid('CSV import needs the file account (accountExternalId)', 'missing_account')
  const settings = options.account ?? { name: 'Imported account', accountType: 'depository' as const, currency: 'USD' }
  const currency = normalizeCurrency(settings.currency)
  const table = parseCsv(text, options.mapping?.delimiter ? { delimiter: options.mapping.delimiter } : {})
  if (!table.records.length) throw invalid('CSV file has no rows', 'empty_file')

  let mapping = options.mapping
  let suggestion: MappingSuggestion | undefined
  let preset: BankPreset | undefined
  const { headers, data } = splitHeader(table, mapping ?? {})
  // A known bank export first (exact headers, the bank's own sign rule), then a guess from the headers. The preset is
  // recognised even when the mapping was worked out earlier (the server plans it at upload), so the file still knows
  // which bank and kind of account it came from.
  const hit = matchPreset(table, headers, data.slice(0, 50).map((r) => r.cells))
  if (hit) {
    mapping ??= hit.mapping
    preset = hit.preset
  }
  if (!mapping) {
    suggestion = suggestMapping(headers, data.slice(0, 50).map((r) => r.cells), {
      accountType: settings.accountType,
      delimiter: table.delimiter,
    })
    const min = options.minConfidence ?? 0.7
    if (!suggestion.mapping || suggestion.confidence < min) {
      throw invalid(
        `couldn't map this CSV's columns with confidence (${suggestion.confidence}): ${suggestion.reasons.join('; ')}`,
        'needs_mapping',
      )
    }
    mapping = suggestion.mapping
  }

  const read = csvRows(table, mapping, currency)
  warnings.push(...read.warnings)
  // A bank's own export names its account (a Chase card, an Amex card): in a catch-all upload connection it gets that
  // account, like an OFX file, instead of one account for every upload.
  const own = options.presetAccounts && !options.ofxIntoFileAccount ? preset : undefined
  const account: FileAccount = {
    externalId: own ? `csv:${own.id}` : options.accountExternalId,
    name: own ? own.label.replace(/ export$/, '') : settings.name,
    accountType: own ? own.accountType : settings.accountType,
    currency,
    ...(settings.institution ?? preset?.institution ? { institution: (settings.institution ?? preset?.institution) as string } : {}),
    source: { headers: read.headers, ...(preset ? { preset: preset.id } : {}) },
  }

  const ordered = chronological(read.rows)
  const balanceCheck: BalanceCheck[] = []
  let closing: ClosingBalance | undefined
  if (mapping.balance !== undefined) {
    balanceCheck.push(runningBalanceCheck(account.externalId, ordered))
    const last = [...ordered].reverse().find((r) => r.balance)
    if (last?.balance) closing = { current: last.balance, at: isoTimestamp(`${last.date}T12:00:00Z`), date: last.date }
  }

  const events = await buildEvents({
    connectionId: options.connectionId,
        ...(options.prior ? { prior: options.prior } : {}),
    raw,
    fileSha256,
    format: 'csv',
    account,
    rows: read.rows,
    ...(closing ? { closing } : {}),
    warnings,
  })
  return {
    detectedFormat: 'csv',
    fileSha256,
    events,
    balanceCheck,
    warnings,
    mapping: suggestion
      ? { mapping, source: 'suggested', confidence: suggestion.confidence, reasons: suggestion.reasons, headers: read.headers }
      : preset
        ? { mapping, source: 'preset', preset: { id: preset.id, label: preset.label, institution: preset.institution, accountType: preset.accountType }, confidence: 1, reasons: [`recognised as a ${preset.label}`], headers: read.headers }
        : { mapping, source: 'provided', headers: read.headers },
  }
}
