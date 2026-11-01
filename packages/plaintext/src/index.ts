// Plain-text accounting exports (landscape item 8): the ledger as a Beancount or hledger journal, so Fava or
// hledger-web can serve as a free, local viewer. Written from the public file-format docs only (no Beancount code,
// which is GPL-2.0-only). Pure: journal entries in, text out.
//
// Accounts are "<Type>:<Company>:<Account>" (Assets, Liabilities, Equity, Income, Expenses), so one file holds every
// company and each company's balances read straight off its subtree. Amounts are exact (minor units, the currency's
// own decimals); a line in a foreign currency carries its home-currency value as a total price (@@), so every
// transaction balances in the company's home currency exactly as it does in the ledger.

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense'

export interface JournalLine {
  account: { id: string; code?: string | null; name: string; role?: string | null; type: AccountType | string }
  debitMinor: number
  creditMinor: number
  currency: string
  baseDebitMinor: number
  baseCreditMinor: number
  memo?: string | null
}

export interface JournalEntry {
  id: string
  entityId: string
  date: string
  kind?: string | null
  memo?: string | null
  sourceId?: string | null
  lines: JournalLine[]
}

export interface Company {
  id: string
  name: string
  baseCurrency: string
}

export type Format = 'beancount' | 'hledger'

const TOP: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', revenue: 'Income', expense: 'Expenses' }

/** Decimals per currency (ISO 4217 via Intl; 2 when unknown). */
export function exponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Exact decimal text for minor units: 123456 USD → "1234.56", -5 JPY → "-5". */
export function amountText(minor: number, currency: string): string {
  const e = exponent(currency)
  const neg = minor < 0
  const digits = String(Math.abs(minor)).padStart(e + 1, '0')
  const body = e ? `${digits.slice(0, -e)}.${digits.slice(-e)}` : digits
  return `${neg ? '-' : ''}${body}`
}

/** One account-name segment: letters, digits and dashes, starting with a capital or digit (Beancount's rule). */
export function segment(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/[^\x00-\x7f]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const s = words.map((w) => (w[0] as string).toUpperCase() + w.slice(1)).join('-')
  return s ? (/^[A-Z0-9]/.test(s) ? s : `X${s}`) : 'Unnamed'
}

/** Commodity: Beancount wants 2–24 capitals (ISO codes already are). */
function commodity(c: string): string {
  const s = c.toUpperCase().replace(/[^A-Z0-9'._-]/g, '')
  return /^[A-Z]/.test(s) && s.length >= 2 ? s : `C${s || 'UR'}`
}

/** Third-party text on one line, safe inside a quoted string. */
function quoted(text: string): string {
  return `"${text.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').trim().slice(0, 200)}"`
}

/** hledger descriptions end at ';' (a comment) and '|' splits payee from note: keep both out. */
function plain(text: string): string {
  return text.replace(/[\r\n\t;|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export interface ExportOptions {
  format: Format
  companies: Company[]
  title?: string
  /** "Exported at" stamp in the header (pass one in for stable output). */
  generatedAt?: string
}

/** Account names per ledger account id, unique even when two accounts share a display name. */
function accountNames(entries: JournalEntry[], companies: Map<string, Company>): Map<string, { name: string; currencies: Set<string>; opened: string }> {
  const out = new Map<string, { name: string; currencies: Set<string>; opened: string }>()
  const taken = new Set<string>()
  for (const e of [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
    for (const l of e.lines) {
      const cur = out.get(l.account.id)
      if (cur) {
        cur.currencies.add(commodity(l.currency))
        continue
      }
      const co = companies.get(e.entityId)
      let name = `${TOP[l.account.type] ?? 'Equity'}:${segment(co?.name ?? e.entityId)}:${segment(l.account.name)}`
      for (let i = 2; taken.has(name); i++) name = `${name.replace(/-\d+$/, '')}-${i}`
      taken.add(name)
      out.set(l.account.id, { name, currencies: new Set([commodity(l.currency)]), opened: e.date })
    }
  }
  return out
}

/** The journal as Beancount or hledger text. */
export function toPlainText(entries: readonly JournalEntry[], opts: ExportOptions): string {
  const companies = new Map(opts.companies.map((c) => [c.id, c]))
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1))
  const names = accountNames(sorted, companies)
  const bean = opts.format === 'beancount'
  const out: string[] = []
  const c = bean ? ';' : ';'
  out.push(`${c} ${opts.title ?? 'Aggregate export'}`)
  out.push(`${c} Generated by Aggregate${opts.generatedAt ? ` at ${opts.generatedAt}` : ''}. Every amount is exact; foreign-currency lines carry their home-currency value (@@).`)
  out.push(`${c} Companies: ${opts.companies.map((co) => `${co.name} (${co.baseCurrency})`).join(', ')}`)
  out.push('')
  if (bean) {
    out.push(`option "title" ${quoted(opts.title ?? 'Aggregate export')}`)
    for (const cur of new Set(opts.companies.map((co) => commodity(co.baseCurrency)))) out.push(`option "operating_currency" "${cur}"`)
    out.push('')
    for (const [, a] of [...names].sort((x, y) => (x[1].opened < y[1].opened ? -1 : x[1].opened > y[1].opened ? 1 : x[1].name < y[1].name ? -1 : 1))) out.push(`${a.opened} open ${a.name} ${[...a.currencies].sort().join(',')}`)
  } else {
    const typeCode: Record<string, string> = { Assets: 'A', Liabilities: 'L', Equity: 'E', Income: 'R', Expenses: 'X' }
    for (const [, a] of [...names].sort((x, y) => (x[1].name < y[1].name ? -1 : 1))) out.push(`account ${a.name}  ; type: ${typeCode[a.name.split(':')[0] as string] ?? 'E'}`)
  }
  out.push('')

  for (const e of sorted) {
    const co = companies.get(e.entityId)
    const base = commodity(co?.baseCurrency ?? e.lines[0]?.currency ?? 'USD')
    const memo = e.memo ?? e.kind ?? 'Entry'
    if (bean) {
      out.push(`${e.date} * ${quoted(memo)}`)
      out.push(`  agfn_id: ${quoted(e.id)}`)
      if (e.kind) out.push(`  agfn_kind: ${quoted(e.kind)}`)
    } else {
      out.push(`${e.date} * ${plain(memo) || 'Entry'}  ; agfn-id:${e.id}${e.kind ? `, agfn-kind:${e.kind}` : ''}`)
    }
    for (const l of e.lines) {
      const a = names.get(l.account.id) as { name: string }
      const native = l.debitMinor - l.creditMinor
      const baseAmt = l.baseDebitMinor - l.baseCreditMinor
      const cur = commodity(l.currency)
      let amt = `${amountText(native, l.currency)} ${cur}`
      if (cur !== base) amt += ` @@ ${amountText(Math.abs(baseAmt), co?.baseCurrency ?? l.currency)} ${base}`
      out.push(`  ${a.name}  ${amt}`)
    }
    out.push('')
  }
  return out.join('\n')
}

/** Balance per account name in its commodities (what `hledger bal` / Fava would show), for round-trip checks. */
export function balances(entries: readonly JournalEntry[], companies: Company[]): Map<string, Map<string, number>> {
  const names = accountNames([...entries], new Map(companies.map((c) => [c.id, c])))
  const out = new Map<string, Map<string, number>>()
  for (const e of entries)
    for (const l of e.lines) {
      const n = (names.get(l.account.id) as { name: string }).name
      const m = out.get(n) ?? new Map<string, number>()
      m.set(commodity(l.currency), (m.get(commodity(l.currency)) ?? 0) + l.debitMinor - l.creditMinor)
      out.set(n, m)
    }
  return out
}

/** Parse our own output back (amount lines only) and total per account: proves the text holds the exact numbers. */
export function parseTotals(text: string): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const line of text.split('\n')) {
    const m = /^ {2}((?:Assets|Liabilities|Equity|Income|Expenses):[^\s]+) {2}(-?\d+(?:\.\d+)?) ([A-Z][A-Z0-9'._-]+)/.exec(line)
    if (!m) continue
    const [, acct, num, cur] = m as unknown as [string, string, string, string]
    const e = exponent(cur)
    const [i, f = ''] = num.replace('-', '').split('.')
    const minor = (Number(i) * 10 ** e + Number((f + '0'.repeat(e)).slice(0, e) || 0)) * (num.startsWith('-') ? -1 : 1)
    const mm = out.get(acct) ?? new Map<string, number>()
    mm.set(cur, (mm.get(cur) ?? 0) + minor)
    out.set(acct, mm)
  }
  return out
}

/** The exported name, role and company of every ledger account used (for checks and viewers' account lists). */
export function accountsOf(entries: readonly JournalEntry[], companies: Company[]): Map<string, { name: string; role: string | null; entityId: string }> {
  const names = accountNames([...entries], new Map(companies.map((c) => [c.id, c])))
  const out = new Map<string, { name: string; role: string | null; entityId: string }>()
  for (const e of entries) for (const l of e.lines) if (!out.has(l.account.id)) out.set(l.account.id, { name: (names.get(l.account.id) as { name: string }).name, role: l.account.role ?? null, entityId: e.entityId })
  return out
}
