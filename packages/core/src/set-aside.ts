// Set-asides: a bucket holding money back in accounts, across companies. A fixed amount, a percent of the balance
// (follows it), or a percent of each inflow since a day. Worked out on every read from balances and posted rows, so
// nothing is stored, no job runs, and re-syncs and reversals need nothing. No money moves and nothing is posted: profit
// and reports never see it. `cash` stays the bank's number; `available_cash` leaves out what doesn't count (metrics.ts).
import { scopedSetAside, type EntityId, type Id, type IsoDate, type Money, type SetAsideView } from '@agfn/contracts'
import { cashRole } from './coa.ts'
import type { Bucket, SetAside, SetAsideAllocation, SourceAccountInfo } from './model.ts'
import { accountBalance, type MetricContext } from './metrics.ts'

export class SetAsideError extends Error {
  override name = 'SetAsideError'
}

const NOTE_MAX = 500
const NOT_HOLDABLE = new Set(['credit_card', 'loan'])

/** Roles on the other side of money in that make it an inflow: earned or received, a payout, or not yet explained. */
const isInflowRole = (r: string): boolean => ['revenue', 'interest_income', 'wages_income', 'other_income', 'clearing_payouts', 'suspense', 'uncategorized_expense'].includes(r) || r.startsWith('processor:')

/** Checks a set-aside against the accounts it names and every other bucket's percents. Throws with a plain reason. */
export function validateSetAside(sa: SetAside, accounts: readonly SourceAccountInfo[], others: readonly Bucket[]): void {
  if (sa.note !== undefined && sa.note.length > NOTE_MAX) throw new SetAsideError(`A note can be up to ${NOTE_MAX} characters`)
  if (sa.goal) {
    if (!Number.isSafeInteger(sa.goal.minor) || sa.goal.minor <= 0) throw new SetAsideError('A goal must be more than zero')
    if (sa.goal.by !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(sa.goal.by)) throw new SetAsideError('A goal date must be YYYY-MM-DD')
  }
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const percents = new Map<Id, number>()
  for (const o of others) for (const al of o.archivedAt ? [] : (o.setAside?.allocations ?? [])) if (al.kind === 'percent') percents.set(al.accountId, (percents.get(al.accountId) ?? 0) + al.percent)
  for (const al of sa.allocations) {
    const a = byId.get(al.accountId)
    if (!a) throw new SetAsideError(`Unknown account ${al.accountId}`)
    if (NOT_HOLDABLE.has(a.accountType)) throw new SetAsideError(`${a.name} is a card or loan: money can only be set aside from an account that holds it`)
    if (al.kind === 'fixed' && (!Number.isSafeInteger(al.minor) || al.minor <= 0)) throw new SetAsideError('A fixed amount must be more than zero')
    if (al.kind !== 'fixed' && !(al.percent > 0 && al.percent <= 100)) throw new SetAsideError('A percent must be more than 0 and at most 100')
    if (al.kind === 'inflow' && !/^\d{4}-\d{2}-\d{2}$/.test(al.since)) throw new SetAsideError('since must be YYYY-MM-DD')
    if (al.kind === 'percent') {
      const total = (percents.get(al.accountId) ?? 0) + al.percent
      if (total > 100) throw new SetAsideError(`More than 100% of ${a.name} would be set aside`)
      percents.set(al.accountId, total)
    }
  }
}

/**
 * A change made by someone who sees only some of the accounts: it replaces what they see, and allocations on accounts
 * they can't see stay. They couldn't have chosen to drop those, and an account's balance isn't theirs to infer.
 */
export function keepUnseenAllocations(current: SetAside | null | undefined, next: SetAside | null, seen: readonly Id[]): SetAside | null {
  const unseen = (current?.allocations ?? []).filter((al) => !seen.includes(al.accountId))
  if (!current || !unseen.length) return next
  return { ...(next ?? current), allocations: [...(next?.allocations ?? []), ...unseen] }
}

/** One allocation's held amount, in the account's currency. */
export interface HeldRow {
  bucketId: Id
  bucketName: string
  accountId: Id
  accountName: string
  entityId: EntityId | null
  /** Owned by the account: a closed or removed account holds nothing. */
  minor: number
  currency: string
  countsInCash: boolean
}

/** Inflows to the account since the day, less what left it tagged to this bucket (paying the tax releases the money). */
async function inflowHeld(rc: MetricContext, b: Bucket, a: SourceAccountInfo, al: Extract<SetAsideAllocation, { kind: 'inflow' }>, asOf: IsoDate): Promise<number> {
  if (!a.entityId) return 0
  const ledger = await rc.store.findLedgerAccount(rc.ws, a.entityId, cashRole(a.id, a.accountType))
  if (!ledger || al.since > asOf) return 0
  const cashLines = (await rc.store.listLines(rc.ws, { entityIds: [a.entityId], basis: 'cash', ledgerAccountIds: [ledger.id], fromDate: al.since, toDate: asOf })).filter((l) => l.currency === a.currency)
  if (!cashLines.length) return 0
  const sourceIds = [...new Set(cashLines.map((l) => l.sourceId))]
  const others = (await rc.store.listLines(rc.ws, { entityIds: [a.entityId], basis: 'cash', sourceIds })).filter((l) => l.ledgerAccountId !== ledger.id)
  const roles = new Map((await rc.store.listLedgerAccounts(rc.ws, [a.entityId])).map((x) => [x.id, x.role]))
  // Net over each row's entries: a row re-posted after an answer or a correction has a reversal that cancels the old one.
  const mine = others.filter((l) => l.currency === a.currency)
  const perRow = new Map<Id, number>()
  for (const l of mine) if (isInflowRole(roles.get(l.ledgerAccountId) ?? '')) perRow.set(l.sourceId, (perRow.get(l.sourceId) ?? 0) + l.creditMinor - l.debitMinor)
  // Only rows that net to money in: spending not yet categorized shares a role with money not yet explained.
  const inflows = [...perRow.values()].reduce((t, n) => t + Math.max(0, n), 0)
  const paid = mine.filter((l) => l.bucketId === b.id).reduce((t, l) => t + l.debitMinor - l.creditMinor, 0)
  return Math.max(0, Math.round((inflows * al.percent) / 100) - paid)
}

/** Every allocation of every live bucket in the workspace, whatever company the bucket or account is in. */
export async function heldRows(rc: MetricContext, asOf: IsoDate): Promise<HeldRow[]> {
  const buckets = (await rc.store.listBuckets(rc.ws)).filter((b) => !b.archivedAt && b.setAside?.allocations.length)
  if (!buckets.length) return []
  const accounts = new Map((await rc.directory.listSourceAccounts(rc.ws)).map((a) => [a.id, a]))
  const out: HeldRow[] = []
  for (const b of buckets) {
    const sa = b.setAside as SetAside
    for (const al of sa.allocations) {
      const a = accounts.get(al.accountId)
      if (!a || !a.entityId) continue
      const minor = al.kind === 'fixed' ? al.minor : al.kind === 'percent' ? Math.max(0, Math.round(((await accountBalance({ rc, asOf }, a)).minor * al.percent) / 100)) : await inflowHeld(rc, b, a, al, asOf)
      out.push({ bucketId: b.id, bucketName: b.name, accountId: a.id, accountName: a.name, entityId: a.entityId, minor, currency: a.currency, countsInCash: sa.countsInCash })
    }
  }
  return out
}

export interface UnderfundedAccount {
  accountId: Id
  accountName: string
  entityId: EntityId
  balance: Money
  held: Money
}

/** Accounts holding less than is set aside from them. */
export async function underfundedAccounts(rc: MetricContext, asOf: IsoDate): Promise<UnderfundedAccount[]> {
  const rows = await heldRows(rc, asOf)
  const accounts = new Map((await rc.directory.listSourceAccounts(rc.ws)).map((a) => [a.id, a]))
  const out: UnderfundedAccount[] = []
  for (const id of new Set(rows.map((r) => r.accountId))) {
    const a = accounts.get(id) as SourceAccountInfo
    const held = rows.filter((r) => r.accountId === id).reduce((t, r) => t + r.minor, 0)
    const bal = await accountBalance({ rc, asOf }, a)
    if (held > bal.minor) out.push({ accountId: id, accountName: a.name, entityId: a.entityId as EntityId, balance: { minor: bal.minor, currency: bal.currency }, held: { minor: held, currency: a.currency } })
  }
  return out
}

/** What a bucket holds, with goal progress. Callers that show it to someone cut perAccount to what they may see (scopedSetAside). */
export async function setAsideView(rc: MetricContext, b: Bucket, asOf: IsoDate): Promise<SetAsideView | null> {
  const sa = b.setAside
  if (!sa) return null
  const base = (await rc.directory.getEntity(rc.ws, b.entityId))?.baseCurrency ?? sa.goal?.currency ?? 'USD'
  const rows = (await heldRows(rc, asOf)).filter((r) => r.bucketId === b.id)
  const perAccount = []
  for (const r of rows) {
    const held = { minor: r.minor, currency: r.currency }
    perAccount.push({ accountId: r.accountId, accountName: r.accountName, entityId: r.entityId, held, heldBase: await rc.toCurrency(held, base, asOf) })
  }
  return scopedSetAside({ countsInCash: sa.countsInCash, held: { minor: 0, currency: base }, perAccount, ...(sa.goal ? { goal: { target: { minor: sa.goal.minor, currency: sa.goal.currency }, ...(sa.goal.by ? { by: sa.goal.by } : {}), progressPercent: 0 } } : {}), ...(sa.note ? { note: sa.note } : {}) }, null, b.createdAt.slice(0, 10), asOf)
}
