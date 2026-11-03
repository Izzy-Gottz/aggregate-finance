// Data health: one quiet line for the Workspace ("All reconciled" / "3 things need a look"), with the detail behind it.
import type { EntityId, Id } from '@agfn/contracts'
import { runChecks } from './checks.ts'
import { coverage } from './coverage.ts'
import { scopeEntities, today, type ReadContext, todayFor } from './queries.ts'
import { listReviewItems } from './review.ts'
import { syncedLongAgo } from './store.ts'

export interface DataHealth {
  status: 'ok' | 'needs_review'
  /** The grey line, e.g. "All reconciled" or "3 things need a look: 2 to review, 1 balance doesn't match". */
  line: string
  counts: {
    toReview: number
    failedChecks: number
    warnings: number
    /** Money that left one account and wasn't seen arriving (transfers, payouts) for over a week. */
    unmatchedInTransit: number
    /** Money in that isn't explained yet. */
    unexplainedMoneyIn: number
    staleSources: number
    /** Months in the last three with no statement or no rows where some were expected. */
    missingStatements: number
    /** Accounts with at most one balance, so nothing to compare: not wrong, not proven either. */
    notTiedOut: number
    /** Checks that passed (so an AI can say "12 checks pass", not only what failed). */
    passedChecks: number
  }
  /** Up to 10 items, most important first. Built from Aggregate's own data; may name counterparties. */
  items: Array<{ kind: 'failed_check' | 'review' | 'in_transit' | 'unexplained' | 'stale_source' | 'missing_statement'; entityId: EntityId | null; text: string; refId: Id | null }>
}


export async function dataHealth(rc: ReadContext, entityIds: EntityId[] | 'all' = 'all'): Promise<DataHealth> {
  const entities = await scopeEntities(rc, entityIds)
  const ids = entities.map((e) => e.id)
  const [checks, review, accounts, connections, cov] = await Promise.all([
    runChecks(rc, { entityIds: ids, asOf: (await todayFor(rc)) }),
    listReviewItems(rc, { entityIds: ids }),
    rc.directory.listSourceAccounts(rc.ws),
    rc.directory.listConnections(rc.ws),
    coverage(rc, { entityIds: ids }),
  ])
  // Gaps in the last three complete months; older ones stay in the coverage view.
  const localToday = await todayFor(rc)
  const since = addMonthsIso(localToday.slice(0, 7), -3)
  const missing = cov.flatMap((a) =>
    a.months
      .filter((m) => m.status === 'missing' && m.month >= since)
      .map((m) => ({ a, m, text: m.detail === 'no statement for this month' ? `Statement for ${a.name}${a.mask ? ` ··${a.mask}` : ''} missing for ${monthLabel(m.month, localToday.slice(0, 4))}` : `No ${a.name}${a.mask ? ` ··${a.mask}` : ''} transactions in ${monthLabel(m.month, localToday.slice(0, 4))}` })),
  )
  const scoped = new Set(ids)
  const connIds = new Set<Id>()
  for (const a of accounts) if (a.entityId && scoped.has(a.entityId) && a.connectionId) connIds.add(a.connectionId)
  for (const c of connections) if (c.entityId && scoped.has(c.entityId)) connIds.add(c.id)
  const now = Date.parse(rc.now)
  const stale = connections.filter((c) => connIds.has(c.id) && c.connectorKey !== 'manual' && c.status !== 'disconnected' && (c.status !== 'active' || syncedLongAgo(c, now)))
  // A synced account counted in cash or cards that has told us nothing yet (no balance, no row): its cash is unknown,
  // so the Workspace isn't "All reconciled". Connections that haven't synced at all are already in `stale`.
  const byConn = new Map(connections.map((c) => [c.id, c]))
  const silent: typeof accounts = []
  for (const a of accounts) {
    const c = a.connectionId ? byConn.get(a.connectionId) : undefined
    if (!a.entityId || !scoped.has(a.entityId) || a.duplicateOf || !c || c.connectorKey === 'manual' || c.connectorKey === 'files') continue
    if (c.status !== 'active' || !c.lastSuccessAt || stale.includes(c)) continue
    if (a.accountType !== 'credit_card' && !a.includeInCash) continue
    // A processor balance is the ledger's sum of its rows (providers never send one): synced with no sales is $0, not silent.
    if (a.accountType === 'processor_balance') continue
    const [any] = await rc.store.listRecords(rc.ws, { sourceAccountId: a.id, eventTypes: ['balance.snapshot', 'txn.upsert', 'processor.balance_txn'], limit: 1 })
    if (!any) silent.push(a)
  }

  const passedChecks = checks.filter((c) => c.status === 'ok').length
  const failed = checks.filter((c) => c.status === 'fail' && c.name !== 'clearing' && c.name !== 'suspense')
  const transit = checks.filter((c) => c.name === 'clearing' && c.status !== 'ok')
  const unexplained = review.filter((r) => r.kind === 'unexplained_money')
  const otherReview = review.filter((r) => r.kind !== 'unexplained_money')
  const warnings = checks.filter((c) => c.status === 'warn').length
  const notTiedOut = checks.filter((c) => c.name === 'balance_identity' && c.status === 'warn' && c.actualMinor === null).length

  // The same items on every run: checks, sources and months by what they say (review items come in a stable order).
  const byText = <T,>(xs: T[], t: (x: T) => string) => [...xs].sort((a, b) => (t(a) < t(b) ? -1 : t(a) > t(b) ? 1 : 0))
  const items: DataHealth['items'] = [
    ...byText(failed, (c) => c.message).map((c) => ({ kind: 'failed_check' as const, entityId: c.entityId, text: c.message, refId: c.subjectId })),
    ...byText(stale, (c) => c.displayName).map((c) => ({ kind: 'stale_source' as const, entityId: c.entityId, text: `${c.displayName} hasn't synced in over a day`, refId: c.id })),
    ...byText(silent, (a) => a.name).map((a) => ({ kind: 'stale_source' as const, entityId: a.entityId, text: `${a.name} hasn't reported a balance yet`, refId: a.id })),
    ...byText(missing, (x) => x.text).map((x) => ({ kind: 'missing_statement' as const, entityId: x.a.entityId, text: x.text, refId: x.a.accountId })),
    ...byText(transit, (c) => c.message).map((c) => ({ kind: 'in_transit' as const, entityId: c.entityId, text: c.message, refId: c.subjectId })),
    ...unexplained.map((r) => ({ kind: 'unexplained' as const, entityId: r.entityId, text: `What is this money? ${r.detail}`, refId: r.recordIds[0] ?? null })),
    ...otherReview.map((r) => ({ kind: 'review' as const, entityId: r.entityId, text: `${r.title} ${r.detail}`.trim(), refId: r.id })),
  ]
  const parts: string[] = []
  if (review.length) parts.push(`${review.length} to review`)
  // Say what failed: a report from the books that disagrees isn't a balance.
  const reports = failed.filter((c) => c.name === 'provider_report').length
  const twice = failed.filter((c) => c.name === 'duplicate_source').length
  const balances = failed.length - reports - twice
  if (balances) parts.push(`${balances} balance${balances === 1 ? " doesn't" : "s don't"} match`)
  if (reports) parts.push(`${reports} report${reports === 1 ? " doesn't" : "s don't"} match the books`)
  if (twice) parts.push(`${twice} source${twice === 1 ? '' : 's'} counted twice`)
  // Book payments waiting for the bank aren't transfers: say which.
  const atBank = transit.filter((c) => c.role === 'clearing_unmatched_receipts').length
  if (transit.length - atBank) parts.push(`${transit.length - atBank} transfer${transit.length - atBank === 1 ? '' : 's'} not seen arriving`)
  if (atBank) parts.push(`payments in the books not seen at the bank`)
  if (stale.length) parts.push(`${stale.length} connection${stale.length === 1 ? '' : 's'} not syncing`)
  if (silent.length) parts.push(`${silent.length} balance${silent.length === 1 ? '' : 's'} not reported yet`)
  if (missing.length) parts.push(`${missing.length} month${missing.length === 1 ? '' : 's'} missing`)
  const total = review.length + failed.length + transit.length + stale.length + silent.length + missing.length
  // Nothing for anyone to do, so not a thing that needs a look, but "All reconciled" would claim more than we know.
  const waiting = `${notTiedOut} account${notTiedOut === 1 ? '' : 's'} not tied out yet`
  const line = total ? `${total} thing${total === 1 ? '' : 's'} need${total === 1 ? 's' : ''} a look: ${parts.join(', ')}` : notTiedOut ? `Reconciled except ${waiting}` : 'All reconciled'
  return {
    status: total === 0 ? 'ok' : 'needs_review',
    line: total && notTiedOut ? `${line}. ${waiting[0]?.toUpperCase()}${waiting.slice(1)}` : line,
    counts: { toReview: review.length, failedChecks: failed.length, warnings, notTiedOut, unmatchedInTransit: transit.length, unexplainedMoneyIn: unexplained.length, staleSources: stale.length + silent.length, missingStatements: missing.length, passedChecks },
    items: items.slice(0, 10),
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "August", or "December 2025" outside the current year. */
function monthLabel(m: string, thisYear: string): string {
  const name = MONTHS[Number(m.slice(5, 7)) - 1] ?? m
  return m.slice(0, 4) === thisYear ? name : `${name} ${m.slice(0, 4)}`
}

function addMonthsIso(m: string, n: number): string {
  const total = Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1 + n
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`
}
