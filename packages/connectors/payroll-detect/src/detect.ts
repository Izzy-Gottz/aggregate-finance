// Deterministic payroll detection from bank rows (MASTER.md §2 "Payroll", finance-model.md N32).
//
// Payroll providers debit the company bank in a few recognizable pieces ("GUSTO NET 241015", "GUSTO TAX 241015").
// Known descriptor patterns become a recognized payroll run, labeled estimated. No AI: the same input always gives
// the same runs, with the same ids.
//
// What a bank-detected run can and can't know:
//   - companyDebit = net + tax + benefits debits (fees are excluded: they're a software expense, not payroll cost).
//   - The split between employee withholding and employer tax is invisible in bank rows, so `gross` carries the
//     estimated total payroll cost (companyDebit) and `employerTaxes` is zero. Payroll cost = gross + employer
//     taxes therefore still equals what left the bank for payroll. Every such run has estimated: true.
import type { ConnectionId, LinkProposal, Money, PayrollRun, TxnUpsert } from '@agfn/contracts'
import { addDays, daysBetween, oldestExactSubset } from '@agfn/invoices'

export type PayrollComponent = 'net' | 'tax' | 'benefits' | 'fee' | 'other'

export interface PayrollPattern {
  provider: string
  /** Matched against the upper-cased descriptor (counterparty + raw text). */
  match: RegExp
  /** First matching component rule wins; unmatched rows of this provider are 'other'. */
  components?: Array<{ component: PayrollComponent; match: RegExp }>
}

const C = (component: PayrollComponent, match: RegExp): { component: PayrollComponent; match: RegExp } => ({ component, match })

/** Common US/EU payroll and PEO descriptors. Order matters: more specific providers first. */
export const DEFAULT_PATTERNS: readonly PayrollPattern[] = [
  {
    provider: 'Gusto',
    match: /\b(GUSTO|ZENPAYROLL)\b/,
    components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('benefits', /\b(BENEFIT|401K|HEALTH|GUIDELINE)/), C('net', /\b(NET|PAY|PAYROLL|CND|DD)\b/)],
  },
  {
    provider: 'ADP',
    match: /\bADP\b/,
    components: [C('fee', /\b(FEE|PAYROLL FEES|SERVICE)/), C('tax', /\bTAX/), C('net', /\b(WAGE|PAY|NET|PAYROLL)/)],
  },
  { provider: 'Paychex', match: /\bPAYCHEX\b/, components: [C('fee', /\b(FEE|INVOICE|EIB)/), C('tax', /\b(TAX|TPS)/), C('net', /\b(PAYROLL|PAY|NET|DIRDEP)/)] },
  { provider: 'Rippling', match: /\bRIPPLING\b/, components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('net', /\b(PAYROLL|PAY|NET|WAGE)/)] },
  { provider: 'Justworks', match: /\bJUSTWORKS\b/, components: [C('fee', /\bFEE/), C('net', /./)] },
  { provider: 'TriNet', match: /\bTRINET\b/, components: [C('net', /./)] },
  { provider: 'Insperity', match: /\bINSPERITY\b/, components: [C('net', /./)] },
  { provider: 'Deel', match: /\bDEEL\b/, components: [C('net', /./)] },
  { provider: 'OnPay', match: /\bONPAY\b/, components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('net', /./)] },
  { provider: 'Paylocity', match: /\bPAYLOCITY\b/, components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('net', /./)] },
  { provider: 'Paycom', match: /\bPAYCOM\b/, components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('net', /./)] },
  { provider: 'Square Payroll', match: /\bSQ(UARE)?\s*\*?\s*PAYROLL\b/, components: [C('tax', /\bTAX/), C('net', /./)] },
  { provider: 'QuickBooks Payroll', match: /\b(INTUIT|QUICKBOOKS|QBOOKS)\b.*\b(PAYROLL|PAYRL|TAX|DD)\b/, components: [C('fee', /\bFEE/), C('tax', /\bTAX/), C('net', /./)] },
  { provider: 'Mercury Payroll', match: /\bCENTRAL\s+PAYROLL\b/, components: [C('tax', /\bTAX/), C('net', /./)] },
]

export interface DetectOptions {
  /** Connection id the detected runs are attributed to (the detector's own connection). */
  connectionId: ConnectionId
  patterns?: readonly PayrollPattern[]
  /** Extra user/AI-defined patterns (e.g. a local PEO), checked before the defaults. */
  customPatterns?: readonly PayrollPattern[]
  /** Debits of one provider within this many days of the cluster's first debit belong to one run. Default 5. */
  clusterDays?: number
  /** Providers with a real payroll connection for this entity: their debits are settlements, not estimates. */
  suppressProviders?: readonly string[]
  /**
   * Pay dates (by provider) already covered by provider or register runs: matching clusters aren't estimated again.
   * When the known run has an externalId, the cluster's rows get settlement links to it instead.
   */
  knownRuns?: ReadonlyArray<Pick<PayrollRun, 'payDate' | 'provider'> & { externalId?: string }>
}

export interface ClassifiedRow {
  txn: TxnUpsert
  provider: string
  component: PayrollComponent
}

export interface DetectResult {
  runs: PayrollRun[]
  /** Every row recognized as payroll-related, with its component (fees included, for categorization). */
  classified: ClassifiedRow[]
  /** Settlement links from each estimated run to the bank rows it was built from. */
  links: LinkProposal[]
  /** Unknown descriptors that look like payroll and repeat; offered as rule suggestions in Review. */
  suggestions: Array<{ descriptor: string; count: number; txnExternalIds: string[] }>
}

export function descriptorOf(t: Pick<TxnUpsert, 'counterparty' | 'rawText'>): string {
  return `${t.counterparty ?? ''} ${t.rawText ?? ''}`.toUpperCase().replace(/\s+/g, ' ').trim()
}

export function classify(t: TxnUpsert, patterns: readonly PayrollPattern[] = DEFAULT_PATTERNS): ClassifiedRow | null {
  const d = descriptorOf(t)
  if (!d) return null
  for (const p of patterns) {
    if (!p.match.test(d)) continue
    const rest = d.replace(p.match, ' ')
    const component = p.components?.find((c) => c.match.test(rest))?.component ?? 'other'
    return { txn: t, provider: p.provider, component }
  }
  return null
}

export function detectPayroll(txns: readonly TxnUpsert[], opts: DetectOptions): DetectResult {
  const patterns = [...(opts.customPatterns ?? []), ...(opts.patterns ?? DEFAULT_PATTERNS)]
  const clusterDays = opts.clusterDays ?? 5
  const suppressed = new Set((opts.suppressProviders ?? []).map((p) => p.toLowerCase()))

  const usable = txns.filter((t) => t.status === 'posted')
  const classified: ClassifiedRow[] = []
  for (const t of usable) {
    const c = classify(t, patterns)
    if (c) classified.push(c)
  }
  classified.sort((a, b) => cmpRow(a.txn, b.txn))

  // Cluster per (provider, account, currency): fees are categorized but never part of a run's cost.
  const groups = new Map<string, ClassifiedRow[]>()
  for (const c of classified) {
    if (c.component === 'fee' || suppressed.has(c.provider.toLowerCase())) continue
    const key = `${c.provider}\0${c.txn.amount.currency}`
    const list = groups.get(key) ?? []
    list.push(c)
    groups.set(key, list)
  }

  const runs: PayrollRun[] = []
  const links: LinkProposal[] = []
  for (const rows of groups.values()) {
    let cluster: ClassifiedRow[] = []
    const flush = (): void => {
      const run = buildRun(cluster, opts.connectionId)
      cluster = []
      if (!run) return
      const known = knownRun(run, opts.knownRuns, clusterDays)
      if (known) {
        if (known.externalId) for (const id of run.settlementTxnExternalIds ?? []) links.push({ type: 'payroll_settlement', fromId: known.externalId, toId: id, confidence: 1, method: 'rule' })
        return
      }
      runs.push(run)
      for (const id of run.settlementTxnExternalIds ?? []) {
        links.push({ type: 'payroll_settlement', fromId: run.externalId, toId: id, confidence: 1, method: 'rule' })
      }
    }
    for (const r of rows) {
      const first = cluster[0]
      if (first && daysBetween(first.txn.date, r.txn.date) > clusterDays) flush()
      cluster.push(r)
    }
    flush()
  }
  runs.sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : a.externalId < b.externalId ? -1 : 1))
  return { runs, classified, links, suggestions: suggest(usable, patterns) }
}

function buildRun(rows: ClassifiedRow[], connectionId: ConnectionId): PayrollRun | null {
  if (rows.length === 0) return null
  const first = rows[0] as ClassifiedRow
  const currency = first.txn.amount.currency
  // Outflows are negative (sign rule); reversals/refunds of the same provider are positive and net against them.
  const out = (pred: (c: PayrollComponent) => boolean): number => -rows.filter((r) => pred(r.component)).reduce((s, r) => s + r.txn.amount.minor, 0)
  const net = out((c) => c === 'net' || c === 'other')
  const tax = out((c) => c === 'tax')
  const benefits = out((c) => c === 'benefits')
  const debit = net + tax + benefits
  if (debit <= 0) return null // only reversals: nothing was paid

  // The net-pay debit is the best proxy for the pay date (taxes are often debited a day or two apart).
  const netRow = rows.find((r) => r.component === 'net') ?? first
  const m = (minor: number): Money => ({ minor, currency })
  const ids = rows.map((r) => r.txn.externalId)
  const run: PayrollRun = {
    type: 'payroll.run',
    externalId: `bank:${slug(first.provider)}:${first.txn.connectionId}:${first.txn.externalId}`,
    connectionId,
    payDate: netRow.txn.date,
    gross: m(debit),
    employerTaxes: m(0),
    net: m(net),
    source: 'bank_detected',
    estimated: true,
    status: 'paid',
    companyDebit: m(debit),
    settlementTxnExternalIds: ids,
    provider: first.provider,
  }
  if (benefits > 0) run.employerBenefits = m(benefits)
  return run
}

function knownRun(run: PayrollRun, known: DetectOptions['knownRuns'], days: number): NonNullable<DetectOptions['knownRuns']>[number] | undefined {
  if (!known) return undefined
  return known.find(
    (k) => (!k.provider || !run.provider || k.provider.toLowerCase() === run.provider.toLowerCase()) && Math.abs(daysBetween(k.payDate, run.payDate)) <= days,
  )
}

const PAYROLLISH = /\b(PAYROLL|PAYRL|PYRL|WAGES?|SALARY|SALARIES|PEO)\b/

function suggest(txns: readonly TxnUpsert[], patterns: readonly PayrollPattern[]): DetectResult['suggestions'] {
  const byDesc = new Map<string, string[]>()
  for (const t of txns) {
    if (t.amount.minor >= 0) continue
    const d = descriptorOf(t)
    if (!PAYROLLISH.test(d) || patterns.some((p) => p.match.test(d))) continue
    const key = d.replace(/[0-9#*]+/g, ' ').replace(/\s+/g, ' ').trim()
    const list = byDesc.get(key) ?? []
    list.push(t.externalId)
    byDesc.set(key, list)
  }
  return [...byDesc.entries()]
    .filter(([, ids]) => ids.length >= 2)
    .map(([descriptor, ids]) => ({ descriptor, count: ids.length, txnExternalIds: ids }))
    .sort((a, b) => b.count - a.count || (a.descriptor < b.descriptor ? -1 : 1))
}

/**
 * For a run reported by a payroll system (Finch, Rippling, a register upload), find the bank debits that settle it,
 * so they're linked (payroll_settlement) instead of counted as separate spend.
 * Exact subset-sum of the provider's debits near the pay date to companyDebit → 0.97; a debit equal to net pay → 0.8.
 */
export function matchSettlements(
  run: Pick<PayrollRun, 'externalId' | 'payDate' | 'net' | 'companyDebit' | 'provider'>,
  txns: readonly TxnUpsert[],
  opts: { before?: number; after?: number; patterns?: readonly PayrollPattern[] } = {},
): LinkProposal[] {
  const from = addDays(run.payDate, -(opts.before ?? 6))
  const to = addDays(run.payDate, opts.after ?? 3)
  const provider = run.provider?.toLowerCase()
  const candidates = txns
    .filter((t) => t.status === 'posted' && t.amount.minor < 0 && t.amount.currency === run.net.currency && t.date >= from && t.date <= to)
    .map((t) => ({ t, c: classify(t, opts.patterns) }))
    .filter((x) => x.c && x.c.component !== 'fee' && (!provider || x.c.provider.toLowerCase() === provider))
    .map((x) => x.t)
    .sort(cmpRow)
  const link = (t: TxnUpsert, confidence: number): LinkProposal => ({
    type: 'payroll_settlement',
    fromId: run.externalId,
    toId: t.externalId,
    amount: { minor: -t.amount.minor, currency: t.amount.currency },
    confidence,
    method: confidence >= 0.95 ? 'exact_id' : 'fuzzy',
  })
  if (run.companyDebit && candidates.length > 0) {
    const subset = oldestExactSubset(
      candidates.map((t) => ({ remaining: { minor: -t.amount.minor, currency: t.amount.currency } })),
      run.companyDebit,
    )
    if (subset) return subset.map((i) => link(candidates[i] as TxnUpsert, 0.97))
  }
  const netHit = candidates.find((t) => -t.amount.minor === run.net.minor)
  return netHit ? [link(netHit, 0.8)] : []
}

function cmpRow(a: TxnUpsert, b: TxnUpsert): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

