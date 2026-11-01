// CSV exports of the big US banks, recognised by their exact column headers (or, for Wells Fargo, by the shape of
// its header-less file). Each preset says how that bank signs amounts, so a card export never needs a "thank you"
// payment row to get the sign right. The date format is still read from the rows (month first, as US banks write).

import type { AccountType } from '@agfn/contracts'
import type { ColumnMapping, CsvTable } from './csv.ts'
import { detectDateFormat, type DateFormat } from './dates.ts'
import { normalizeLabel } from './text.ts'

export interface BankPreset {
  id: string
  /** Shown to the person: "Chase credit card export". */
  label: string
  institution: string
  accountType: AccountType
  /** Every one of these headers (normalized) must be present; extra columns are fine. */
  headers?: string[]
  /** For files without a header row: does this table look like the bank's export? */
  shape?: (table: CsvTable) => boolean
  mapping: Omit<ColumnMapping, 'dateFormat' | 'decimal'>
}

const H = (...names: string[]) => names.map(normalizeLabel)

export const BANK_PRESETS: BankPreset[] = [
  {
    // Chase checking/savings: Details (DEBIT/CREDIT/CHECK/DSLIP), signed Amount (− = out), running Balance.
    id: 'chase-checking',
    label: 'Chase checking export',
    institution: 'Chase',
    accountType: 'depository',
    headers: H('Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance'),
    mapping: { date: 'Posting Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, description: 'Description', balance: 'Balance' },
  },
  {
    // Chase credit card: purchases are negative, payments and returns positive.
    id: 'chase-card',
    label: 'Chase credit card export',
    institution: 'Chase',
    accountType: 'credit_card',
    headers: H('Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount'),
    mapping: { date: 'Transaction Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, description: 'Description', category: 'Category' },
  },
  {
    // Bank of America checking: a summary block, then Date, Description, Amount (− = out), Running Bal.
    id: 'bofa-checking',
    label: 'Bank of America checking export',
    institution: 'Bank of America',
    accountType: 'depository',
    headers: H('Date', 'Description', 'Amount', 'Running Bal.'),
    mapping: { date: 'Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, description: 'Description', balance: 'Running Bal.' },
  },
  {
    // Bank of America credit card: purchases negative, payments positive.
    id: 'bofa-card',
    label: 'Bank of America credit card export',
    institution: 'Bank of America',
    accountType: 'credit_card',
    headers: H('Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'),
    mapping: { date: 'Posted Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, counterparty: 'Payee', externalId: 'Reference Number' },
  },
  {
    // Wells Fargo: no header row; date, signed amount, "*", check number, description.
    id: 'wells-fargo',
    label: 'Wells Fargo export',
    institution: 'Wells Fargo',
    accountType: 'depository',
    shape: (t) => {
      const rows = t.records.filter((r) => r.cells.some((c) => c.trim() !== '')).slice(0, 20)
      return rows.length > 0 && rows.every((r) => r.cells.length === 5 && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(r.cells[0]!.trim()) && /^-?\d+(\.\d+)?$/.test(r.cells[1]!.trim()) && r.cells[2]!.trim() === '*')
    },
    mapping: { hasHeader: false, date: 0, amount: { kind: 'signed', column: 1, convention: 'positive_is_in' }, description: 4 },
  },
  {
    // Citi cards: Status (Cleared/Pending), Debit = charges, Credit = payments (written as negative numbers).
    id: 'citi-card',
    label: 'Citi credit card export',
    institution: 'Citi',
    accountType: 'credit_card',
    headers: H('Status', 'Date', 'Description', 'Debit', 'Credit'),
    mapping: { date: 'Date', amount: { kind: 'split', debit: 'Debit', credit: 'Credit' }, description: 'Description', status: 'Status' },
  },
  {
    // Capital One cards: Debit = charges, Credit = payments, both positive; Card No. is the last four.
    id: 'capitalone-card',
    label: 'Capital One credit card export',
    institution: 'Capital One',
    accountType: 'credit_card',
    headers: H('Transaction Date', 'Posted Date', 'Card No.', 'Description', 'Category', 'Debit', 'Credit'),
    mapping: { date: 'Transaction Date', amount: { kind: 'split', debit: 'Debit', credit: 'Credit' }, description: 'Description', category: 'Category' },
  },
  {
    // Capital One 360 checking/savings: unsigned Transaction Amount, direction in Transaction Type (Debit/Credit).
    id: 'capitalone-360',
    label: 'Capital One 360 export',
    institution: 'Capital One',
    accountType: 'depository',
    headers: H('Account Number', 'Transaction Description', 'Transaction Date', 'Transaction Type', 'Transaction Amount', 'Balance'),
    mapping: { date: 'Transaction Date', amount: { kind: 'indicator', column: 'Transaction Amount', indicator: 'Transaction Type' }, description: 'Transaction Description', balance: 'Balance' },
  },
  {
    // American Express: charges positive, payments and credits negative. Only its detailed export is told apart: a
    // bare Date/Description/Amount file could be anyone's, so it goes through the header guess.
    id: 'amex',
    label: 'American Express export',
    institution: 'American Express',
    accountType: 'credit_card',
    headers: H('Date', 'Description', 'Amount', 'Extended Details', 'Appears On Your Statement As'),
    mapping: { date: 'Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_out' }, description: 'Description', externalId: 'Reference', category: 'Category' },
  },
  {
    // U.S. Bank: Transaction (DEBIT/CREDIT), Name, Memo, signed Amount.
    id: 'usbank',
    label: 'U.S. Bank export',
    institution: 'U.S. Bank',
    accountType: 'depository',
    headers: H('Date', 'Transaction', 'Name', 'Memo', 'Amount'),
    mapping: { date: 'Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, counterparty: 'Name', description: 'Memo' },
  },
  {
    // PNC: separate Withdrawals and Deposits, running Balance.
    id: 'pnc',
    label: 'PNC export',
    institution: 'PNC',
    accountType: 'depository',
    headers: H('Date', 'Description', 'Withdrawals', 'Deposits', 'Balance'),
    mapping: { date: 'Date', amount: { kind: 'split', debit: 'Withdrawals', credit: 'Deposits' }, description: 'Description', balance: 'Balance' },
  },
  {
    // Apple Card (Goldman Sachs): purchases positive, payments and credits negative; Merchant is the clean name,
    // Description the raw authorization text. Family accounts add "Purchased By". Neither Apple nor Goldman publishes
    // the columns: these follow importer documentation, and a file without "Amount (USD)" goes through the header guess.
    id: 'apple-card',
    label: 'Apple Card export',
    institution: 'Apple Card',
    accountType: 'credit_card',
    headers: H('Transaction Date', 'Clearing Date', 'Description', 'Merchant', 'Category', 'Type', 'Amount (USD)'),
    mapping: { date: 'Transaction Date', amount: { kind: 'signed', column: 'Amount (USD)', convention: 'positive_is_out' }, counterparty: 'Merchant', description: 'Description', category: 'Category' },
  },
  {
    // Discover cards: charges positive, payments and credits negative ("Payments and Credits" category).
    id: 'discover-card',
    label: 'Discover credit card export',
    institution: 'Discover',
    accountType: 'credit_card',
    headers: H('Trans. Date', 'Post Date', 'Description', 'Amount', 'Category'),
    mapping: { date: 'Trans. Date', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_out' }, description: 'Description', category: 'Category' },
  },
  {
    // Mercury: signed Amount, Status (Sent/Pending/Failed/Cancelled), Reference.
    id: 'mercury',
    label: 'Mercury export',
    institution: 'Mercury',
    accountType: 'depository',
    headers: H('Date (UTC)', 'Description', 'Amount', 'Status', 'Source Account', 'Bank Description'),
    mapping: { date: 'Date (UTC)', amount: { kind: 'signed', column: 'Amount', convention: 'positive_is_in' }, counterparty: 'Description', description: 'Bank Description', status: 'Status', category: 'Category' },
  },
]

/** Most specific first: a preset whose headers are a superset of another's wins. */
const BY_SPECIFICITY = [...BANK_PRESETS].sort((a, b) => (b.headers?.length ?? 99) - (a.headers?.length ?? 99))

export interface PresetMatch {
  preset: BankPreset
  mapping: ColumnMapping
  dateAmbiguous: boolean
}

/** The bank export this table is, with a full mapping; null when no preset fits (fall back to suggestMapping). */
export function matchPreset(table: CsvTable, headers: string[], data: string[][]): PresetMatch | null {
  const norm = new Set(headers.map(normalizeLabel))
  for (const p of BY_SPECIFICITY) {
    const fits = p.shape ? p.shape(table) : p.headers!.every((h) => norm.has(h))
    if (!fits) continue
    const rows = p.mapping.hasHeader === false ? table.records.map((r) => r.cells) : data
    const di = typeof p.mapping.date === 'number' ? p.mapping.date : headers.findIndex((h) => normalizeLabel(h) === normalizeLabel(p.mapping.date as string))
    const dates = detectDateFormat(rows.slice(0, 50).map((r) => r[di] ?? ''))
    if (!dates) continue
    // Optional columns a preset names but this file lacks (Mercury's Category) are left out.
    const has = (ref: unknown) => typeof ref !== 'string' || norm.has(normalizeLabel(ref))
    const m = Object.fromEntries(Object.entries(p.mapping).filter(([k, v]) => k === 'amount' || k === 'hasHeader' || has(v))) as BankPreset['mapping']
    return { preset: p, mapping: { ...m, dateFormat: dates.format as DateFormat, decimal: '.' }, dateAmbiguous: dates.ambiguous }
  }
  return null
}
