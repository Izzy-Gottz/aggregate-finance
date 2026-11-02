// Review queue (ledger side): suggested matches, unexplained money, "loan or investment?", suggested rules,
// accounts without a company. AI-write review items are S7's and merge with these in list_review_items.
import { underfundedAccounts } from './set-aside.ts'
import type { EntityId, Id, LinkType } from '@agfn/contracts'
import { openItems } from './checks.ts'
import { usedSides } from './matching.ts'
import type { Link, SourceRecord } from './model.ts'
import { formatMoney } from './money.ts'
import { addDays, ledgerAccounts, todayFor, type ReadContext } from './queries.ts'
import { sortKey } from './store.ts'

export type ReviewKind = 'suggested_match' | 'unexplained_money' | 'owner_money' | 'suggested_rule' | 'which_company' | 'underfunded_set_aside'

export interface ReviewItem {
  /** Stable id: "<kind>:<subject id>". */
  id: string
  kind: ReviewKind
  entityId: EntityId | null
  title: string
  detail: string
  recordIds: Id[]
  linkId?: Id
  ruleId?: Id
  accountId?: Id
  /** which_company: the connection the account came with, and the provider's guess (never applied without a person). */
  connectionId?: Id
  suggested?: EntityId | 'personal'
  confidence?: number
  /** The plain question to show ("Did you move $500 from Capital One to Ally on Oct 22?"); title stays for older clients. */
  question?: string
  /** The names from outside that question quotes; the rest of it is our own words. */
  questionNames?: string[]
  /** When a move's money arrived, for telling two otherwise alike matches apart. */
  arrivedOn?: string
  /** What Confirm does, in words ("Confirm: a card payment"), or "Yes" where the question already says it. */
  confirmLabel?: string
  /** "No" where the question is a yes-or-no one. */
  rejectLabel?: string
  /** Other matches for the same money, behind this one (best first): each resolves like any item, by its own id. */
  alternatives?: ReviewItem[]
  /** Items of one kind that can be confirmed together; label is the plural line ("5 moves between your own accounts"). */
  group?: { key: string; label: string }
  /** The answers to pick from where there is no single proposal ("What is this money?"): each is an edit. */
  choices?: Array<{ label: string; edits: Record<string, string> }>
  /** What resolving it does, for the UI/AI: the engine call to make. */
  resolve: 'decideLink' | 'setOverride' | 'setRuleStatus' | 'assignAccount' | 'none'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** Dates the way the app writes them: "Oct 3", or "Oct 3, 2025" outside the current year. */
export function shortDate(iso: string, thisYear: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const md = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`
  return m[1] === thisYear ? md : `${md}, ${m[1]}`
}

function describe(r: SourceRecord | null, thisYear: string): string {
  if (!r) return 'a record'
  const amt = r.amount ? formatMoney(r.amount.minor, r.amount.currency) : ''
  const ev = r.event
  const who = ev.type === 'txn.upsert' ? (ev.counterparty ?? ev.rawText ?? '') : ev.type === 'invoice.upsert' ? `${ev.number ?? ''} ${ev.counterparty}` : ev.type
  return `${shortDate(r.date, thisYear)} ${who.trim()} ${amt}`.trim()
}

/** A receivable is an invoice, a payable a bill (also for a payment the books recorded against one). */
function docWord(r: SourceRecord): 'invoice' | 'bill' {
  const ev = r.event
  return (ev.type === 'invoice.upsert' || ev.type === 'payment.applied') && ev.direction === 'payable' ? 'bill' : 'invoice'
}

/**
 * When the payment and the document's open amount differ (a cent off, transposed digits), what confirming leaves:
 * still owed on the document, or part of the payment still to explain.
 */
function leftover(l: Link, doc: SourceRecord, pay: SourceRecord, explained: Map<Id, number>): string {
  if (doc.event.type !== 'invoice.upsert' || !l.amount || !pay.amount) return ''
  const ev = doc.event
  const linked = Math.abs(l.amount.minor)
  const paidThere = Math.abs(ev.amountPaid.minor) + Math.abs(ev.amountCredited?.minor ?? 0)
  const owed = Math.abs(ev.total.minor) - Math.max(paidThere, explained.get(doc.id) ?? 0) - linked
  const unexplained = Math.abs(pay.amount.minor) - (explained.get(pay.id) ?? 0) - linked
  const word = docWord(doc)
  if (owed > 0) return `; ${formatMoney(owed, ev.total.currency)} stays owed on the ${word}`
  if (unexplained > 0) return `; ${formatMoney(unexplained, pay.amount.currency)} of the payment is left to explain`
  return ''
}

function docNumber(r: SourceRecord): string {
  return r.event.type === 'invoice.upsert' && r.event.number ? ` ${r.event.number}` : ''
}

/** Unexplained money in this recent is asked about row by row; older is one question per account. */
const RECENT_DAYS = 30

/** What confirming a suggested link means, in words (also the item's title). */
const LINK_LABELS: Record<LinkType, string> = {
  transfer: 'a transfer between your own accounts',
  card_payment: 'a card payment',
  payout: 'a payout of these charges',
  cash_deposit: 'a cash deposit',
  pending_posted: 'the same charge, pending then posted',
  duplicate: 'the same transaction twice (keep one)',
  invoice_payment: 'payment of this invoice',
  reimbursement: 'a reimbursement',
  intercompany: 'money between your companies',
  payroll_settlement: 'a payroll payment',
  equity_cash: 'investment money for shares',
  investment_cash: 'money for an investment the company holds',
  refund: 'a refund',
}

/** Money moving between two accounts of the same person: one card per movement, whatever type was proposed. */
const MOVE_TYPES: readonly LinkType[] = ['transfer', 'card_payment', 'cash_deposit', 'intercompany']

/** Where an item sits in Review: what changes profit or tax first, moves between your own accounts later. */
const TIER = { unknown: 0, profit: 1, older: 2, moves: 3, rules: 4 } as const

/** Could this be money that was already there? A bank deposit, not a card credit or a refund (those change spending). */
export function openingCandidate(r: SourceRecord, accountType: string | undefined): boolean {
  const ev = r.event
  const text = ev.type === 'txn.upsert' ? `${ev.counterparty ?? ''} ${ev.rawText ?? ''}` : ''
  return accountType === 'depository' && !/refund|return|revers|chargeback/i.test(text)
}

/** Link types that use up a record's amount (one money movement can't be two of these at once). */
const CAPACITY_TYPES: readonly LinkType[] = ['transfer', 'card_payment', 'intercompany', 'reimbursement', 'payout', 'cash_deposit', 'duplicate', 'pending_posted', 'equity_cash', 'investment_cash', 'invoice_payment', 'payroll_settlement']

export async function listReviewItems(rc: ReadContext, opts: { entityIds?: EntityId[] } = {}): Promise<ReviewItem[]> {
  if (rc.shared) return rc.shared(`review|${[...(opts.entityIds ?? ['*'])].sort().join(',')}|${rc.now.slice(0, 10)}`, () => computeReviewItems(rc, opts))
  return computeReviewItems(rc, opts)
}

async function computeReviewItems(rc: ReadContext, opts: { entityIds?: EntityId[] }): Promise<ReviewItem[]> {
  const ws = rc.ws
  const scope = opts.entityIds ? new Set(opts.entityIds) : null
  const inScope = (e: EntityId | null): boolean => !scope || (e !== null && scope.has(e))
  const items: ReviewItem[] = []
  const year = rc.now.slice(0, 4)
  // Not shown: where each item sorts.
  const rank = new Map<string, { tier: number; minor: number }>()
  const sized = (r: SourceRecord | null | undefined): number => Math.abs(r?.amount?.minor ?? 0)

  // Suggested matches.
  // In the order of what they link (date, then the provider's ids), not by link id: ids are random, so the list (and the
  // ten items data health shows) would differ from run to run.
  const proposedLinks = await stableLinks(rc, await rc.store.listLinks(ws, { statuses: ['proposed'] }))
  const proposedIds = new Set(proposedLinks.flatMap((l) => [l.fromId, l.toId]))
  // How much of each record confirmed links already explain: a proposal that can't fit is not a question to ask.
  const explained = new Map<Id, number>()
  for (const l of proposedIds.size ? await rc.store.listLinks(ws, { recordIds: [...proposedIds], statuses: ['confirmed'] }) : []) {
    if (!CAPACITY_TYPES.includes(l.type)) continue
    const amt = l.amount ? Math.abs(l.amount.minor) : Number.POSITIVE_INFINITY
    for (const id of usedSides(l.type, l.fromId, l.toId)) explained.set(id, (explained.get(id) ?? 0) + amt)
  }
  const full = (r: SourceRecord): boolean => (explained.get(r.id) ?? 0) >= Math.abs(r.amount?.minor ?? 0) && explained.has(r.id)
  // Money a person already said what it is isn't asked about again (a guess from before their answer stays on file).
  const answered = new Set((await rc.store.listOverrides(ws)).filter((o) => o.kind !== undefined || o.category !== undefined).map((o) => o.recordId))
  // One payment of two invoices (a pair) is one question, asked on its first link; deciding it decides both.
  const pairs = new Map<Id, Link[]>()
  for (const l of proposedLinks) if (l.type === 'invoice_payment' && l.scores?.['pair'] === 1) pairs.set(l.toId, [...(pairs.get(l.toId) ?? []), l])
  // Both sides of every suggestion in one read, not one per item.
  const linked = new Map((await rc.store.getRecords(ws, [...proposedIds])).map((r) => [r.id, r]))
  // Money between a company and the owner's Personal space isn't "between your companies" (it may be pay, a draw or a loan).
  const kindOf = new Map((await rc.directory.listEntities(ws)).map((e) => [e.id, e.kind]))
  const withPersonal = (a: SourceRecord, b: SourceRecord) => kindOf.get(a.entityId as EntityId) === 'personal' || kindOf.get(b.entityId as EntityId) === 'personal'
  const sourceAccounts = await rc.directory.listSourceAccounts(ws)
  const accountNames = new Map(sourceAccounts.map((a) => [a.id, a.institution && !a.name.toLowerCase().includes(a.institution.toLowerCase()) ? `${a.institution} ${a.name}` : a.name]))
  const nameOf = (r: SourceRecord): string | undefined => (r.sourceAccountId ? accountNames.get(r.sourceAccountId) : undefined)
  const moveQuestion = (l: Link, from: SourceRecord, to: SourceRecord): string | undefined => {
    const [a, b] = [nameOf(from), nameOf(to)]
    if (!a || !b || !from.amount) return undefined
    const amt = formatMoney(Math.abs(from.amount.minor), from.amount.currency)
    const on = shortDate(from.date, year)
    if (l.type === 'card_payment') return `Did you pay ${amt} to ${b} from ${a} on ${on}?`
    if (l.type === 'cash_deposit') return `Did you deposit ${amt} of cash into ${b} on ${on}?`
    return `Did you move ${amt} from ${a} to ${b} on ${on}?`
  }
  for (const l of proposedLinks) {
    const pair = l.scores?.['pair'] === 1 ? (pairs.get(l.toId) ?? []) : []
    if (pair.length > 1 && pair[0]?.id !== l.id) continue
    const [from, to] = [linked.get(l.fromId), linked.get(l.toId)]
    if (!from || !to || (!inScope(from.entityId) && !inScope(to.entityId))) continue
    if (from.status !== 'posted' && from.status !== 'recorded') continue
    if (to.status !== 'posted' && to.status !== 'recorded') continue
    if (CAPACITY_TYPES.includes(l.type) && (full(from) || full(to))) continue
    if (l.method !== 'exact_id' && ((from.origin === 'connector' && answered.has(from.id)) || (to.origin === 'connector' && answered.has(to.id)))) continue
    if (pair.length > 1) {
      // Either invoice already paid another way: the pair can't be the answer any more.
      const pairDocs = pair.map((p) => linked.get(p.fromId)).filter((r): r is SourceRecord => r !== undefined)
      if (pairDocs.some(full)) continue
      const docs = pairDocs.sort((a, b) => (pair.findIndex((p) => p.fromId === a.id) < pair.findIndex((p) => p.fromId === b.id) ? -1 : 1))
      items.push({
        id: `suggested_match:${l.id}`,
        kind: 'suggested_match',
        entityId: to.entityId ?? from.entityId,
        title: `Same money? (${docs.length} ${docWord(from)}s paid together)`,
        detail: `${describe(to, year)} ↔ ${docs.map((d) => describe(d, year)).join(' + ')}`,
        confirmLabel: `Confirm: payment of ${docWord(from)}s ${docs.map((d) => docNumber(d).trim() || '(no number)').join(' and ')}`,
        recordIds: [to.id, ...docs.map((d) => d.id)],
        linkId: l.id,
        confidence: l.confidence,
        question: `Did this payment cover ${docs.length} ${docWord(from)}s?`,
        resolve: 'decideLink',
      })
      rank.set(`suggested_match:${l.id}`, { tier: TIER.profit, minor: sized(to) })
      continue
    }
    const move = MOVE_TYPES.includes(l.type)
    const personal = l.type === 'intercompany' && withPersonal(from, to)
    rank.set(`suggested_match:${l.id}`, { tier: move && !personal ? TIER.moves : TIER.profit, minor: sized(from) })
    const asked = move ? moveQuestion(l, from, to) : undefined
    items.push({
      ...(asked ? { rejectLabel: 'No', questionNames: [nameOf(from) ?? '', nameOf(to) ?? ''], arrivedOn: shortDate(to.date, year) } : {}),
      question: asked ?? (l.type === 'invoice_payment' ? `Is this payment of ${docWord(from)}${docNumber(from)}?` : `Is this ${LINK_LABELS[l.type] ?? l.type.replace(/_/g, ' ')}?`),
      id: `suggested_match:${l.id}`,
      kind: 'suggested_match',
      entityId: to.entityId ?? from.entityId,
      title: `Same money? (${l.type === 'invoice_payment' ? `${docWord(from)} payment` : l.type === 'intercompany' && withPersonal(from, to) ? 'between a company and Personal' : l.type.replace(/_/g, ' ')})`,
      detail: `${describe(from, year)} ↔ ${describe(to, year)}`,
      confirmLabel: asked && !personal ? 'Yes' : `${asked ? 'Yes' : 'Confirm'}: ${l.type === 'invoice_payment' ? `payment of ${docWord(from)}${docNumber(from)}${leftover(l, from, to, explained)}` : personal ? 'money owed between your company and you (not pay)' : (LINK_LABELS[l.type] ?? l.type.replace(/_/g, ' '))}`,
      recordIds: [from.id, to.id],
      linkId: l.id,
      confidence: l.confidence,
      resolve: 'decideLink',
    })
  }

  // Unexplained money in, and owner money not yet called a loan or an investment.
  const allEntities = await rc.directory.listEntities(ws)
  const entities = allEntities.filter((e) => inScope(e.id))
  // Which answers can apply (record-writer would refuse the rest): owner money needs exactly one Personal space.
  const entityKind = new Map(allEntities.map((e) => [e.id, e.kind]))
  const personalSpaces = allEntities.filter((e) => e.kind === 'personal').length
  const companies = allEntities.filter((e) => e.kind === 'company').length
  // Companies with a processor connected (Stripe, Shopify…): its sales are already revenue, so a deposit it paid out
  // is a payout, and calling it revenue would count those sales twice.
  const processors = new Map<EntityId, string[]>()
  for (const a of await rc.directory.listSourceAccounts(ws)) {
    if (a.accountType !== 'processor_balance' || a.duplicateOf || !a.entityId) continue
    const name = (a.institution ?? a.name.split(/\s+/)[0] ?? '').trim()
    // Sorted: the label must read the same whatever order the store lists accounts in.
    if (name) processors.set(a.entityId, [...new Set([...(processors.get(a.entityId) ?? []), name])].sort())
  }
  const payoutOf = (entityId: EntityId | null, rec: SourceRecord) => processorPayout(entityId ? processors.get(entityId) ?? [] : [], rec)
  const idx = await ledgerAccounts(rc, entities.map((e) => e.id))
  const watch = [...idx.byId.values()].filter((a) => a.role === 'suspense' || a.role === 'owner_money_unspecified')
  // Money in older than this is asked about once per account, not row by row (a first sync brings years of it).
  const recentFrom = addDays(await todayFor(rc), -RECENT_DAYS)
  const older = new Map<Id, { entityId: EntityId | null; records: SourceRecord[] }>()
  // Older deposits from before the account was connected: for a company, one yes-or-no question (opening balance).
  const connectedOn = new Map((await rc.directory.listConnections(ws)).map((c) => [c.id, c.createdAt?.slice(0, 10)]))
  const beforeConnection = (r: SourceRecord): boolean => {
    const account = r.sourceAccountId ? sourceAccounts.find((a) => a.id === r.sourceAccountId) : undefined
    const day = account?.connectionId ? connectedOn.get(account.connectionId) : undefined
    return day !== undefined && r.date < day && openingCandidate(r, account?.accountType)
  }
  if (watch.length) {
    const lines = await rc.store.listLines(ws, { entityIds: entities.map((e) => e.id), basis: 'cash', ledgerAccountIds: watch.map((a) => a.id) })
    const bySource = new Map<string, number>()
    for (const l of lines) {
      const key = `${l.ledgerAccountId}|${l.sourceId}`
      bySource.set(key, (bySource.get(key) ?? 0) + l.baseDebitMinor - l.baseCreditMinor)
    }
    const sources = new Map((await rc.store.getRecords(ws, [...new Set([...bySource.keys()].map((k) => k.split('|')[1] as Id))])).map((r) => [r.id, r]))
    // By date, then the provider's ids (rows of one day come back in random-id order otherwise).
    const keyOf = (k: string) => {
      const r = sources.get(k.split('|')[1] as Id)
      return r ? sortKey(r.date, r.eventType, r.externalId ?? r.id) : `~${k}`
    }
    for (const [key, bal] of [...bySource].sort(([a], [b]) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0))) {
      if (bal === 0) continue
      const [acctId, sourceId] = key.split('|') as [string, string]
      const acct = idx.byId.get(acctId)
      const rec = sources.get(sourceId)
      if (!acct || !rec) continue
      // Already waiting on a suggested match: one question at a time.
      if (proposedIds.has(rec.id)) continue
      const owner = acct.role === 'owner_money_unspecified'
      if (!owner && rec.date < recentFrom && rec.sourceAccountId) {
        const g = older.get(rec.sourceAccountId) ?? { entityId: acct.entityId, records: [] }
        g.records.push(rec)
        older.set(rec.sourceAccountId, g)
        continue
      }
      const isCompany = entityKind.get(acct.entityId as EntityId) === 'company'
      // Money in a company can't explain may be a customer paying an invoice (a match rejected by mistake, or one the
      // matcher couldn't see): its open invoices are answers too, nearest amount first.
      const pays = !owner && isCompany && (rec.amount?.minor ?? 0) > 0 ? await invoiceChoices(rc, acct.entityId as EntityId, rec) : []
      items.push({
        id: `${owner ? 'owner_money' : 'unexplained_money'}:${rec.id}`,
        kind: owner ? 'owner_money' : 'unexplained_money',
        entityId: acct.entityId,
        title: owner ? 'Owner money: a loan or an investment?' : 'What is this money?',
        detail: describe(rec, year),
        choices: [...pays, ...whoseMoneyChoices({ owner, inflow: (rec.amount?.minor ?? 0) > 0, company: isCompany, ownerSpace: personalSpaces === 1, companies, payout: payoutOf(acct.entityId as EntityId, rec) })],
        recordIds: [rec.id],
        resolve: 'setOverride',
      })
      rank.set(`${owner ? 'owner_money' : 'unexplained_money'}:${rec.id}`, { tier: TIER.unknown, minor: sized(rec) })
    }
  }

  // Older money in: one question per account ("23 deposits before Sep 11"), unless there's only one.
  if (older.size) {
    const names = new Map((await rc.directory.listSourceAccounts(ws)).map((a) => [a.id, `${a.name}${a.mask ? ` ··${a.mask}` : ''}`]))
    for (const [accountId, g] of older) {
      const isCompany = entityKind.get(g.entityId as EntityId) === 'company'
      if (g.records.length === 1) {
        const rec = g.records[0] as SourceRecord
        const pays = isCompany && (rec.amount?.minor ?? 0) > 0 ? await invoiceChoices(rc, g.entityId as EntityId, rec) : []
        rank.set(`unexplained_money:${rec.id}`, { tier: TIER.older, minor: sized(rec) })
        items.push({ id: `unexplained_money:${rec.id}`, kind: 'unexplained_money', entityId: g.entityId, title: 'What is this money?', detail: describe(rec, year), choices: [...pays, ...whoseMoneyChoices({ owner: false, inflow: (rec.amount?.minor ?? 0) > 0, company: isCompany, ownerSpace: personalSpaces === 1, companies, payout: payoutOf(g.entityId as EntityId, rec) })], recordIds: [rec.id], resolve: 'setOverride' })
        continue
      }
      const opening = isCompany ? g.records.filter(beforeConnection) : []
      if (opening.length > 1) {
        const openCur = opening[0]?.amount?.currency ?? 'USD'
        const openTotal = opening.reduce((s, r) => s + (r.amount?.currency === openCur ? Math.abs(r.amount.minor) : 0), 0)
        const firstDay = connectedOn.get(sourceAccounts.find((a) => a.id === accountId)?.connectionId ?? '') ?? recentFrom
        const id = `unexplained_money:older:opening:${accountId}`
        rank.set(id, { tier: TIER.older, minor: openTotal })
        items.push({
          id,
          kind: 'unexplained_money',
          entityId: g.entityId,
          title: 'What is this money?',
          question: `${opening.length} deposits before ${shortDate(firstDay, year)} in ${names.get(accountId) ?? 'this account'} (${formatMoney(openTotal, openCur)}): count them as your opening balance?`,
          questionNames: [names.get(accountId) ?? ''],
          detail: `From before this account was connected`,
          choices: [
            { label: 'Yes, opening balance', edits: { kind: 'other', category: 'opening_balance_equity' } },
            { label: 'All revenue', edits: { kind: 'revenue' } },
            { label: 'All other income', edits: { kind: 'other', category: 'other_income' } },
            { label: 'All transfers between my accounts', edits: { kind: 'transfer' } },
          ],
          recordIds: opening.map((r) => r.id),
          resolve: 'setOverride',
        })
        g.records = g.records.filter((r) => !opening.includes(r))
        if (!g.records.length) continue
      }
      const cur = g.records[0]?.amount?.currency ?? 'USD'
      const total = g.records.reduce((s, r) => s + (r.amount?.currency === cur ? Math.abs(r.amount.minor) : 0), 0)
      rank.set(`unexplained_money:older:${accountId}`, { tier: TIER.older, minor: total })
      items.push({
        id: `unexplained_money:older:${accountId}`,
        kind: 'unexplained_money',
        entityId: g.entityId,
        title: 'What is this money?',
        detail: `${g.records.length} deposits before ${shortDate(recentFrom, year)} in ${names.get(accountId) ?? 'this account'} aren't explained (${formatMoney(total, cur)})`,
        choices: [
          ...(isCompany ? [{ label: 'All revenue', edits: { kind: 'revenue' } }] : []),
          { label: 'All other income', edits: { kind: 'other', category: 'other_income' } },
          { label: 'All transfers between my accounts', edits: { kind: 'transfer' } },
        ],
        recordIds: g.records.map((r) => r.id),
        resolve: 'setOverride',
      })
    }
  }

  // Rules learned from repeats.
  for (const rule of await rc.store.listRules(ws)) {
    if (rule.status !== 'suggested') continue
    if (rule.actions.forEntityId && !inScope(rule.actions.forEntityId)) continue
    rank.set(`suggested_rule:${rule.id}`, { tier: TIER.rules, minor: 0 })
    items.push({ id: `suggested_rule:${rule.id}`, kind: 'suggested_rule', entityId: rule.actions.forEntityId ?? null, title: 'Always do this?', detail: rule.name, recordIds: [], ruleId: rule.id, confirmLabel: 'Confirm: always do this', resolve: 'setRuleStatus' })
  }

  // Accounts that still need "which company, or Personal?" (their rows are held until then).
  const ents = await rc.directory.listEntities(ws)
  const companyIds = ents.filter((e) => e.kind === 'company').map((e) => e.id)
  const hasPersonal = ents.some((e) => e.kind === 'personal')
  for (const a of await rc.directory.listSourceAccounts(ws)) {
    if (a.entityId || a.duplicateOf) continue
    const held = await rc.store.listRecords(ws, { sourceAccountId: a.id, statuses: ['unassigned'] })
    items.push({
      id: `which_company:${a.id}`,
      kind: 'which_company',
      entityId: null,
      title: `Which company is ${a.name}${a.mask ? ` ··${a.mask}` : ''}?`,
      detail: held.length === 1 ? '1 transaction is waiting for an answer' : `${held.length} transactions are waiting for an answer`,
      recordIds: held.map((r) => r.id),
      accountId: a.id,
      ...(a.connectionId ? { connectionId: a.connectionId } : {}),
      ...(a.businessHint === 'personal' && hasPersonal ? { suggested: 'personal' as const } : a.businessHint === 'business' && companyIds.length === 1 ? { suggested: companyIds[0]! } : {}),
      resolve: 'assignAccount',
    })
    rank.set(`which_company:${a.id}`, { tier: TIER.unknown, minor: held.reduce((s, r) => s + sized(r), 0) })
  }
  // More set aside from an account than it holds. Derived from the balance, so it clears itself once that's fixed.
  for (const u of await underfundedAccounts({ ...rc, engine: {} }, rc.now.slice(0, 10))) {
    if (!inScope(u.entityId)) continue
    const id = `underfunded_set_aside:${u.accountId}`
    items.push({ id, kind: 'underfunded_set_aside', entityId: u.entityId, accountId: u.accountId, title: 'Set-aside is short', detail: `${u.accountName} has ${formatMoney(u.balance.minor, u.balance.currency)} but ${formatMoney(u.held.minor, u.held.currency)} is set aside from it.`, recordIds: [], resolve: 'none' })
    rank.set(id, { tier: TIER.unknown, minor: u.held.minor })
  }
  const cards = oneCardPerMovement(items, proposedLinks, linked)
  groupMoves(cards, proposedLinks, linked, withPersonal)
  // Sorted is stable: within one size, items keep the order above (date, then the provider's ids).
  const place = (i: ReviewItem) => rank.get(i.id) ?? { tier: TIER.moves, minor: 0 }
  return cards.map((c, n) => ({ c, n })).sort((a, b) => place(a.c).tier - place(b.c).tier || place(b.c).minor - place(a.c).minor || a.n - b.n).map((x) => x.c)
}

/**
 * One card for one movement. The same two rows proposed as two types (an account moved to another company after the
 * first proposal) keep the type that fits their companies now. Matches that want the same row are one card: the best
 * first (closest date, then confidence, then a name that fits), the others behind it.
 */
function oneCardPerMovement(items: ReviewItem[], links: Link[], linked: Map<Id, SourceRecord>): ReviewItem[] {
  const byId = new Map(links.map((l) => [l.id, l]))
  const linkOf = (i: ReviewItem): Link | undefined => (i.kind === 'suggested_match' && i.linkId ? byId.get(i.linkId) : undefined)
  const isMove = (i: ReviewItem): boolean => {
    const l = linkOf(i)
    return l !== undefined && MOVE_TYPES.includes(l.type)
  }
  const fits = (l: Link): boolean => (linked.get(l.fromId)?.entityId === linked.get(l.toId)?.entityId) === (l.type !== 'intercompany')
  const pairs = new Map<string, ReviewItem>()
  for (const i of items.filter(isMove)) {
    const l = linkOf(i) as Link
    const key = [l.fromId, l.toId].sort().join('|')
    const held = pairs.get(key)
    const heldLink = held && (linkOf(held) as Link)
    if (!heldLink || (fits(l) && !fits(heldLink)) || (fits(l) === fits(heldLink) && l.confidence > heldLink.confidence)) pairs.set(key, i)
  }
  const score = (i: ReviewItem): [number, number, number] => {
    const l = linkOf(i) as Link
    return [l.scores?.['date'] ?? 0, l.confidence, l.scores?.['text'] ?? 0]
  }
  const best = (a: ReviewItem, b: ReviewItem): number => {
    const [x, y] = [score(a), score(b)]
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]
  }
  const left = [...pairs.values()].sort(best)
  const kept = new Map<string, ReviewItem>()
  while (left.length) {
    const card = left.shift() as ReviewItem
    const ids = new Set(card.recordIds)
    const alternatives = left.filter((i) => i.recordIds.some((id) => ids.has(id)))
    for (const a of alternatives) left.splice(left.indexOf(a), 1)
    // Same words for different deposits: the day each arrived is the difference.
    const arriving = (i: ReviewItem): ReviewItem => (alternatives.some((a) => a.question === card.question) && i.arrivedOn ? { ...i, question: i.question?.replace(/\?$/, `, arriving ${i.arrivedOn}?`) } : i)
    kept.set(card.id, alternatives.length ? { ...arriving(card), alternatives: alternatives.map(arriving) } : card)
  }
  return items.flatMap((i) => (isMove(i) ? (kept.has(i.id) ? [kept.get(i.id) as ReviewItem] : []) : [i]))
}

/** Moves anyone can confirm together: within one company, or between companies. Money with Personal is asked one by one. */
function groupMoves(items: ReviewItem[], links: Link[], linked: Map<Id, SourceRecord>, withPersonal: (a: SourceRecord, b: SourceRecord) => boolean): void {
  const byId = new Map(links.map((l) => [l.id, l]))
  const own: ReviewItem[] = []
  const between: ReviewItem[] = []
  for (const i of items) {
    const l = i.linkId ? byId.get(i.linkId) : undefined
    if (!l || i.alternatives || !MOVE_TYPES.includes(l.type)) continue
    const [from, to] = [linked.get(l.fromId), linked.get(l.toId)]
    if (!from || !to || withPersonal(from, to)) continue
    ;(l.type === 'intercompany' ? between : own).push(i)
  }
  for (const [list, key, words] of [[own, 'moves:own', 'between your own accounts'], [between, 'moves:companies', 'between your companies']] as const) {
    if (list.length < 2) continue
    for (const i of list) i.group = { key, label: `${list.length} moves ${words}` }
  }
}

/**
 * The answers to "What is this money?" (or "a loan or an investment?") that can apply to this record: each maps to a
 * kind record-writer accepts for it. Revenue and refunds only for money into a company; owner money only when there is
 * exactly one Personal space to owe it to; between companies only with two or more.
 */
/** Up to five open invoices of the company in the money's currency, the closest to its amount first. */
async function invoiceChoices(rc: ReadContext, entityId: EntityId, rec: SourceRecord): Promise<Array<{ label: string; edits: Record<string, string> }>> {
  const amt = rec.amount
  if (!amt) return []
  const open = (await openItems(rc, [entityId], 'receivable', rc.now.slice(0, 10))).filter((o) => o.currency === amt.currency && o.remainingMinor > 0)
  open.sort((a, b) => Math.abs(a.remainingMinor - amt.minor) - Math.abs(b.remainingMinor - amt.minor) || (a.record.date < b.record.date ? -1 : 1))
  return open.slice(0, 5).map((o) => {
    const ev = o.record.event
    const num = ev.type === 'invoice.upsert' && ev.number ? ` ${ev.number}` : ''
    const who = ev.type === 'invoice.upsert' ? ` to ${ev.counterparty}` : ''
    return { label: `Pays invoice${num}${who} · ${formatMoney(o.remainingMinor, o.currency)} open`, edits: { paysInvoice: o.record.id } }
  })
}

/**
 * For money into a company with a processor connected: which processor may have paid it out, and whether the bank's
 * text names it (then it is a payout, not revenue). Null without a processor.
 */
export function processorPayout(names: string[], rec: SourceRecord): { name: string; named: boolean } | null {
  if (!names.length || (rec.amount?.minor ?? 0) <= 0) return null
  const ev = rec.event
  const text = ev.type === 'txn.upsert' ? `${ev.counterparty ?? ''} ${ev.rawText ?? ''}`.toLowerCase() : ''
  const named = names.find((n) => text.includes(n.toLowerCase()))
  return { name: named ?? names.join(' or '), named: named !== undefined }
}

export function whoseMoneyChoices(o: { owner: boolean; inflow: boolean; company: boolean; ownerSpace: boolean; companies: number; payout?: { name: string; named: boolean } | null }): Array<{ label: string; edits: Record<string, string> }> {
  const ownerChoices = o.ownerSpace && o.company ? [{ label: 'Owner loan (to be paid back)', edits: { kind: 'owner_loan' } }, { label: 'Owner investment', edits: { kind: 'owner_contribution' } }] : []
  if (o.owner) return ownerChoices
  // A deposit the bank says came from the connected processor is a payout: its sales are already revenue.
  const payout = o.inflow && o.company && o.payout ? [{ label: `A ${o.payout.name} payout (its sales are already counted)`, edits: { kind: 'payout' } }] : []
  const revenue = o.payout?.named ? [] : [{ label: 'Revenue', edits: { kind: 'revenue' } }]
  return [
    ...payout,
    ...(o.inflow && o.company ? [...revenue, { label: 'A refund', edits: { kind: 'refund' } }] : []),
    ...(o.inflow ? ownerChoices : []),
    { label: 'Transfer between my accounts', edits: { kind: 'transfer' } },
    ...(o.companies >= 2 ? [{ label: o.inflow ? 'From one of my companies' : 'To one of my companies', edits: { kind: 'intercompany' } }] : []),
    { label: 'Something else', edits: { kind: 'other' } },
  ]
}

async function stableLinks<T extends { id: Id; fromId: Id; toId: Id }>(rc: ReadContext, links: T[]): Promise<T[]> {
  if (links.length < 2) return links
  const keys = await rc.store.recordSortKeys(rc.ws, links.flatMap((l) => [l.fromId, l.toId]))
  const k = (l: T) => `${keys.get(l.fromId) ?? '~'}>${keys.get(l.toId) ?? '~'}`
  return links.map((l) => ({ l, k: k(l) })).sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.l.id < b.l.id ? -1 : 1)).map((x) => x.l)
}
