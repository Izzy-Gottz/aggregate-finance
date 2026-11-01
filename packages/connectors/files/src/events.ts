// Parsed statement rows → NormalizedEvents, plus the balance check. Shared by the CSV and OFX paths so both get the
// same stable-id rules: the bank's own id when it has one, otherwise a content hash with an occurrence index, so
// re-importing the same (or an overlapping) file never double counts, and two identical rows stay two rows.

import type {
  AccountType,
  AccountUpsert,
  BalanceSnapshot,
  Money,
  NormalizedEvent,
  RawSink,
  TxnUpsert,
} from '@agfn/contracts'
import { textCategoryHint } from '@agfn/connector-sdk'
import { normalizeLabel, sha256Hex } from './text.ts'

// OFX transaction types that settle what a row is (OFX 1.0.2 §11.4.2.3), in the ledger's category words, by direction:
// INT out of a card is interest charged, not earned.
const OFX_IN: Record<string, string> = { 'ofx:int': 'INCOME_INTEREST_EARNED', 'ofx:div': 'INCOME_DIVIDENDS' }
const OFX_OUT: Record<string, string> = { 'ofx:fee': 'BANK_FEES', 'ofx:srvchg': 'BANK_FEES' }

/**
 * The row's category hint: the bank's own words when they plainly say paycheck, interest, dividend or bank fee, then
 * an OFX type that says the same, then the file's own category column.
 */
const hintOf = (row: ParsedRow): string | undefined =>
  textCategoryHint([row.description, row.counterparty].filter(Boolean).join(' '), row.amount.minor > 0) ??
  (row.category ? ((row.amount.minor > 0 ? OFX_IN : OFX_OUT)[row.category] ?? row.category) : undefined)

export interface ParsedRow {
  /** 1-based line in the source file where the row starts. */
  line: number
  /** txn: a transaction. balance_only: a "Beginning balance" style row (balance chain only). void_only: OFX DELETE. */
  kind: 'txn' | 'balance_only' | 'void_only'
  date: string
  /** Signed: + money in, − money out. 0 for balance_only rows. */
  amount: Money
  status: TxnUpsert['status']
  description?: string
  counterparty?: string
  category?: string
  /** The bank's own transaction id (OFX FITID, a CSV reference column). */
  ref?: string
  /** Running balance after this row, signed like `amount` (owed on a card = negative). */
  balance?: Money
  linkRefs?: Record<string, string>
  /** OFX CORRECTFITID: the earlier row this one deletes or replaces. */
  voids?: string
  /** Original cells / fields, stored verbatim in raw capture. */
  cells: unknown
}

export interface FileAccount {
  externalId: string
  name: string
  accountType: AccountType
  currency: string
  mask?: string
  institution?: string
  /** What the file said about the account (for raw capture). */
  source: unknown
}

export interface ClosingBalance {
  current: Money
  available?: Money
  /** ISO timestamp the balance is as of. */
  at: string
  /** YYYY-MM-DD used in the snapshot id. */
  date: string
}

export interface BalanceMismatch {
  line: number
  expected: Money
  actual: Money
}

export interface BalanceCheck {
  accountExternalId: string
  status: 'ok' | 'mismatch' | 'skipped'
  method: 'running_balance' | 'opening_closing'
  reason?: string
  opening?: Money
  closing?: Money
  /** Sum of the checked rows. */
  sum?: Money
  /** closing − (opening + sum); 0 when ok. */
  difference?: Money
  /** closing − sum, reported when there is no opening balance to compare against. */
  impliedOpening?: Money
  rowsChecked: number
  mismatches: BalanceMismatch[]
}

const m = (minor: number, currency: string): Money => ({ minor, currency })

/** Content hash id: account, date, amount, normalized description, occurrence index among identical rows. */
export function rowHashId(accountExternalId: string, row: ParsedRow, occurrence: number): string {
  const desc = normalizeLabel(`${row.description ?? ''} ${row.counterparty ?? ''}`)
  const key = [accountExternalId, row.date, String(row.amount.minor), row.amount.currency, desc, String(occurrence)].join('\u001f')
  return `${accountExternalId}:h${sha256Hex(key).slice(0, 32)}`
}

function rowContentKey(accountExternalId: string, row: ParsedRow): string {
  const desc = normalizeLabel(`${row.description ?? ''} ${row.counterparty ?? ''}`)
  return [accountExternalId, row.date, String(row.amount.minor), row.amount.currency, desc].join('\u001f')
}

/** A row an earlier file of this connection imported (for banks that re-issue transaction ids between downloads). */
export interface PriorRow {
  externalId: string
  date: string
  amountMinor: number
  text: string
}
/** Earlier imports of one account in a date range (inclusive). */
export type PriorRows = (accountExternalId: string, from: string, to: string) => Promise<PriorRow[]>

export interface BuildInput {
  /** Earlier imports, to keep a row's id when the bank gave it a new FITID this time. */
  prior?: PriorRows
  connectionId: string
  raw: RawSink
  fileSha256: string
  format: string
  account: FileAccount
  rows: ParsedRow[]
  closing?: ClosingBalance
  warnings: string[]
}

export async function buildEvents(input: BuildInput): Promise<NormalizedEvent[]> {
  const { connectionId, raw, fileSha256, format, account, rows, warnings } = input
  const acct = account.externalId
  const events: NormalizedEvent[] = []

  const accountEvent: AccountUpsert = {
    type: 'account.upsert',
    externalId: acct,
    connectionId,
    name: account.name,
    accountType: account.accountType,
    currency: account.currency,
    ...(account.mask ? { mask: account.mask } : {}),
    ...(account.institution ? { institution: account.institution } : {}),
    rawRef: await raw.put(connectionId, 'files.account', acct, { file: fileSha256, format, account: account.source }),
  }
  events.push(accountEvent)

  const occurrences = new Map<string, number>()
  const used = new Set<string>()
  const put = (id: string, row: ParsedRow) =>
    raw.put(connectionId, 'files.row', id, { file: fileSha256, format, line: row.line, cells: row.cells })

  // Some banks (Chase and Bank of America among them) hand out new FITIDs when the same rows are downloaded again. A
  // row with an id we've never seen that matches an earlier import's row exactly (day, amount, text) whose id isn't in
  // this file is that row again: it keeps the earlier id.
  const sameRow = (date: string, minor: number, text: string) => [date, String(minor), normalizeLabel(text)].join('\u001f')
  const priorIds = new Set<string>()
  const reissued = new Map<string, string[]>()
  const withRef = rows.filter((r) => r.kind === 'txn' && r.ref)
  if (input.prior && withRef.length) {
    const days = rows.filter((r) => r.kind === 'txn').map((r) => r.date).sort()
    const inFile = new Set(withRef.map((r) => `${acct}:${r.ref}`))
    for (const p of await input.prior(acct, days[0] as string, days[days.length - 1] as string)) {
      priorIds.add(p.externalId)
      if (inFile.has(p.externalId)) continue
      const k = sameRow(p.date, p.amountMinor, p.text)
      reissued.set(k, [...(reissued.get(k) ?? []), p.externalId])
    }
  }
  let kept = 0

  for (const row of rows) {
    if (row.kind === 'balance_only') continue
    if (row.voids) {
      const voidId = `${acct}:${row.voids}`
      if (!used.has(voidId)) {
        used.add(voidId)
        events.push({
          type: 'txn.upsert',
          externalId: voidId,
          connectionId,
          accountExternalId: acct,
          date: row.date,
          amount: row.amount,
          status: 'void',
          ...(row.description ? { rawText: row.description } : {}),
          rawRef: await put(voidId, row),
        })
      }
    }
    if (row.kind === 'void_only') continue

    let id: string | undefined
    if (row.ref && !priorIds.has(`${acct}:${row.ref}`)) {
      const earlier = reissued.get(sameRow(row.date, row.amount.minor, row.description ?? ''))?.shift()
      if (earlier && !used.has(earlier)) {
        id = earlier
        kept++
      }
    }
    if (!id && row.ref) {
      const candidate = `${acct}:${row.ref}`
      if (used.has(candidate)) warnings.push(`line ${row.line}: transaction id ${JSON.stringify(row.ref)} repeats in this file; using a content hash instead`)
      else id = candidate
    }
    if (!id) {
      const key = rowContentKey(acct, row)
      const n = occurrences.get(key) ?? 0
      occurrences.set(key, n + 1)
      id = rowHashId(acct, row, n)
    }
    used.add(id)
    const category = hintOf(row)
    const txn: TxnUpsert = {
      type: 'txn.upsert',
      externalId: id,
      connectionId,
      accountExternalId: acct,
      date: row.date,
      amount: row.amount,
      status: row.status,
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.description ? { rawText: row.description } : {}),
      ...(category ? { categoryHint: category } : {}),
      ...(row.linkRefs && Object.keys(row.linkRefs).length ? { linkRefs: row.linkRefs } : {}),
      rawRef: await put(id, row),
    }
    events.push(txn)
  }

  if (kept) warnings.push(`${kept} row${kept === 1 ? '' : 's'} came with new transaction ids from the bank; matched to the earlier import so ${kept === 1 ? 'it counts' : 'they count'} once`)
  if (input.closing) {
    const c = input.closing
    const id = `${acct}@${c.date}`
    const snap: BalanceSnapshot = {
      type: 'balance.snapshot',
      externalId: id,
      connectionId,
      accountExternalId: acct,
      at: c.at,
      current: c.current,
      ...(c.available ? { available: c.available } : {}),
      rawRef: await raw.put(connectionId, 'files.balance', id, {
        file: fileSha256,
        format,
        current: c.current,
        available: c.available ?? null,
        at: c.at,
      }),
    }
    events.push(snap)
  }
  return events
}

// ---------- Balance check ----------

/** Rows in chronological order: file order or reversed, whichever is date-ascending (and agrees with the balances). */
export function chronological(rows: ParsedRow[]): ParsedRow[] {
  const asc = (rs: ParsedRow[]) => rs.every((r, i) => i === 0 || (rs[i - 1] as ParsedRow).date <= r.date)
  const forward = rows
  const backward = [...rows].reverse()
  const candidates = [forward, backward].filter(asc)
  if (candidates.length === 0) return [...rows].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (candidates.length === 1) return candidates[0] as ParsedRow[]
  // Same date throughout: let the running balance decide.
  const score = (rs: ParsedRow[]) => chainMismatches(rs.filter((r) => r.balance && r.kind !== 'void_only')).length
  return score(backward) < score(forward) ? backward : forward
}

function chainMismatches(chain: ParsedRow[]): BalanceMismatch[] {
  const out: BalanceMismatch[] = []
  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1] as ParsedRow
    const row = chain[i] as ParsedRow
    if (!prev.balance || !row.balance) continue
    const expected = prev.balance.minor + row.amount.minor
    if (expected !== row.balance.minor) {
      out.push({ line: row.line, expected: m(expected, row.balance.currency), actual: row.balance })
    }
  }
  return out
}

/** Running-balance check: every row's balance = previous balance + its amount. Rows without a balance are skipped. */
export function runningBalanceCheck(accountExternalId: string, ordered: ParsedRow[]): BalanceCheck {
  const chain = ordered.filter((r) => r.balance && r.kind !== 'void_only')
  const base = { accountExternalId, method: 'running_balance' as const, rowsChecked: chain.length, mismatches: [] }
  if (chain.length < 2) return { ...base, status: 'skipped', reason: 'fewer than two rows carry a running balance' }
  const currencies = new Set(chain.map((r) => (r.balance as Money).currency))
  if (currencies.size > 1) return { ...base, status: 'skipped', reason: 'running balance mixes currencies' }
  const first = chain[0] as ParsedRow
  const last = chain[chain.length - 1] as ParsedRow
  const currency = (first.balance as Money).currency
  const opening = m((first.balance as Money).minor - first.amount.minor, currency)
  const sum = chain.reduce((s, r) => s + r.amount.minor, 0)
  const closing = last.balance as Money
  const mismatches = chainMismatches(chain)
  const difference = closing.minor - (opening.minor + sum)
  const skippedRows = ordered.filter((r) => r.kind === 'txn' && !r.balance).length
  return {
    ...base,
    status: mismatches.length || difference !== 0 ? 'mismatch' : 'ok',
    ...(skippedRows ? { reason: `${skippedRows} row(s) without a running balance were not checked` } : {}),
    opening,
    closing,
    sum: m(sum, currency),
    difference: m(difference, currency),
    mismatches,
  }
}

/** Opening + sum(rows) = closing. Without an opening balance (OFX gives only LEDGERBAL) it reports the implied opening. */
export function openingClosingCheck(
  accountExternalId: string,
  rows: ParsedRow[],
  closing: Money | undefined,
  opening: Money | undefined,
): BalanceCheck {
  const txns = rows.filter((r) => r.kind === 'txn' && r.status !== 'void')
  const base = { accountExternalId, method: 'opening_closing' as const, rowsChecked: txns.length, mismatches: [] }
  if (!closing) return { ...base, status: 'skipped', reason: 'the file has no closing balance' }
  if (txns.some((r) => r.amount.currency !== closing.currency)) {
    return { ...base, status: 'skipped', reason: 'transactions are in a different currency than the balance' }
  }
  const sum = m(
    txns.reduce((s, r) => s + r.amount.minor, 0),
    closing.currency,
  )
  const impliedOpening = m(closing.minor - sum.minor, closing.currency)
  if (!opening) {
    return { ...base, status: 'skipped', reason: 'no opening balance to compare against', closing, sum, impliedOpening }
  }
  if (opening.currency !== closing.currency) {
    return { ...base, status: 'skipped', reason: 'opening balance currency differs', closing, sum, impliedOpening }
  }
  const difference = m(closing.minor - (opening.minor + sum.minor), closing.currency)
  return { ...base, status: difference.minor === 0 ? 'ok' : 'mismatch', opening, closing, sum, difference }
}
