// Invariants checked on every write, by every store.
import type { Money, NormalizedEvent } from '@agfn/contracts'
import type { Basis, EntryBasis, JournalEntry } from './model.ts'
import { isFixedRole } from './coa.ts'

export class LedgerInvariantError extends Error {
  override name = 'LedgerInvariantError'
}

/** An entry must have at least two lines, one side per line, safe integers, and debits = credits in base currency. */
export function assertEntryBalanced(entry: JournalEntry): void {
  if (entry.lines.length < 2) throw new LedgerInvariantError(`Entry ${entry.id} has fewer than two lines`)
  let base = 0
  for (const l of entry.lines) {
    for (const v of [l.debitMinor, l.creditMinor, l.baseDebitMinor, l.baseCreditMinor]) {
      if (!Number.isSafeInteger(v) || v < 0) throw new LedgerInvariantError(`Entry ${entry.id} line ${l.id} has an invalid amount ${v}`)
    }
    if (l.debitMinor > 0 && l.creditMinor > 0) throw new LedgerInvariantError(`Entry ${entry.id} line ${l.id} is both debit and credit`)
    if (l.baseDebitMinor > 0 && l.baseCreditMinor > 0) throw new LedgerInvariantError(`Entry ${entry.id} line ${l.id} is both debit and credit in base`)
    base += l.baseDebitMinor - l.baseCreditMinor
  }
  if (base !== 0) throw new LedgerInvariantError(`Entry ${entry.id} does not balance: base debits - credits = ${base}`)
}

export function inView(entryBasis: EntryBasis, view: Basis): boolean {
  return entryBasis === 'both' || entryBasis === view
}

// ---------- Event validation (connectors and AI writes are untrusted input) ----------

export class EventValidationError extends Error {
  override name = 'EventValidationError'
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const TS = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/

function checkMoney(m: Money | undefined, field: string, required = true): void {
  if (m === undefined) {
    if (required) throw new EventValidationError(`${field} is required`)
    return
  }
  if (typeof m !== 'object' || m === null) throw new EventValidationError(`${field} must be {minor, currency}`)
  if (!Number.isSafeInteger(m.minor)) throw new EventValidationError(`${field}.minor must be a safe integer (minor units)`)
  if (typeof m.currency !== 'string' || !/^[A-Z]{3}$/.test(m.currency)) throw new EventValidationError(`${field}.currency must be an ISO 4217 code`)
}

function checkDate(v: string | undefined, field: string, required = true): void {
  if (v === undefined) {
    if (required) throw new EventValidationError(`${field} is required`)
    return
  }
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new EventValidationError(`${field} must be YYYY-MM-DD`)
}

function checkTs(v: string, field: string): void {
  if (typeof v !== 'string' || !TS.test(v) || Number.isNaN(Date.parse(v))) throw new EventValidationError(`${field} must be an ISO 8601 timestamp`)
}

export function validateEvent(ev: NormalizedEvent): void {
  if (!ev || typeof ev !== 'object') throw new EventValidationError('Event must be an object')
  if (typeof ev.externalId !== 'string' || ev.externalId === '' || ev.externalId.length > 512) throw new EventValidationError('externalId is required')
  if (typeof ev.connectionId !== 'string' || ev.connectionId === '') throw new EventValidationError('connectionId is required')
  switch (ev.type) {
    case 'account.upsert':
      if (!/^[A-Z]{3}$/.test(ev.currency)) throw new EventValidationError('currency must be an ISO 4217 code')
      return
    case 'balance.snapshot':
      checkTs(ev.at, 'at')
      checkMoney(ev.current, 'current')
      checkMoney(ev.available, 'available', false)
      return
    case 'txn.upsert':
      checkDate(ev.date, 'date')
      checkMoney(ev.amount, 'amount')
      if (!['pending', 'posted', 'void'].includes(ev.status)) throw new EventValidationError('status must be pending|posted|void')
      return
    case 'processor.balance_txn':
      checkTs(ev.at, 'at')
      checkMoney(ev.gross, 'gross')
      checkMoney(ev.fee, 'fee')
      checkMoney(ev.net, 'net')
      return
    case 'invoice.upsert':
      checkDate(ev.issueDate, 'issueDate')
      checkDate(ev.dueDate, 'dueDate', false)
      checkMoney(ev.total, 'total')
      checkMoney(ev.amountPaid, 'amountPaid')
      checkMoney(ev.tax, 'tax', false)
      if (ev.amountPaid.currency !== ev.total.currency) throw new EventValidationError('amountPaid and total must share a currency')
      if (ev.tax && ev.tax.currency !== ev.total.currency) throw new EventValidationError('tax and total must share a currency')
      return
    case 'payroll.run':
      checkDate(ev.payDate, 'payDate')
      checkMoney(ev.gross, 'gross')
      checkMoney(ev.employerTaxes, 'employerTaxes')
      checkMoney(ev.net, 'net')
      checkMoney(ev.employerBenefits, 'employerBenefits', false)
      for (const m of [ev.employerTaxes, ev.net, ev.employerBenefits]) {
        if (m && m.currency !== ev.gross.currency) throw new EventValidationError('payroll amounts must share a currency')
      }
      return
    case 'equity.event':
      checkDate(ev.date, 'date')
      checkMoney(ev.amount, 'amount', false)
      return
    case 'investment.event': {
      checkDate(ev.date, 'date')
      checkDate(ev.maturityDate, 'maturityDate', false)
      checkMoney(ev.amount, 'amount', false)
      checkMoney(ev.valuationCap, 'valuationCap', false)
      if (!['invest', 'mark', 'distribution', 'write_off', 'exit', 'convert'].includes(ev.kind)) throw new EventValidationError(`unknown investment kind "${ev.kind}"`)
      if (typeof ev.positionId !== 'string' || ev.positionId === '' || ev.positionId.length > 200) throw new EventValidationError('positionId is required')
      if (typeof ev.issuer !== 'string' || ev.issuer.trim() === '') throw new EventValidationError('issuer is required')
      if (ev.amount && ev.amount.minor < 0) throw new EventValidationError('investment amounts are positive (the kind says which way money moved)')
      if ((ev.kind === 'invest' || ev.kind === 'distribution' || ev.kind === 'mark') && !ev.amount) throw new EventValidationError(`${ev.kind} needs an amount`)
      for (const [k, v] of [['shares', ev.shares], ['discountPct', ev.discountPct], ['interestPct', ev.interestPct]] as const) {
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new EventValidationError(`${k} must be a number ≥ 0`)
      }
      if (ev.discountPct !== undefined && ev.discountPct > 100) throw new EventValidationError('discountPct is a percent (20 = 20%)')
      return
    }
    case 'payment.applied':
      checkDate(ev.date, 'date')
      checkMoney(ev.amount, 'amount')
      if (ev.amount.minor < 0) throw new EventValidationError('payment amount must be positive')
      for (const [i, a] of ev.applications.entries()) {
        checkMoney(a.amount, `applications[${i}].amount`)
        if (a.amount.currency !== ev.amount.currency) throw new EventValidationError('applications must share the payment currency')
        if (a.amount.minor < 0) throw new EventValidationError('application amounts must be positive')
      }
      return
    case 'credit_note.upsert':
      checkDate(ev.date, 'date')
      checkMoney(ev.amount, 'amount')
      return
    case 'report.snapshot':
      return
    case 'journal.upsert': {
      checkDate(ev.date, 'date')
      if (!Array.isArray(ev.lines) || ev.lines.length < 2 || ev.lines.length > 500) throw new EventValidationError('a journal needs 2 to 500 lines')
      const sums = new Map<string, number>()
      for (const [i, l] of ev.lines.entries()) {
        checkMoney(l.amount, `lines[${i}].amount`)
        if (!journalRoleAllowed(l.role)) throw new EventValidationError(`lines[${i}].role "${l.role}" can't be used in a journal (bank-side money comes only from bank feeds; use a chart role)`)
        sums.set(l.amount.currency, (sums.get(l.amount.currency) ?? 0) + l.amount.minor)
      }
      for (const [cur, s] of sums) if (s !== 0) throw new EventValidationError(`journal lines don't balance in ${cur} (off by ${s})`)
      return
    }
  }
}

/** Chart roles a provider journal may post to: anything but money accounts and money-in-transit. */
export function journalRoleAllowed(role: string): boolean {
  if (!isFixedRole(role)) return false
  return role !== 'cash_on_hand' && !role.startsWith('clearing_') && role !== 'opening_balance_equity' && role !== 'suspense'
}
