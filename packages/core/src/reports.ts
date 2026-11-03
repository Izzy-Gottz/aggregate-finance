// Reports: P&L, balance sheet, cash flow (direct method). All amounts in the reporting currency.
// This is a live, unofficial view; when QuickBooks/Xero is connected, its books stay the official ones.
import type { EntityId, Id, IsoDate, Money } from '@agfn/contracts'
import { cashFlowSection, isCashLikeRole, NON_CASH_EXPENSE_ROLES, type LedgerAccountType } from './coa.ts'
import type { Basis, EntityInfo, LedgerAccount } from './model.ts'
import { addDays, ledgerAccounts, scopeEntities, sumLinesIn, type ReadContext } from './queries.ts'
import type { LineRow } from './store.ts'

export interface ReportLine {
  ledgerAccountIds: Id[]
  role: string
  name: string
  amount: Money
}

export interface ReportSection {
  title: string
  lines: ReportLine[]
  total: Money
}

const money = (minor: number, currency: string): Money => ({ minor: minor || 0, currency })

/** Group lines by role across entities (a consolidated view shows one "Revenue", not one per company). */
async function byRole(rc: ReadContext, lines: LineRow[], idx: Map<Id, LedgerAccount>, entities: Map<EntityId, EntityInfo>, currency: string, sign: 1 | -1, filter: (a: LedgerAccount) => boolean): Promise<ReportLine[]> {
  const groups = new Map<string, { ids: Set<Id>; name: string; lines: LineRow[] }>()
  for (const l of lines) {
    const a = idx.get(l.ledgerAccountId)
    if (!a || !filter(a)) continue
    // Parameterized roles (one per bank/card/entity) stay separate; fixed roles merge across entities.
    const key = a.role.includes(':') ? `${a.role}|${a.entityId}` : a.role
    const g = groups.get(key) ?? { ids: new Set<Id>(), name: a.name, lines: [] }
    g.ids.add(a.id)
    g.lines.push(l)
    groups.set(key, g)
  }
  const out: ReportLine[] = []
  for (const [key, g] of groups) {
    const minor = sign * (await sumLinesIn(rc, g.lines, entities, currency))
    if (minor !== 0) out.push({ ledgerAccountIds: [...g.ids], role: key.split('|')[0] as string, name: g.name, amount: money(minor, currency) })
  }
  return out.sort((a, b) => (a.role < b.role ? -1 : 1))
}

/**
 * "Processor fees" as one line per processor when more than one charged fees (Stripe and Shopify each keep their own),
 * so "how much did Stripe keep?" has an answer. A fee belongs to the processor balance its entry posts to; fees from
 * anywhere else (a bank row categorized as a fee) stay on "Processor fees". With one processor the line is unchanged.
 */
async function splitProcessorFees(rc: ReadContext, lines: LineRow[], idx: Map<Id, LedgerAccount>, entities: Map<EntityId, EntityInfo>, currency: string, out: ReportLine[]): Promise<ReportLine[]> {
  const at = out.findIndex((l) => l.role === 'processor_fees')
  if (at < 0) return out
  const processorOf = new Map<Id, string>()
  for (const l of lines) {
    const a = idx.get(l.ledgerAccountId)
    if (a?.role.startsWith('processor:')) processorOf.set(l.entryId, a.name)
  }
  const groups = new Map<string, LineRow[]>()
  for (const l of lines) {
    if (idx.get(l.ledgerAccountId)?.role !== 'processor_fees') continue
    const key = processorOf.get(l.entryId) ?? ''
    groups.set(key, [...(groups.get(key) ?? []), l])
  }
  if (groups.size < 2) return out
  const whole = out[at] as ReportLine
  const split: ReportLine[] = []
  for (const [name, g] of [...groups].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))) {
    const minor = await sumLinesIn(rc, g, entities, currency)
    if (minor !== 0) split.push({ ...whole, name: name ? `${whole.name} · ${name}` : whole.name, amount: money(minor, currency) })
  }
  return [...out.slice(0, at), ...split, ...out.slice(at + 1)]
}

function section(title: string, lines: ReportLine[], currency: string): ReportSection {
  return { title, lines, total: money(lines.reduce((s, l) => s + l.amount.minor, 0), currency) }
}

export interface ProfitAndLoss {
  kind: 'profit_and_loss'
  from: IsoDate
  to: IsoDate
  basis: Basis
  currency: string
  entityIds: EntityId[]
  revenue: ReportSection
  costOfRevenue: ReportSection
  grossProfit: Money
  operatingExpenses: ReportSection
  operatingIncome: Money
  other: ReportSection
  netIncome: Money
}

export async function profitAndLoss(rc: ReadContext, opts: { entityIds: EntityId[] | 'all'; from: IsoDate; to: IsoDate; basis: Basis; sourceIds?: Id[]; currency?: string }): Promise<ProfitAndLoss> {
  const entities = await scopeEntities(rc, opts.entityIds)
  const ids = entities.map((e) => e.id)
  const currency = opts.currency ?? (await rc.directory.reportingCurrency(rc.ws))
  const idx = (await ledgerAccounts(rc, ids)).byId
  const emap = new Map(entities.map((e) => [e.id, e]))
  const lines = await rc.store.listLines(rc.ws, { entityIds: ids, basis: opts.basis, fromDate: opts.from, toDate: opts.to, ...(opts.sourceIds ? { sourceIds: opts.sourceIds } : {}) })
  const income = (roles: string[]) => (a: LedgerAccount) => a.type === 'income' && roles.includes(a.role)
  const revenue = section('Revenue', await byRole(rc, lines, idx, emap, currency, -1, income(['revenue', 'refunds'])), currency)
  const cogs = section('Cost of revenue', await byRole(rc, lines, idx, emap, currency, 1, (a) => a.role === 'cogs'), currency)
  const opex = section('Operating expenses', await splitProcessorFees(rc, lines, idx, emap, currency, await byRole(rc, lines, idx, emap, currency, 1, (a) => a.type === 'expense' && a.role !== 'cogs' && a.role !== 'investment_writeoffs')), currency)
  // Other: interest, wages, other income, FX, investments' realized gains and write-offs (shown as income; negative = cost).
  const other = section('Other income and costs', await byRole(rc, lines, idx, emap, currency, -1, (a) => income(['interest_income', 'wages_income', 'other_income', 'fx_gain_loss', 'investment_gains'])(a) || a.role === 'investment_writeoffs'), currency)
  const grossProfit = revenue.total.minor - cogs.total.minor
  const operatingIncome = grossProfit - opex.total.minor
  return {
    kind: 'profit_and_loss',
    from: opts.from,
    to: opts.to,
    basis: opts.basis,
    currency,
    entityIds: ids,
    revenue,
    costOfRevenue: cogs,
    grossProfit: money(grossProfit, currency),
    operatingExpenses: opex,
    operatingIncome: money(operatingIncome, currency),
    other,
    netIncome: money(operatingIncome + other.total.minor, currency),
  }
}

export interface BalanceSheet {
  kind: 'balance_sheet'
  asOf: IsoDate
  basis: Basis
  currency: string
  entityIds: EntityId[]
  assets: ReportSection
  liabilities: ReportSection
  equity: ReportSection
  /** assets − (liabilities + equity); always 0 (FX revaluation is shown as its own equity line). */
  difference: number
}

/**
 * Assets and liabilities are valued at the as-of rate from their original currencies (unrealized FX).
 * Equity is the historical amounts; current-year and prior earnings roll into retained earnings; the FX
 * revaluation that makes it balance is shown on its own line.
 */
export async function balanceSheet(rc: ReadContext, opts: { entityIds: EntityId[] | 'all'; asOf: IsoDate; basis: Basis }): Promise<BalanceSheet> {
  const entities = await scopeEntities(rc, opts.entityIds)
  const ids = entities.map((e) => e.id)
  const currency = await rc.directory.reportingCurrency(rc.ws)
  const idx = (await ledgerAccounts(rc, ids)).byId
  const totals = await rc.store.accountTotals(rc.ws, { entityIds: ids, basis: opts.basis, toDate: opts.asOf })
  const emap = new Map(entities.map((e) => [e.id, e]))
  const groups: Record<'asset' | 'liability' | 'equity', Map<string, ReportLine>> = { asset: new Map(), liability: new Map(), equity: new Map() }
  let earnings = 0
  let historicalTotal = 0
  const add = (type: 'asset' | 'liability' | 'equity', a: LedgerAccount, minor: number): void => {
    const key = a.role.includes(':') ? `${a.role}|${a.entityId}` : a.role
    const g = groups[type].get(key) ?? { ledgerAccountIds: [], role: a.role, name: a.name, amount: money(0, currency) }
    if (!g.ledgerAccountIds.includes(a.id)) g.ledgerAccountIds.push(a.id)
    g.amount = money(g.amount.minor + minor, currency)
    groups[type].set(key, g)
  }
  for (const t of totals) {
    const a = idx.get(t.ledgerAccountId)
    if (!a) continue
    const e = emap.get(a.entityId) as EntityInfo
    const signed = t.debitMinor - t.creditMinor
    const baseSigned = t.baseDebitMinor - t.baseCreditMinor
    // Historical value in reporting currency (base → reporting at as-of, so translation shows as FX).
    const historical = (await rc.toCurrency({ minor: baseSigned, currency: e.baseCurrency }, currency, opts.asOf)).minor
    historicalTotal += historical
    const type: LedgerAccountType = a.type
    if (type === 'asset' || type === 'liability') {
      const current = (await rc.toCurrency({ minor: signed, currency: t.currency }, currency, opts.asOf)).minor
      add(type, a, type === 'asset' ? current : -current)
    } else if (type === 'equity') {
      add('equity', a, -historical)
    } else {
      earnings += -historical
    }
  }
  const assets = section('Assets', [...groups.asset.values()].filter((l) => l.amount.minor !== 0), currency)
  const liabilities = section('Liabilities', [...groups.liability.values()].filter((l) => l.amount.minor !== 0), currency)
  const equityLines = [...groups.equity.values()].filter((l) => l.amount.minor !== 0)
  if (earnings !== 0) equityLines.push({ ledgerAccountIds: [], role: 'retained_earnings', name: 'Earnings to date', amount: money(earnings, currency) })
  void historicalTotal
  const fx = assets.total.minor - liabilities.total.minor - equityLines.reduce((s, l) => s + l.amount.minor, 0)
  if (fx !== 0) equityLines.push({ ledgerAccountIds: [], role: 'fx_revaluation', name: 'Currency revaluation (unrealized)', amount: money(fx, currency) })
  const equity = section('Equity', equityLines, currency)
  return {
    kind: 'balance_sheet',
    asOf: opts.asOf,
    basis: opts.basis,
    currency,
    entityIds: ids,
    assets,
    liabilities,
    equity,
    difference: assets.total.minor - liabilities.total.minor - equity.total.minor,
  }
}

export interface CashFlow {
  kind: 'cash_flow'
  from: IsoDate
  to: IsoDate
  currency: string
  entityIds: EntityId[]
  opening: Money
  operating: ReportSection
  investing: ReportSection
  financing: ReportSection
  /** Money that left one account and hasn't been seen arriving (payouts, transfers in transit). */
  inTransit: Money
  fxEffect: Money
  closing: Money
}

/** Pool = bank, cash on hand, processor balances and cards (card spending counts when it happens). */
function inPool(role: string): boolean {
  return isCashLikeRole(role) || role.startsWith('card:')
}

export async function cashFlow(rc: ReadContext, opts: { entityIds: EntityId[] | 'all'; from: IsoDate; to: IsoDate }): Promise<CashFlow> {
  const entities = await scopeEntities(rc, opts.entityIds)
  const ids = entities.map((e) => e.id)
  const currency = await rc.directory.reportingCurrency(rc.ws)
  const idx = (await ledgerAccounts(rc, ids)).byId
  const emap = new Map(entities.map((e) => [e.id, e]))
  const poolIds = [...idx.values()].filter((a) => inPool(a.role)).map((a) => a.id)

  const poolValue = async (asOf: IsoDate): Promise<number> => {
    if (poolIds.length === 0) return 0
    const totals = await rc.store.accountTotals(rc.ws, { entityIds: ids, basis: 'cash', toDate: asOf, ledgerAccountIds: poolIds })
    let v = 0
    for (const t of totals) v += (await rc.toCurrency({ minor: t.debitMinor - t.creditMinor, currency: t.currency }, currency, asOf)).minor
    return v
  }
  const opening = await poolValue(addDays(opts.from, -1))
  const closing = await poolValue(opts.to)

  const lines = await rc.store.listLines(rc.ws, { entityIds: ids, basis: 'cash', fromDate: opts.from, toDate: opts.to })
  const byEntry = new Map<string, LineRow[]>()
  for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l])
  const counter: Record<'operating' | 'investing' | 'financing' | 'internal', LineRow[]> = { operating: [], investing: [], financing: [], internal: [] }
  const openingSeen: LineRow[] = []
  for (const entryLines of byEntry.values()) {
    if (!entryLines.some((l) => inPool(idx.get(l.ledgerAccountId)?.role ?? ''))) continue
    for (const l of entryLines) {
      const role = idx.get(l.ledgerAccountId)?.role ?? ''
      if (inPool(role)) continue
      if (NON_CASH_EXPENSE_ROLES.includes(role)) continue
      // A balance first seen inside the period is where it started, not money that moved.
      if (role === 'opening_balance_equity') {
        openingSeen.push(l)
        continue
      }
      counter[cashFlowSection(role)].push(l)
    }
  }
  const sec = async (title: string, ls: LineRow[]): Promise<ReportSection> => section(title, await byRole(rc, ls, idx, emap, currency, -1, () => true), currency)
  const operating = await sec('Operating', counter.operating)
  const investing = await sec('Investing', counter.investing)
  const financing = await sec('Financing', counter.financing)
  const inTransit = -(await sumLinesIn(rc, counter.internal, emap, currency))
  const firstSeen = -(await sumLinesIn(rc, openingSeen, emap, currency))
  const explained = opening + firstSeen + operating.total.minor + investing.total.minor + financing.total.minor + inTransit
  return {
    kind: 'cash_flow',
    from: opts.from,
    to: opts.to,
    currency,
    entityIds: ids,
    opening: money(opening + firstSeen, currency),
    operating,
    investing,
    financing,
    inTransit: money(inTransit, currency),
    fxEffect: money(closing - explained, currency),
    closing: money(closing, currency),
  }
}
