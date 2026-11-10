// Recurring bills and subscriptions over the finance reader port (no ledger internals): read money-out rows,
// detect series (detect.ts), and answer "what's due soon" without double counting bills that are already invoices.
import type { EntityId, FinanceReader, IsoDate, ReadScope, RecurringView, TxnView } from '@agfn/contracts'
import { counterpartyKey, detectRecurring, dueBetween, type Row, type Series } from './detect.ts'

export * from './detect.ts'

/** Kinds that repeat but aren't bills: moving our own money, payroll (its own tool), owner money. */
const NOT_BILLS = new Set(['transfer', 'card_payment', 'payout', 'payroll', 'owner_loan', 'owner_contribution', 'intercompany', 'reimbursement', 'refund'])
/** Two yearly charges and their tolerance (365 × 2 + 15), so a yearly bill can be seen twice and confirmed. */
const LOOKBACK_DAYS = 760
const PAGE = 2_000
const MAX_PAGES = 50

function addDays(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function toView(s: Series): RecurringView {
  const m = (minor: number) => ({ minor, currency: s.currency })
  return {
    id: s.id,
    entityId: s.entityId as EntityId,
    counterparty: s.counterparty,
    cadence: s.cadence,
    status: s.status,
    amount: m(s.amountMinor),
    monthly: m(s.monthlyMinor),
    occurrences: s.occurrences,
    firstDate: s.firstDate,
    lastDate: s.lastDate,
    nextDue: s.nextDue,
    late: s.late,
    events: s.events.map((e) =>
      e.kind === 'trial_converted' ? { kind: e.kind, date: e.date, from: m(e.trialMinor), to: m(e.toMinor) } : { kind: e.kind, date: e.date, from: m(e.fromMinor), to: m(e.toMinor), pct: e.pct },
    ),
    recordIds: s.recordIds,
  }
}

export interface Recurring {
  /** Series per company, newest knowledge as of `asOf` (YYYY-MM-DD). */
  list(scope: ReadScope, opts: { asOf: IsoDate; status?: RecurringView['status'][] }): Promise<RecurringView[]>
  /** Active series charging in [asOf, asOf + days], minus counterparties that already have an open bill. */
  due(scope: ReadScope, asOf: IsoDate, days: number): Promise<RecurringView[]>
}

export interface RecurringOptions {
  /**
   * A cache for the money-out rows (760 days, read page by page) that lasts until the workspace's next ledger write,
   * e.g. the ledger engine's `metricContext(ws).shared`. Without it every call reads them again.
   */
  cacheFor?: (workspaceId: string) => (<T>(key: string, fn: () => Promise<T>) => Promise<T>) | undefined
}

export function createRecurring(reader: Pick<FinanceReader, 'searchTransactions' | 'searchInvoices'>, opts: RecurringOptions = {}): Recurring {
  async function rows(scope: ReadScope, asOf: IsoDate): Promise<Row[]> {
    const cache = opts.cacheFor?.(scope.workspaceId)
    return cache ? cache(`recurring:rows|${[...scope.entityIds].sort().join(',')}|${asOf}`, () => readRows(scope, asOf)) : readRows(scope, asOf)
  }

  async function readRows(scope: ReadScope, asOf: IsoDate): Promise<Row[]> {
    const out: Row[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await reader.searchTransactions(scope, { from: addDays(asOf, -LOOKBACK_DAYS), to: asOf, direction: 'out', status: 'posted', limit: PAGE, ...(cursor ? { cursor } : {}) })
      for (const t of res.rows as TxnView[]) {
        if (t.kind && NOT_BILLS.has(t.kind)) continue
        // A processor's cut of a sale repeats when the sale does (a customer's yearly charge), but it's not a bill.
        if (t.kind === 'fee' && t.category === 'processor_fees') continue
        if (t.links.some((l) => l.type === 'payroll_settlement' || l.type === 'transfer' || l.type === 'card_payment')) continue
        out.push({ id: t.id, entityId: t.entityId, date: t.date, minor: t.amount.minor, currency: t.amount.currency, counterparty: t.counterparty ?? null })
      }
      if (!res.nextCursor) break
      cursor = res.nextCursor
    }
    return out
  }

  async function list(scope: ReadScope, opts: { asOf: IsoDate; status?: RecurringView['status'][] }): Promise<RecurringView[]> {
    if (!scope.entityIds.length) return []
    const series = detectRecurring(await rows(scope, opts.asOf), opts.asOf)
    const want = opts.status ?? ['active', 'suggested']
    return series.filter((s) => want.includes(s.status)).map(toView)
  }

  async function due(scope: ReadScope, asOf: IsoDate, days: number): Promise<RecurringView[]> {
    if (!scope.entityIds.length) return []
    const series = dueBetween(detectRecurring(await rows(scope, asOf), asOf), asOf, addDays(asOf, days))
    if (!series.length) return []
    // A bill that is already an open invoice (QuickBooks, Bill.com, added by hand) is counted there, not here.
    const billed = new Set<string>()
    const inv = await reader.searchInvoices(scope, { direction: 'payable', limit: 200 }).catch(() => null)
    for (const i of inv?.rows ?? []) if (['open', 'overdue', 'partially_paid'].includes(i.status)) billed.add(`${i.entityId}|${counterpartyKey(i.counterparty)}`)
    return series.filter((s) => !billed.has(`${s.entityId}|${counterpartyKey(s.counterparty)}`)).map(toView)
  }

  return { list, due }
}
