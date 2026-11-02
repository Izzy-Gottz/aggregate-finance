// What Review doesn't need to ask: the obvious is filed for the person, and every filing can be undone (filed list).
// Read side: this decides, the engine applies it after a settle.
import type { EntityId, Id, LinkType } from '@agfn/contracts'
import type { Link, SourceRecord } from './model.ts'
import { formatMoney } from './money.ts'
import { addDays, daysBetween, todayFor, type ReadContext } from './queries.ts'
import { listReviewItems, openingCandidate, shortDate } from './review.ts'

/** Who filed it, on the link or override. An undone filing is left marked so it's asked, not filed again. */
export const AUTO_FILED = 'auto:review'
export const AUTO_UNDONE = 'auto:undone'
const AUTO_STALE = 'auto:stale'
export { AUTO_STALE }

const MOVES: readonly LinkType[] = ['transfer', 'card_payment', 'intercompany']
/** How far apart two sides of a move can be and still be obvious. */
const OBVIOUS_DAYS = 3
/** Money in below this ($1) isn't worth a question. */
const IMMATERIAL_MINOR = 100
const RECENT_DAYS = 30

export interface AutoFilePlan {
  /** Proposals whose type no longer fits the rows' companies, where another proposal for the same rows does. */
  stale: Id[]
  links: Id[]
  /** Money in under $1: other income. */
  small: Id[]
  /** Old deposits in Personal from before the connection existed: opening balance. */
  opening: Id[]
}

/** A move's type fits where its rows are now: between entities it's intercompany, within one it isn't. */
export function moveFits(type: LinkType, from: SourceRecord, to: SourceRecord): boolean {
  return (from.entityId === to.entityId) === (type !== 'intercompany')
}

export async function planAutoFile(rc: ReadContext): Promise<AutoFilePlan> {
  const ws = rc.ws
  const plan: AutoFilePlan = { stale: [], links: [], small: [], opening: [] }
  const proposed = (await rc.store.listLinks(ws, { statuses: ['proposed'] })).filter((l) => MOVES.includes(l.type))
  const records = new Map((await rc.store.getRecords(ws, [...new Set(proposed.flatMap((l) => [l.fromId, l.toId]))])).map((r) => [r.id, r]))
  const entities = new Map((await rc.directory.listEntities(ws)).map((e) => [e.id, e]))
  const isPersonal = (r: SourceRecord) => entities.get(r.entityId as EntityId)?.kind === 'personal'
  // A closed month is the owner saying those numbers are final: nothing changes it without a person. Those stay questions.
  const lockedThrough = new Map<EntityId, string>()
  for (const l of await rc.store.listPeriodLocks(ws)) {
    if (l.removedAt) continue
    const held = lockedThrough.get(l.entityId)
    if (!held || l.through > held) lockedThrough.set(l.entityId, l.through)
  }
  const locked = (r: SourceRecord): boolean => {
    const through = r.entityId ? lockedThrough.get(r.entityId) : undefined
    return through !== undefined && r.date <= through
  }

  const ofPair = new Map<string, Link[]>()
  for (const l of proposed) {
    const key = [l.fromId, l.toId].sort().join('|')
    ofPair.set(key, [...(ofPair.get(key) ?? []), l])
  }
  const live: Link[] = []
  for (const links of ofPair.values()) {
    const [from, to] = [records.get((links[0] as Link).fromId), records.get((links[0] as Link).toId)]
    const right = from && to ? links.filter((l) => moveFits(l.type, records.get(l.fromId) as SourceRecord, records.get(l.toId) as SourceRecord)) : []
    if (right.length && right.length < links.length) plan.stale.push(...links.filter((l) => !right.includes(l)).map((l) => l.id))
    live.push(...(right.length ? right : links))
  }
  // Every row's number of possible partners: an obvious move is the only answer on both sides.
  const partners = new Map<Id, number>()
  for (const l of live) for (const id of [l.fromId, l.toId]) partners.set(id, (partners.get(id) ?? 0) + 1)
  for (const l of live) {
    const [from, to] = [records.get(l.fromId), records.get(l.toId)]
    if (!from || !to || !from.amount || !to.amount) continue
    if (l.scores?.['noAuto'] === 1) continue
    if (partners.get(from.id) !== 1 || partners.get(to.id) !== 1) continue
    if (from.origin !== 'connector' || to.origin !== 'connector') continue
    if (from.status !== 'posted' || to.status !== 'posted') continue
    if (from.amount.currency !== to.amount.currency || from.amount.minor !== -to.amount.minor) continue
    if (Math.abs(daysBetween(from.date, to.date)) > OBVIOUS_DAYS) continue
    // Pay, a draw or a loan: only the person knows.
    if (isPersonal(from) || isPersonal(to)) continue
    if (!moveFits(l.type, from, to) || locked(from) || locked(to)) continue
    plan.links.push(l.id)
  }

  // Money waiting for an answer, as Review asks it.
  const items = (await listReviewItems(rc)).filter((i) => i.kind === 'unexplained_money')
  const waiting = [...new Set(items.flatMap((i) => i.recordIds))]
  if (!waiting.length) return plan
  const rows = await rc.store.getRecords(ws, waiting)
  const overrides = new Map((await rc.store.listOverrides(ws)).map((o) => [o.recordId, o]))
  const accounts = new Map((await rc.directory.listSourceAccounts(ws)).map((a) => [a.id, a]))
  const connections = new Map((await rc.directory.listConnections(ws)).map((c) => [c.id, c]))
  const recentFrom = addDays(await todayFor(rc), -RECENT_DAYS)
  for (const r of rows) {
    if (overrides.get(r.id)?.updatedBy === AUTO_UNDONE || !r.amount || r.amount.minor <= 0 || locked(r)) continue
    if (r.amount.currency === 'USD' && r.amount.minor < IMMATERIAL_MINOR) {
      plan.small.push(r.id)
      continue
    }
    const account = r.sourceAccountId ? accounts.get(r.sourceAccountId) : undefined
    const connection = account?.connectionId ? connections.get(account.connectionId) : undefined
    if (connection && isPersonal(r) && openingCandidate(r, account?.accountType) && r.date < recentFrom && connection.createdAt && r.date < connection.createdAt.slice(0, 10)) plan.opening.push(r.id)
  }
  return plan
}

export interface FiledItem {
  /** "link:<id>" or "record:<id>": what undo takes. */
  id: string
  entityId: EntityId | null
  text: string
  filedAt: string
}

/** Everything filed for the person and not undone, newest first. */
export async function filedItems(rc: ReadContext, opts: { entityIds?: EntityId[] } = {}): Promise<FiledItem[]> {
  const ws = rc.ws
  const year = rc.now.slice(0, 4)
  const scope = opts.entityIds ? new Set(opts.entityIds) : null
  const inScope = (r: SourceRecord | undefined) => r !== undefined && (!scope || (r.entityId !== null && scope.has(r.entityId)))
  const links = (await rc.store.listLinks(ws, { statuses: ['confirmed'] })).filter((l) => l.decidedBy === AUTO_FILED)
  const overrides = (await rc.store.listOverrides(ws)).filter((o) => o.updatedBy === AUTO_FILED)
  const records = new Map((await rc.store.getRecords(ws, [...links.flatMap((l) => [l.fromId, l.toId]), ...overrides.map((o) => o.recordId)])).map((r) => [r.id, r]))
  const accounts = new Map((await rc.directory.listSourceAccounts(ws)).map((a) => [a.id, a.name]))
  const name = (r: SourceRecord) => (r.sourceAccountId ? (accounts.get(r.sourceAccountId) ?? 'an account') : 'an account')
  const out: FiledItem[] = []
  for (const l of links) {
    const [from, to] = [records.get(l.fromId), records.get(l.toId)]
    if (!from || !to || (!inScope(from) && !inScope(to)) || !from.amount) continue
    out.push({ id: `link:${l.id}`, entityId: from.entityId, text: `${formatMoney(Math.abs(from.amount.minor), from.amount.currency)} moved from ${name(from)} to ${name(to)} on ${shortDate(from.date, year)}`, filedAt: l.decidedAt ?? rc.now })
  }
  for (const o of overrides) {
    const r = records.get(o.recordId)
    if (!r || !inScope(r) || !r.amount) continue
    const what = o.category === 'opening_balance_equity' ? 'opening balance' : 'other income'
    out.push({ id: `record:${r.id}`, entityId: r.entityId, text: `${formatMoney(r.amount.minor, r.amount.currency)} into ${name(r)} on ${shortDate(r.date, year)}, filed as ${what}`, filedAt: o.updatedAt })
  }
  return out.sort((a, b) => (a.filedAt < b.filedAt ? 1 : a.filedAt > b.filedAt ? -1 : a.id < b.id ? -1 : 1))
}
