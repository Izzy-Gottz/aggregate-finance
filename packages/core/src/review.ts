// Review queue (ledger side): suggested matches, unexplained money, "loan or investment?", suggested rules,
// accounts without a company. AI-write review items are S7's and merge with these in list_review_items.
import type { EntityId, Id, LinkType } from '@agfn/contracts'
import { openItems } from './checks.ts'
import { usedSides } from './matching.ts'
import type { Link, SourceRecord } from './model.ts'
import { formatMoney } from './money.ts'
import { addDays, ledgerAccounts, todayFor, type ReadContext } from './queries.ts'
import { sortKey } from './store.ts'

export type ReviewKind = 'suggested_match' | 'unexplained_money' | 'owner_money' | 'suggested_rule' | 'which_company'

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
  /** What Confirm does, in words ("Confirm: a card payment"), where Confirm is an answer. */
  confirmLabel?: string
  /** The answers to pick from where there is no single proposal ("What is this money?"): each is an edit. */
  choices?: Array<{ label: string; edits: Record<string, string> }>
  /** What resolving it does, for the UI/AI: the engine call to make. */
  resolve: 'decideLink' | 'setOverride' | 'setRuleStatus' | 'assignAccount'
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
        resolve: 'decideLink',
      })
      continue
    }
    items.push({
      id: `suggested_match:${l.id}`,
      kind: 'suggested_match',
      entityId: to.entityId ?? from.entityId,
      title: `Same money? (${l.type === 'invoice_payment' ? `${docWord(from)} payment` : l.type === 'intercompany' && withPersonal(from, to) ? 'between a company and Personal' : l.type.replace(/_/g, ' ')})`,
      detail: `${describe(from, year)} ↔ ${describe(to, year)}`,
      confirmLabel: `Confirm: ${l.type === 'invoice_payment' ? `payment of ${docWord(from)}${docNumber(from)}${leftover(l, from, to, explained)}` : l.type === 'intercompany' && withPersonal(from, to) ? 'money owed between your company and you (not pay)' : (LINK_LABELS[l.type] ?? l.type.replace(/_/g, ' '))}`,
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
        items.push({ id: `unexplained_money:${rec.id}`, kind: 'unexplained_money', entityId: g.entityId, title: 'What is this money?', detail: describe(rec, year), choices: [...pays, ...whoseMoneyChoices({ owner: false, inflow: (rec.amount?.minor ?? 0) > 0, company: isCompany, ownerSpace: personalSpaces === 1, companies, payout: payoutOf(g.entityId as EntityId, rec) })], recordIds: [rec.id], resolve: 'setOverride' })
        continue
      }
      const cur = g.records[0]?.amount?.currency ?? 'USD'
      const total = g.records.reduce((s, r) => s + (r.amount?.currency === cur ? Math.abs(r.amount.minor) : 0), 0)
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
  }
  return items
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
