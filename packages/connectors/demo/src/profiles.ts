// The demo world: three fictional companies and a Personal space, with money flows that tie together the way real ones
// do (processor payouts land in the bank, card payments appear on both sides, payroll runs settle as bank
// debits, a founder loan moves from Personal to a company). Every amount is a pure function of (seed, profile, date).
// All names are invented.

import type { AccountType, BalanceSnapshot, LiabilityDetails, Money, NormalizedEvent } from '@agfn/contracts'
import { addDays, dayOfMonth, eachDay, isMonthEnd, lastDayOfMonth, monthKey, weekday } from './dates.ts'
import { dice, seedOf, type Dice } from './rng.ts'
import { glassBills, glassDay } from './glass.ts'
import { HC_CARD_PAY_DAY, beanCharges, beanSubscriptions, hcCardPurchases, hcCardTerms } from './harbor-extras.ts'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** An event before the connector stamps connectionId + rawRef. */
export type Draft = DistributiveOmit<NormalizedEvent, 'connectionId' | 'rawRef'>

export type ProfileKey = 'northwind' | 'bluebird' | 'harbor' | 'personal'
export const PROFILE_KEYS: readonly ProfileKey[] = ['northwind', 'bluebird', 'harbor', 'personal']

export interface DemoAccount {
  id: string
  name: string
  type: AccountType
  institution: string
  mask?: string
  /** Balance (signed, money-in positive) the day before the demo history starts. */
  opening: number
  /** Investment positions behind every balance of this account; their values add up to `opening` (no trades). */
  holdings?: NonNullable<BalanceSnapshot['holdings']>
  /** Card terms as of a day (APR, statement, due date), sent with the account. */
  liability?: (today: string, ctx: DayContext) => LiabilityDetails
}

export interface Profile {
  key: ProfileKey
  /** Entity name in the demo workspace. */
  entityName: string
  kind: 'company' | 'personal'
  /** Whole months of history a new demo gets (default 12). */
  historyMonths?: number
  description: string
  accounts: DemoAccount[]
  /** Everything that happened on `date` (start = first day of history). */
  day(date: string, ctx: DayContext): Draft[]
  /** State-as-of-today objects (invoices, subscriptions), emitted on the last page. */
  final(today: string, ctx: DayContext): Draft[]
}

export interface DayContext {
  seed: string
  start: string
  /** Glass Ledger start (Harbor Coffee only): from the Monday on or after it, a synthetic week every week (glass.ts). */
  glass?: string
  /** Glass Ledger on the public log: the planted rows say so in their bank text (" [planted]"). Off for the benchmark. */
  glassTag?: boolean
}

const USD = (minor: number): Money => ({ minor, currency: 'USD' })
const d = (ctx: DayContext, profile: string, date: string, salt = ''): Dice => dice(seedOf(ctx.seed, profile, date, salt))

function txn(
  id: string,
  account: string,
  date: string,
  minor: number,
  counterparty: string,
  rawText: string,
  categoryHint?: string,
  linkRefs?: Record<string, string>,
): Draft {
  return {
    type: 'txn.upsert',
    externalId: id,
    accountExternalId: account,
    date,
    amount: USD(minor),
    status: 'posted',
    counterparty,
    rawText,
    ...(categoryHint ? { categoryHint } : {}),
    ...(linkRefs ? { linkRefs } : {}),
  }
}

// ---------------------------------------------------------------- shared money flows

/** Pay last calendar month's card purchases in full on `date`; both legs carry the same ref. */
function cardStatementPayment(
  date: string,
  purchases: (date: string) => Draft[],
  ids: { bank: string; card: string; bankAccount: string; cardAccount: string; ref: string; bankText: string; cardText: string; payee: string },
): Draft[] {
  const prevEnd = addDays(date.slice(0, 8) + '01', -1)
  const due = -eachDay(prevEnd.slice(0, 8) + '01', prevEnd).reduce(
    (s, x) => s + purchases(x).reduce((a, e) => a + (e.type === 'txn.upsert' ? e.amount.minor : 0), 0),
    0,
  )
  if (due <= 0) return []
  return [
    txn(ids.bank, ids.bankAccount, date, -due, ids.payee, ids.bankText, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', { card_payment: ids.ref }),
    txn(ids.card, ids.cardAccount, date, due, 'Payment', ids.cardText, 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT', { card_payment: ids.ref }),
  ]
}

/** Founder loan: Personal → Northwind, 40 days into the history. Same transfer ref on both legs. */
const LOAN_DAY = 40
const LOAN_MINOR = 25_000_00
const loanDate = (ctx: DayContext) => addDays(ctx.start, LOAN_DAY)

/** SAFE money from the cap table arrives by wire on these days (offsets from the history start). */
export const SAFE_WIRES: ReadonlyArray<{ offset: number; investor: string; minor: number }> = [
  { offset: 95, investor: 'R. Cohen', minor: 50_000_00 },
  { offset: 170, investor: 'Kite Ventures', minor: 250_000_00 },
]

/** Founder salary (net) paid by Northwind payroll on the 15th and month end; deposited to Personal checking. */
const SALARY_NET = 6_250_00

// ---------------------------------------------------------------- Northwind Labs (SaaS on Stripe)

interface Customer {
  id: string
  name: string
  plan: number
  interval: 'month' | 'year'
  billingDay: number
  startOffset: number
  endOffset?: number
  /** ctx.start plus the offsets, kept with them. */
  startDate: string
  endDate?: string
}

const CUSTOMER_NAMES = [
  'Lumen Health', 'Ferris & Co', 'Oakline Retail', 'Pinecrest Clinic', 'Atlas Freight', 'Cobalt Studio', 'Juniper Legal',
  'Meridian Dental', 'Quarry Labs', 'Redwood Realty', 'Sable Analytics', 'Tidewater Supply', 'Union Bakery',
  'Vantage Fitness', 'Willow Schools', 'Yardline Sports', 'Zephyr Travel', 'Beacon Insurance', 'Cascade Energy',
  'Driftwood Media', 'Elm Street Books', 'Fjord Outdoor', 'Granite Works', 'Harbor Lights', 'Ironwood Tools',
  'Kestrel Air', 'Larkspur Floral', 'Marlin Marine', 'Nimbus Cloud', 'Orchid Spa', 'Paloma Foods', 'Quill Press',
  'Riverbend Hotels', 'Summit Dental', 'Trailhead Gear', 'Upland Farms', 'Verity Audit', 'Wildflower Cafe', 'Xenon Labs',
  'Yellowstone Tours', 'Zinnia Design', 'Alder Capital', 'Birch Logistics', 'Cedar Health',
]

/**
 * Per (seed, start): what a profile derives from those alone, computed once instead of once per generated day. A fill
 * generates every day of a year, and recomputing the customer list and its dates each day held the event loop for
 * seconds on a shared CPU (staging, 2026-10-13). Callers only read the results.
 */
const perStart = new Map<string, unknown>()
function once<T>(ctx: DayContext, what: string, make: () => T): T {
  const key = `${what}|${ctx.seed}|${ctx.start}`
  if (perStart.has(key)) return perStart.get(key) as T
  if (perStart.size > 256) perStart.clear()
  const v = make()
  perStart.set(key, v)
  return v
}

function customers(ctx: DayContext): Customer[] {
  return once(ctx, 'customers', () => makeCustomers(ctx))
}

function makeCustomers(ctx: DayContext): Customer[] {
  const r = dice(seedOf(ctx.seed, 'northwind', 'customers'))
  return CUSTOMER_NAMES.map((name, i) => {
    const plan = r.pick([499_00, 999_00, 999_00, 1_499_00, 1_999_00, 2_999_00])
    const yearly = r.chance(0.2)
    const startOffset = i < 30 ? 0 : r.int(20, 340)
    const churn = r.chance(0.18) ? startOffset + r.int(60, 300) : undefined
    const endOffset = churn !== undefined && churn < 365 ? churn : undefined
    return {
      id: `cus_nw_${String(i + 1).padStart(3, '0')}`,
      name,
      plan: yearly ? plan * 10 : plan,
      interval: yearly ? 'year' : 'month',
      billingDay: r.int(1, 28),
      startOffset,
      startDate: addDays(ctx.start, startOffset),
      ...(endOffset !== undefined ? { endOffset, endDate: addDays(ctx.start, endOffset) } : {}),
    }
  })
}

const stripeFee = (gross: number) => Math.round((gross * 29) / 1000) + 30

function isActive(c: Customer, date: string): boolean {
  return date >= c.startDate && (c.endDate === undefined || date < c.endDate)
}

/** Charges (and the occasional refund) on one day, with their net. Pure, so payouts can be recomputed for any day. */
function stripeDay(ctx: DayContext, date: string): { rows: Draft[]; net: number } {
  if (date < ctx.start) return { rows: [], net: 0 }
  const rows: Draft[] = []
  let net = 0
  const startDay = (c: Customer) => c.startDate
  for (const c of customers(ctx)) {
    if (!isActive(c, date)) continue
    const due =
      c.interval === 'month'
        ? dayOfMonth(date) === c.billingDay || (date === startDay(c) && c.startOffset > 0)
        : date.slice(5) === startDay(c).slice(5) || (date === startDay(c) && c.startOffset > 0)
    if (!due) continue
    const fee = stripeFee(c.plan)
    const id = `txn_nw_${c.id.slice(-3)}_${date}`
    rows.push({
      type: 'processor.balance_txn',
      externalId: id,
      accountExternalId: 'nw-stripe:USD',
      at: `${date}T14:00:00.000Z`,
      kind: 'charge',
      gross: USD(c.plan),
      fee: USD(fee),
      net: USD(c.plan - fee),
      sourceExternalId: `ch_${id.slice(4)}`,
      customer: c.name,
      payoutExternalId: `po_nw_${addDays(date, 1)}`,
    })
    net += c.plan - fee
  }
  // A refund on the 17th of odd months: Stripe keeps its fee.
  const month = Number(date.slice(5, 7))
  if (dayOfMonth(date) === 17 && month % 2 === 1) {
    const amount = 99_00
    rows.push({
      type: 'processor.balance_txn',
      externalId: `txn_nw_refund_${date}`,
      accountExternalId: 'nw-stripe:USD',
      at: `${date}T16:00:00.000Z`,
      kind: 'refund',
      gross: USD(-amount),
      fee: USD(0),
      net: USD(-amount),
      customer: 'Cobalt Studio',
      payoutExternalId: `po_nw_${addDays(date, 1)}`,
    })
    net -= amount
  }
  return { rows, net }
}

const NW_VENDORS: Array<{ day: number; name: string; raw: string; min: number; max: number; cat: string }> = [
  { day: 3, name: 'Amazon Web Services', raw: 'AWS EMEA aws.amazon.co', min: 2_800_00, max: 3_900_00, cat: 'GENERAL_SERVICES_OTHER' },
  { day: 5, name: 'Figma', raw: 'FIGMA MONTHLY', min: 75_00, max: 75_00, cat: 'GENERAL_SERVICES_OTHER' },
  { day: 6, name: 'Google Workspace', raw: 'GOOGLE *GSUITE_northwind', min: 216_00, max: 216_00, cat: 'GENERAL_SERVICES_OTHER' },
  { day: 9, name: 'Slack', raw: 'SLACK T0123ABC', min: 160_00, max: 160_00, cat: 'GENERAL_SERVICES_OTHER' },
  { day: 12, name: 'GitHub', raw: 'GITHUB INC', min: 84_00, max: 84_00, cat: 'GENERAL_SERVICES_OTHER' },
  { day: 20, name: 'Datadog', raw: 'DATADOG INC NEW YORK', min: 410_00, max: 690_00, cat: 'GENERAL_SERVICES_OTHER' },
]
const NW_PAYROLL_GROSS = 28_000_00

function nwCardPurchases(ctx: DayContext, date: string): Draft[] {
  if (date < ctx.start) return []
  const out: Draft[] = []
  const r = d(ctx, 'northwind', date, 'card')
  const months = Math.floor((Date.parse(date) - Date.parse(ctx.start)) / (30.44 * 86_400_000))
  for (const v of NW_VENDORS) {
    if (dayOfMonth(date) !== v.day) continue
    const key = v.name.replace(/\W+/g, '').toLowerCase()
    // Anomalies for the "anything odd" section: Slack raises its price half a year in; Figma bills twice once.
    const amount = v.name === 'Slack' && months >= 6 ? 200_00 : r.int(v.min, v.max)
    out.push(txn(`nw-card-${date}-${key}`, 'nw-card', date, -amount, v.name, v.raw, v.cat))
    if (v.name === 'Figma' && months === 8) out.push(txn(`nw-card-${date}-${key}-2`, 'nw-card', date, -amount, v.name, v.raw, v.cat))
  }
  if (weekday(date) >= 1 && weekday(date) <= 5 && r.chance(0.25)) {
    const m = r.pick([['Blue Bottle Coffee', 'BLUE BOTTLE COFFEE SF'], ['Uber', 'UBER *TRIP'], ['Delta Air Lines', 'DELTA AIR 0062312'], ['Sweetgreen', 'SWEETGREEN MISSION']] as const)
    out.push(txn(`nw-card-${date}-misc`, 'nw-card', date, -r.int(12_00, m[0] === 'Delta Air Lines' ? 640_00 : 85_00), m[0], m[1], 'TRAVEL_OR_FOOD'))
  }
  return out
}

const northwind: Profile = {
  key: 'northwind',
  entityName: 'Northwind Labs',
  kind: 'company',
  description: 'B2B software on Stripe subscriptions, a team of 9, card spend on cloud tools',
  accounts: [
    { id: 'nw-checking', name: 'Business Checking', type: 'depository', institution: 'Demo Bank', mask: '4021', opening: 182_450_00 },
    { id: 'nw-savings', name: 'Business Savings', type: 'depository', institution: 'Demo Bank', mask: '4022', opening: 400_000_00 },
    { id: 'nw-card', name: 'Business Card', type: 'credit_card', institution: 'Demo Bank', mask: '9910', opening: -6_120_00 },
    { id: 'nw-stripe:USD', name: 'Stripe balance (USD)', type: 'processor_balance', institution: 'Stripe', opening: 0 },
  ],
  day(date, ctx) {
    const out: Draft[] = []
    out.push(...stripeDay(ctx, date).rows)
    // Daily payout of yesterday's net, landing in checking the same day: a finished demo has nothing left in transit
    // (and Stripe's balance reconciles with its payouts on every day).
    const paid = stripeDay(ctx, addDays(date, -1)).net
    if (paid > 0) {
      const po = `po_nw_${date}`
      const arrival = date
      out.push({
        type: 'processor.balance_txn',
        externalId: po,
        accountExternalId: 'nw-stripe:USD',
        at: `${date}T13:00:00.000Z`,
        kind: 'payout',
        gross: USD(-paid),
        fee: USD(0),
        net: USD(-paid),
        payoutExternalId: po,
        arrivalDate: arrival,
      })
      out.push(txn(`nw-chk-${date}-stripe`, 'nw-checking', date, paid, 'Stripe', `STRIPE TRANSFER ST-${po.slice(-10).replace(/-/g, '')}`, 'TRANSFER_IN', { payout_id: po }))
    }
    out.push(...nwCardPurchases(ctx, date))
    // Card statement paid on the 25th: last month's purchases, both legs carry the same ref.
    if (dayOfMonth(date) === 25) {
      out.push(...cardStatementPayment(date, (x) => nwCardPurchases(ctx, x), {
        bank: `nw-chk-${date}-cardpay`, card: `nw-card-${date}-payment`, bankAccount: 'nw-checking', cardAccount: 'nw-card',
        ref: `cardpay-nw-${monthKey(date)}`, bankText: 'DEMO BANK CARD AUTOPAY', cardText: 'PAYMENT THANK YOU', payee: 'Demo Bank Card',
      }))
    }
    if (dayOfMonth(date) === 1) out.push(txn(`nw-chk-${date}-rent`, 'nw-checking', date, -8_500_00, 'Commonspace', 'COMMONSPACE MEMBERSHIP ACH', 'RENT_AND_UTILITIES_RENT'))
    // Payroll on the 15th and at month end: one run, settled by a net debit and a tax debit.
    if (dayOfMonth(date) === 15 || isMonthEnd(date)) {
      const r = d(ctx, 'northwind', date, 'payroll')
      const gross = NW_PAYROLL_GROSS + r.int(-1_500_00, 1_500_00)
      const employerTaxes = Math.round(gross * 0.0765)
      const employeeTaxes = Math.round(gross * 0.22)
      const net = gross - employeeTaxes
      const netId = `nw-chk-${date}-payroll-net`
      const taxId = `nw-chk-${date}-payroll-tax`
      out.push(txn(netId, 'nw-checking', date, -net, 'Gusto', 'GUSTO NET 7821 NORTHWIND LABS', 'PAYROLL'))
      out.push(txn(taxId, 'nw-checking', date, -(employerTaxes + employeeTaxes), 'Gusto', 'GUSTO TAX 7821 NORTHWIND LABS', 'PAYROLL_TAX'))
      out.push({
        type: 'payroll.run',
        externalId: `nw-payroll-${date}`,
        payDate: date,
        gross: USD(gross),
        employerTaxes: USD(employerTaxes),
        employeeTaxes: USD(employeeTaxes),
        net: USD(net),
        employeeCount: 9,
        source: 'provider',
        provider: 'Gusto',
        status: 'paid',
        companyDebit: USD(net + employerTaxes + employeeTaxes),
        settlementTxnExternalIds: [netId, taxId],
      })
    }
    // The company burns a little each month: top up checking from savings every quarter. Plus monthly interest.
    if (dayOfMonth(date) === 2 && ['01', '04', '07', '10'].includes(date.slice(5, 7))) {
      const ref = `topup-nw-${monthKey(date)}`
      out.push(txn(`nw-sav-${date}-topup`, 'nw-savings', date, -45_000_00, 'Business Checking', 'ONLINE TRANSFER TO CHK ...4021', 'TRANSFER_OUT', { transfer: ref }))
      out.push(txn(`nw-chk-${date}-topup`, 'nw-checking', date, 45_000_00, 'Business Savings', 'ONLINE TRANSFER FROM SAV ...4022', 'TRANSFER_IN', { transfer: ref }))
    }
    if (isMonthEnd(date)) out.push(txn(`nw-sav-${date}-interest`, 'nw-savings', date, d(ctx, 'northwind', date, 'int').int(1_150_00, 1_420_00), 'Demo Bank', 'INTEREST PAYMENT', 'INCOME_INTEREST_EARNED'))
    for (const w of SAFE_WIRES) {
      if (date === addDays(ctx.start, w.offset)) {
        out.push(txn(`nw-chk-${date}-safe-${w.investor.replace(/\W+/g, '').toLowerCase()}`, 'nw-checking', date, w.minor, w.investor, `INCOMING WIRE ${w.investor.toUpperCase()} SAFE`, 'TRANSFER_IN'))
      }
    }
    if (date === loanDate(ctx)) out.push(txn(`nw-chk-${date}-ownerloan`, 'nw-checking', date, LOAN_MINOR, 'Alex Morgan', 'ONLINE TRANSFER FROM A MORGAN', 'TRANSFER_IN', { transfer: 'owner-loan-1' }))
    return out
  },
  final(today, ctx) {
    return customers(ctx)
      .filter((c) => c.startDate <= today)
      .map((c): Draft => {
        const active = isActive(c, today)
        const mrr = c.interval === 'year' ? Math.round(c.plan / 12) : c.plan
        return {
          type: 'subscription.upsert',
          externalId: `sub_${c.id.slice(4)}`,
          customer: c.name,
          status: active ? 'active' : 'canceled',
          mrr: USD(active ? mrr : 0),
          interval: c.interval,
          intervalCount: 1,
          startedAt: `${addDays(ctx.start, c.startOffset)}T12:00:00.000Z`,
          ...(c.endOffset !== undefined && !active ? { canceledAt: `${addDays(ctx.start, c.endOffset)}T12:00:00.000Z`, endedAt: `${addDays(ctx.start, c.endOffset)}T12:00:00.000Z` } : {}),
          items: [{ priceExternalId: `price_${c.plan}_${c.interval}`, quantity: 1, amount: USD(c.plan) }],
        }
      })
  },
}

// ---------------------------------------------------------------- Bluebird Studio (agency, invoices)

interface Invoice {
  id: string
  number: string
  client: string
  issue: string
  due: string
  total: number
  /** Payments: [date, amount]. */
  payments: Array<[string, number]>
}

const CLIENTS = ['Lumen Health', 'Ferris & Co', 'Oakline Retail', 'Pinecrest Clinic', 'Atlas Freight']

function invoices(ctx: DayContext): Invoice[] {
  return once(ctx, 'invoices', () => makeInvoices(ctx))
}

function makeInvoices(ctx: DayContext): Invoice[] {
  const out: Invoice[] = []
  let n = 1041
  for (let m = 0; m < 13; m++) {
    const r = dice(seedOf(ctx.seed, 'bluebird', 'inv', String(m)))
    const count = r.int(2, 3)
    for (let k = 0; k < count; k++) {
      const issue = addDays(ctx.start, m * 30 + r.int(0, 25))
      const due = addDays(issue, 30)
      const total = r.int(80, 250) * 100_00
      // Only the last few months stay short-paid: a healthy agency with a year of unpaid invoices reads as a broken demo.
      const style = m < 10 ? r.next() * 0.75 : r.next()
      const payments: Array<[string, number]> =
        style < 0.55 ? [[addDays(due, r.int(-5, 6)), total]] : style < 0.75 ? [[addDays(due, r.int(10, 40)), total]] : style < 0.9 ? [[addDays(due, r.int(0, 10)), Math.round(total / 2)]] : []
      out.push({ id: `bb-inv-${n}`, number: `INV-${n}`, client: r.pick(CLIENTS), issue, due, total, payments })
      n++
    }
  }
  return out
}

function bbCardPurchases(ctx: DayContext, date: string): Draft[] {
  if (date < ctx.start || weekday(date) < 1 || weekday(date) > 5) return []
  const r = d(ctx, 'bluebird', date, 'card')
  if (!r.chance(0.2)) return []
  const v = r.pick([['Adobe', 'ADOBE *CREATIVE CLD'], ['Shutterstock', 'SHUTTERSTOCK'], ['FedEx', 'FEDEX 77123'], ['Staples', 'STAPLES 0042']] as const)
  return [txn(`bb-card-${date}`, 'bb-card', date, -r.int(20_00, 420_00), v[0], v[1], 'GENERAL_MERCHANDISE')]
}

const bluebird: Profile = {
  key: 'bluebird',
  entityName: 'Bluebird Studio',
  kind: 'company',
  description: 'Design agency billing clients by invoice (net 30), paying contractors',
  accounts: [
    { id: 'bb-checking', name: 'Operating Account', type: 'depository', institution: 'Demo Credit Union', mask: '7730', opening: 64_200_00 },
    { id: 'bb-card', name: 'Visa Business', type: 'credit_card', institution: 'Demo Credit Union', mask: '1188', opening: -1_940_00 },
  ],
  day(date, ctx) {
    const out: Draft[] = []
    for (const inv of invoices(ctx)) {
      inv.payments.forEach(([when, amount], i) => {
        if (when !== date) return
        const bankId = `bb-chk-${date}-${inv.number}-${i}`
        out.push(txn(bankId, 'bb-checking', date, amount, inv.client, `ACH CREDIT ${inv.client.toUpperCase()} ${inv.number}`, 'INCOME_OTHER'))
        out.push({
          type: 'payment.applied',
          externalId: `bb-pay-${inv.number}-${i}`,
          direction: 'receivable',
          date,
          amount: USD(amount),
          method: 'ach',
          counterparty: inv.client,
          applications: [{ invoiceExternalId: inv.id, amount: USD(amount) }],
          bankTxnRef: bankId,
        })
      })
    }
    const r = d(ctx, 'bluebird', date)
    if (dayOfMonth(date) === 5) {
      for (const [name, min, max] of [['Rosa Kim (contract design)', 4_000_00, 6_500_00], ['Dev Patel (contract dev)', 3_500_00, 6_000_00]] as const) {
        out.push(txn(`bb-chk-${date}-${name.split(' ')[0]?.toLowerCase()}`, 'bb-checking', date, -r.int(min, max), name, `ZELLE TO ${name.split(' (')[0]?.toUpperCase()}`, 'GENERAL_SERVICES_CONTRACTORS'))
      }
    }
    if (dayOfMonth(date) === 1) out.push(txn(`bb-chk-${date}-rent`, 'bb-checking', date, -3_600_00, 'Foundry Lofts', 'FOUNDRY LOFTS LLC RENT', 'RENT_AND_UTILITIES_RENT'))
    if (isMonthEnd(date)) {
      const gross = 14_000_00
      const taxes = Math.round(gross * 0.0765)
      const net = gross - Math.round(gross * 0.21)
      const id = `bb-chk-${date}-payroll`
      out.push(txn(id, 'bb-checking', date, -(net + taxes + Math.round(gross * 0.21)), 'Gusto', 'GUSTO PAYROLL BLUEBIRD', 'PAYROLL'))
      out.push({ type: 'payroll.run', externalId: `bb-payroll-${date}`, payDate: date, gross: USD(gross), employerTaxes: USD(taxes), employeeTaxes: USD(Math.round(gross * 0.21)), net: USD(net), employeeCount: 2, source: 'provider', provider: 'Gusto', status: 'paid', settlementTxnExternalIds: [id] })
    }
    out.push(...bbCardPurchases(ctx, date))
    if (dayOfMonth(date) === 28) {
      out.push(...cardStatementPayment(date, (x) => bbCardPurchases(ctx, x), {
        bank: `bb-chk-${date}-cardpay`, card: `bb-card-${date}-payment`, bankAccount: 'bb-checking', cardAccount: 'bb-card',
        ref: `cardpay-bb-${monthKey(date)}`, bankText: 'VISA BUSINESS PAYMENT', cardText: 'PAYMENT RECEIVED', payee: 'Visa Business',
      }))
    }
    return out
  },
  final(today, ctx) {
    return invoices(ctx)
      .filter((inv) => inv.issue <= today)
      .map((inv): Draft => {
        const paid = inv.payments.filter(([w]) => w <= today).reduce((s, [, a]) => s + a, 0)
        const status = paid >= inv.total ? 'paid' : paid > 0 ? 'partially_paid' : 'open'
        return {
          type: 'invoice.upsert',
          externalId: inv.id,
          direction: 'receivable',
          number: inv.number,
          counterparty: inv.client,
          issueDate: inv.issue,
          dueDate: inv.due,
          total: USD(inv.total),
          amountPaid: USD(paid),
          status,
          lines: [{ description: 'Design services', amount: USD(inv.total), quantity: 1 }],
        }
      })
  },
}

// ---------------------------------------------------------------- Harbor Coffee (café: Stripe in store, Shopify online, cash)

function cafeSales(ctx: DayContext, date: string): { gross: number; fee: number; cash: number } {
  if (date < ctx.start) return { gross: 0, fee: 0, cash: 0 }
  const r = d(ctx, 'harbor', date, 'sales')
  const weekend = weekday(date) === 0 || weekday(date) === 6
  const gross = r.int(weekend ? 2_100_00 : 1_250_00, weekend ? 3_400_00 : 2_200_00)
  const tickets = Math.round(gross / 9_50)
  return { gross, fee: Math.round(gross * 0.026) + tickets * 10, cash: r.int(90_00, 260_00) }
}

/** Online bean orders through Shopify (a few a day, more on weekends), with Shopify Payments' fee. */
function shopSales(ctx: DayContext, date: string): { gross: number; fee: number } {
  if (date < ctx.start) return { gross: 0, fee: 0 }
  const r = d(ctx, 'harbor', date, 'shop')
  const orders = r.int(weekday(date) === 0 || weekday(date) === 6 ? 4 : 2, weekday(date) === 0 || weekday(date) === 6 ? 9 : 6)
  let gross = 0
  // Bag prices plus shipping by weight, so no two days come to the same total by chance.
  for (let i = 0; i < orders; i++) gross += r.pick([18_00, 22_00, 24_00, 36_00, 44_00, 64_00]) + r.int(5_49, 12_99)
  return { gross, fee: Math.round(gross * 0.029) + orders * 30 }
}

const nextMonday = (date: string) => addDays(date, ((8 - weekday(date)) % 7) || 7)

/** The owner moves savings into checking once, with nothing on either side tying the two rows together. */
const HC_TOPUP_DAY = 150
const HC_TOPUP_MINOR = 15_000_00

const harbor: Profile = {
  key: 'harbor',
  entityName: 'Harbor Coffee',
  kind: 'company',
  description: 'Neighborhood café: card sales in store and the Bean Club on Stripe, beans online on Shopify, some cash, weekly suppliers, software on a card',
  // Two years, so this year can be compared with last.
  historyMonths: 24,
  accounts: [
    { id: 'hc-checking', name: 'Checking', type: 'depository', institution: 'Demo Community Bank', mask: '5512', opening: 28_300_00 },
    { id: 'hc-savings', name: 'Savings', type: 'depository', institution: 'Demo Community Bank', mask: '5519', opening: 60_000_00 },
    // The id is older than the name (existing demo connections keep their running balances under it).
    { id: 'hc-processor:USD', name: 'Stripe balance (USD)', type: 'processor_balance', institution: 'Stripe', opening: 0 },
    { id: 'hc-shopify:USD', name: 'Shopify balance (USD)', type: 'processor_balance', institution: 'Shopify', opening: 0 },
    { id: 'hc-cash', name: 'Cash drawer', type: 'cash_on_hand', institution: 'Harbor Coffee', opening: 400_00 },
    { id: 'hc-card', name: 'Business Card', type: 'credit_card', institution: 'Demo Community Bank', mask: '7741', opening: 0, liability: (today, ctx) => hcCardTerms(ctx, today) },
  ],
  day(date, ctx) {
    const out: Draft[] = []
    const s = cafeSales(ctx, date)
    const po = `hc-po-${addDays(date, 1)}`
    out.push({ type: 'processor.balance_txn', externalId: `hc-sales-${date}`, accountExternalId: 'hc-processor:USD', at: `${date}T19:00:00.000Z`, kind: 'charge', gross: USD(s.gross), fee: USD(s.fee), net: USD(s.gross - s.fee), description: 'In-store card sales (Stripe Terminal, day total)', payoutExternalId: po })
    const beans = beanCharges(ctx, date)
    out.push(...beans)
    // Yesterday's in-store sales and Bean Club charges, paid out together.
    const prevCafe = cafeSales(ctx, addDays(date, -1))
    const prevBeans = beanCharges(ctx, addDays(date, -1)).reduce((sum, e) => sum + (e.type === 'processor.balance_txn' ? e.net.minor : 0), 0)
    const prev = { gross: prevCafe.gross + prevBeans, fee: prevCafe.fee }
    if (prev.gross > 0) {
      const id = `hc-po-${date}`
      // Lands in the bank the same day, so nothing is in transit when the demo finishes. The bank row carries no payout
      // id (as at most banks): the matcher pairs it with the payout by amount and the name.
      out.push({ type: 'processor.balance_txn', externalId: id, accountExternalId: 'hc-processor:USD', at: `${date}T13:00:00.000Z`, kind: 'payout', gross: USD(-(prev.gross - prev.fee)), fee: USD(0), net: USD(-(prev.gross - prev.fee)), payoutExternalId: id, arrivalDate: date })
      out.push(txn(`hc-chk-${date}-deposit`, 'hc-checking', date, prev.gross - prev.fee, 'Stripe', `STRIPE TRANSFER ST-${id.slice(-10).replace(/-/g, '')}`, 'TRANSFER_IN'))
    }
    const shop = shopSales(ctx, date)
    if (shop.gross > 0) out.push({ type: 'processor.balance_txn', externalId: `hc-shop-${date}`, accountExternalId: 'hc-shopify:USD', at: `${date}T17:00:00.000Z`, kind: 'charge', gross: USD(shop.gross), fee: USD(shop.fee), net: USD(shop.gross - shop.fee), payoutExternalId: `hc-shpo-${nextMonday(date)}` })
    // Shopify pays out weekly, on Mondays, for the seven days before.
    const net = weekday(date) === 1 ? eachDay(addDays(date, -7), addDays(date, -1)).reduce((sum, x) => sum + shopSales(ctx, x).gross - shopSales(ctx, x).fee, 0) : 0
    if (net > 0) {
      const id = `hc-shpo-${date}`
      out.push({ type: 'processor.balance_txn', externalId: id, accountExternalId: 'hc-shopify:USD', at: `${date}T13:00:00.000Z`, kind: 'payout', gross: USD(-net), fee: USD(0), net: USD(-net), payoutExternalId: id, arrivalDate: date })
      out.push(txn(`hc-chk-${date}-shopify`, 'hc-checking', date, net, 'Shopify', 'SHOPIFY PAYMENTS PAYOUT', 'TRANSFER_IN'))
    }
    // Savings into checking: no shared reference, so without the matcher it would read as $15,000 of income.
    if (date === addDays(ctx.start, HC_TOPUP_DAY)) {
      out.push(txn(`hc-sav-${date}-topup`, 'hc-savings', date, -HC_TOPUP_MINOR, 'Transfer to checking', 'ONLINE TRANSFER TO CHK XXXX5512', 'TRANSFER_OUT'))
      out.push(txn(`hc-chk-${date}-topup`, 'hc-checking', date, HC_TOPUP_MINOR, 'Transfer from savings', 'ONLINE TRANSFER FROM SAV XXXX5519', 'TRANSFER_IN'))
    }
    out.push(txn(`hc-cash-${date}-sales`, 'hc-cash', date, s.cash, 'Cash sales', 'Cash sales (counted at close)', 'INCOME_SALES'))
    // Cash goes to the bank every Monday: a transfer, not new income.
    if (weekday(date) === 1) {
      const week = eachDay(addDays(date, -7), addDays(date, -1)).reduce((sum, x) => sum + cafeSales(ctx, x).cash, 0)
      if (week > 0) {
        const ref = `cashdep-hc-${date}`
        out.push(txn(`hc-cash-${date}-deposit`, 'hc-cash', date, -week, 'Bank deposit', 'Cash taken to bank', 'TRANSFER_OUT', { transfer: ref }))
        out.push(txn(`hc-chk-${date}-cashdep`, 'hc-checking', date, week, 'Cash deposit', 'BRANCH DEPOSIT CASH', 'TRANSFER_IN', { transfer: ref }))
      }
    }
    const r = d(ctx, 'harbor', date, 'ap')
    if (weekday(date) === 2) out.push(txn(`hc-chk-${date}-roast`, 'hc-checking', date, -r.int(1_100_00, 1_600_00), 'Roastworks Coffee', 'ROASTWORKS COFFEE ACH', 'FOOD_AND_DRINK_SUPPLIES'))
    if (weekday(date) === 1 || weekday(date) === 4) out.push(txn(`hc-chk-${date}-dairy`, 'hc-checking', date, -r.int(280_00, 460_00), 'Valley Dairy', 'VALLEY DAIRY CO', 'FOOD_AND_DRINK_SUPPLIES'))
    if (dayOfMonth(date) === 1) out.push(txn(`hc-chk-${date}-rent`, 'hc-checking', date, -6_800_00, 'Pier 9 Properties', 'PIER 9 PROPERTIES RENT', 'RENT_AND_UTILITIES_RENT'))
    if (dayOfMonth(date) === 18) out.push(txn(`hc-chk-${date}-power`, 'hc-checking', date, -r.int(520_00, 840_00), 'City Power & Water', 'CITY UTILITIES AUTOPAY', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'))
    if (weekday(date) === 5 && Math.floor((Date.parse(date) - Date.parse(ctx.start)) / 86_400_000 / 7) % 2 === 0) {
      const gross = r.int(13_000_00, 15_500_00)
      const net = gross - Math.round(gross * 0.18)
      const taxes = Math.round(gross * 0.0765)
      const id = `hc-chk-${date}-payroll`
      out.push(txn(id, 'hc-checking', date, -(gross + taxes), 'ADP', 'ADP WAGE PAY HARBOR COFFEE', 'PAYROLL'))
      out.push({ type: 'payroll.run', externalId: `hc-payroll-${date}`, payDate: date, gross: USD(gross), employerTaxes: USD(taxes), employeeTaxes: USD(gross - net), net: USD(net), employeeCount: 11, source: 'provider', provider: 'ADP', status: 'paid', settlementTxnExternalIds: [id] })
    }
    out.push(...hcCardPurchases(ctx, date))
    if (dayOfMonth(date) === HC_CARD_PAY_DAY) {
      out.push(...cardStatementPayment(date, (x) => hcCardPurchases(ctx, x), {
        bank: `hc-chk-${date}-cardpay`, card: `hc-card-${date}-payment`, bankAccount: 'hc-checking', cardAccount: 'hc-card',
        ref: `cardpay-hc-${monthKey(date)}`, bankText: 'DEMO COMMUNITY BANK CARD PAYMENT', cardText: 'PAYMENT RECEIVED THANK YOU', payee: 'Business Card',
      }))
    }
    if (ctx.glass) out.push(...glassDay({ ...ctx, glass: ctx.glass }, date))
    return out
  },
  final: (today, ctx) => [...beanSubscriptions(ctx, today), ...(ctx.glass ? glassBills({ ...ctx, glass: ctx.glass }, today) : [])],
}

// ---------------------------------------------------------------- Personal

/** The founder's brokerage: a few index funds, a bond fund, one stock and cash. Values add up to the account's balance. */
const BROKERAGE: NonNullable<BalanceSnapshot['holdings']> = [
  { securityExternalId: 'sec-vti', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', quantity: '210', value: USD(61_005_00), costBasis: USD(48_300_00) },
  { securityExternalId: 'sec-vxus', ticker: 'VXUS', name: 'Vanguard Total International Stock ETF', quantity: '380', value: USD(24_415_00), costBasis: USD(22_800_00) },
  { securityExternalId: 'sec-bnd', ticker: 'BND', name: 'Vanguard Total Bond Market ETF', quantity: '300', value: USD(21_720_00), costBasis: USD(22_500_00) },
  { securityExternalId: 'sec-aapl', ticker: 'AAPL', name: 'Apple Inc.', quantity: '85', value: USD(19_210_00), costBasis: USD(12_750_00) },
  { securityExternalId: 'sec-cash', name: 'Cash', quantity: '3150', value: USD(3_150_00) },
]

function pCardPurchases(ctx: DayContext, date: string): Draft[] {
  if (date < ctx.start) return []
  const out: Draft[] = []
  const r = d(ctx, 'personal', date)
  if (r.chance(0.5)) {
    const m = r.pick([['Whole Foods', 'WHOLEFDS 10233', 'FOOD_AND_DRINK_GROCERIES'], ['Trader Joe’s', 'TRADER JOE S #120', 'FOOD_AND_DRINK_GROCERIES'], ['Shell', 'SHELL OIL 5741', 'TRANSPORTATION_GAS'], ['Target', 'TARGET 00028', 'GENERAL_MERCHANDISE']] as const)
    out.push(txn(`p-card-${date}`, 'p-card', date, -r.int(18_00, 160_00), m[0], m[1], m[2]))
  }
  if (dayOfMonth(date) === 8) out.push(txn(`p-card-${date}-netflix`, 'p-card', date, -22_99, 'Netflix', 'NETFLIX.COM', 'ENTERTAINMENT_TV_AND_MOVIES'))
  return out
}

const personal: Profile = {
  key: 'personal',
  entityName: 'Personal',
  kind: 'personal',
  description: "The founder's own accounts: salary from Northwind, everyday spending, a loan to the company",
  accounts: [
    { id: 'p-checking', name: 'Everyday Checking', type: 'depository', institution: 'Demo Bank', mask: '0815', opening: 41_300_00 },
    { id: 'p-brokerage', name: 'Brokerage', type: 'investment', institution: 'Demo Brokerage', mask: '7714', opening: 129_500_00, holdings: BROKERAGE },
    { id: 'p-card', name: 'Rewards Card', type: 'credit_card', institution: 'Demo Bank', mask: '3007', opening: -2_210_00 },
  ],
  day(date, ctx) {
    const out: Draft[] = []
    if (dayOfMonth(date) === 15 || isMonthEnd(date)) out.push(txn(`p-chk-${date}-salary`, 'p-checking', date, SALARY_NET, 'Northwind Labs', 'NORTHWIND LABS PAYROLL', 'INCOME_WAGES'))
    if (date === loanDate(ctx)) out.push(txn(`p-chk-${date}-ownerloan`, 'p-checking', date, -LOAN_MINOR, 'Northwind Labs', 'ONLINE TRANSFER TO NORTHWIND LABS', 'TRANSFER_OUT', { transfer: 'owner-loan-1' }))
    // Venmo cash-outs: friends paying back, or a catering order for Harbor Coffee paid to the founder? The demo's one
    // honest "what is this money?" question (packages/demo tidyDemoReview keeps the newest).
    if (dayOfMonth(date) === 3) out.push(txn(`p-chk-${date}-venmo`, 'p-checking', date, d(ctx, 'personal', date, 'venmo').int(18, 52) * 10_00, 'Venmo', 'VENMO CASHOUT'))
    if (dayOfMonth(date) === 1) out.push(txn(`p-chk-${date}-mortgage`, 'p-checking', date, -3_420_00, 'Demo Home Loans', 'DEMO HOME LOANS PMT', 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'))
    out.push(...pCardPurchases(ctx, date))
    if (dayOfMonth(date) === 22) {
      out.push(...cardStatementPayment(date, (x) => pCardPurchases(ctx, x), {
        bank: `p-chk-${date}-cardpay`, card: `p-card-${date}-payment`, bankAccount: 'p-checking', cardAccount: 'p-card',
        ref: `cardpay-p-${monthKey(date)}`, bankText: 'REWARDS CARD AUTOPAY', cardText: 'AUTOPAY PAYMENT', payee: 'Rewards Card',
      }))
    }
    return out
  },
  final: () => [],
}

export const PROFILES: Record<ProfileKey, Profile> = { northwind, bluebird, harbor, personal }

export { lastDayOfMonth }
