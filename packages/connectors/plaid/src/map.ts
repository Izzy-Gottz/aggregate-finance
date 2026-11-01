// Plaid → NormalizedEvent mapping. Sign rule: Plaid amounts are positive for money OUT, so we negate.
// Liability balances (credit cards, loans) are reported by Plaid as positive amounts owed; we emit them negative.

import type {
  AccountType,
  AccountUpsert,
  BalanceSnapshot,
  LiabilityDetails,
  Money,
  TxnUpsert,
} from '@agfn/contracts'
import { money, negate, normalizeCurrency } from '@agfn/connector-sdk'
import type {
  PlaidAccount,
  PlaidCreditLiability,
  PlaidHolding,
  PlaidInvestmentTransaction,
  PlaidLoanLiability,
  PlaidMortgageLiability,
  PlaidSecurity,
  PlaidStudentLiability,
  PlaidTransaction,
} from './types.ts'

/** Depository subtypes that aren't spendable cash: a CD is locked until it matures, an HSA is for medical costs only.
 *  Tracked like investments (net worth, not cash); a person can still count one as cash. */
const NOT_CASH_DEPOSITORY = new Set(['cd', 'hsa'])

/** Subtypes that belong to a person, not a company (retirement, health, education, home and student loans). A business
 *  account flagged by the bank (holder_category) still wins. */
const PERSONAL_SUBTYPES = new Set([
  'hsa', 'ira', 'roth', '401k', '401a', '403b', '457b', 'roth 401k', 'sep ira', 'simple ira', 'sarsep', 'keogh', 'pension',
  'retirement', 'profit sharing plan', 'thrift savings plan', 'non-taxable brokerage account', 'rlif', 'rrif', 'rrsp', 'lif',
  'lira', 'lrif', 'lrsp', 'prif', 'rdsp', 'resp', 'tfsa', 'isa', 'sipp', 'education savings account', '529', 'ugma', 'utma',
  'health reimbursement arrangement', 'mortgage', 'home equity', 'student', 'auto',
])

export function accountType(a: PlaidAccount): AccountType {
  switch (a.type) {
    case 'depository':
      return a.subtype && NOT_CASH_DEPOSITORY.has(a.subtype.toLowerCase()) ? 'investment' : 'depository'
    case 'credit':
      return 'credit_card'
    case 'loan':
      return 'loan'
    case 'investment':
    case 'brokerage':
      return a.subtype === 'crypto exchange' || a.subtype === 'non-custodial wallet' ? 'crypto' : 'investment'
    default:
      return 'other'
  }
}

export function isLiability(a: PlaidAccount): boolean {
  return a.type === 'credit' || a.type === 'loan'
}

/**
 * Plaid sends exactly one of iso_currency_code and unofficial_currency_code. An unofficial one (crypto such as BTC,
 * points) isn't money in any currency the ledger knows: it's 'XXX', never USD, so 1.5 BTC can't become $1.50.
 */
export function plaidCurrency(iso: string | null | undefined, unofficial: string | null | undefined, fallback = 'USD'): string {
  if (iso && /^[A-Za-z]{3}$/.test(iso.trim())) return normalizeCurrency(iso)
  return unofficial?.trim() ? 'XXX' : fallback
}

export function accountCurrency(a: PlaidAccount): string {
  return plaidCurrency(a.balances.iso_currency_code, a.balances.unofficial_currency_code)
}

export function mapAccount(
  a: PlaidAccount,
  connectionId: string,
  rawRef: string,
  institution: string | undefined,
  liability: LiabilityDetails | undefined,
): AccountUpsert {
  const personalKind = !!a.subtype && PERSONAL_SUBTYPES.has(a.subtype.toLowerCase())
  const hint = a.holder_category === 'business' ? 'business' : a.holder_category === 'personal' || personalKind ? 'personal' : 'unknown'
  return {
    type: 'account.upsert',
    externalId: a.account_id,
    connectionId,
    rawRef,
    name: (a.name || a.official_name || 'Account').slice(0, 120),
    accountType: accountType(a),
    currency: accountCurrency(a),
    ...(a.mask ? { mask: a.mask } : {}),
    ...(institution ? { institution } : {}),
    businessHint: hint,
    ...(liability ? { liability } : {}),
  }
}

export function mapBalance(
  a: PlaidAccount,
  connectionId: string,
  rawRef: string,
  at: string,
  holdings?: BalanceSnapshot['holdings'],
): BalanceSnapshot | undefined {
  if (a.balances.current === null || a.balances.current === undefined) return undefined
  const cur = accountCurrency(a)
  const liability = isLiability(a)
  const current = money(a.balances.current, cur)
  return {
    type: 'balance.snapshot',
    // One snapshot per account per UTC day; a later sync the same day replaces it.
    externalId: `${a.account_id}@${at.slice(0, 10)}`,
    connectionId,
    rawRef,
    accountExternalId: a.account_id,
    at,
    current: liability ? negate(current) : current,
    // "available" on a card is unused credit, not money; only depository accounts get it.
    ...(a.type === 'depository' && a.balances.available !== null && a.balances.available !== undefined
      ? { available: money(a.balances.available, cur) }
      : {}),
    ...(holdings?.length ? { holdings } : {}),
  }
}

export function txnCurrency(t: PlaidTransaction, fallback: string): string {
  return plaidCurrency(t.iso_currency_code, t.unofficial_currency_code, fallback)
}

export function mapTxn(t: PlaidTransaction, connectionId: string, rawRef: string, fallbackCurrency: string): TxnUpsert {
  const amount = negate(money(t.amount, txnCurrency(t, fallbackCurrency)))
  const named = t.merchant_name || t.counterparties?.find((c) => c?.name)?.name || undefined
  // A payment app (Zelle, Venmo, Cash App…) is how the money moved, not who it was with: keep the person.
  // No merchant or counterparty (common for money in): Plaid's own cleaned name ("SUSHI BY KATSUYUKI"), so the row says
  // who it was with instead of a generic label.
  const counterparty = named && !isPaymentRail(named) ? named : (railPerson(t) ?? named ?? plainName(t.name))
  const linkRefs: Record<string, string> = {}
  if (t.check_number) linkRefs.check_number = t.check_number
  if (t.payment_meta?.reference_number) linkRefs.reference_number = t.payment_meta.reference_number
  if (t.payment_meta?.ppd_id) linkRefs.ppd_id = t.payment_meta.ppd_id
  const raw = t.original_description || t.name
  return {
    type: 'txn.upsert',
    externalId: t.transaction_id,
    connectionId,
    rawRef,
    accountExternalId: t.account_id,
    date: t.date,
    amount,
    status: t.pending ? 'pending' : 'posted',
    ...(counterparty ? { counterparty: counterparty.slice(0, 120) } : {}),
    ...(raw ? { rawText: raw.slice(0, 500) } : {}),
    ...(categoryHint(t) ? { categoryHint: categoryHint(t) } : {}),
    ...(t.pending_transaction_id ? { pendingExternalId: t.pending_transaction_id } : {}),
    ...(Object.keys(linkRefs).length ? { linkRefs } : {}),
  }
}

// The bank's own words for interest paid to the account ("INTRST PYMNT", "INTEREST PAYMENT", "INTEREST EARNED").
const INTEREST_RE = /\b(intrst|interest)\s*(pymnt|pmt|payment|paid|earned|credit|cr)\b|^\s*interest\s*$/i

/**
 * Personal finance category v2 (what we request; the default for Plaid teams since Dec 2025) renamed three v1 codes.
 * Core and the stored rows speak v1 for those, so a paycheck (v2 INCOME_SALARY) still reads as INCOME_WAGES. Codes new
 * in v2 (INCOME_MILITARY, TRANSFER_IN_WIRE…) pass through as they are. Source: plaid.com/documents/pfc-taxonomy-all.csv.
 */
const PFC_V2_TO_V1: Record<string, string> = {
  INCOME_SALARY: 'INCOME_WAGES',
  INCOME_OTHER: 'INCOME_OTHER_INCOME',
  LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT: 'TRANSFER_IN_CASH_ADVANCES_AND_LOANS',
}

/**
 * Plaid's category, except where its own guess is weak and the bank plainly says it's interest on money in: then
 * Plaid's interest category, so it's booked as interest income instead of asked about. Still editable like any other.
 */
export function categoryHint(t: Pick<PlaidTransaction, 'amount' | 'name' | 'original_description' | 'personal_finance_category'>): string | undefined {
  const pfc = t.personal_finance_category
  const weak = !pfc?.confidence_level || pfc.confidence_level === 'LOW' || pfc.confidence_level === 'MEDIUM' || pfc.confidence_level === 'UNKNOWN'
  if (t.amount < 0 && weak && pfc?.primary !== 'INCOME' && INTEREST_RE.test(t.original_description || t.name || '')) return 'INCOME_INTEREST_EARNED'
  const detailed = pfc?.detailed || undefined
  return detailed ? (PFC_V2_TO_V1[detailed] ?? detailed) : undefined
}

/** A transaction Plaid removed (usually a pending row that settled under a new id). Ledger reverses by externalId. */
export function mapRemoved(
  r: { transaction_id: string; account_id?: string },
  connectionId: string,
  rawRef: string,
  currency: string,
  date: string,
): TxnUpsert {
  return {
    type: 'txn.upsert',
    externalId: r.transaction_id,
    connectionId,
    rawRef,
    accountExternalId: r.account_id ?? '',
    date,
    amount: { minor: 0, currency },
    status: 'void',
  }
}

const opt = (v: number | null | undefined, cur: string): Money | undefined =>
  v === null || v === undefined ? undefined : money(v, cur)

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as T
}

function rate(v: number | null | undefined): string | undefined {
  return v === null || v === undefined ? undefined : String(v)
}

export function creditDetails(l: PlaidCreditLiability, cur: string): LiabilityDetails {
  const purchase = l.aprs?.find((a) => a.apr_type === 'purchase_apr') ?? l.aprs?.[0]
  return compact<LiabilityDetails>({
    kind: 'credit',
    nextPaymentDueDate: l.next_payment_due_date ?? undefined,
    minimumPayment: opt(l.minimum_payment_amount, cur),
    lastStatementBalance: opt(l.last_statement_balance, cur),
    lastStatementDate: l.last_statement_issue_date ?? undefined,
    lastPaymentAmount: opt(l.last_payment_amount, cur),
    lastPaymentDate: l.last_payment_date ?? undefined,
    apr: rate(purchase?.apr_percentage),
  })
}

export function mortgageDetails(l: PlaidMortgageLiability, cur: string): LiabilityDetails {
  return compact<LiabilityDetails>({
    kind: 'mortgage',
    nextPaymentDueDate: l.next_payment_due_date ?? undefined,
    minimumPayment: opt(l.next_monthly_payment, cur),
    lastPaymentAmount: opt(l.last_payment_amount, cur),
    lastPaymentDate: l.last_payment_date ?? undefined,
    apr: rate(l.interest_rate?.percentage),
    originationPrincipal: opt(l.origination_principal_amount, cur),
    maturityDate: l.maturity_date ?? undefined,
  })
}

export function studentDetails(l: PlaidStudentLiability, cur: string): LiabilityDetails {
  return compact<LiabilityDetails>({
    kind: 'student',
    nextPaymentDueDate: l.next_payment_due_date ?? undefined,
    minimumPayment: opt(l.minimum_payment_amount, cur),
    lastStatementBalance: opt(l.last_statement_balance, cur),
    lastStatementDate: l.last_statement_issue_date ?? undefined,
    lastPaymentAmount: opt(l.last_payment_amount, cur),
    lastPaymentDate: l.last_payment_date ?? undefined,
    apr: rate(l.interest_rate_percentage),
    originationPrincipal: opt(l.origination_principal_amount, cur),
    maturityDate: l.expected_payoff_date ?? undefined,
  })
}

export function loanDetails(l: PlaidLoanLiability, cur: string): LiabilityDetails {
  return compact<LiabilityDetails>({
    kind: 'other',
    nextPaymentDueDate: l.next_payment_due_date ?? undefined,
    minimumPayment: opt(l.next_payment_amount, cur),
    lastPaymentAmount: opt(l.last_payment_amount, cur),
    lastPaymentDate: l.last_payment_date ?? undefined,
    apr: rate(l.interest_rate?.percentage),
    originationPrincipal: opt(l.origination_principal_amount, cur),
    maturityDate: l.maturity_date ?? undefined,
  })
}

/** Cash flows that change an investment account's value; buys/sells/cancels (internal reallocations) return undefined. */
export function mapInvestmentTxn(
  t: PlaidInvestmentTransaction,
  security: PlaidSecurity | undefined,
  connectionId: string,
  rawRef: string,
  fallbackCurrency: string,
): TxnUpsert | undefined {
  if (t.type !== 'cash' && t.type !== 'fee' && t.type !== 'transfer') return undefined
  const amount = negate(money(t.amount, plaidCurrency(t.iso_currency_code, t.unofficial_currency_code, fallbackCurrency)))
  if (amount.minor === 0) return undefined
  const who = security?.ticker_symbol || security?.name || undefined
  return {
    type: 'txn.upsert',
    externalId: t.investment_transaction_id,
    connectionId,
    rawRef,
    accountExternalId: t.account_id,
    date: t.date,
    amount,
    status: 'posted',
    ...(who ? { counterparty: who.slice(0, 120) } : {}),
    rawText: t.name.slice(0, 500),
    categoryHint: `INVESTMENT_${t.type}${t.subtype ? '_' + t.subtype : ''}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
  }
}

export function mapHoldings(
  holdings: PlaidHolding[],
  securities: PlaidSecurity[],
  accountCur: Map<string, string>,
): Map<string, NonNullable<BalanceSnapshot['holdings']>> {
  const sec = new Map(securities.map((s) => [s.security_id, s]))
  const out = new Map<string, NonNullable<BalanceSnapshot['holdings']>>()
  for (const h of holdings) {
    const s = sec.get(h.security_id)
    const cur = plaidCurrency(h.iso_currency_code, h.unofficial_currency_code, accountCur.get(h.account_id) ?? 'USD')
    const list = out.get(h.account_id) ?? []
    list.push({
      securityExternalId: h.security_id,
      ...(s?.ticker_symbol ? { ticker: s.ticker_symbol } : {}),
      ...(s?.name ? { name: s.name } : {}),
      quantity: String(h.quantity),
      value: money(h.institution_value, cur),
      ...(h.cost_basis !== null && h.cost_basis !== undefined ? { costBasis: money(h.cost_basis, cur) } : {}),
    })
    out.set(h.account_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.securityExternalId.localeCompare(b.securityExternalId))
  return out
}

const RAILS = ['zelle', 'venmo', 'cash app', 'cashapp', 'square cash', 'paypal', 'apple cash', 'google pay', 'popmoney']
const RAIL_RE = /\b(zelle|venmo|cash\s?app|square cash|paypal|apple cash|google pay|popmoney)\b/i
const NOISE = /\b(payment|pmt|transfer|xfer|sent|received|recd|from|to|on|web|id|ref|conf(irmation)?|trn|des|indn|ppd|ccd|inst|instant|request|online|mobile|cashout|cash out|p2p|co|llc)\b/gi

export function isPaymentRail(name: string): boolean {
  return RAILS.includes(name.trim().toLowerCase())
}

/**
 * The person on a payment-app row, from Plaid's own payer/payee or the bank's text ("JOHN MELTON ZELLE",
 * "ZELLE FROM JOHN MELTON", "VENMO *DANA RUIZ", "CASH APP*SAM LEE"). Title-cased; undefined when only the app is named.
 */
export function railPerson(t: Pick<PlaidTransaction, 'amount' | 'name' | 'original_description' | 'payment_meta'>): string | undefined {
  const meta = t.amount < 0 ? (t.payment_meta?.payer ?? t.payment_meta?.by_order_of) : t.payment_meta?.payee
  const fromMeta = meta?.trim()
  if (fromMeta && !isPaymentRail(fromMeta)) return titleCase(fromMeta)
  const text = t.original_description || t.name || ''
  if (!RAIL_RE.test(text)) return undefined
  const rest = text
    .replace(RAIL_RE, ' ')
    .replace(/[*#:]+/g, ' ')
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]*\b/gi, ' ')
    .replace(/[^a-z&' -]+/gi, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return /[a-z]{2,}/i.test(rest) && rest.length <= 60 ? titleCase(rest) : undefined
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to'])

// Words that stay upper case when a shouted name is title-cased.
const ACRONYMS = new Set(['ach', 'llc', 'llp', 'usa', 'irs', 'atm', 'adp', 'ups', 'usps', 'ibm', 'hsa', 'dba', 'dmv', 'ssa', 'eftps', 'aws', 'gcp', 'ira', 'ein'])
const NOT_ACRONYMS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'ft', 'mt'])

function titleWord(w: string, i: number): string {
  if (i > 0 && SMALL_WORDS.has(w)) return w
  // "pg&e", "at&t", "h&m": short names joined by & are initials.
  if (ACRONYMS.has(w) || (/^[a-z]{1,3}&[a-z]{1,3}$/.test(w))) return w.toUpperCase()
  // No vowel at all and short ("cvs", "pnc") reads as initials, except the usual abbreviations.
  if (/^[a-z]{2,4}$/.test(w) && !/[aeiouy]/.test(w) && !NOT_ACRONYMS.has(w)) return w.toUpperCase()
  return w.replace(/^([a-z])/, (m) => m.toUpperCase())
}

function titleCase(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map(titleWord)
    .join(' ')
    .slice(0, 120)
}

// Bank wording a row's name often ends with: "BARNETT DESIGN PAYMENT", "TRAVIS WALDRON ACH CREDIT", "… PPD ID: 123".
const TRAILING_BANK = /\s+(ach\s+(credit|debit|pmt|payment)|ach|bill\s+pay(ment)?|bill|online|payments?|pmt|direct\s+dep(osit)?|deposit|dep|ppd|ccd|web|id:?|[a-z#:]*\d[\w#:./-]*)$/i
// What is left must still name someone: "Mobile Deposit" stays as it is.
const GENERIC = /^(mobile|online|check|atm|bank|branch|direct|wire|instant|internet|e?transfer|counter|cash)$/i

function stripBankSuffix(v: string): string {
  let out = v
  for (let next = out.replace(TRAILING_BANK, ''); next !== out; next = out.replace(TRAILING_BANK, '')) {
    if (!/[a-z]{2,}/i.test(next) || GENERIC.test(next.trim())) break
    out = next
  }
  return out.trim()
}

/** Plaid's `name` as a display name when nothing better exists; shouting ALL CAPS is title-cased. */
export function plainName(name: string | null | undefined): string | undefined {
  const v = name?.trim()
  if (!v || !/[a-z]{2,}/i.test(v)) return undefined
  const short = stripBankSuffix(v)
  return short === short.toUpperCase() ? titleCase(short) : short.slice(0, 120)
}
