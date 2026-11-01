// Harbor Coffee's subscription line and business card (for "Ask your books"): the Bean Club, monthly coffee
// subscriptions billed through Stripe, with members joining, upgrading and leaving every month; and a business card
// that carries the café's software, paid in full each month, with an APR and a due date.

import type { LiabilityDetails, Money } from '@agfn/contracts'
import { addDays, dayOfMonth, eachDay, lastDayOfMonth } from './dates.ts'
import { dice, seedOf } from './rng.ts'
import type { DayContext, Draft } from './profiles.ts'

const USD = (minor: number): Money => ({ minor, currency: 'USD' })
const stripeFee = (gross: number) => Math.round((gross * 29) / 1000) + 30

// ---------------------------------------------------------------- Bean Club

/** Monthly plans: one bag, two bags, the roaster's pick. An upgrade moves to the next one. */
export const BEAN_PLANS = [18_00, 32_00, 54_00] as const

export interface BeanMember {
  id: string
  name: string
  joined: string
  billingDay: number
  /** Plan from `from` on (the first entry is the plan at joining). */
  plans: Array<{ from: string; minor: number }>
  ended?: string
}

const FIRST = ['Ava', 'Ben', 'Cleo', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Lena', 'Milo', 'Nia', 'Omar', 'Pia', 'Quin', 'Rosa', 'Sam', 'Tess', 'Uma', 'Vic', 'Wren', 'Xan', 'Yara', 'Zed']
const LAST = 'ABCDEFGHJKLMNPRSTVW'

const firstOfMonth = (date: string) => date.slice(0, 8) + '01'
const nextMonth = (date: string) => addDays(lastDayOfMonth(date), 1)
const memo = new Map<string, BeanMember[]>()

/**
 * The Bean Club's members, simulated month by month from the history start: 14 founding members, then every month
 * 2–3 join, one upgrades (from the second month) and one leaves (from the third). Pure in (seed, start).
 */
export function beanMembers(ctx: DayContext): BeanMember[] {
  const key = `${ctx.seed}|${ctx.start}`
  const hit = memo.get(key)
  if (hit) return hit
  const members: BeanMember[] = []
  const planAt = (m: BeanMember, date: string) => [...m.plans].reverse().find((p) => p.from <= date)?.minor ?? 0
  const activeAt = (m: BeanMember, date: string) => m.joined <= date && (!m.ended || m.ended > date)
  let month = firstOfMonth(ctx.start)
  for (let n = 0; n < 48; n++, month = nextMonth(month)) {
    const r = dice(seedOf(ctx.seed, 'harbor-beans', month))
    const day = (min = 0) => addDays(month, r.int(min, 27))
    const joins = n === 0 ? 14 : r.int(2, 3)
    for (let i = 0; i < joins; i++) {
      const joined = n === 0 ? ctx.start : day()
      const k = members.length
      members.push({ id: `bc-${String(k + 1).padStart(3, '0')}`, name: `${FIRST[k % FIRST.length]} ${LAST[(k * 7) % LAST.length]}.`, joined, billingDay: Math.min(28, dayOfMonth(joined)), plans: [{ from: joined, minor: r.pick(BEAN_PLANS) }] })
    }
    const settled = members.filter((m) => m.joined < month && activeAt(m, month))
    if (n >= 1) {
      const up = settled.filter((m) => planAt(m, month) < BEAN_PLANS[2])
      if (up.length) {
        const m = up[r.int(0, up.length - 1)] as BeanMember
        const next = BEAN_PLANS[BEAN_PLANS.indexOf(planAt(m, month) as (typeof BEAN_PLANS)[number]) + 1] as number
        // Plan changes take effect at renewal (no proration): on the member's billing day, charged at the new price.
        m.plans.push({ from: `${month.slice(0, 8)}${String(m.billingDay).padStart(2, '0')}`, minor: next })
      }
    }
    if (n >= 2) {
      const upgraded = new Set(members.filter((m) => m.plans.some((p) => p.from >= month)).map((m) => m.id))
      const can = settled.filter((m) => !upgraded.has(m.id))
      if (can.length) (can[r.int(0, can.length - 1)] as BeanMember).ended = day(1)
    }
  }
  memo.set(key, members)
  return members
}

export const beanPlanAt = (m: BeanMember, date: string): number => [...m.plans].reverse().find((p) => p.from <= date)?.minor ?? 0

/** Bean Club charges on `date` (each member on their billing day, and on the day they join). */
export function beanCharges(ctx: DayContext, date: string): Draft[] {
  if (date < ctx.start) return []
  const out: Draft[] = []
  for (const m of beanMembers(ctx)) {
    if (m.joined > date || (m.ended && m.ended <= date)) continue
    if (date !== m.joined && dayOfMonth(date) !== m.billingDay) continue
    const gross = beanPlanAt(m, date)
    const fee = stripeFee(gross)
    out.push({ type: 'processor.balance_txn', externalId: `hc-bean-${m.id}-${date}`, accountExternalId: 'hc-processor:USD', at: `${date}T15:00:00.000Z`, kind: 'charge', gross: USD(gross), fee: USD(fee), net: USD(gross - fee), customer: `cus_${m.id.replace('-', '_')}`, counterparty: m.name, description: `Bean Club (${m.name}): ${date === m.joined ? 'Subscription creation' : 'Subscription update'}`, sourceExternalId: `ch_bean_${m.id}_${date}`, payoutExternalId: `hc-po-${addDays(date, 1)}` })
  }
  return out
}

/** The members as subscriptions today: active ones at their current plan, the rest canceled when they left. */
export function beanSubscriptions(ctx: DayContext, today: string): Draft[] {
  return beanMembers(ctx)
    .filter((m) => m.joined <= today)
    .map((m): Draft => {
      const active = !m.ended || m.ended > today
      const plan = beanPlanAt(m, active ? today : addDays(m.ended as string, -1))
      return {
        type: 'subscription.upsert',
        externalId: `sub_bean_${m.id}`,
        customer: m.name,
        status: active ? 'active' : 'canceled',
        mrr: USD(active ? plan : 0),
        interval: 'month',
        intervalCount: 1,
        startedAt: `${m.joined}T12:00:00.000Z`,
        ...(active ? {} : { canceledAt: `${m.ended}T12:00:00.000Z`, endedAt: `${m.ended}T12:00:00.000Z` }),
        items: [{ priceExternalId: `price_bean_${plan}`, product: 'Bean Club', quantity: 1, amount: USD(plan) }],
        // Plan changes as Stripe's history would show them, so upgrades fall in the month they happened.
        changes: m.plans.filter((p) => p.from <= today && (active || p.from < (m.ended as string))).map((p) => ({ at: `${p.from}T12:00:00.000Z`, mrr: USD(p.minor) })),
      }
    })
}

// ---------------------------------------------------------------- business card

const SOFTWARE: ReadonlyArray<{ day: number; name: string; raw: string; minor: number }> = [
  { day: 3, name: 'Shopify', raw: 'SHOPIFY* 21983711', minor: 39_00 },
  { day: 7, name: 'Google Workspace', raw: 'GOOGLE *WORKSPACE harborc', minor: 28_80 },
  { day: 11, name: 'QuickBooks Online', raw: 'INTUIT *QBOOKS ONLINE', minor: 90_00 },
  { day: 15, name: '7shifts', raw: '7SHIFTS.COM', minor: 76_99 },
  { day: 22, name: 'Canva', raw: 'CANVA* 04123', minor: 15_00 },
]

/** The card's purchases on `date`: the café's software, one charge each a month. */
export function hcCardPurchases(ctx: DayContext, date: string): Draft[] {
  if (date < ctx.start) return []
  return SOFTWARE.filter((s) => s.day === dayOfMonth(date)).map((s) => ({
    type: 'txn.upsert',
    externalId: `hc-card-${date}-${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    accountExternalId: 'hc-card',
    date,
    amount: USD(-s.minor),
    status: 'posted',
    counterparty: s.name,
    rawText: s.raw,
    categoryHint: 'GENERAL_SERVICES_SOFTWARE_SUBSCRIPTIONS',
  }))
}

export const HC_CARD_APR = '24.49'
export const HC_CARD_PAY_DAY = 25

/** The card's terms as of `today`: the last statement (the month before), and the payment due on the 25th. */
export function hcCardTerms(ctx: DayContext, today: string): LiabilityDetails {
  const statementDate = addDays(firstOfMonth(today), -1)
  const owed = eachDay(firstOfMonth(statementDate), statementDate).reduce((s, d) => s - hcCardPurchases(ctx, d).reduce((a, e) => a + (e.type === 'txn.upsert' ? e.amount.minor : 0), 0), 0)
  const due = dayOfMonth(today) <= HC_CARD_PAY_DAY ? `${today.slice(0, 8)}${HC_CARD_PAY_DAY}` : `${nextMonth(today).slice(0, 8)}${HC_CARD_PAY_DAY}`
  return { kind: 'credit', apr: HC_CARD_APR, lastStatementDate: statementDate, lastStatementBalance: USD(owed), nextPaymentDueDate: due, minimumPayment: USD(Math.min(owed, Math.max(35_00, Math.round(owed * 0.02)))) }
}
