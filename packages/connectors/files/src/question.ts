// When a CSV can't be read with confidence, ask the person one plain question at a time ("Which column is the
// amount?") instead of failing. Each answer narrows the mapping; when nothing is left to ask, the file imports with
// that mapping. A known bank export (presets) or a confident header guess never asks anything.

import type { AccountType } from '@agfn/contracts'
import { parseCsv, splitHeader, suggestMapping, type ColumnMapping } from './csv.ts'
import { detectDateFormat, parseDate, type DateFormat } from './dates.ts'
import { matchPreset } from './presets.ts'
import { decodeText } from './text.ts'

export interface MappingAnswers {
  date?: string
  amount?: string
  sign?: 'positive_is_in' | 'positive_is_out'
  dateFormat?: DateFormat
}

export interface MappingQuestion {
  field: keyof MappingAnswers
  /** One plain question. */
  text: string
  options: Array<{ value: string; label: string }>
  /** The file's columns and its first rows, so the person can see what the question is about. */
  headers: string[]
  sample: string[][]
}

export type CsvPlan = { mapping: ColumnMapping } | { question: MappingQuestion }

const SWAP: Record<string, DateFormat> = { 'MM/DD/YYYY': 'DD/MM/YYYY', 'MM-DD-YYYY': 'DD-MM-YYYY', 'M/D/YY': 'D/M/YY' }

export function planCsvImport(bytes: Uint8Array, answers: MappingAnswers = {}, hints: { accountType?: AccountType; minConfidence?: number } = {}): CsvPlan {
  const table = parseCsv(decodeText(bytes).text)
  const { headers, data } = splitHeader(table, {})
  const rows = data.slice(0, 50).map((r) => r.cells)
  const sample = rows.slice(0, 3)
  const ask = (field: keyof MappingAnswers, text: string, options: MappingQuestion['options']): CsvPlan => ({ question: { field, text, options, headers, sample } })
  const columns = headers.map((h) => ({ value: h, label: h }))
  const answered = Object.keys(answers).length > 0

  if (!answered) {
    const hit = matchPreset(table, headers, rows)
    if (hit) return { mapping: hit.mapping }
  }
  const s = suggestMapping(headers, rows, hints.accountType ? { accountType: hints.accountType } : {})
  const min = hints.minConfidence ?? 0.7
  // A guessed sign is worth one question even when the rest is confident: a wrong sign silently flips every row.
  const signGuess = s.reasons.some((r) => /assuming charges are positive/.test(r))
  if (!answered && s.mapping && s.confidence >= min && !signGuess) return { mapping: s.mapping }

  const valid = (h: string | undefined) => (h && headers.includes(h) ? h : undefined)
  const date = valid(answers.date) ?? (typeof s.mapping?.date === 'string' ? s.mapping.date : undefined)
  if (!date) return ask('date', 'Which column is the date?', columns)
  const amountCol = valid(answers.amount)
  const amount: ColumnMapping['amount'] | undefined = amountCol ? { kind: 'signed', column: amountCol, convention: answers.sign ?? 'positive_is_in' } : s.mapping?.amount
  if (!amount) return ask('amount', 'Which column is the amount?', columns.filter((c) => c.value !== date))

  const di = headers.indexOf(date)
  const detected = detectDateFormat(rows.map((r) => r[di] ?? ''))
  if (!detected) return ask('date', `The "${date}" column doesn't look like dates. Which column is the date?`, columns)
  const dateFormat = answers.dateFormat && rows.every((r) => !r[di]?.trim() || parseDate(r[di]!, answers.dateFormat!)) ? answers.dateFormat : detected.format
  if (!answers.dateFormat && detected.ambiguous && SWAP[detected.format]) {
    const example = rows.map((r) => r[di] ?? '').find((v) => v.trim()) ?? ''
    const [a, b] = example.split(/[/-]/)
    return ask('dateFormat', `Is ${example} ${monthName(a)} ${Number(b)} or ${monthName(b)} ${Number(a)}?`, [
      { value: detected.format, label: `${monthName(a)} ${Number(b)} (month first)` },
      { value: SWAP[detected.format] as string, label: `${monthName(b)} ${Number(a)} (day first)` },
    ])
  }

  // A single amount column with nothing to tell money in from money out (a card export without payment rows).
  const guessedSign = amount.kind === 'signed' && !answers.sign && signGuess
  if (guessedSign || (amountCol && !answers.sign && hints.accountType === 'credit_card')) {
    return ask('sign', 'In this file, is a positive amount money you spent or money that came in?', [
      { value: 'positive_is_out', label: 'Money I spent' },
      { value: 'positive_is_in', label: 'Money that came in' },
    ])
  }
  const signed = amount.kind === 'signed' && answers.sign ? { ...amount, convention: answers.sign } : amount
  return { mapping: { ...(s.mapping ?? {}), date, dateFormat, amount: signed, decimal: s.mapping?.decimal ?? '.' } as ColumnMapping }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (n: string | undefined) => MONTHS[Number(n) - 1] ?? String(n)
