// Card and loan terms (APR, minimum payment, next due date) and investment positions, kept as side data next to
// accounts (migration 0302). Filled from events the connectors already emit (account.upsert.liability and
// balance.snapshot.holdings) as each one passes through the sync route; the ledger still gets every event.
import type { BalanceSnapshot, HoldingView, LiabilityDetails, LiabilityView, Money, NormalizedEvent, ReadScope, UpcomingItem } from '@agfn/contracts'
import type { CoreTables } from '@agfn/db'
import { newId } from '@agfn/db'
import type { Kysely } from 'kysely'

interface LiabilitiesTable {
  account_id: string
  workspace_id: string
  kind: string
  currency: string
  apr: string | null
  minimum_payment_minor: number | string | null
  next_due_date: string | null
  last_statement_balance_minor: number | string | null
  last_statement_date: string | null
  last_payment_minor: number | string | null
  last_payment_date: string | null
  origination_principal_minor: number | string | null
  maturity_date: string | null
  as_of: string
}

interface HoldingsTable {
  id: string
  workspace_id: string
  account_id: string
  as_of_date: string
  security_id: string
  ticker: string | null
  name: string | null
  quantity: string
  currency: string
  value_minor: number | string
  cost_basis_minor: number | string | null
  updated_at: string
}

export interface TermsTables {
  account_liabilities: LiabilitiesTable
  account_holdings: HoldingsTable
}

type Db = Kysely<CoreTables & TermsTables>
type RoutePage = { events: readonly NormalizedEvent[]; cache: Map<string, unknown> }

const n = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v))
const money = (minor: number | string | null, currency: string): Money | undefined => (minor === null ? undefined : { minor: Number(minor), currency })

async function accountOf(db: Db, ws: string, connectionId: string, externalId: string): Promise<string | undefined> {
  const r = await db.selectFrom('accounts').select('id').where('workspace_id', '=', ws).where('connection_id', '=', connectionId).where('external_id', '=', externalId).executeTakeFirst()
  return r?.id
}

/** Stores the terms or positions an event carries; every other event is ignored. Never throws into the sync. */
export async function recordTerms(db: Db, ws: string, e: NormalizedEvent): Promise<void> {
  if (e.type === 'account.upsert' && e.liability) {
    const accountId = await accountOf(db, ws, e.connectionId, e.externalId)
    if (accountId) await saveLiability(db, ws, accountId, e.currency, e.liability)
  } else if (e.type === 'balance.snapshot' && e.holdings) {
    const accountId = await accountOf(db, ws, e.connectionId, e.accountExternalId)
    if (accountId) await saveHoldings(db, ws, accountId, e)
  }
}

async function saveLiability(db: Db, ws: string, accountId: string, currency: string, l: LiabilityDetails): Promise<void> {
  const row: LiabilitiesTable = {
    account_id: accountId,
    workspace_id: ws,
    kind: l.kind,
    currency: l.minimumPayment?.currency ?? l.lastStatementBalance?.currency ?? currency,
    apr: l.apr ?? null,
    minimum_payment_minor: l.minimumPayment?.minor ?? null,
    next_due_date: l.nextPaymentDueDate ?? null,
    last_statement_balance_minor: l.lastStatementBalance?.minor ?? null,
    last_statement_date: l.lastStatementDate ?? null,
    last_payment_minor: l.lastPaymentAmount?.minor ?? null,
    last_payment_date: l.lastPaymentDate ?? null,
    origination_principal_minor: l.originationPrincipal?.minor ?? null,
    maturity_date: l.maturityDate ?? null,
    as_of: new Date().toISOString(),
  }
  const { account_id: _a, workspace_id: _w, ...rest } = row
  await db.insertInto('account_liabilities').values(row).onConflict((oc) => oc.column('account_id').doUpdateSet(rest)).execute()
}

/** One snapshot per account per day: the day's positions replace that day's earlier ones (a sold position goes). */
async function saveHoldings(db: Db, ws: string, accountId: string, e: BalanceSnapshot): Promise<void> {
  const day = e.at.slice(0, 10)
  const at = new Date().toISOString()
  await db.transaction().execute(async (tx) => {
    await tx.deleteFrom('account_holdings').where('account_id', '=', accountId).where('as_of_date', '=', day).execute()
    const seen = new Set<string>()
    for (const h of e.holdings ?? []) {
      if (seen.has(h.securityExternalId)) continue
      seen.add(h.securityExternalId)
      await tx
        .insertInto('account_holdings')
        .values({
          id: newId(),
          workspace_id: ws,
          account_id: accountId,
          as_of_date: day,
          security_id: h.securityExternalId,
          ticker: h.ticker ?? null,
          name: h.name ?? null,
          quantity: h.quantity,
          currency: h.value.currency,
          value_minor: h.value.minor,
          cost_basis_minor: h.costBasis?.minor ?? null,
          updated_at: at,
        })
        .execute()
    }
  })
}

/**
 * A sync page's terms and positions at once (see tapTerms): one read of the page's accounts, then per account its
 * liability upsert, and per account and day one delete and one multi-row insert of the positions. The same rows as
 * recordTerms for each event in turn. Never throws into the sync.
 */
export async function recordTermsPage(db: Db, ws: string, page: { events: readonly NormalizedEvent[] }): Promise<void> {
  const wanted = page.events.filter((e) => (e.type === 'account.upsert' && e.liability) || (e.type === 'balance.snapshot' && e.holdings))
  if (!wanted.length) return
  try {
    const keys = [...new Set(wanted.map((e) => `${e.connectionId}\0${e.type === 'account.upsert' ? e.externalId : (e as BalanceSnapshot).accountExternalId}`))]
    const ids = new Map<string, string>()
    for (const conn of new Set(wanted.map((e) => e.connectionId))) {
      const ext = keys.filter((k) => k.startsWith(`${conn}\0`)).map((k) => k.slice(conn.length + 1))
      for (let i = 0; i < ext.length; i += 100) {
        const rows = await db.selectFrom('accounts').select(['id', 'external_id']).where('workspace_id', '=', ws).where('connection_id', '=', conn).where('external_id', 'in', ext.slice(i, i + 100)).execute()
        for (const r of rows) ids.set(`${conn}\0${r.external_id}`, r.id)
      }
    }
    // The last snapshot of an account for a day wins, as it would one event at a time.
    const days = new Map<string, { accountId: string; e: BalanceSnapshot }>()
    for (const e of wanted) {
      if (e.type === 'account.upsert' && e.liability) {
        const accountId = ids.get(`${e.connectionId}\0${e.externalId}`)
        if (accountId) await saveLiability(db, ws, accountId, e.currency, e.liability)
      } else if (e.type === 'balance.snapshot') {
        const accountId = ids.get(`${e.connectionId}\0${e.accountExternalId}`)
        if (accountId) days.set(`${accountId}\0${e.at.slice(0, 10)}`, { accountId, e })
      }
    }
    if (!days.size) return
    const at = new Date().toISOString()
    await db.transaction().execute(async (tx) => {
      const rows: Array<HoldingsTable> = []
      for (const { accountId, e } of days.values()) {
        const day = e.at.slice(0, 10)
        await tx.deleteFrom('account_holdings').where('account_id', '=', accountId).where('as_of_date', '=', day).execute()
        const seen = new Set<string>()
        for (const h of e.holdings ?? []) {
          if (seen.has(h.securityExternalId)) continue
          seen.add(h.securityExternalId)
          rows.push({ id: newId(), workspace_id: ws, account_id: accountId, as_of_date: day, security_id: h.securityExternalId, ticker: h.ticker ?? null, name: h.name ?? null, quantity: h.quantity, currency: h.value.currency, value_minor: h.value.minor, cost_basis_minor: h.costBasis?.minor ?? null, updated_at: at })
        }
      }
      for (let i = 0; i < rows.length; i += 100) await tx.insertInto('account_holdings').values(rows.slice(i, i + 100)).execute()
    })
  } catch {
    // Side data: a failure here never fails the sync (as recordTerms).
  }
}

/**
 * The sync route with terms recorded on the way through; the wrapped route (or the ledger) still gets the event. In
 * a sync page they're recorded when the page is done (recordTermsPage, from the engine's pageDone), all at once.
 */
export function tapTerms<R>(db: Db, previous: ((ws: string, entityId: string | null, e: NormalizedEvent, page?: RoutePage) => Promise<R | null>) | undefined) {
  return async (ws: string, entityId: string | null, e: NormalizedEvent, page?: RoutePage): Promise<R | null> => {
    if (!page) await recordTerms(db, ws, e).catch(() => undefined)
    return previous ? previous(ws, entityId, e, page) : null
  }
}

export interface TermsReader {
  liabilities(scope: ReadScope): Promise<LiabilityView[]>
  holdings(scope: ReadScope, opts?: { accountId?: string; asOf?: string }): Promise<HoldingView[]>
  /** Card and loan payments due from `from` for `days` days (minimum payment on the next due date). */
  paymentsDue(scope: ReadScope, from: string, days: number): Promise<UpcomingItem[]>
}

const addDays = (d: string, k: number) => new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10)

export function termsReader(db: Db): TermsReader {
  const liabilities: TermsReader['liabilities'] = async (scope) => {
    if (!scope.entityIds.length) return []
    const rows = await db
      .selectFrom('account_liabilities as l')
      .innerJoin('accounts as a', 'a.id', 'l.account_id')
      .selectAll('l')
      .select(['a.entity_id', 'a.name', 'a.institution'])
      .where('l.workspace_id', '=', scope.workspaceId)
      .where('a.entity_id', 'in', scope.entityIds)
      .where('a.closed_at', 'is', null)
      .orderBy('a.name')
      .execute()
    return rows.map((r) => {
      const c = r.currency
      const v: LiabilityView = { accountId: r.account_id, entityId: r.entity_id!, accountName: r.name, kind: r.kind as LiabilityView['kind'], asOf: r.as_of }
      if (r.institution) v.institution = r.institution
      if (r.apr) v.apr = r.apr
      const set = <K extends keyof LiabilityView>(k: K, x: LiabilityView[K] | undefined) => {
        if (x !== undefined && x !== null) v[k] = x
      }
      set('minimumPayment', money(r.minimum_payment_minor, c))
      set('nextPaymentDueDate', r.next_due_date ?? undefined)
      set('lastStatementBalance', money(r.last_statement_balance_minor, c))
      set('lastStatementDate', r.last_statement_date ?? undefined)
      set('lastPaymentAmount', money(r.last_payment_minor, c))
      set('lastPaymentDate', r.last_payment_date ?? undefined)
      set('originationPrincipal', money(r.origination_principal_minor, c))
      set('maturityDate', r.maturity_date ?? undefined)
      return v
    })
  }

  return {
    liabilities,

    async holdings(scope, opts = {}) {
      if (!scope.entityIds.length) return []
      const asOf = opts.asOf ?? '9999-12-31'
      let q = db
        .selectFrom('account_holdings as h')
        .innerJoin('accounts as a', 'a.id', 'h.account_id')
        .selectAll('h')
        .select(['a.entity_id', 'a.name as account_name'])
        .where('h.workspace_id', '=', scope.workspaceId)
        .where('a.entity_id', 'in', scope.entityIds)
        .where('a.closed_at', 'is', null)
        .where('h.as_of_date', '<=', asOf)
      if (opts.accountId) q = q.where('h.account_id', '=', opts.accountId)
      const rows = await q.orderBy('h.as_of_date', 'desc').execute()
      // The latest day per account, on or before asOf.
      const day = new Map<string, string>()
      for (const r of rows) if (!day.has(r.account_id)) day.set(r.account_id, r.as_of_date)
      return rows
        .filter((r) => day.get(r.account_id) === r.as_of_date)
        .map((r) => {
          const qty = Number(r.quantity)
          const value = { minor: Number(r.value_minor), currency: r.currency }
          const v: HoldingView = { accountId: r.account_id, entityId: r.entity_id!, accountName: r.account_name, securityId: r.security_id, quantity: r.quantity, value, asOf: r.as_of_date }
          if (r.ticker) v.ticker = r.ticker
          if (r.name) v.name = r.name
          if (qty && Number.isFinite(qty)) v.price = { minor: Math.round(value.minor / qty), currency: r.currency }
          const cb = n(r.cost_basis_minor)
          if (cb !== null) v.costBasis = { minor: cb, currency: r.currency }
          return v
        })
        .sort((a, b) => a.accountName.localeCompare(b.accountName) || b.value.minor - a.value.minor)
    },

    async paymentsDue(scope, from, days) {
      const through = addDays(from, days)
      return (await liabilities(scope))
        .filter((l) => l.nextPaymentDueDate && l.nextPaymentDueDate >= from && l.nextPaymentDueDate <= through && (l.minimumPayment?.minor ?? 0) > 0)
        .map((l) => ({
          date: l.nextPaymentDueDate!,
          entityId: l.entityId,
          kind: 'loan_payment' as const,
          paymentOf: l.kind === 'credit' ? ('card' as const) : ('loan' as const),
          what: `${l.accountName} minimum payment`,
          amount: { ...l.minimumPayment!, minor: -l.minimumPayment!.minor },
          confidence: 'scheduled' as const,
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    },
  }
}

/** The drawer's one-line terms for an account row ("Min $35 due Oct 28 · 24.9% APR"); only the parts reported. */
export function termsField(l: LiabilityView): { kind: LiabilityView['kind']; apr?: string; minimumPayment?: Money; nextPaymentDueDate?: string } {
  return { kind: l.kind, ...(l.apr ? { apr: l.apr } : {}), ...(l.minimumPayment ? { minimumPayment: l.minimumPayment } : {}), ...(l.nextPaymentDueDate ? { nextPaymentDueDate: l.nextPaymentDueDate } : {}) }
}

/** Terms by account id for these companies (empty when the reader has none). */
export async function termsByAccount(reader: { liabilities?: (scope: ReadScope) => Promise<LiabilityView[]> }, scope: ReadScope): Promise<Map<string, ReturnType<typeof termsField>>> {
  const rows = reader.liabilities && scope.entityIds.length ? await reader.liabilities(scope).catch(() => []) : []
  return new Map(rows.map((l) => [l.accountId, termsField(l)]))
}
