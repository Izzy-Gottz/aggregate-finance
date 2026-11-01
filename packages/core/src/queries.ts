// Shared read helpers for checks, metrics and reports.
import type { Currency, EntityId, Id, IsoDate, WorkspaceId } from '@agfn/contracts'
import type { SystemRole } from './coa.ts'
import type { Basis, EntityInfo, LedgerAccount, SourceRecord } from './model.ts'
import type { AccountDirectory, LedgerStore, LineRow } from './store.ts'

export type ToCurrency = (amount: { minor: number; currency: string }, to: Currency, date: IsoDate) => Promise<{ minor: number; currency: string; rate: string }>

export interface ReadContext {
  ws: WorkspaceId
  store: LedgerStore
  directory: AccountDirectory
  /** Current time (ISO). */
  now: string
  toCurrency: ToCurrency
  /**
   * Cache for results derived from the whole ledger (checks, review), shared across requests and keyed by the
   * workspace's write counter. Absent in tests and inside writes.
   */
  shared?: <T>(key: string, fn: () => Promise<T>) => Promise<T>
}

export function today(now: string): IsoDate {
  return now.slice(0, 10)
}

/** A workspace without a time zone is treated as US Eastern (most of our banks and users). */
export const DEFAULT_TIME_ZONE = 'America/New_York'

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The calendar day an instant falls on in a time zone ("2026-10-11T02:54Z" in New York is 2026-10-10). */
export function localDate(iso: string, timeZone: string): IsoDate {
  if (timeZone === 'UTC') return iso.slice(0, 10)
  let f = formatters.get(timeZone)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    } catch {
      return localDate(iso, DEFAULT_TIME_ZONE)
    }
    formatters.set(timeZone, f)
  }
  const parts = Object.fromEntries(f.formatToParts(new Date(iso)).map((p) => [p.type, p.value]))
  return `${parts['year']}-${parts['month']}-${parts['day']}`
}

const zones = new WeakMap<object, Map<WorkspaceId, { zone: Promise<string> | string; at: number }>>()

/** The workspace's time zone (cached for a minute per directory). */
export async function zoneOf(rc: { ws: WorkspaceId; directory: AccountDirectory }): Promise<string> {
  let m = zones.get(rc.directory)
  if (!m) {
    m = new Map()
    zones.set(rc.directory, m)
  }
  const hit = m.get(rc.ws)
  if (hit && Date.now() - hit.at < 60_000) return hit.zone
  // The read in flight is shared: an overview asks for "today" dozens of times at once.
  const zone = Promise.resolve(rc.directory.timeZone?.(rc.ws)).then((z) => z ?? DEFAULT_TIME_ZONE)
  m.set(rc.ws, { zone, at: Date.now() })
  zone.catch(() => m?.delete(rc.ws))
  return zone
}

/** Drop a workspace's cached time zone (it was just changed). */
export function forgetZone(directory: AccountDirectory, ws: WorkspaceId): void {
  zones.get(directory)?.delete(ws)
}

/** Today in the workspace's own time zone. */
export async function todayFor(rc: { ws: WorkspaceId; directory: AccountDirectory; now: string }): Promise<IsoDate> {
  return localDate(rc.now, await zoneOf(rc))
}

/**
 * Resolve a scope to entities. 'all' means every company; Personal is private and only included when named.
 * (The permission layer narrows ids further before calling in.)
 */
export async function scopeEntities(rc: ReadContext, ids: EntityId[] | 'all'): Promise<EntityInfo[]> {
  const all = await rc.directory.listEntities(rc.ws)
  if (ids === 'all') return all.filter((e) => e.kind === 'company')
  const set = new Set(ids)
  return all.filter((e) => set.has(e.id))
}

export interface AccountIndex {
  byId: Map<Id, LedgerAccount>
  byEntityRole: Map<string, LedgerAccount>
}

export async function ledgerAccounts(rc: ReadContext, entityIds: EntityId[]): Promise<AccountIndex> {
  // Within one request (a memo on the context): the workspace's chart once, filtered per scope.
  const memo = (rc as { memo?: Map<string, Promise<unknown>> }).memo
  let list: LedgerAccount[]
  if (memo) {
    let all = memo.get('ledgerAccounts|*') as Promise<LedgerAccount[]> | undefined
    if (!all) {
      all = rc.store.listLedgerAccounts(rc.ws)
      memo.set('ledgerAccounts|*', all)
    }
    const want = new Set(entityIds)
    list = (await all).filter((a) => want.has(a.entityId))
  } else list = await rc.store.listLedgerAccounts(rc.ws, entityIds)
  return { byId: new Map(list.map((a) => [a.id, a])), byEntityRole: new Map(list.map((a) => [`${a.entityId}|${a.role}`, a])) }
}

/**
 * A source account's provider balances (recorded snapshots). Within one request (a memo on the context) every
 * account's are read in one query and grouped; checks and coverage asked per account (dozens of reads cold).
 */
export async function snapshotsOf(rc: ReadContext, accountId: Id): Promise<SourceRecord[]> {
  const memo = (rc as { memo?: Map<string, Promise<unknown>> }).memo
  if (!memo) return rc.store.listRecords(rc.ws, { sourceAccountId: accountId, eventTypes: ['balance.snapshot'], statuses: ['recorded'] })
  let all = memo.get('snapshots|*') as Promise<Map<Id, SourceRecord[]>> | undefined
  if (!all) {
    all = rc.store.listRecords(rc.ws, { eventTypes: ['balance.snapshot'], statuses: ['recorded'] }).then((rows) => {
      const by = new Map<Id, SourceRecord[]>()
      for (const r of rows) if (r.sourceAccountId) by.set(r.sourceAccountId, [...(by.get(r.sourceAccountId) ?? []), r])
      return by
    })
    memo.set('snapshots|*', all)
  }
  return (await all).get(accountId) ?? []
}

/** An entity's ledger account for a role, from the chart (read once per request when the context has a memo). */
export async function ledgerAccountFor(rc: ReadContext, entityId: EntityId, role: string): Promise<LedgerAccount | null> {
  return (await ledgerAccounts(rc, [entityId])).byEntityRole.get(`${entityId}|${role}`) ?? null
}

/** Signed base balance (debit − credit) per ledger account up to a date. */
export async function baseBalances(rc: ReadContext, entityIds: EntityId[], basis: Basis, toDate?: IsoDate, fromDate?: IsoDate): Promise<Map<Id, number>> {
  const totals = await rc.store.accountTotals(rc.ws, { entityIds, basis, ...(toDate ? { toDate } : {}), ...(fromDate ? { fromDate } : {}) })
  const out = new Map<Id, number>()
  for (const t of totals) out.set(t.ledgerAccountId, (out.get(t.ledgerAccountId) ?? 0) + t.baseDebitMinor - t.baseCreditMinor)
  return out
}

/** Signed original-currency balances per ledger account and currency. */
export async function originalBalances(rc: ReadContext, entityIds: EntityId[], basis: Basis, toDate?: IsoDate): Promise<Map<Id, Map<Currency, number>>> {
  const totals = await rc.store.accountTotals(rc.ws, { entityIds, basis, ...(toDate ? { toDate } : {}) })
  const out = new Map<Id, Map<Currency, number>>()
  for (const t of totals) {
    const m = out.get(t.ledgerAccountId) ?? new Map<Currency, number>()
    m.set(t.currency, (m.get(t.currency) ?? 0) + t.debitMinor - t.creditMinor)
    out.set(t.ledgerAccountId, m)
  }
  return out
}

/** Sum line base amounts (signed debit − credit) converted to `currency`, each at its own date's rate. */
export async function sumLinesIn(rc: ReadContext, lines: readonly LineRow[], entities: ReadonlyMap<EntityId, EntityInfo>, currency: Currency): Promise<number> {
  // Group by (entity base currency, date) so each rate is fetched once.
  const groups = new Map<string, number>()
  for (const l of lines) {
    const base = entities.get(l.entityId)?.baseCurrency ?? currency
    const key = `${base}|${l.date}`
    groups.set(key, (groups.get(key) ?? 0) + l.baseDebitMinor - l.baseCreditMinor)
  }
  let total = 0
  for (const [key, minor] of groups) {
    const [base, date] = key.split('|') as [string, string]
    total += (await rc.toCurrency({ minor, currency: base }, currency, date)).minor
  }
  return total
}

export function roleOf(acct: LedgerAccount | undefined): SystemRole | '' {
  return acct?.role ?? ''
}

export function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`
}

export function addMonths(date: IsoDate, n: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

export function addDays(date: IsoDate, n: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function monthEnd(date: IsoDate): IsoDate {
  return addDays(addMonths(monthStart(date), 1), -1)
}

/** The last `n` complete calendar months before the month containing `asOf`, oldest first. */
export function trailingMonths(asOf: IsoDate, n: number): Array<{ from: IsoDate; to: IsoDate }> {
  const out: Array<{ from: IsoDate; to: IsoDate }> = []
  for (let i = n; i >= 1; i--) {
    const from = addMonths(monthStart(asOf), -i)
    out.push({ from, to: monthEnd(from) })
  }
  return out
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

const moneyLines = new WeakMap<object, Promise<Map<Id, LineRow[]>>>()

/** Ledger accounts whose lines checks, coverage and balances walk one account at a time. */
function isWalkedRole(role: string): boolean {
  return /^(cash|card|loan|processor):/.test(role) || role.startsWith('clearing_') || role === 'suspense'
}

/**
 * The cash-basis lines of one money, clearing or suspense ledger account (sorted by date), optionally up to a day.
 * The first call in a read context reads every such account's lines in one query and later calls are served from
 * it: checks and coverage walk accounts one by one, and one query per account was hundreds of round trips.
 */
export async function walkedLines(rc: ReadContext, ledgerAccountId: Id, toDate?: IsoDate): Promise<LineRow[]> {
  let all = moneyLines.get(rc)
  if (!all) {
    const load = async () => {
      const ids = (await rc.store.listLedgerAccounts(rc.ws)).filter((a) => isWalkedRole(a.role)).map((a) => a.id)
      const by = new Map<Id, LineRow[]>(ids.map((id) => [id, []]))
      for (let i = 0; i < ids.length; i += 400) {
        for (const l of await rc.store.listLines(rc.ws, { basis: 'cash', ledgerAccountIds: ids.slice(i, i + 400) })) by.get(l.ledgerAccountId)?.push(l)
      }
      return by
    }
    // Kept until the next write (the shared cache): every overview's cash and balance figures walk these lines, and the
    // read is the costliest one left (staging: ~280 ms, 15k rows, on every overview).
    all = rc.shared ? rc.shared('walked|cash', load) : load()
    moneyLines.set(rc, all)
    all.catch(() => moneyLines.delete(rc))
  }
  const lines = (await all).get(ledgerAccountId)
  // Not a walked account (or created since): read it directly.
  if (!lines) return rc.store.listLines(rc.ws, { basis: 'cash', ledgerAccountIds: [ledgerAccountId], ...(toDate ? { toDate } : {}) })
  return toDate ? lines.filter((l) => l.date <= toDate) : lines.slice()
}
