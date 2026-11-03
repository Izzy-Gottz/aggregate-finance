// Matching: find sightings of the same real-world event. Exact ids first, then deterministic heuristics.
// Proposals carry a confidence; the engine auto-confirms exact ids and anything at or above 0.95, the rest go to Review.
//
// Link direction conventions (fromId → toId):
//   pending_posted: pending → posted · transfer/card_payment/intercompany/reimbursement: money-out leg → money-in leg
//   payout: processor payout → bank deposit · cash_deposit: cash-on-hand entry → bank deposit
//   invoice_payment: invoice or payment.applied → bank/processor row · payroll_settlement: payroll run → bank debit
//   equity_cash: equity event → bank deposit · investment_cash: investment event → its bank row · refund: original → refund · duplicate: kept → copy
import type { EntityId, Id, InvoiceUpsert, LinkProposal, LinkType, Money, TxnUpsert } from '@agfn/contracts'
import type { EntityInfo, Link, SourceAccountInfo, SourceRecord } from './model.ts'
import { merchantKey } from './rules.ts'
import { yieldNow } from './yield.ts'

export interface Proposal extends LinkProposal {
  scores?: Record<string, number>
  reason: string
}

export interface MatchInput {
  records: readonly SourceRecord[]
  accounts: ReadonlyMap<Id, SourceAccountInfo>
  entities: ReadonlyMap<EntityId, EntityInfo>
  links: readonly Link[]
  /** Amount in the reporting currency at the record's date (for cross-currency transfer matching). */
  reportingMinor: ReadonlyMap<Id, number>
  /** Accounts that came from uploaded statements (the files connector): checked against the company's other accounts. */
  uploadedAccounts?: ReadonlySet<Id>
  /** Two accounts a person has confirmed money moving between, either way round (accountPair): evidence for a transfer. */
  knownPairs?: ReadonlySet<string>
}

export const accountPair = (a: Id | null, b: Id | null): string => [a, b].sort().join('|')

export const AUTO_CONFIRM = 0.95
/** How close two customer names must be to treat a sale in two sources as the same one. */
const SAME_CUSTOMER = 0.7
/**
 * Bump when matching finds something it didn't before: each workspace's whole history is re-matched once, on its next
 * settle. 2: open balance of partly paid invoices, cents off, unnamed deposits, pairs, processor charges → invoices.
 * 3: links to a processor charge stored at its net (before links counted gross) are corrected to its gross.
 * 4: part payments that name their bill or invoice are asked about; a cash drawer that records its own bank trips is
 * not offered as the source of every deposit.
 * 5: rows whose provider category is a utility are posted again, to Utilities instead of Rent (engine #rematchAll).
 * 6: the whole history matched again once: on Postgres a page's matching could read its rows before they were all
 * written (concurrent reads in one transaction, kysely-store #inOrder), so a pair in the same page could go unproposed.
 */
export const MATCHER_VERSION = 6
export const PROPOSE_MIN = 0.6
/** A payment this close to an invoice's open balance (a few cents) is suggested, never linked automatically. */
const NEAR_MINOR = 100

/** Link types where one record can take part only once (or up to its amount). */
const EXCLUSIVE: readonly LinkType[] = ['transfer', 'card_payment', 'intercompany', 'reimbursement', 'payout', 'cash_deposit', 'duplicate', 'pending_posted', 'equity_cash', 'investment_cash']

const PROCESSOR_NAMES = ['stripe', 'paypal', 'square', 'shopify', 'paddle', 'lemon squeezy', 'lemonsqueezy', 'gumroad', 'braintree', 'adyen', 'apple', 'google']
const PAYROLL_NAMES = ['gusto', 'adp', 'rippling', 'justworks', 'deel', 'paychex', 'trinet', 'payroll', 'oyster', 'remote com']
const TRANSFER_WORDS = ['transfer', 'xfer', 'trnsfr', 'online banking', 'from chk', 'to chk', 'from sav', 'to sav', 'internal', 'paid in for', 'paid out from']
const CARD_PAYMENT_WORDS = ['payment', 'autopay', 'epay', 'card pmt', 'pymt', 'thank you']

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000)
}

function txnText(r: SourceRecord): string {
  if (r.event.type !== 'txn.upsert') return ''
  return `${r.event.counterparty ?? ''} ${r.event.rawText ?? ''}`.toLowerCase()
}

/** Dice coefficient on character bigrams of the merchant keys; 0..1. */
export function nameSimilarity(a: string, b: string): number {
  const x = merchantKey(a).replace(/ /g, '')
  const y = merchantKey(b).replace(/ /g, '')
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 2 || y.length < 2) return 0
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>()
    for (let i = 0; i < s.length - 1; i++) m.set(s.slice(i, i + 2), (m.get(s.slice(i, i + 2)) ?? 0) + 1)
    return m
  }
  const gx = grams(x)
  const gy = grams(y)
  let overlap = 0
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0)
  const sim = (2 * overlap) / (x.length - 1 + (y.length - 1))
  // A short name fully contained in the other ("acme" in "acme corp ach") is a strong signal.
  return Math.max(sim, x.includes(y) || y.includes(x) ? 0.9 : 0)
}

class LinkIndex {
  #used = new Map<Id, number>()
  #pairs = new Set<string>()

  constructor(links: readonly Link[]) {
    for (const l of links) {
      // Pending proposals stay matchable, so one can be upgraded once the money it needs is freed.
      if (l.status !== 'proposed') this.#pairs.add(`${l.type}|${l.fromId}|${l.toId}`)
      if (l.status !== 'confirmed') continue
      if (EXCLUSIVE.includes(l.type) || l.type === 'invoice_payment' || l.type === 'payroll_settlement') {
        const amt = l.amount ? Math.abs(l.amount.minor) : Number.POSITIVE_INFINITY
        for (const id of usedSides(l.type, l.fromId, l.toId)) this.#used.set(id, (this.#used.get(id) ?? 0) + amt)
      }
    }
  }

  /** Amount of the record already explained by confirmed links. */
  used(id: Id): number {
    return this.#used.get(id) ?? 0
  }

  seen(type: LinkType, from: Id, to: Id): boolean {
    return this.#pairs.has(`${type}|${from}|${to}`)
  }

  claim(type: LinkType, from: Id, to: Id, amount: number): void {
    this.#pairs.add(`${type}|${from}|${to}`)
    for (const id of usedSides(type, from, to)) this.#used.set(id, (this.#used.get(id) ?? 0) + amount)
  }
}

/**
 * Which ends a link uses up. A pending row is replaced by its posted row and a copy by the row it repeats, so only
 * that side is spent; the posted or kept row is still free to be a transfer, a payment and so on.
 */
export function usedSides(type: LinkType, from: Id, to: Id): Id[] {
  if (type === 'pending_posted') return [from]
  if (type === 'duplicate') return [to]
  return [from, to]
}

function absAmount(r: SourceRecord): number {
  return Math.abs(r.amount?.minor ?? 0)
}

function free(idx: LinkIndex, r: SourceRecord): number {
  return Math.max(0, absAmount(r) - idx.used(r.id))
}

function money(minor: number, currency: string): Money {
  return { minor, currency }
}

export function findMatches(input: MatchInput): Proposal[] {
  const { out, passes } = matchPasses(input)
  for (const pass of passes) pass()
  return out
}

/** findMatches, letting other work run between its passes (each a few hundred ms on a shared CPU for a demo fill). */
export async function findMatchesYielding(input: MatchInput): Promise<Proposal[]> {
  const { out, passes } = matchPasses(input)
  for (const pass of passes) {
    pass()
    await yieldNow()
  }
  return out
}

function matchPasses(input: MatchInput): { out: Proposal[]; passes: Array<() => void> } {
  const idx = new LinkIndex(input.links)
  const out: Proposal[] = []
  const push = (p: Proposal): void => {
    if (idx.seen(p.type, p.fromId, p.toId)) return
    out.push(p)
    // Only auto-confirmable proposals reserve their amount; weaker ones may compete in Review.
    // A link without an amount explains both records in full (as LinkIndex reads confirmed links back).
    if (p.method === 'exact_id' || p.confidence >= AUTO_CONFIRM) idx.claim(p.type, p.fromId, p.toId, p.amount ? Math.abs(p.amount.minor) : Number.POSITIVE_INFINITY)
  }

  const live = input.records.filter((r) => r.status === 'posted' || r.status === 'recorded')
  const txns = live.filter((r) => r.event.type === 'txn.upsert' && (r.event as TxnUpsert).status === 'posted')
  const byExternal = new Map<string, SourceRecord[]>()
  for (const r of input.records) {
    const key = `${r.eventType}|${r.externalId}`
    const list = byExternal.get(key)
    if (list) list.push(r)
    else byExternal.set(key, [r])
  }
  const acct = (r: SourceRecord): SourceAccountInfo | undefined => (r.sourceAccountId ? input.accounts.get(r.sourceAccountId) : undefined)

  // In this order: stronger evidence claims amounts first.
  const passes = [
    () => exactPass(input, txns, byExternal, idx, push),
    () => sameAccountPass(input, txns, idx, push),
    () => transferPass(input, txns, idx, push, acct),
    () => payoutPass(live, txns, idx, push),
    () => cashDepositPass(txns, idx, push, acct),
    () => paymentPass(live, txns, idx, push),
    () => processorInvoicePass(live, idx, push),
    () => bookedRefundPass(live, idx, push),
    () => invoicePass(live, txns, idx, push),
    () => payrollPass(live, txns, idx, push),
    () => equityPass(live, txns, idx, push),
    () => investmentPass(live, txns, idx, push),
    () => duplicatePass(txns, idx, push, acct),
  ]
  return { out, passes }
}

type Push = (p: Proposal) => void

/**
 * Two sources for one real account (a statement upload for an account Plaid already syncs, two connections to the same
 * bank): the copy's account has `duplicateOf` set, its rows post into the primary account, and here each copy row is
 * paired with the primary row it repeats. The three greedy passes follow Actual Budget's `matchTransactions`
 * (packages/loot-core/src/server/accounts/sync.ts, MIT licence, © Actual Budget contributors):
 *   1. the same bank id (external id or a shared reference such as an OFX FITID or trace number);
 *   2. the same amount within ±7 days and the same payee;
 *   3. the same amount within ±7 days.
 * A pair claims both rows, so stronger matches win; ties go to the nearest date. Bank ids and same-day, same-payee
 * pairs are certain (confirmed); the rest wait in Review.
 */
function sameAccountPass(input: MatchInput, txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  const accountOf = (r: SourceRecord): SourceAccountInfo | undefined => (r.sourceAccountId ? input.accounts.get(r.sourceAccountId) : undefined)
  const uploaded = (r: SourceRecord): boolean => Boolean(r.sourceAccountId && input.uploadedAccounts?.has(r.sourceAccountId))
  // Spending typed in as cash can be the bank's own row arriving later: asked about, like an upload.
  const typedIn = (r: SourceRecord): boolean => r.origin !== 'connector' && accountOf(r)?.accountType === 'cash_on_hand' && (r.amount?.minor ?? 0) < 0
  const byAccount = new Map<Id, SourceRecord[]>()
  const byEntity = new Map<string, SourceRecord[]>()
  const copies: SourceRecord[] = []
  for (const t of txns) {
    if (!t.sourceAccountId) continue
    if (accountOf(t)?.duplicateOf || uploaded(t) || typedIn(t)) copies.push(t)
    if (accountOf(t)?.duplicateOf) continue
    byAccount.set(t.sourceAccountId, [...(byAccount.get(t.sourceAccountId) ?? []), t])
    if (!uploaded(t) && !typedIn(t)) byEntity.set(`${t.entityId}`, [...(byEntity.get(`${t.entityId}`) ?? []), t])
  }
  if (copies.length === 0) return
  const matched = new Set<Id>()
  const refs = (r: SourceRecord): string[] => [r.externalId, ...Object.values((r.event as TxnUpsert).linkRefs ?? {})]
  const payee = (r: SourceRecord): string => merchantKey((r.event as TxnUpsert).counterparty ?? (r.event as TxnUpsert).rawText ?? '')
  const samePayee = (a: SourceRecord, b: SourceRecord): boolean => {
    const x = payee(a)
    const y = payee(b)
    return x === y || nameSimilarity(x, y) >= 0.8
  }
  // Declared twins compare with their primary account; an undeclared upload with the company's synced accounts.
  const declared = (c: SourceRecord): boolean => Boolean(accountOf(c)?.duplicateOf)
  const pool = (c: SourceRecord): SourceRecord[] =>
    (declared(c) ? (byAccount.get(accountOf(c)?.duplicateOf as Id) ?? []) : (byEntity.get(`${c.entityId}`) ?? [])).filter(
      // A primary already linked is fine: a duplicate voids the copy and leaves the primary's links alone.
      (p) => p.id !== c.id && !matched.has(p.id) && (p.amount as Money).currency === (c.amount as Money).currency,
    )
  const near = (c: SourceRecord, ps: SourceRecord[], days: number): SourceRecord[] =>
    ps
      .filter((p) => (p.amount as Money).minor === (c.amount as Money).minor && Math.abs(daysBetween(c.date, p.date)) <= days)
      .sort((a, b) => Math.abs(daysBetween(c.date, a.date)) - Math.abs(daysBetween(c.date, b.date)) || (a.id < b.id ? -1 : 1))
  const pair = (c: SourceRecord, p: SourceRecord, confidence: number, method: 'exact_id' | 'rule' | 'fuzzy', pass: number, reason: string): void => {
    matched.add(c.id)
    matched.add(p.id)
    // Not known to be one account: even a perfect match is only a suggestion.
    const sure = declared(c)
    push({
      type: 'duplicate',
      fromId: p.id,
      toId: c.id,
      confidence: sure ? confidence : Math.min(confidence, 0.9),
      method: sure ? method : 'fuzzy',
      scores: { pass, days: Math.abs(daysBetween(c.date, p.date)) },
      reason: sure ? reason : typedIn(c) ? 'an entry repeats a synced row' : 'an uploaded statement repeats a synced row',
    })
  }
  const open = () => copies.filter((c) => !matched.has(c.id) && idx.used(c.id) === 0)
  // 1. Bank id.
  for (const c of open()) {
    const ids = new Set(refs(c))
    const hit = pool(c).find((p) => (p.amount as Money).minor === (c.amount as Money).minor && refs(p).some((r) => ids.has(r)))
    if (hit) pair(c, hit, 1, 'exact_id', 1, 'the same bank id from two sources for one account')
  }
  // 2. Amount within 7 days, same payee (both blank counts as the same). Undeclared uploads: 2 days, and only ever proposed.
  for (const c of open()) {
    const hit = near(c, pool(c), declared(c) ? 7 : 2).find((p) => samePayee(c, p))
    if (!hit) continue
    const sameDay = hit.date === c.date
    pair(c, hit, sameDay ? 0.97 : 0.85, sameDay ? 'rule' : 'fuzzy', 2, sameDay ? 'same day, amount and payee from two sources for one account' : 'same amount and payee within a week, from two sources for one account')
  }
  // 3. Amount within 7 days (declared twins only).
  for (const c of open()) {
    if (!declared(c)) continue
    const hit = near(c, pool(c), 7)[0]
    if (hit) pair(c, hit, hit.date === c.date ? 0.8 : 0.7, 'fuzzy', 3, 'same amount within a week, from two sources for one account')
  }
}

function exactPass(input: MatchInput, txns: SourceRecord[], byExternal: Map<string, SourceRecord[]>, idx: LinkIndex, push: Push): void {
  const refKey = (r: SourceRecord, ...keys: string[]): string | undefined => {
    if (r.event.type !== 'txn.upsert') return undefined
    for (const k of keys) {
      const v = r.event.linkRefs?.[k]
      if (v) return v
    }
    return undefined
  }
  const processorByPayout = new Map<string, SourceRecord>()
  const processorByRef = new Map<string, SourceRecord>()
  for (const r of input.records) {
    if (r.event.type === 'processor.balance_txn' && r.event.kind === 'payout') {
      processorByPayout.set(r.event.externalId, r)
      if (r.event.payoutExternalId) processorByPayout.set(r.event.payoutExternalId, r)
      for (const v of Object.values(processorRefs(r))) processorByRef.set(v, r)
    }
  }
  const transferRefs = new Map<string, SourceRecord[]>()
  for (const t of txns) {
    const ev = t.event as TxnUpsert
    // pending → posted
    if (ev.pendingExternalId) {
      const pending = (byExternal.get(`txn.upsert|${ev.pendingExternalId}`) ?? []).find((p) => p.connectionId === t.connectionId && p.id !== t.id)
      if (pending) push({ type: 'pending_posted', fromId: pending.id, toId: t.id, confidence: 1, method: 'exact_id', reason: 'provider pending id' })
    }
    // payout → deposit (payout id, or any shared reference such as a trace id)
    const payoutRef = refKey(t, 'payout_id', 'payout')
    const traced = ev.amount.minor > 0 ? Object.values(ev.linkRefs ?? {}).map((v) => processorByRef.get(v)).find(Boolean) : undefined
    if ((payoutRef || traced) && ev.amount.minor > 0) {
      const payout = (payoutRef ? processorByPayout.get(payoutRef) : undefined) ?? traced
      if (payout && payout.event.type === 'processor.balance_txn') {
        push({ type: 'payout', fromId: payout.id, toId: t.id, amount: money(Math.abs(payout.event.net.minor), payout.event.net.currency), confidence: 1, method: 'exact_id', reason: 'payout id on the deposit' })
      }
    }
    for (const key of ['transfer', 'card_payment']) {
      const ref = refKey(t, key)
      if (ref) transferRefs.set(`${key}|${ref}`, [...(transferRefs.get(`${key}|${ref}`) ?? []), t])
    }
    // invoice reference on a bank row
    const invRef = refKey(t, 'invoice', 'invoice_id')
    if (invRef) {
      const inv = (byExternal.get(`invoice.upsert|${invRef}`) ?? []).find((i) => i.entityId === t.entityId)
      if (inv && inv.event.type === 'invoice.upsert') {
        const amt = Math.min(free(idx, t), Math.max(0, Math.abs(inv.event.total.minor) - idx.used(inv.id)))
        if (amt > 0) push({ type: 'invoice_payment', fromId: inv.id, toId: t.id, amount: money(amt, ev.amount.currency), confidence: 1, method: 'exact_id', reason: 'invoice id on the payment' })
      }
    }
  }
  // A processor charge that paid an invoice of the same connection (Stripe: the invoice lists the charge's payment intent): it settles the
  // invoice instead of being revenue a second time.
  const invoiceByPayment = new Map<string, SourceRecord>()
  for (const r of input.records) {
    if (r.event.type === 'invoice.upsert') for (const ref of r.event.paymentRefs ?? []) invoiceByPayment.set(`${r.connectionId}|${ref}`, r)
  }
  if (invoiceByPayment.size) {
    for (const r of input.records) {
      if (r.event.type !== 'processor.balance_txn' || r.event.kind !== 'charge') continue
      const pi = r.event.linkRefs?.payment_intent
      const inv = pi ? invoiceByPayment.get(`${r.connectionId}|${pi}`) : undefined
      if (!inv || inv.event.type !== 'invoice.upsert') continue
      // No amount: the charge pays the invoice in full (its gross; Stripe's fee comes out of the balance, not the invoice).
      if (idx.used(r.id) === 0 && idx.used(inv.id) === 0) push({ type: 'invoice_payment', fromId: inv.id, toId: r.id, confidence: 1, method: 'exact_id', reason: 'the invoice lists this payment' })
    }
  }
  for (const [key, group] of transferRefs) {
    const out = group.filter((g) => (g.amount?.minor ?? 0) < 0)
    const inn = group.filter((g) => (g.amount?.minor ?? 0) > 0)
    if (out.length === 1 && inn.length === 1) {
      const [o, i] = [out[0] as SourceRecord, inn[0] as SourceRecord]
      const type = o.entityId !== i.entityId ? 'intercompany' : key.startsWith('card_payment') ? 'card_payment' : 'transfer'
      push({ type, fromId: o.id, toId: i.id, confidence: 1, method: 'exact_id', reason: `shared ${key.split('|')[0]} reference` })
    }
  }
  // Payments told by an invoicing tool, with the bank row id.
  for (const r of input.records) {
    if (r.event.type === 'payment.applied' && r.event.bankTxnRef && r.status !== 'void') {
      const bank = (byExternal.get(`txn.upsert|${r.event.bankTxnRef}`) ?? []).find((b) => b.entityId === r.entityId)
      if (bank) push({ type: 'invoice_payment', fromId: r.id, toId: bank.id, amount: r.event.amount, confidence: 1, method: 'exact_id', reason: 'bank transaction id on the payment' })
    }
    if (r.event.type === 'payroll.run' && r.event.settlementTxnExternalIds) {
      for (const ext of r.event.settlementTxnExternalIds) {
        const bank = (byExternal.get(`txn.upsert|${ext}`) ?? []).find((b) => b.entityId === r.entityId)
        if (bank) push({ type: 'payroll_settlement', fromId: r.id, toId: bank.id, confidence: 1, method: 'exact_id', reason: 'payroll provider settlement id' })
      }
    }
  }
}

function transferPass(input: MatchInput, txns: SourceRecord[], idx: LinkIndex, push: Push, acct: (r: SourceRecord) => SourceAccountInfo | undefined): void {
  const outs = txns.filter((t) => (t.amount?.minor ?? 0) < 0 && idx.used(t.id) === 0)
  const ins = txns.filter((t) => (t.amount?.minor ?? 0) > 0 && idx.used(t.id) === 0)
  // Index money-in rows by (currency, amount) for exact matches, and by date for the cross-currency band.
  const exact = new Map<string, SourceRecord[]>()
  for (const i of ins) {
    const key = `${(i.amount as Money).currency}|${(i.amount as Money).minor}`
    exact.set(key, [...(exact.get(key) ?? []), i])
  }
  const insByDate = [...ins].sort((a, b) => (a.date < b.date ? -1 : 1))
  const firstOnOrAfter = (date: string): number => {
    let lo = 0
    let hi = insByDate.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((insByDate[mid] as SourceRecord).date < date) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  type Cand = { i: SourceRecord; fx: boolean; diff: number; tier: number }
  const candidates = (o: SourceRecord): Cand[] => {
    const oa = o.amount as Money
    // A card can show a payment a day or two before the bank does.
    const earliest = (i: SourceRecord) => (acct(i)?.accountType === 'credit_card' ? -2 : 0)
    const ok = (i: SourceRecord) => i.sourceAccountId && o.sourceAccountId && i.sourceAccountId !== o.sourceAccountId && daysBetween(o.date, i.date) >= earliest(i) && daysBetween(o.date, i.date) <= 4
    const same = (exact.get(`${oa.currency}|${-oa.minor}`) ?? []).filter(ok)
    // Tiers: 1 same company + same currency, 2 another company + same currency, 3 cross-currency within the band.
    const tier1 = same.filter((i) => i.entityId === o.entityId).map((i) => ({ i, fx: false, diff: 0, tier: 1 }))
    if (tier1.length) return tier1
    const tier2 = same.map((i) => ({ i, fx: false, diff: 0, tier: 2 }))
    if (tier2.length) return tier2
    const ro = input.reportingMinor.get(o.id)
    if (ro === undefined || ro === 0) return []
    const out: Cand[] = []
    for (let n = firstOnOrAfter(o.date); n < insByDate.length; n++) {
      const i = insByDate[n] as SourceRecord
      if (daysBetween(o.date, i.date) > 4) break
      if ((i.amount as Money).currency === oa.currency || !ok(i)) continue
      const ri = input.reportingMinor.get(i.id)
      if (ri === undefined) continue
      const diff = Math.abs(Math.abs(ri) - Math.abs(ro)) / Math.abs(ro)
      if (diff <= 0.1) out.push({ i, fx: true, diff, tier: i.entityId === o.entityId ? 3 : 4 })
    }
    const best = Math.min(...out.map((c) => c.tier))
    return out.filter((c) => c.tier === best)
  }
  const all = outs.map((o) => ({ o, cands: candidates(o) }))
  // How many money-out rows compete for each money-in row, at its best tier.
  const inBest = new Map<Id, { tier: number; n: number }>()
  for (const { cands } of all) {
    for (const c of cands) {
      const cur = inBest.get(c.i.id)
      if (!cur || c.tier < cur.tier) inBest.set(c.i.id, { tier: c.tier, n: 1 })
      else if (c.tier === cur.tier) cur.n++
    }
  }
  for (const { o, cands } of all) {
    for (const { i, fx, diff, tier } of cands) {
      const ib = inBest.get(i.id)
      if (ib && ib.tier < tier) continue // this money-in row has a better match elsewhere
      const oa = acct(o)
      const ia = acct(i)
      const crossEntity = o.entityId !== i.entityId
      const type: LinkType = crossEntity
        ? 'intercompany'
        : oa?.accountType === 'credit_card' || ia?.accountType === 'credit_card'
          ? 'card_payment'
          : oa?.accountType === 'cash_on_hand' || ia?.accountType === 'cash_on_hand'
            ? 'cash_deposit'
            : 'transfer'
      const unique = cands.length === 1 && ib?.n === 1
      const providerBoth = o.origin === 'connector' && i.origin === 'connector'
      const words = type === 'card_payment' ? CARD_PAYMENT_WORDS : TRANSFER_WORDS
      const textHint = words.some((w) => txnText(o).includes(w) || txnText(i).includes(w))
      let confidence: number
      // Money between companies always waits for a person; so does anything not unique.
      if (crossEntity) confidence = unique ? (textHint ? 0.9 : 0.85) : textHint ? 0.75 : 0.65
      // Equal and opposite amounts alone are a guess ($12,000 rent, a $12,000 customer ACH): it takes words to confirm.
      else if (fx) confidence = diff <= 0.03 && unique && providerBoth && textHint ? 0.95 : 0.75
      else if (unique && providerBoth && (textHint || (type === 'transfer' && input.knownPairs?.has(accountPair(o.sourceAccountId, i.sourceAccountId))))) confidence = 0.99
      else if (unique) confidence = textHint ? 0.9 : 0.85
      else confidence = textHint ? 0.75 : 0.65
      push({
        type,
        fromId: o.id,
        toId: i.id,
        confidence,
        method: 'rule',
        scores: { amount: fx ? 1 - diff : 1, date: 1 - Math.abs(daysBetween(o.date, i.date)) / 5, unique: unique ? 1 : 0, text: textHint ? 1 : 0 },
        reason: fx ? 'opposite amounts in two currencies within the FX band' : 'opposite equal amounts within 4 days',
      })
    }
  }
}

/** Optional fields S3 adds to payouts (linkRefs, arrivalDate); read defensively until they're in the contract. */
function processorRefs(r: SourceRecord): Record<string, string> {
  const refs = (r.event as { linkRefs?: Record<string, string> }).linkRefs
  return refs && typeof refs === 'object' ? refs : {}
}

function arrivalDate(r: SourceRecord): string {
  const d = (r.event as { arrivalDate?: string }).arrivalDate
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : r.date
}

function payoutPass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  const payouts = live.filter((r) => r.event.type === 'processor.balance_txn' && (r.event.kind === 'payout' || r.event.balanceRole === 'clearing_payouts') && idx.used(r.id) === 0)
  if (!payouts.length) return
  // Bank rows by company, currency and amount (in their order): each payout looks at its own few, not every row. A demo
  // fill's every payout scanning every bank row held the event loop seconds on a shared CPU (staging, 2026-10-13).
  const byAmount = new Map<string, SourceRecord[]>()
  for (const t of txns) {
    if (!t.amount) continue
    const k = `${t.entityId}|${t.amount.currency}|${t.amount.minor}`
    const list = byAmount.get(k)
    if (list) list.push(t)
    else byAmount.set(k, [t])
  }
  for (const p of payouts) {
    if (p.event.type !== 'processor.balance_txn') continue
    const net = p.event.net
    const deposits = (byAmount.get(`${p.entityId}|${net.currency}|${-net.minor}`) ?? []).filter(
      (t) =>
        idx.used(t.id) === 0 &&
        daysBetween(arrivalDate(p), t.date) >= (arrivalDate(p) === p.date ? 0 : -1) &&
        daysBetween(arrivalDate(p), t.date) <= (arrivalDate(p) === p.date ? 7 : 3),
    )
    for (const d of deposits) {
      const named = PROCESSOR_NAMES.some((n) => txnText(d).includes(n))
      const confidence = deposits.length === 1 ? (named ? 0.97 : 0.85) : named ? 0.8 : 0.6
      push({ type: 'payout', fromId: p.id, toId: d.id, amount: money(Math.abs(net.minor), net.currency), confidence, method: 'rule', scores: { amount: 1, name: named ? 1 : 0 }, reason: 'payout amount arrived at the bank' })
    }
  }
}

function cashDepositPass(txns: SourceRecord[], idx: LinkIndex, push: Push, acct: (r: SourceRecord) => SourceAccountInfo | undefined): void {
  // A drawer that records its own trips to the bank (money out of the cash account) is matched as transfers; only cash
  // that is never seen leaving waits for a deposit here.
  // A refund paid back from the drawer (a Square cash refund, tagged refund_of) is not a trip to the bank.
  const isRefund = (t: SourceRecord): boolean => !!(t.event as TxnUpsert).linkRefs?.refund_of
  const tracked = new Set(txns.filter((t) => acct(t)?.accountType === 'cash_on_hand' && (t.amount?.minor ?? 0) < 0 && !isRefund(t)).map((t) => t.sourceAccountId))
  const cash = txns.filter((t) => acct(t)?.accountType === 'cash_on_hand' && !tracked.has(t.sourceAccountId) && (t.amount?.minor ?? 0) > 0 && free(idx, t) > 0)
  const summed = drawerRunPass(txns, cash, idx, push, acct, isRefund)
  const guesses = new Map<Id, Array<() => void>>()
  for (const c of cash) {
    const amt = free(idx, c)
    const deposits = txns.filter((d) => {
      const a = acct(d)
      if (!a || a.accountType === 'cash_on_hand' || summed.has(d.id) || d.entityId !== c.entityId || d.amount?.currency !== c.amount?.currency) return false
      const days = daysBetween(c.date, d.date)
      return (d.amount?.minor ?? 0) >= amt && free(idx, d) >= amt && days >= 0 && days <= 30
    })
    for (const d of deposits) {
      const keyword = /deposit|cash|atm|branch/.test(txnText(d))
      const exact = d.amount?.minor === amt
      const soon = daysBetween(c.date, d.date) <= 7
      // Same amount, says "cash deposit", the only candidate, within a week: confident enough to link (undoable).
      const confidence = exact && keyword && soon && deposits.length === 1 ? 0.96 : Math.min(0.9, (keyword ? 0.75 : 0.6) + (exact ? 0.15 : 0) + (deposits.length === 1 ? 0.05 : 0))
      const p = () => push({ type: 'cash_deposit', fromId: c.id, toId: d.id, amount: money(amt, c.amount?.currency ?? 'USD'), confidence, method: 'rule', reason: 'cash recorded earlier, later deposited' })
      if (exact) p()
      else guesses.set(d.id, [...(guesses.get(d.id) ?? []), p])
    }
  }
  // A deposit that could hold any of many cash rows is a guess, not a question worth asking (more than 3: none).
  for (const ps of guesses.values()) if (ps.length <= 3) for (const p of ps) p()
}

/**
 * A deposit that is a drawer's takings: many small cash sales (Square cash and "other" tenders), less cash refunds paid
 * from the drawer, taken to the bank together. The drawer's oldest undeposited sales are summed in date order up to the
 * deposit's date (within 30 days); when that run, less the refunds among it, equals the deposit exactly, each sale is
 * proposed as part of it (for Review: a sum is a strong hint, not proof). A refund comes off the sale it names, so
 * that sale's refunded cash isn't counted as deposited. Returns the deposits it explained, so single-row guesses leave them alone.
 */
function drawerRunPass(
  txns: SourceRecord[],
  cash: SourceRecord[],
  idx: LinkIndex,
  push: Push,
  acct: (r: SourceRecord) => SourceAccountInfo | undefined,
  isRefund: (t: SourceRecord) => boolean,
): Set<Id> {
  const done = new Set<Id>()
  const drawers = new Map<Id, SourceRecord[]>()
  for (const c of cash) if (c.sourceAccountId) drawers.set(c.sourceAccountId, [...(drawers.get(c.sourceAccountId) ?? []), c])
  if (!drawers.size) return done
  const refunds = txns.filter((t) => isRefund(t) && t.sourceAccountId && drawers.has(t.sourceAccountId) && free(idx, t) > 0)
  const deposits = txns
    .filter((d) => {
      const a = acct(d)
      return !!a && a.accountType !== 'cash_on_hand' && (d.amount?.minor ?? 0) > 0 && free(idx, d) === absAmount(d)
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const spent = new Set<Id>()
  for (const d of deposits) {
    const want = d.amount?.minor ?? 0
    for (const [drawer, sales] of drawers) {
      const first = sales[0]
      if (!first || first.entityId !== d.entityId || first.amount?.currency !== d.amount?.currency) continue
      const rows = [...sales.filter((c) => !spent.has(c.id)), ...refunds.filter((r) => r.sourceAccountId === drawer && !spent.has(r.id))]
        .filter((r) => daysBetween(r.date, d.date) >= 0 && daysBetween(r.date, d.date) <= 30)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.amount?.minor ?? 0) - (b.amount?.minor ?? 0)))
      let net = 0
      const run: SourceRecord[] = []
      for (const r of rows) {
        net += (r.amount?.minor ?? 0) > 0 ? free(idx, r) : -free(idx, r)
        run.push(r)
        if (net === want && run.filter((x) => (x.amount?.minor ?? 0) > 0).length >= 2) break
        if (net > want) break
      }
      const salesInRun = run.filter((x) => (x.amount?.minor ?? 0) > 0)
      if (net !== want || salesInRun.length < 2) continue
      // A refund that names its sale (refund_of) comes off that sale; any other refund off the latest sales. Then the
      // deposit covers each sale's remaining cash, oldest first.
      const owed = new Map(salesInRun.map((c) => [c.id, free(idx, c)]))
      const saleOf = (paymentId: string) => salesInRun.find((c) => (c.event as TxnUpsert).linkRefs?.square_payment === paymentId || c.externalId === `cash:${paymentId}`)
      let loose = 0
      for (const r of run.filter((x) => (x.amount?.minor ?? 0) < 0)) {
        const target = saleOf((r.event as TxnUpsert).linkRefs?.refund_of ?? '')
        let amt = free(idx, r)
        if (target) {
          const take = Math.min(amt, owed.get(target.id) ?? 0)
          owed.set(target.id, (owed.get(target.id) ?? 0) - take)
          amt -= take
        }
        loose += amt
      }
      for (const c of [...salesInRun].reverse()) {
        if (loose <= 0) break
        const take = Math.min(loose, owed.get(c.id) ?? 0)
        owed.set(c.id, (owed.get(c.id) ?? 0) - take)
        loose -= take
      }
      let left = want
      const keyword = /deposit|cash|atm|branch/.test(txnText(d))
      for (const c of salesInRun) {
        const amt = Math.min(owed.get(c.id) ?? 0, left)
        if (amt <= 0) continue
        left -= amt
        push({ type: 'cash_deposit', fromId: c.id, toId: d.id, amount: money(amt, c.amount?.currency ?? 'USD'), confidence: keyword ? 0.9 : 0.8, method: 'rule', scores: { amount: 1, rows: salesInRun.length }, reason: 'the drawer’s cash sales add up to this deposit' })
      }
      for (const r of run) spent.add(r.id)
      done.add(d.id)
      break
    }
  }
  return done
}

function paymentPass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  for (const p of live) {
    if (p.event.type !== 'payment.applied' || idx.used(p.id) > 0 || p.event.bankTxnRef) continue
    const pay = p.event
    const sign = pay.direction === 'receivable' ? 1 : -1
    const cands = txns.filter((t) => {
      const d = daysBetween(pay.date, t.date)
      return t.entityId === p.entityId && free(idx, t) === absAmount(t) && t.amount?.currency === pay.amount.currency && t.amount.minor === sign * pay.amount.minor && d >= -2 && d <= 7
    })
    for (const t of cands) {
      const name = pay.counterparty ? nameSimilarity(pay.counterparty, txnText(t)) : 0
      const confidence = Math.min(0.99, (cands.length === 1 ? 0.88 : 0.7) + 0.08 * name)
      push({ type: 'invoice_payment', fromId: p.id, toId: t.id, amount: pay.amount, confidence, method: 'fuzzy', scores: { amount: 1, name }, reason: 'payment recorded by the invoicing tool' })
    }
  }
}

/**
 * A processor charge that pays an invoice from the same provider (Stripe invoices paid by card): settles AR there
 * instead of being revenue a second time. Exact by the invoice id on the charge (linkRefs.invoice); otherwise the
 * one invoice of that connection with the same amount, issued shortly before (several alike: a question). A sale also
 * in other books (QuickBooks, Xero, FreshBooks) is proposed by amount and customer name, never confirmed on its own.
 */
function processorInvoicePass(live: SourceRecord[], idx: LinkIndex, push: Push): void {
  const invoices = live.filter((r) => r.event.type === 'invoice.upsert' && r.event.direction === 'receivable' && ['open', 'partially_paid', 'paid', 'disputed'].includes(r.event.status))
  if (invoices.length === 0) return
  const remaining = (inv: SourceRecord): number => (inv.event.type === 'invoice.upsert' ? Math.abs(inv.event.total.minor) - idx.used(inv.id) : 0)
  for (const c of live) {
    if (c.event.type !== 'processor.balance_txn' || c.event.kind !== 'charge' || idx.used(c.id) > 0 || c.event.gross.minor <= 0) continue
    const gross = c.event.gross
    const refs = processorRefs(c)
    const ref = refs.invoice ?? refs.invoice_id
    if (ref) {
      const inv = invoices.find((i) => i.externalId === ref && i.entityId === c.entityId)
      const amt = inv ? Math.min(gross.minor, remaining(inv)) : 0
      if (inv && amt > 0) push({ type: 'invoice_payment', fromId: inv.id, toId: c.id, amount: money(amt, gross.currency), confidence: 1, method: 'exact_id', reason: 'invoice id on the charge' })
      continue
    }
    const cands = invoices.filter((i) => {
      if (i.event.type !== 'invoice.upsert' || i.connectionId !== c.connectionId || i.entityId !== c.entityId || i.event.total.currency !== gross.currency) return false
      const days = daysBetween(i.event.issueDate, c.date)
      return remaining(i) === gross.minor && days >= -1 && days <= 45
    })
    for (const inv of cands) {
      push({ type: 'invoice_payment', fromId: inv.id, toId: c.id, amount: gross, confidence: cands.length === 1 ? AUTO_CONFIRM : 0.7, method: 'fuzzy', scores: { amount: 1, date: 1 }, reason: 'same provider, same amount as the invoice' })
    }
    if (cands.length > 0 || !c.event.counterparty) continue
    const who = c.event.counterparty
    const payments = live.filter((p) => {
      if (p.event.type !== 'payment.applied' || p.event.direction !== 'receivable' || p.event.bankTxnRef || idx.used(p.id) > 0) return false
      const days = daysBetween(p.event.date, c.date)
      return p.connectionId !== c.connectionId && p.entityId === c.entityId && p.event.amount.currency === gross.currency && p.event.amount.minor === gross.minor && days >= -2 && days <= 7 && nameSimilarity(p.event.counterparty ?? '', who) >= SAME_CUSTOMER
    })
    const open = payments.length ? [] : invoices.filter((i) => {
      if (i.event.type !== 'invoice.upsert' || i.event.status === 'paid' || i.connectionId === c.connectionId || i.entityId !== c.entityId || i.event.total.currency !== gross.currency) return false
      const days = daysBetween(i.event.issueDate, c.date)
      return remaining(i) === gross.minor && days >= -1 && days <= 45 && nameSimilarity(i.event.counterparty, who) >= SAME_CUSTOMER
    })
    for (const r of [...payments, ...open]) push({ type: 'invoice_payment', fromId: r.id, toId: c.id, amount: gross, confidence: 0.8, method: 'fuzzy', scores: { amount: 1, name: 1 }, reason: 'same amount and customer in your books and your processor' })
  }
}

/**
 * A refund in a processor that the books also recorded as a refund credit note: both take the money off revenue on the
 * accrual side. Proposed on amount and customer name, never confirmed on its own.
 */
function bookedRefundPass(live: SourceRecord[], idx: LinkIndex, push: Push): void {
  const notes = live.filter((r) => r.event.type === 'credit_note.upsert' && r.event.direction === 'receivable' && r.event.appliedTo === 'refund' && r.event.status !== 'void')
  if (notes.length === 0) return
  for (const c of live) {
    if (c.event.type !== 'processor.balance_txn' || c.event.kind !== 'refund' || idx.used(c.id) > 0 || c.event.gross.minor >= 0) continue
    const who = c.event.counterparty
    if (!who) continue
    const gross = c.event.gross
    for (const n of notes) {
      if (n.event.type !== 'credit_note.upsert' || n.connectionId === c.connectionId || n.entityId !== c.entityId || idx.used(n.id) > 0) continue
      const days = daysBetween(n.event.date, c.date)
      if (n.event.amount.currency !== gross.currency || Math.abs(n.event.amount.minor) !== -gross.minor || days < -2 || days > 14) continue
      if (nameSimilarity(n.event.counterparty ?? '', who) >= SAME_CUSTOMER) push({ type: 'refund', fromId: n.id, toId: c.id, amount: money(-gross.minor, gross.currency), confidence: 0.8, method: 'fuzzy', scores: { amount: 1, name: 1 }, reason: 'same amount and customer in your books' })
    }
  }
}

function invoicePass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  // Invoices whose payments arrive as payment.applied events are matched through those payments, except what the
  // provider still shows open (a partial payment there, the rest paid straight into the bank).
  const viaPayments = new Set<string>()
  for (const r of live) if (r.event.type === 'payment.applied') for (const a of r.event.applications) viaPayments.add(`${r.connectionId}|${a.invoiceExternalId}`)
  const open: Array<{ inv: SourceRecord; e: InvoiceUpsert; remaining: number; partial: boolean }> = []
  for (const r of live) {
    if (r.event.type !== 'invoice.upsert' || !['open', 'partially_paid', 'disputed'].includes(r.event.status)) continue
    const e = r.event
    const total = Math.abs(e.total.minor)
    const paidThere = viaPayments.has(`${r.connectionId}|${r.externalId}`) ? Math.abs(e.amountPaid.minor) + Math.abs(e.amountCredited?.minor ?? 0) : 0
    const remaining = total - paidThere - idx.used(r.id)
    if (remaining > 0) open.push({ inv: r, e, remaining, partial: remaining !== total })
  }
  for (const t of txns) {
    const ev = t.event as TxnUpsert
    if (free(idx, t) !== absAmount(t)) continue
    const pay = Math.abs(ev.amount.minor)
    const text = txnText(t)
    const fits = open.filter((o) => o.inv.entityId === t.entityId && (o.e.direction === 'receivable') === ev.amount.minor > 0 && o.e.total.currency === ev.amount.currency)
    const scored: Array<{ inv: SourceRecord; score: number; scores: Record<string, number>; amt: number }> = []
    const amountOnly: typeof scored = []
    for (const { inv, e, remaining, partial } of fits) {
      // Exact (the open balance, or the whole invoice when nothing was paid); near (a few cents off): never automatic.
      const exact = pay === remaining || (!partial && pay === Math.abs(e.total.minor))
      const near = !exact && Math.abs(pay - remaining) <= Math.max(NEAR_MINOR, Math.round(remaining * 0.005))
      const reference = e.number && e.number.length >= 3 && text.includes(e.number.toLowerCase()) ? 1 : 0
      // Part of what's owed, naming the document (a bill paid in two): asked about, for the part paid.
      const part = !exact && !near && reference === 1 && pay < remaining
      const amount = exact ? 1 : near ? 0.7 : part ? 0.5 : 0
      const counterparty = nameSimilarity(e.counterparty, `${ev.counterparty ?? ''} ${ev.rawText ?? ''}`)
      const due = e.dueDate ?? e.issueDate
      const date = t.date >= e.issueDate && daysBetween(due, t.date) <= 60 ? 1 : 0
      const score = 0.45 * amount + 0.25 * counterparty + 0.2 * reference + 0.1 * date
      const entry = { inv, score: near || part ? Math.min(score, 0.9) : score, scores: { amount, counterparty, reference, date }, amt: Math.min(pay, remaining) }
      if (score >= PROPOSE_MIN && (amount > 0 || reference === 1)) scored.push(entry)
      // The same amount, in time, but nothing names it (a mobile deposit): a question when there are few such.
      else if (exact && date === 1 && reference === 0) amountOnly.push({ ...entry, score: PROPOSE_MIN })
    }
    if (scored.length === 0 && amountOnly.length > 0 && amountOnly.length <= 3) scored.push(...amountOnly)
    scored.sort((a, b) => b.score - a.score)
    for (const [n, s] of scored.entries()) {
      // A tie at the top can never auto-confirm.
      const tie = n === 0 && scored.length > 1 && (scored[1]?.score ?? 0) === s.score
      const confidence = Math.round((tie ? Math.min(s.score, 0.94) : s.score) * 1000) / 1000
      push({ type: 'invoice_payment', fromId: s.inv.id, toId: t.id, amount: money(s.amt, ev.amount.currency), confidence, method: 'fuzzy', scores: s.scores, reason: 'amount, name, reference and date score' })
    }
    if (scored.length > 0) continue
    // One deposit paying two open invoices in full (two checks deposited together): proposed only when exactly one
    // pair adds up, and never automatic.
    const inTime = fits.filter((o) => t.date >= o.e.issueDate && daysBetween(o.e.dueDate ?? o.e.issueDate, t.date) <= 60)
    const byAmount = new Map<number, typeof inTime>()
    for (const o of inTime) byAmount.set(o.remaining, [...(byAmount.get(o.remaining) ?? []), o])
    const pairs: Array<[(typeof inTime)[number], (typeof inTime)[number]]> = []
    for (const [i, a] of inTime.entries()) {
      for (const b of byAmount.get(pay - a.remaining) ?? []) if (inTime.indexOf(b) > i) pairs.push([a, b])
      if (pairs.length > 1) break
    }
    if (pairs.length !== 1) continue
    for (const o of pairs[0] as [(typeof inTime)[number], (typeof inTime)[number]]) {
      push({ type: 'invoice_payment', fromId: o.inv.id, toId: t.id, amount: money(o.remaining, ev.amount.currency), confidence: 0.7, method: 'fuzzy', scores: { amount: 1, counterparty: 0, reference: 0, date: 1, pair: 1 }, reason: 'two open invoices add up to this payment' })
    }
  }
}

function payrollPass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  // Payroll-looking debits per company, found once (the name test is the expensive part).
  const named = new Map<string | null, SourceRecord[]>()
  for (const t of txns) {
    if ((t.amount?.minor ?? 0) >= 0 || !PAYROLL_NAMES.some((n) => txnText(t).includes(n))) continue
    named.set(t.entityId, [...(named.get(t.entityId) ?? []), t])
  }
  for (const r of live) {
    if (r.event.type !== 'payroll.run' || r.event.status === 'void' || r.event.status === 'scheduled') continue
    const run = r.event
    const debits = (named.get(r.entityId) ?? []).filter((t) => {
      const d = daysBetween(run.payDate, t.date)
      return idx.used(t.id) === 0 && d >= -4 && d <= 2
    })
    if (debits.length === 0) continue
    const target = run.companyDebit?.minor ?? run.net.minor + run.employerTaxes.minor + (run.employeeTaxes?.minor ?? 0)
    const sum = debits.reduce((s, d) => s + Math.abs(d.amount?.minor ?? 0), 0)
    const exact = sum === target
    for (const d of debits) {
      push({ type: 'payroll_settlement', fromId: r.id, toId: d.id, confidence: exact ? 0.97 : 0.8, method: 'rule', scores: { sum: exact ? 1 : 0 }, reason: exact ? 'payroll debits add up to the run' : 'payroll provider debit near the pay date' })
    }
  }
}

function equityPass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  for (const r of live) {
    if (r.event.type !== 'equity.event' || !r.event.amount || idx.used(r.id) > 0) continue
    if (!['issuance', 'safe', 'convertible_note', 'exercise'].includes(r.event.kind)) continue
    const eq = r.event
    const amount = eq.amount as Money
    const deposits = txns.filter((t) => {
      const d = daysBetween(eq.date, t.date)
      return t.entityId === r.entityId && idx.used(t.id) === 0 && t.amount?.currency === amount.currency && t.amount.minor === amount.minor && Math.abs(d) <= 10
    })
    for (const d of deposits) {
      const name = nameSimilarity(eq.stakeholder, txnText(d))
      const confidence = deposits.length === 1 && name >= 0.8 ? 0.95 : deposits.length === 1 ? 0.85 : 0.65
      push({ type: 'equity_cash', fromId: r.id, toId: d.id, amount, confidence, method: 'rule', scores: { amount: 1, name }, reason: 'investment money arrived' })
    }
  }
}

/** An investment's money at the bank: invest → the wire out; distribution or exit → the money in. Same amount, ±10 days. */
function investmentPass(live: SourceRecord[], txns: SourceRecord[], idx: LinkIndex, push: Push): void {
  for (const r of live) {
    if (r.event.type !== 'investment.event' || !r.event.amount || r.event.amount.minor === 0 || idx.used(r.id) > 0) continue
    if (!['invest', 'distribution', 'exit'].includes(r.event.kind)) continue
    const ev = r.event
    const amount = ev.amount as Money
    const signed = ev.kind === 'invest' ? -amount.minor : amount.minor
    const rows = txns.filter((t) => t.entityId === r.entityId && idx.used(t.id) === 0 && t.amount?.currency === amount.currency && t.amount.minor === signed && Math.abs(daysBetween(ev.date, t.date)) <= 10)
    for (const d of rows) {
      const name = nameSimilarity(ev.issuer, txnText(d))
      const confidence = rows.length === 1 && name >= 0.8 ? 0.95 : rows.length === 1 ? 0.85 : 0.65
      push({ type: 'investment_cash', fromId: r.id, toId: d.id, amount, confidence, method: 'rule', scores: { amount: 1, name }, reason: ev.kind === 'invest' ? 'investment money sent' : 'money back from an investment' })
    }
  }
}

function duplicatePass(txns: SourceRecord[], idx: LinkIndex, push: Push, acct: (r: SourceRecord) => SourceAccountInfo | undefined): void {
  // AI/manual entries that a feed later reports too (a card swipe the AI already recorded as an expense).
  const manual = txns.filter((t) => t.origin !== 'connector' && idx.used(t.id) === 0)
  for (const m of manual) {
    const ma = m.amount as Money
    const cands = txns.filter((t) => {
      if (t.id === m.id || t.origin !== 'connector' || t.entityId !== m.entityId || idx.used(t.id) > 0) return false
      const ta = t.amount as Money
      if (ta.currency !== ma.currency || Math.sign(ta.minor) !== Math.sign(ma.minor)) return false
      const tol = Math.max(1, Math.round(Math.abs(ma.minor) * 0.01))
      return Math.abs(Math.abs(ta.minor) - Math.abs(ma.minor)) <= tol && Math.abs(daysBetween(m.date, t.date)) <= 3 && acct(t)?.accountType !== 'cash_on_hand'
    })
    for (const t of cands) {
      const name = nameSimilarity(txnText(m), txnText(t))
      const confidence = Math.min(0.9, 0.6 + 0.3 * name)
      if (confidence >= PROPOSE_MIN) push({ type: 'duplicate', fromId: t.id, toId: m.id, confidence, method: 'fuzzy', scores: { name }, reason: 'an entry you added also arrived from a connection' })
    }
  }
}
