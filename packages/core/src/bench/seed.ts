// Deterministic "big workspace" seed for the ledger benchmark: 5 companies + Personal, 3 years of bank, card and
// Stripe rows, invoices with payments, monthly payroll, weekly balance snapshots. Same seed → same events.
import type { AccountType, Money, NormalizedEvent } from '@agfn/contracts'
import type { Kit } from '../test-kit.ts'
import type { SourceAccountInfo } from '../model.ts'
import { addDays, addMonths } from '../queries.ts'

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SeedOptions {
  companies?: number
  years?: number
  /** Scales daily volumes (1 ≈ 100k rows for 5 companies × 3 years). */
  scale?: number
  endDate?: string
  seed?: number
}

export interface Seeded {
  entities: string[]
  personal: string
  /** All events in date order (backfill). */
  events: NormalizedEvent[]
  /** Builds the next day's rows (incremental sync). */
  nextDay(rows: number): NormalizedEvent[]
  accounts: Map<string, SourceAccountInfo>
}

const SAAS: Array<[string, number]> = [['Figma', 4_500], ['Notion', 1_600], ['Slack', 8_750], ['GitHub', 2_100], ['Vercel', 2_000], ['Google Workspace', 3_600], ['Linear', 1_400], ['AWS', 0]]
const SPEND = ['Uber', 'Lyft', 'Delta Air Lines', 'Marriott', 'Blue Bottle', 'Sweetgreen', 'Staples', 'Amazon', 'WeWork Day Pass', 'FedEx', 'Apple Store', 'Best Buy', 'Chipotle', 'United Airlines', 'Hilton']
const CUSTOMERS = ['Globex Corp', 'Initech LLC', 'Umbrella Co', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Acme Rockets', 'Soylent Inc', 'Vandelay Imports', 'Pied Piper', 'Massive Dynamic', 'Cyberdyne', 'Tyrell Corp', 'Aperture Labs', 'Wonka Industries']

export async function seedBig(k: Kit, opts: SeedOptions = {}): Promise<Seeded> {
  const nCompanies = opts.companies ?? 5
  const years = opts.years ?? 3
  const scale = opts.scale ?? 1
  const end = opts.endDate ?? '2026-10-09'
  const start = addMonths(end, -12 * years)
  const r = rng(opts.seed ?? 42)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T
  const between = (lo: number, hi: number): number => Math.round(lo + r() * (hi - lo))
  const poisson = (mean: number): number => {
    let n = 0
    let p = Math.exp(-mean)
    let s = p
    const u = r()
    while (u > s && n < mean * 5 + 10) {
      n++
      p *= mean / n
      s += p
    }
    return n
  }

  // EUR→USD daily rates for the EUR-based company.
  for (let d = addDays(start, -10); d <= addDays(end, 10); d = addDays(d, 1)) k.rates.set(d, 'EUR', 'USD', (1.05 + 0.06 * Math.sin(Date.parse(d) / 3e10)).toFixed(4))

  const entities: string[] = []
  const accounts = new Map<string, SourceAccountInfo>()
  const personal = await k.personal('Founder')
  const conns = new Map<string, { books: string; payroll: string }>()
  for (let c = 0; c < nCompanies; c++) {
    const currency = c === nCompanies - 1 ? 'EUR' : 'USD'
    const e = await k.company(`Company ${String.fromCharCode(65 + c)}`, { currency })
    entities.push(e)
    const plaid = await k.connection({ key: 'plaid', lastSuccessAt: `${end}T06:00:00Z` })
    const stripeConn = await k.connection({ key: 'stripe', lastSuccessAt: `${end}T06:00:00Z` })
    conns.set(e, { books: await k.connection({ entityId: e, key: 'quickbooks', lastSuccessAt: `${end}T06:00:00Z` }), payroll: await k.connection({ entityId: e, key: 'gusto', lastSuccessAt: `${end}T06:00:00Z` }) })
    const mk = async (name: string, type: AccountType, connectionId: string) => {
      const a = await k.account({ entityId: e, name, type, currency, connectionId, mask: String(1000 + accounts.size) })
      accounts.set(`${e}|${name}`, a)
      return a
    }
    await mk('Checking', 'depository', plaid)
    await mk('Savings', 'depository', plaid)
    await mk('Card', 'credit_card', plaid)
    await mk('Stripe', 'processor_balance', stripeConn)
  }
  const pConn = await k.connection({ key: 'plaid', lastSuccessAt: `${end}T06:00:00Z` })
  accounts.set(`${personal}|Checking`, await k.account({ entityId: personal, name: 'Personal checking', connectionId: pConn }))

  let seq = 0
  const ext = (p: string) => `${p}_${++seq}`
  const money = (minor: number, currency: string): Money => ({ minor, currency })
  const balances = new Map<string, number>()
  const move = (a: SourceAccountInfo, minor: number) => balances.set(a.id, (balances.get(a.id) ?? 0) + minor)
  const txn = (a: SourceAccountInfo, date: string, minor: number, extra: Record<string, unknown> = {}): NormalizedEvent => {
    move(a, minor)
    return { type: 'txn.upsert', externalId: ext('t'), connectionId: a.connectionId as string, accountExternalId: a.externalId as string, date, amount: money(minor, a.currency), status: 'posted', ...extra } as NormalizedEvent
  }

  const dayEvents = (e: string, idx: number, date: string, volume = 1): NormalizedEvent[] => {
    const out: NormalizedEvent[] = []
    const acc = (n: string) => accounts.get(`${e}|${n}`) as SourceAccountInfo
    const checking = acc('Checking')
    const card = acc('Card')
    const st = acc('Stripe')
    const cur = checking.currency
    const dom = Number(date.slice(8, 10))
    // Stripe charges, settled the next business day as one payout.
    let net = 0
    for (let i = 0; i < poisson(6 * scale * volume); i++) {
      const gross = between(1_900, 49_900)
      const fee = Math.round(gross * 0.029) + 30
      net += gross - fee
      move(st, gross - fee)
      out.push({ type: 'processor.balance_txn', externalId: ext('ch'), connectionId: st.connectionId as string, accountExternalId: st.externalId as string, at: `${date}T${String(between(10, 22)).padStart(2, '0')}:00:00Z`, kind: 'charge', gross: money(gross, cur), fee: money(fee, cur), net: money(gross - fee, cur), customer: `cus_${between(1, 400)}` })
    }
    if (net > 0) {
      const po = ext('po')
      move(st, -net)
      out.push({ type: 'processor.balance_txn', externalId: po, connectionId: st.connectionId as string, accountExternalId: st.externalId as string, at: `${date}T23:30:00Z`, kind: 'payout', gross: money(-net, cur), fee: money(0, cur), net: money(-net, cur), payoutExternalId: po })
      out.push(txn(checking, addDays(date, 2), net, idx % 2 === 0 ? { rawText: 'STRIPE TRANSFER', linkRefs: { payout_id: po } } : { rawText: 'STRIPE TRANSFER ST-XXXX' }))
    }
    // Card spending and monthly SaaS.
    for (let i = 0; i < poisson(4 * scale * volume); i++) out.push(txn(card, date, -between(500, 25_000), { counterparty: pick(SPEND) }))
    for (const [j, [name, price]] of SAAS.entries()) if (dom === 3 + j) out.push(txn(card, date, -(price || between(80_000, 160_000)), { counterparty: name }))
    // Monthly: card payment, rent, savings transfer, payroll.
    if (dom === 25) {
      const owed = -(balances.get(card.id) ?? 0)
      if (owed > 0) {
        out.push(txn(checking, date, -owed, { rawText: 'CARD AUTOPAY PAYMENT' }))
        out.push(txn(card, date, owed, { rawText: 'PAYMENT THANK YOU' }))
      }
    }
    if (dom === 1) out.push(txn(checking, date, -between(400_000, 900_000), { counterparty: 'Landlord LLC', rawText: 'RENT' }))
    if (dom === 10) {
      const amt = between(500_000, 2_000_000)
      out.push(txn(checking, date, -amt, { rawText: 'ONLINE TRANSFER TO SAV' }))
      out.push(txn(acc('Savings'), date, amt, { rawText: 'ONLINE TRANSFER FROM CHK' }))
    }
    if (dom === 15) {
      const gross = between(3_000_000, 6_000_000)
      const employerTaxes = Math.round(gross * 0.0765)
      const netPay = Math.round(gross * 0.72)
      const tax = gross - netPay + employerTaxes
      const a = txn(checking, addDays(date, -1), -netPay, { rawText: 'GUSTO NET PAY' })
      const b = txn(checking, date, -tax, { rawText: 'GUSTO TAX' })
      out.push(a, b)
      out.push({ type: 'payroll.run', externalId: ext('run'), connectionId: conns.get(e)?.payroll as string, payDate: date, gross: money(gross, cur), employerTaxes: money(employerTaxes, cur), net: money(netPay, cur), employeeTaxes: money(gross - netPay, cur), companyDebit: money(netPay + tax, cur), status: 'paid', employeeCount: between(8, 25) } as NormalizedEvent)
    }
    // Invoices (~13/month) paid 10–45 days later by bank deposit naming the invoice.
    if (r() < (13 * volume) / 30) {
      const total = between(200_000, 3_000_000)
      const number = `INV-${1000 + seq}`
      const counterparty = pick(CUSTOMERS)
      const paidOn = addDays(date, between(10, 45))
      out.push({ type: 'invoice.upsert', externalId: ext('inv'), connectionId: conns.get(e)?.books as string, direction: 'receivable', number, counterparty, issueDate: date, dueDate: addDays(date, 30), total: money(total, cur), amountPaid: money(0, cur), status: 'open' } as NormalizedEvent)
      if (paidOn <= end) pendingPayments.push({ date: paidOn, ev: () => txn(checking, paidOn, total, { counterparty, rawText: `${counterparty.toUpperCase()} PAYMENT ${number}` }) })
    }
    // Weekly balance snapshots (taken after the day's rows).
    if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) {
      for (const n of ['Checking', 'Savings', 'Card', 'Stripe']) {
        const a = acc(n)
        out.push({ type: 'balance.snapshot', externalId: ext('bal'), connectionId: a.connectionId as string, accountExternalId: a.externalId as string, at: `${date}T23:59:00Z`, current: money(balances.get(a.id) ?? 0, a.currency) })
      }
    }
    return out
  }

  const pendingPayments: Array<{ date: string; ev: () => NormalizedEvent }> = []
  // Opening cash so balances stay positive.
  for (const e of entities) move(accounts.get(`${e}|Checking`) as SourceAccountInfo, 50_000_000)
  const events: NormalizedEvent[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    for (const [i, e] of entities.entries()) events.push(...dayEvents(e, i, d))
    for (let i = pendingPayments.length - 1; i >= 0; i--) {
      const p = pendingPayments[i] as { date: string; ev: () => NormalizedEvent }
      if (p.date === d) {
        events.push(p.ev())
        pendingPayments.splice(i, 1)
      }
    }
  }
  sortAndSnapshot(events, accounts, 50_000_000, entities)

  let next = addDays(end, 1)
  void balances
  return {
    entities,
    personal,
    events,
    accounts,
    nextDay(rows: number) {
      const out: NormalizedEvent[] = []
      while (out.length < rows) {
        for (const [i, e] of entities.entries()) out.push(...dayEvents(e, i, next, 4))
        next = addDays(next, 1)
      }
      return out.slice(0, rows)
    },
  }
}

function dateOf(ev: NormalizedEvent): string {
  if ('date' in ev && typeof ev.date === 'string') return ev.date
  if ('at' in ev && typeof ev.at === 'string') return ev.at.slice(0, 10)
  if (ev.type === 'invoice.upsert') return ev.issueDate
  if (ev.type === 'payroll.run') return ev.payDate
  return '9999-12-31'
}

/** Date order (snapshots last within a day), then set each snapshot to the balance of everything dated up to it. */
function sortAndSnapshot(events: NormalizedEvent[], accounts: Map<string, SourceAccountInfo>, openingChecking: number, entities: string[]): void {
  const rank = (ev: NormalizedEvent) => (ev.type === 'balance.snapshot' ? 1 : 0)
  events.sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : dateOf(a) > dateOf(b) ? 1 : rank(a) - rank(b)))
  const byExt = new Map<string, SourceAccountInfo>()
  for (const a of accounts.values()) byExt.set(`${a.connectionId}|${a.externalId}`, a)
  const bal = new Map<string, number>()
  for (const e of entities) {
    const c = accounts.get(`${e}|Checking`)
    if (c) bal.set(c.id, openingChecking)
  }
  for (const ev of events) {
    if (ev.type === 'txn.upsert' || ev.type === 'processor.balance_txn' || ev.type === 'balance.snapshot') {
      const a = byExt.get(`${ev.connectionId}|${ev.accountExternalId}`)
      if (!a) continue
      if (ev.type === 'txn.upsert') bal.set(a.id, (bal.get(a.id) ?? 0) + ev.amount.minor)
      else if (ev.type === 'processor.balance_txn') bal.set(a.id, (bal.get(a.id) ?? 0) + ev.net.minor)
      else ev.current = { minor: bal.get(a.id) ?? 0, currency: ev.current.currency }
    }
  }
}
