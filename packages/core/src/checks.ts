// Always-on checks. Each returns ok / warn / fail with the numbers behind it; failures surface as one grey
// "needs review" line in the UI, and in the coverage gaps and reason of the figures they affect (metrics.ts).
import type { Currency, EntityId, Id, IsoDate, Money, PaymentApplied, ReportSnapshot } from '@agfn/contracts'
import { convert, formatMoney, NOT_MONEY } from './money.ts'
import { assertionChecks } from './coverage.ts'
import { cashRole, isClearingRole } from './coa.ts'
import type { EntityInfo, SourceRecord } from './model.ts'
import { addDays, baseBalances, daysBetween, ledgerAccountFor, ledgerAccounts, scopeEntities, snapshotsOf, today, type ReadContext, todayFor, walkedLines } from './queries.ts'
import { profitAndLoss } from './reports.ts'
import { documentFx, fxFits } from './posting.ts'

export type CheckName = 'trial_balance' | 'balance_identity' | 'subledger_ar' | 'subledger_ap' | 'intercompany' | 'processor' | 'clearing' | 'suspense' | 'balance_assertion' | 'provider_report' | 'duplicate_source' | 'listing'

export interface CheckResult {
  name: CheckName
  status: 'ok' | 'warn' | 'fail'
  entityId: EntityId | null
  /** Source account or ledger account the check is about. */
  subjectId: Id | null
  expectedMinor: number | null
  actualMinor: number | null
  differenceMinor: number | null
  currency: string | null
  message: string
  /** balance_assertion only: the neighbouring day the ledger does match (a midnight date shift, not an error). */
  matchesOn?: IsoDate
  /** balance_assertion only: the account pinned (subjectId is the pin). */
  accountId?: Id
  /** clearing only: the clearing account's role (payouts and transfers in transit, or book payments not yet at the bank). */
  role?: string
}

export interface CheckOptions {
  entityIds?: EntityId[] | 'all'
  asOf?: IsoDate
  /** Only return warn/fail results. */
  problemsOnly?: boolean
}

export async function runChecks(rc: ReadContext, opts: CheckOptions = {}): Promise<CheckResult[]> {
  if (rc.shared) {
    // One cached run over every entity (Personal included) per day, whoever asks, filtered to the scope: an overview's
    // metrics, its health line and each company used to ask for their own run, cold.
    const [every, wanted] = await Promise.all([rc.directory.listEntities(rc.ws), scopeEntities(rc, opts.entityIds ?? 'all')])
    const asOf = opts.asOf ?? (await todayFor(rc))
    const results = await rc.shared(`checks|*|${asOf}`, () => computeChecks(rc, { entityIds: every.map((e) => e.id), asOf }))
    const scope = new Set<string>(wanted.map((e) => e.id))
    const mine = results.filter((r) => r.entityId === null || scope.has(r.entityId))
    return opts.problemsOnly ? mine.filter((r) => r.status !== 'ok') : mine
  }
  return computeChecks(rc, opts)
}

async function computeChecks(rc: ReadContext, opts: CheckOptions): Promise<CheckResult[]> {
  const entities = await scopeEntities(rc, opts.entityIds ?? 'all')
  const asOf = opts.asOf ?? (await todayFor(rc))
  const results: CheckResult[] = []
  results.push(...(await trialBalance(rc, entities)))
  results.push(...(await balanceIdentity(rc, entities, asOf)))
  results.push(...(await subledgers(rc, entities, asOf)))
  results.push(...(await intercompany(rc, entities, asOf)))
  results.push(...(await processorIdentity(rc, entities)))
  results.push(...(await clearingAndSuspense(rc, entities, asOf)))
  results.push(...(await assertionChecks(rc, entities.map((e) => e.id), asOf)))
  results.push(...(await providerReports(rc, entities, asOf)))
  results.push(...(await duplicateSources(rc, entities)))
  results.push(...(await listingOutcomes(rc, entities)))
  return opts.problemsOnly ? results.filter((r) => r.status !== 'ok') : results
}

const ok = (name: CheckName, entityId: EntityId | null, message: string, subjectId: Id | null = null): CheckResult => ({
  name,
  status: 'ok',
  entityId,
  subjectId,
  expectedMinor: null,
  actualMinor: null,
  differenceMinor: null,
  currency: null,
  message,
})

async function trialBalance(rc: ReadContext, entities: EntityInfo[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  // One pass per basis for every company at once (by each entry's company), where the store can; else per company.
  const ids = entities.map((e) => e.id)
  const byBasis = new Map<string, Map<EntityId, number>>()
  for (const basis of ['cash', 'accrual'] as const) {
    if (rc.store.entityNets) {
      byBasis.set(basis, await rc.store.entityNets(rc.ws, { entityIds: ids, basis }))
      continue
    }
    const per = new Map<EntityId, number>()
    for (const e of entities) per.set(e.id, (await rc.store.accountTotals(rc.ws, { entityIds: [e.id], basis })).reduce((s, t) => s + t.baseDebitMinor - t.baseCreditMinor, 0))
    byBasis.set(basis, per)
  }
  for (const e of entities) {
    for (const basis of ['cash', 'accrual'] as const) {
      const diff = byBasis.get(basis)?.get(e.id) ?? 0
      out.push(
        diff === 0
          ? ok('trial_balance', e.id, `${e.name}: debits equal credits (${basis})`)
          : {
              name: 'trial_balance',
              status: 'fail',
              entityId: e.id,
              subjectId: null,
              expectedMinor: 0,
              actualMinor: diff,
              differenceMinor: diff,
              currency: e.baseCurrency,
              message: `${e.name}: ${basis} ledger is out of balance by ${formatMoney(diff, e.baseCurrency)}`,
            },
      )
    }
  }
  // Every entry is checked on insert, so a per-entry scan (a full pass over the lines) only runs to find the culprits
  // when a company's totals are already off.
  const unbalanced = out.some((r) => r.status === 'fail') ? new Set(await rc.store.unbalancedEntries(rc.ws)) : new Set<Id>()
  if (unbalanced.size > 0) {
    out.push({ name: 'trial_balance', status: 'fail', entityId: null, subjectId: [...unbalanced][0] ?? null, expectedMinor: 0, actualMinor: unbalanced.size, differenceMinor: null, currency: null, message: `${unbalanced.size} journal entries don't balance` })
  }
  return out
}

/** Banks often move the balance a business day or two before or after the date on the row (pending, posting lag). */
export const POSTING_LAG_BUSINESS_DAYS = 2

/** Weekdays after `a` up to and including `b` (0 when b ≤ a). */
export function businessDaysBetween(a: IsoDate, b: IsoDate): number {
  let n = 0
  for (let d = a; d < b; ) {
    d = addDays(d, 1)
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (wd !== 0 && wd !== 6) n++
  }
  return n
}

/**
 * Provider balance = ledger balance, allowing for posting lag. On each day with a provider balance, the gap is that
 * balance minus the ledger's. A gap that opens and closes again within POSTING_LAG_BUSINESS_DAYS is a bank posting a
 * row on another day than its date, not a problem. A gap that's still open after that fails, one item per account
 * (the latest), with what the provider moved and what was posted since the gap opened. One still inside the window is
 * a warning: it may yet settle.
 */
async function balanceIdentity(rc: ReadContext, entities: EntityInfo[], asOf: IsoDate): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ids = new Set(entities.map((e) => e.id))
  // Points or crypto with no ISO code are never posted, so there are no rows to check its balance against. A brokerage
  // balance includes the market value of its holdings, which no posted row explains: holdings carry their own values.
  // A loan's balance grows by interest the same way, and many lenders send no rows at all.
  const accounts = (await rc.directory.listSourceAccounts(rc.ws)).filter(
    (a) => a.entityId && ids.has(a.entityId) && !a.duplicateOf && a.currency !== NOT_MONEY && a.accountType !== 'investment' && a.accountType !== 'loan',
  )
  const pinned = new Set((await rc.store.listAssertions(rc.ws, accounts.map((a) => a.id))).map((x) => x.accountId))
  for (const acc of accounts) {
    const snaps = latestPerDay(
      (await snapshotsOf(rc, acc.id)).filter((r) => r.date <= asOf),
    )
    if (snaps.length === 0) {
      // A bank or card with rows and no balance at all: its figure is only the ledger's. Processors never send one.
      if ((acc.accountType === 'depository' || acc.accountType === 'credit_card') && !pinned.has(acc.id) && (await rc.store.listRecords(rc.ws, { sourceAccountId: acc.id, eventTypes: ['txn.upsert'], statuses: ['posted'], limit: 1 })).length) {
        out.push({ name: 'balance_identity', status: 'warn', entityId: acc.entityId, subjectId: acc.id, expectedMinor: null, actualMinor: null, differenceMinor: null, currency: acc.currency, message: `${acc.name}: not tied out yet, it has no balance to compare with` })
      }
      continue
    }
    const ledger = await ledgerAccountFor(rc, acc.entityId as EntityId, cashRole(acc.id, acc.accountType))
    const lines = ledger ? await walkedLines(rc, ledger.id, asOf) : []
    const cur = snapCurrent(snaps[0] as SourceRecord).currency
    // Rows that carry an instant (processor rows) count against a snapshot by instant: a payout at 02:00Z belongs
    // after a 23:59Z balance even when both fall on the same local day. Date-only rows count by local day.
    const instantOf = new Map<Id, string>()
    if (acc.accountType === 'processor_balance') {
      for (const r of await rc.store.listRecords(rc.ws, { sourceAccountId: acc.id, eventTypes: ['processor.balance_txn'] })) {
        if (r.event.type === 'processor.balance_txn' && r.event.at) instantOf.set(r.id, r.event.at)
      }
    }
    const byDay = runningSum(lines.filter((l) => l.currency === cur && !instantOf.has(l.sourceId)).map((l) => [l.date, l.debitMinor - l.creditMinor]))
    const byInstant = runningSum(
      lines
        .filter((l) => l.currency === cur && instantOf.has(l.sourceId))
        .map((l): [string, number] => [instantOf.get(l.sourceId) as string, l.debitMinor - l.creditMinor])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    )
    const balanceAt = (snap: SourceRecord): number => byDay(snap.date) + (snap.event.type === 'balance.snapshot' ? byInstant(snap.event.at) : 0)
    const gap = (snap: SourceRecord): number => snapCurrent(snap).minor - balanceAt(snap)
    const moved = (s0: SourceRecord, s1: SourceRecord, status: 'fail' | 'warn'): CheckResult => {
      const expected = snapCurrent(s1).minor - snapCurrent(s0).minor
      const actual = balanceAt(s1) - balanceAt(s0)
      return {
        name: 'balance_identity',
        status,
        entityId: acc.entityId,
        subjectId: acc.id,
        expectedMinor: expected,
        actualMinor: actual,
        differenceMinor: expected - actual,
        currency: cur,
        message: `${acc.name}: provider balance moved ${formatMoney(expected, cur)} between ${s0.date} and ${s1.date}, posted rows add up to ${formatMoney(actual, cur)}`,
      }
    }
    // The settled gap, and where the current departure from it started (the last snapshot before it opened).
    let base = gap(snaps[0] as SourceRecord)
    let openedAfter: SourceRecord | null = null
    let opened: IsoDate | null = null
    let problem: CheckResult | null = null
    for (let i = 1; i < snaps.length; i++) {
      const s = snaps[i] as SourceRecord
      const g = gap(s)
      if (g === 0 || g === base) {
        // An exact match with the provider settles the account, whatever happened before (a row that posted late).
        if (g === 0) {
          base = 0
          problem = null
        }
        openedAfter = opened = null
        continue
      }
      if (!openedAfter) {
        openedAfter = snaps[i - 1] as SourceRecord
        opened = s.date
      }
      if (businessDaysBetween(opened as IsoDate, s.date) > POSTING_LAG_BUSINESS_DAYS) {
        // Still open past the window: a real difference. Keep the latest, and take this gap as the new settled one so
        // the same difference isn't reported again on every later day.
        problem = moved(openedAfter, s, 'fail')
        base = g
        openedAfter = opened = null
      }
    }
    const last = snaps[snaps.length - 1] as SourceRecord
    if (openedAfter && opened) {
      const settling = businessDaysBetween(opened, asOf) <= POSTING_LAG_BUSINESS_DAYS
      // A failed difference is the more useful item; a newer gap that may still settle is only shown if nothing failed.
      if (!settling) problem = moved(openedAfter, last, 'fail')
      else if (!problem) problem = moved(openedAfter, last, 'warn')
    }
    if (problem) {
      out.push(problem)
      continue
    }
    const diff = gap(last)
    if (diff !== 0) {
      const settling = businessDaysBetween(last.date, asOf) <= 1
      out.push({
        name: 'balance_identity',
        status: settling ? 'warn' : 'fail',
        entityId: acc.entityId,
        subjectId: acc.id,
        expectedMinor: snapCurrent(last).minor,
        actualMinor: balanceAt(last),
        differenceMinor: diff,
        currency: cur,
        message: `${acc.name}: provider says ${formatMoney(snapCurrent(last).minor, cur)}, the ledger says ${formatMoney(balanceAt(last), cur)} on ${last.date}`,
      })
    } else if (snaps.length === 1 && !pinned.has(acc.id)) {
      // The opening balance is worked out from this one snapshot, so it matches by construction. That proves nothing yet.
      out.push({ name: 'balance_identity', status: 'warn', entityId: acc.entityId, subjectId: acc.id, expectedMinor: null, actualMinor: null, differenceMinor: null, currency: cur, message: `${acc.name}: not tied out yet, it needs a second balance or a statement to compare` })
    } else {
      out.push(ok('balance_identity', acc.entityId, `${acc.name}: matches the provider balance`, acc.id))
    }
  }
  return out
}

/** Sum of amounts with key ≤ k, from (key, amount) pairs sorted by key: one pass to build, a binary search per ask. */
function runningSum(pairs: Array<[string, number]>): (k: string) => number {
  const keys: string[] = []
  const totals: number[] = []
  let total = 0
  for (const [k, v] of pairs) {
    total += v
    if (keys[keys.length - 1] === k) totals[totals.length - 1] = total
    else {
      keys.push(k)
      totals.push(total)
    }
  }
  return (k) => {
    let lo = 0
    let hi = keys.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((keys[mid] as string) <= k) lo = mid + 1
      else hi = mid
    }
    return lo === 0 ? 0 : (totals[lo - 1] as number)
  }
}

export function snapCurrent(r: SourceRecord): { minor: number; currency: string } {
  if (r.event.type !== 'balance.snapshot') throw new Error('not a snapshot')
  return r.event.current
}

export function latestPerDay(snaps: SourceRecord[]): SourceRecord[] {
  const byDay = new Map<string, SourceRecord>()
  for (const s of snaps) {
    if (s.event.type !== 'balance.snapshot') continue
    const prev = byDay.get(s.date)
    if (!prev || (prev.event.type === 'balance.snapshot' && prev.event.at < s.event.at)) byDay.set(s.date, s)
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

export interface OpenItem {
  record: SourceRecord
  remainingMinor: number
  currency: string
  dueDate: IsoDate | null
}

/** Open invoices/bills with what's still owed: total − max(provider amountPaid, payments we've seen) − credit notes. */
export async function openItems(rc: ReadContext, entityIds: EntityId[], direction: 'receivable' | 'payable', asOf: IsoDate): Promise<OpenItem[]> {
  const both = rc.shared ? await rc.shared(`open|${[...entityIds].sort().join(',')}|${asOf}`, () => computeOpenItems(rc, entityIds, asOf)) : await computeOpenItems(rc, entityIds, asOf)
  return both[direction]
}

async function computeOpenItems(rc: ReadContext, entityIds: EntityId[], asOf: IsoDate): Promise<Record<'receivable' | 'payable', OpenItem[]>> {
  const records = await rc.store.listRecords(rc.ws, { entityIds, eventTypes: ['invoice.upsert', 'payment.applied', 'credit_note.upsert'], statuses: ['posted'] })
  const links = await rc.store.listLinks(rc.ws, { types: ['invoice_payment'], statuses: ['confirmed'] })
  // Payments count from the day they happened: a bill paid after asOf is still open on asOf (AP still holds it).
  const paidOn = new Map((await rc.store.getRecords(rc.ws, [...new Set(links.map((l) => l.toId))])).map((r) => [r.id, r.date]))
  const linked = new Map<Id, number>()
  const hasPayments = new Set<string>()
  for (const l of links) {
    hasPayments.add(l.fromId)
    const day = paidOn.get(l.toId)
    if (day && day <= asOf) linked.set(l.fromId, (linked.get(l.fromId) ?? 0) + Math.abs(l.amount?.minor ?? 0))
  }
  const applied = new Map<string, number>()
  const credited = new Map<string, number>()
  for (const r of records) {
    if (r.event.type === 'payment.applied') for (const a of r.event.applications) hasPayments.add(`${r.connectionId}|${a.invoiceExternalId}`)
    if (r.date > asOf) continue
    if (r.event.type === 'payment.applied') {
      const p: PaymentApplied = r.event
      for (const a of p.applications) applied.set(`${r.connectionId}|${a.invoiceExternalId}`, (applied.get(`${r.connectionId}|${a.invoiceExternalId}`) ?? 0) + a.amount.minor)
    }
    if (r.event.type === 'credit_note.upsert' && r.event.invoiceExternalId && (r.event.appliedTo === 'invoice' || r.event.appliedTo === 'out_of_band')) {
      const k = `${r.connectionId}|${r.event.invoiceExternalId}`
      credited.set(k, (credited.get(k) ?? 0) + r.event.amount.minor)
    }
  }
  const out: Record<'receivable' | 'payable', OpenItem[]> = { receivable: [], payable: [] }
  for (const r of records) {
    if (r.event.type !== 'invoice.upsert' || r.date > asOf) continue
    const inv = r.event
    if (inv.status === 'draft' || inv.status === 'void' || inv.status === 'uncollectible') continue
    const key = `${r.connectionId}|${r.externalId}`
    // Dated payments when the source sends them (as of asOf); the document's own "amount paid" only for sources
    // that never do (it has no date, and it's what the posting relied on too).
    const dated = (linked.get(r.id) ?? 0) + (applied.get(key) ?? 0)
    const paid = hasPayments.has(r.id) || hasPayments.has(key) ? dated : Math.max(inv.amountPaid.minor, dated)
    const remaining = inv.total.minor - paid - (credited.get(key) ?? 0)
    if (remaining > 0) out[inv.direction].push({ record: r, remainingMinor: remaining, currency: inv.total.currency, dueDate: inv.dueDate ?? null })
  }
  return out
}

async function subledgers(rc: ReadContext, entities: EntityInfo[], asOf: IsoDate): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const e of entities) {
    const idx = await ledgerAccounts(rc, [e.id])
    const bal = await baseBalances(rc, [e.id], 'accrual', asOf)
    for (const [direction, role, name] of [['receivable', 'ar', 'subledger_ar'], ['payable', 'ap', 'subledger_ap']] as const) {
      const acct = idx.byEntityRole.get(`${e.id}|${role}`)
      const items = await openItems(rc, [e.id], direction, asOf)
      if (!acct && items.length === 0) continue
      let sub = 0
      for (const it of items) {
        // At the rate it was booked at: the provider's own when it sent one, else that day's market rate.
        const amount = { minor: it.remainingMinor, currency: it.currency }
        const fx = documentFx(it.record.event)
        sub += fxFits(fx, it.currency, e.baseCurrency) ? convert(amount, e.baseCurrency, fx.rate).minor : (await rc.toCurrency(amount, e.baseCurrency, it.record.date)).minor
      }
      const control = acct ? (bal.get(acct.id) ?? 0) * (direction === 'receivable' ? 1 : -1) : 0
      const diff = control - sub
      out.push(
        diff === 0
          ? ok(name, e.id, `${e.name}: ${direction === 'receivable' ? 'money owed to you' : 'bills'} match the ledger`)
          : {
              name,
              status: 'fail',
              entityId: e.id,
              subjectId: acct?.id ?? null,
              expectedMinor: sub,
              actualMinor: control,
              differenceMinor: diff,
              currency: e.baseCurrency,
              message: `${e.name}: open ${direction === 'receivable' ? 'invoices' : 'bills'} total ${formatMoney(sub, e.baseCurrency)}, the ${role.toUpperCase()} account says ${formatMoney(control, e.baseCurrency)}`,
            },
      )
    }
  }
  return out
}

async function intercompany(rc: ReadContext, entities: EntityInfo[], asOf: IsoDate): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const companies = entities.filter((e) => e.kind === 'company')
  const reporting = await rc.directory.reportingCurrency(rc.ws)
  const pairBalance = async (x: EntityInfo, y: EntityInfo): Promise<{ minor: number; foreign: boolean }> => {
    const idx = await ledgerAccounts(rc, [x.id])
    const bal = await baseBalances(rc, [x.id], 'cash', asOf)
    let sum = 0
    for (const role of [`due_from:${y.id}`, `due_to:${y.id}`]) {
      const a = idx.byEntityRole.get(`${x.id}|${role}`)
      if (a) sum += bal.get(a.id) ?? 0
    }
    return { minor: (await rc.toCurrency({ minor: sum, currency: x.baseCurrency }, reporting, asOf)).minor, foreign: x.baseCurrency !== reporting }
  }
  for (let i = 0; i < companies.length; i++) {
    for (let j = i + 1; j < companies.length; j++) {
      const a = companies[i] as EntityInfo
      const b = companies[j] as EntityInfo
      const [x, y] = await Promise.all([pairBalance(a, b), pairBalance(b, a)])
      if (x.minor === 0 && y.minor === 0) continue
      const net = x.minor + y.minor
      const tolerance = a.baseCurrency !== b.baseCurrency ? Math.ceil(Math.max(Math.abs(x.minor), Math.abs(y.minor)) * 0.01) : 0
      out.push(
        net === 0
          ? ok('intercompany', a.id, `${a.name} ↔ ${b.name}: both sides agree`)
          : {
              name: 'intercompany',
              status: Math.abs(net) <= tolerance ? 'warn' : 'fail',
              entityId: a.id,
              subjectId: b.id,
              expectedMinor: -x.minor,
              actualMinor: y.minor,
              differenceMinor: net,
              currency: reporting,
              message: `${a.name} ↔ ${b.name}: what one says it's owed and the other says it owes differ by ${formatMoney(Math.abs(net), reporting)}${Math.abs(net) <= tolerance ? ' (currency movement)' : ''}`,
            },
      )
    }
  }
  return out
}

/** Stripe-style: gross − fees − refunds − payouts (and other movements) = change in the processor balance. */
async function processorIdentity(rc: ReadContext, entities: EntityInfo[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ids = new Set(entities.map((e) => e.id))
  const accounts = (await rc.directory.listSourceAccounts(rc.ws)).filter((a) => a.accountType === 'processor_balance' && a.entityId && ids.has(a.entityId) && !a.duplicateOf)
  for (const acc of accounts) {
    const snaps = latestPerDay(await rc.store.listRecords(rc.ws, { sourceAccountId: acc.id, eventTypes: ['balance.snapshot'], statuses: ['recorded'] }))
    if (snaps.length < 2) continue
    const txns = await rc.store.listRecords(rc.ws, { sourceAccountId: acc.id, eventTypes: ['processor.balance_txn'], statuses: ['posted'] })
    const s0 = snaps[0] as SourceRecord
    const s1 = snaps[snaps.length - 1] as SourceRecord
    // By instant when the rows and both balances carry one (they straddle local-day edges), else by local day.
    const at = (r: SourceRecord): string | null => (r.event.type === 'balance.snapshot' || r.event.type === 'processor.balance_txn' ? (r.event.at ?? null) : null)
    const [a0, a1] = [at(s0), at(s1)]
    const inWindow = txns.filter((t) => {
      const ta = at(t)
      return ta && a0 && a1 ? ta > a0 && ta <= a1 : t.date > s0.date && t.date <= s1.date
    })
    const sums = { gross: 0, fees: 0, refunds: 0, payouts: 0, other: 0 }
    for (const t of inWindow) {
      if (t.event.type !== 'processor.balance_txn') continue
      const ev = t.event
      if (ev.kind === 'charge') {
        sums.gross += ev.gross.minor
        sums.fees += ev.fee.minor
      } else if (ev.kind === 'refund' || ev.kind === 'dispute') {
        sums.refunds += -ev.gross.minor
        sums.fees += ev.fee.minor
      } else if (ev.kind === 'payout') sums.payouts += -ev.net.minor
      else if (ev.kind === 'fee') sums.fees += -ev.net.minor
      else sums.other += ev.net.minor
    }
    const change = snapCurrent(s1).minor - snapCurrent(s0).minor
    const lhs = sums.gross - sums.fees - sums.refunds + sums.other
    const rhs = sums.payouts + change
    const cur = snapCurrent(s1).currency
    const m = (minor: number) => formatMoney(minor, cur)
    out.push(
      lhs === rhs
        ? ok('processor', acc.entityId, `${acc.name}: gross − fees − refunds = payouts + balance change`, acc.id)
        : {
            name: 'processor',
            status: 'fail',
            entityId: acc.entityId,
            subjectId: acc.id,
            expectedMinor: rhs,
            actualMinor: lhs,
            differenceMinor: lhs - rhs,
            currency: cur,
            message: `${acc.name} ${s0.date}→${s1.date}: gross ${m(sums.gross)} − fees ${m(sums.fees)} − refunds ${m(sums.refunds)}${sums.other ? ` + other ${m(sums.other)}` : ''} = ${m(lhs)}, but payouts ${m(sums.payouts)} + balance change ${m(change)} = ${m(rhs)}`,
          },
    )
  }
  return out
}

function clearingMessage(company: string, role: string, amount: string, positive: boolean): string {
  if (role === 'clearing_unmatched_receipts') return `${company}: payments in the books, ${amount} net ${positive ? 'in' : 'out'}, not seen at the bank for over a week`
  const what = role === 'clearing_payouts' ? 'payouts' : role === 'clearing_equity' ? 'investment money' : 'transfers'
  return `${company}: ${amount} of ${what} not seen arriving for over a week`
}

/** Money in transit should arrive within a week; unexplained money in should be explained. */
async function clearingAndSuspense(rc: ReadContext, entities: EntityInfo[], asOf: IsoDate): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const e of entities) {
    const idx = await ledgerAccounts(rc, [e.id])
    for (const acct of idx.byId.values()) {
      const isSuspense = acct.role === 'suspense'
      if (!isClearingRole(acct.role) && !isSuspense) continue
      const lines = (await walkedLines(rc, acct.id, asOf)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      // Age from when the balance last stood at zero: years of cleared history don't make today's item old.
      let bal = 0
      let since: IsoDate | null = null
      for (const l of lines) {
        if (bal === 0) since = l.date
        bal += l.baseDebitMinor - l.baseCreditMinor
      }
      if (bal === 0) continue
      const age = daysBetween(since ?? asOf, asOf)
      if (!isSuspense && age <= 7) continue
      out.push({
        name: isSuspense ? 'suspense' : 'clearing',
        status: 'warn',
        entityId: e.id,
        subjectId: acct.id,
        expectedMinor: 0,
        actualMinor: bal,
        differenceMinor: bal,
        currency: e.baseCurrency,
        message: isSuspense ? `${e.name}: ${formatMoney(Math.abs(bal), e.baseCurrency)} of money in isn't explained yet` : clearingMessage(e.name, acct.role, formatMoney(Math.abs(bal), e.baseCurrency), bal > 0),
        ...(isSuspense ? {} : { role: acct.role }),
      })
    }
  }
  return out
}


const PROVIDER_NAMES: Record<string, string> = { quickbooks: 'QuickBooks', xero: 'Xero', freshbooks: 'FreshBooks' }

/** Figures a store or invoicing tool reports, stored as report snapshots: not a company's books, so never compared with the ledger's P&L. */
const NOT_BOOKS = new Set(['woocommerce', 'harvest', 'lightspeed', 'sumup', 'adsense', 'youtube', 'pinterest', 'squarespace', 'wix'])

/** Records that put amounts on a P&L outside bank feeds (books, billing and payroll sources). */
const BOOKED_TYPES = ['invoice.upsert', 'credit_note.upsert', 'payment.applied', 'payroll.run', 'journal.upsert', 'equity.event']

/** "QuickBooks" for a QuickBooks connection ("QuickBooks · Acme" display names too); else "the books". */
function providerName(c: { connectorKey: string; displayName: string } | undefined): string {
  if (!c) return 'the books'
  return PROVIDER_NAMES[c.connectorKey] ?? (c.displayName.includes(' · ') ? (c.displayName.split(' · ')[0] as string) : 'the books')
}

/** The provider's own bottom line, e.g. QuickBooks "Net Income" or Xero "Net Profit" (null when the report has none). */
export function providerNetIncome(rows: ReportSnapshot['rows']): Money | null {
  const net = [...rows].reverse().find((r) => /^net (income|profit|earnings)$/i.test(r.account.trim()))
  return net ? net.amount : null
}

/**
 * Our profit and loss against the books' own, per company, period and basis (QuickBooks/Xero report pages stored at
 * sync). A gap means a connector missed entries or something is counted twice: the P&L would be quietly wrong.
 * Each period's latest report counts; the last twelve months are checked; a period still running only warns.
 */
/**
 * The same provider's documents posted by two connections (a Xero organisation connected again, the old connection
 * kept with its data): invoices, bills, payments and journals would all count twice. Bank rows have their own
 * duplicate handling (duplicateOf); this covers the books.
 */
const LISTING_NOUNS: Record<string, [string, string]> = { invoice: ['invoice', 'invoices'], bill: ['bill', 'bills'], journal: ['journal entry', 'journal entries'], payment: ['payment', 'payments'], txn: ['transaction', 'transactions'], credit_note: ['credit note', 'credit notes'] }

/**
 * What the latest completed listing of each connection and kind did: records deleted at the provider were voided
 * (ok, said once), or the safety limits stopped it (warn: someone should look at the connection).
 */
async function listingOutcomes(rc: ReadContext, entities: EntityInfo[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ids = new Set(entities.map((e) => e.id))
  const conns = new Map((await rc.directory.listConnections(rc.ws)).map((c) => [c.id, c]))
  for (const l of await rc.store.listListings(rc.ws)) {
    const c = conns.get(l.connectionId)
    if (!c || !c.entityId || !ids.has(c.entityId) || c.status === 'disconnected') continue
    const where = providerName(c) === 'the books' ? c.displayName : providerName(c)
    const [one, many] = LISTING_NOUNS[l.kind] ?? [l.kind, l.kind]
    if (l.skippedReason) {
      out.push({ name: 'listing', status: 'warn', entityId: c.entityId, subjectId: c.id, expectedMinor: null, actualMinor: null, differenceMinor: null, currency: null, message: `${where}: ${many} missing from its latest full list weren't voided, because ${l.skippedReason}. Check the connection; if they were really deleted there, the next full sync will try again.` })
    } else if (l.voided > 0) {
      out.push(ok('listing', c.entityId, `${where}: ${l.voided} ${l.voided === 1 ? one : many} no longer in ${where} ${l.voided === 1 ? 'was' : 'were'} voided`, c.id))
    }
  }
  return out
}

async function duplicateSources(rc: ReadContext, entities: EntityInfo[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ids = entities.map((e) => e.id)
  if (ids.length === 0) return out
  const conns = new Map((await rc.directory.listConnections(rc.ws)).map((c) => [c.id, c]))
  const recs = await rc.store.listRecords(rc.ws, { entityIds: ids, statuses: ['posted'], eventTypes: BOOKED_TYPES })
  // entity|connector|type|externalId → connections that posted it
  const seen = new Map<string, Set<Id>>()
  for (const r of recs) {
    const c = conns.get(r.connectionId)
    if (!c || !r.entityId) continue
    const k = `${r.entityId}|${c.connectorKey}|${r.eventType}|${r.externalId}`
    const set = seen.get(k) ?? new Set<Id>()
    set.add(r.connectionId)
    seen.set(k, set)
  }
  // Per company and pair of connections: how many documents both posted.
  const pairs = new Map<string, { entityId: EntityId; conns: Id[]; n: number }>()
  for (const [k, set] of seen) {
    if (set.size < 2) continue
    const entityId = k.split('|')[0] as EntityId
    const cs = [...set].sort()
    const pk = `${entityId}|${cs.join(',')}`
    const p = pairs.get(pk) ?? { entityId, conns: cs, n: 0 }
    p.n++
    pairs.set(pk, p)
  }
  const byEntity = new Map(entities.map((e) => [e.id, e]))
  for (const p of pairs.values()) {
    const e = byEntity.get(p.entityId)
    const names = p.conns.map((id) => {
      const c = conns.get(id)
      return `${c?.displayName ?? 'a connection'}${c?.status === 'disconnected' ? ' (disconnected)' : ''}`
    })
    out.push({
      name: 'duplicate_source',
      status: 'fail',
      entityId: p.entityId,
      subjectId: p.conns[0] ?? null,
      expectedMinor: null,
      actualMinor: null,
      differenceMinor: null,
      currency: null,
      message: `${e?.name ?? 'A company'}: ${names.join(' and ')} both posted the same ${p.n} document${p.n === 1 ? '' : 's'}, so they count twice. Remove the old connection with its data.`,
    })
  }
  return out
}

async function providerReports(rc: ReadContext, entities: EntityInfo[], asOf: IsoDate): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ids = entities.map((e) => e.id)
  if (ids.length === 0) return out
  const byEntity = new Map(entities.map((e) => [e.id, e]))
  const reports = await rc.store.listRecords(rc.ws, { entityIds: ids, eventTypes: ['report.snapshot'], statuses: ['recorded'], fromDate: addDays(asOf, -400) })
  const conns = new Map((await rc.directory.listConnections(rc.ws)).map((c) => [c.id, c]))
  const latest = new Map<string, SourceRecord>()
  for (const r of reports) {
    const ev = r.event
    if (ev.type !== 'report.snapshot' || ev.kind !== 'profit_and_loss' || ev.to > asOf || !r.entityId) continue
    // Before the period key: a store's report for a month must not stand in for the books' report of that month.
    if (NOT_BOOKS.has(conns.get(r.connectionId)?.connectorKey ?? '')) continue
    const key = `${r.entityId}|${ev.from}|${ev.to}|${ev.basis}`
    const prev = latest.get(key)
    if (!prev || r.updatedAt > prev.updatedAt) latest.set(key, r)
  }
  for (const r of latest.values()) {
    const ev = r.event as ReportSnapshot
    const e = byEntity.get(r.entityId as EntityId) as EntityInfo
    // The provider's own total when the connector sent it; else its "Net Income" row.
    const theirs = ev.totals?.netIncome ?? providerNetIncome(ev.rows)
    if (!theirs || theirs.currency !== e.baseCurrency) continue
    // Their report covers only what's in that provider's books; ours also has payroll, a second ledger, bank rows.
    // Accrual: compare with the entries from that connection's own records. Cash: their cash revenue and costs are
    // our bank rows, so compare the whole company, and only when nothing else books into its P&L.
    const recent = await rc.store.listRecords(rc.ws, { entityIds: [e.id], statuses: ['posted'], fromDate: addDays(ev.from, -400), toDate: ev.to, eventTypes: BOOKED_TYPES })
    const mine = recent.filter((x) => x.connectionId === r.connectionId).map((x) => x.id)
    if (ev.basis === 'cash' && recent.some((x) => x.connectionId !== r.connectionId)) continue
    // In the company's own currency, as the provider reports it: no rate to disagree on.
    const pnl = await profitAndLoss(rc, { entityIds: [e.id], from: ev.from, to: ev.to, basis: ev.basis, currency: e.baseCurrency, ...(ev.basis === 'accrual' ? { sourceIds: mine } : {}) })
    const ourMinor = pnl.netIncome.minor
    const diff = theirs.minor - ourMinor
    const fmt = (m: number) => formatMoney(m, e.baseCurrency)
    const where = providerName(conns.get(r.connectionId))
    // Rounding across many lines can leave a cent or two.
    if (Math.abs(diff) <= 2) {
      out.push(ok('provider_report', e.id, `${e.name}: ${ev.from} to ${ev.to} (${ev.basis}) matches ${where === 'the books' ? "the books' own P&L" : `the P&L in ${where}`}`, r.id))
      continue
    }
    // Which part of the P&L differs, when the provider gave its section totals (same currency only).
    const parts: string[] = []
    const t = ev.totals
    if (t && pnl.currency === e.baseCurrency) {
      for (const [label, their, our] of [
        ['income', t.income, pnl.revenue.total],
        ['cost of goods sold', t.cogs, pnl.costOfRevenue.total],
        ['expenses', t.expenses, pnl.operatingExpenses.total],
      ] as const) {
        if (!their || their.currency !== e.baseCurrency) continue
        const d = Math.abs(their.minor) - Math.abs(our.minor)
        if (Math.abs(d) > 2) parts.push(`${label} ${fmt(Math.abs(our.minor))} vs ${fmt(Math.abs(their.minor))}`)
      }
    }
    // What the provider's report has that its connector can't read, said for this company's situation.
    let note = ev.notCovered?.text
    if (ev.notCovered?.withPayroll) {
      const runs = await rc.store.listRecords(rc.ws, { entityIds: [e.id], eventTypes: ['payroll.run'], statuses: ['posted'], fromDate: ev.from })
      if (runs.some((x) => x.date <= ev.to && x.connectionId !== r.connectionId)) note = ev.notCovered.withPayroll
    }
    out.push({
      name: 'provider_report',
      status: ev.to >= asOf ? 'warn' : 'fail',
      entityId: e.id,
      subjectId: r.id,
      expectedMinor: theirs.minor,
      actualMinor: ourMinor,
      differenceMinor: diff,
      currency: e.baseCurrency,
      message: `${e.name}: net income ${ev.from} to ${ev.to} (${ev.basis}) is ${fmt(ourMinor)} here and ${fmt(theirs.minor)} in ${where}${parts.length ? ` (${parts.join('; ')})` : ''}${note ? `. ${note}` : ''}`,
    })
  }
  return out
}
