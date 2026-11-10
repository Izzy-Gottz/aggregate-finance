// Roast my books / Hype my books (launch plan): a few lines about one company's spending, from facts the ledger made.
// Every line is a fixed template filled with one computed figure (a share, a change, a count, months), so a shared
// card never carries a number the ledger didn't make. An AI may write its own roast in the chat; a card is rebuilt
// from these facts. Tone (34-approved): roast the spending, never the person; witty, short, kind; never advice.
// Hard stops: nothing when the books aren't reconciled; no roast when runway is under six months.
// Merchant names only when the person turns names on; otherwise "one software vendor".

import type { ReportView, TxnView } from '@agfn/contracts'

export type Mood = 'roast' | 'hype'

/** Spending groups, in words, from the ledger's expense roles (packages/core coa.ts EXPENSE_ROLES). */
const GROUP: Record<string, string> = {
  payroll_expense: 'payroll',
  payroll_taxes: 'payroll',
  payroll_benefits: 'payroll',
  contractors: 'contractors',
  software: 'software',
  cloud: 'software',
  cogs: 'what you sell',
  rent: 'rent',
  housing: 'rent',
  utilities: 'utilities',
  meals: 'food',
  groceries: 'groceries',
  marketing: 'marketing',
  travel: 'travel',
  processor_fees: 'fees',
  bank_fees: 'fees',
  professional_fees: 'advisers',
  insurance: 'insurance',
  taxes: 'taxes',
  shopping: 'shopping',
  entertainment: 'entertainment',
}
/** What a single vendor in a group is called when names are off. */
const VENDOR: Record<string, string> = { software: 'one software tool', food: 'one place to eat', travel: 'one travel company', 'what you sell': 'one supplier', marketing: 'one ad platform', fees: 'one payment processor', rent: 'your landlord' }
/** Where buying often is a habit worth a joke; never supplies, groceries, payroll, rent or utilities (that's just running the place). */
const HABIT_GROUPS = new Set(['food', 'travel', 'shopping', 'entertainment', 'software', 'marketing'])
const SPEND_ROLES = new Set(Object.keys(GROUP).concat(['uncategorized_expense', 'other_expense']))

export interface Facts {
  /** Biggest spending group and its share of all spending (last 3 complete months). */
  top?: { group: string; pct: number }
  /** The next biggest, when it's at least 8% of spending. */
  second?: { group: string; pct: number }
  /** A vendor whose monthly charge rose by at least 40% within the window. */
  priceJump?: { name: string; group: string; pct: number }
  /** The vendor charged most often, at least 6 times a month on average. */
  frequent?: { name: string; group: string; perMonth: number }
  /** The same charge twice on one day from one vendor (count of such pairs). */
  doubles?: { name: string; count: number }
  /** Spending vs the 3 months before, % (only when both windows have spending). */
  spendChangePct?: number
  /** Money in from customers vs the 3 months before, %. */
  revenueChangePct?: number
  /** Processor and bank fees as % of money in from customers. */
  feesPct?: number
  /** Runway in whole months, or null when not burning (from the runway metric). */
  runwayMonths?: number | null
}

const monthOf = (d: string) => d.slice(0, 7)
const pct = (a: number, b: number) => Math.round(((a - b) / b) * 100)

/** One window of the company's profit and loss: spending per ledger role (cost of revenue and operating expenses) and revenue. */
export interface Pnl {
  spend: Record<string, number>
  revenue: number
}

/** The accrual P&L as the reports show it ([revenue, cost of revenue, operating expenses, other]), in minor units. */
export function pnlOf(r: ReportView | undefined): Pnl {
  const spend: Record<string, number> = {}
  for (const sec of [r?.sections[1], r?.sections[2]]) for (const row of sec?.rows ?? []) spend[row.role ?? 'other_expense'] = (spend[row.role ?? 'other_expense'] ?? 0) + row.amount.minor
  return { spend, revenue: r?.sections[0]?.total.minor ?? 0 }
}

/**
 * Facts for one company. Shares, changes and fees come from the P&L (accrual, the 3 complete months before `asOf` and
 * the 3 before those), so a card never disagrees with the company's reports. Vendor facts (a price jump, a habit, a
 * double charge) come from posted rows with an expense role, so transfers, card payments, payouts and owner money
 * never count.
 */
export function factsFrom(rows: TxnView[], months: { now: string[]; before: string[] }, pnl: { now: Pnl; before: Pnl }, runwayMonths?: number | null): Facts {
  const now = new Set(months.now)
  const posted = rows.filter((r) => r.status === 'posted' && r.category)
  const spend = (set: Set<string>) => posted.filter((r) => set.has(monthOf(r.date)) && r.amount.minor < 0 && SPEND_ROLES.has(r.category!))
  const f: Facts = {}
  const spentNow = spend(now)
  const total = (p: Pnl) => Object.values(p.spend).reduce((t, x) => t + x, 0)
  const spentTotal = total(pnl.now)
  if (spentTotal > 0) {
    const by = new Map<string, number>()
    for (const [role, amt] of Object.entries(pnl.now.spend)) {
      const g = GROUP[role] ?? 'everything else'
      by.set(g, (by.get(g) ?? 0) + amt)
    }
    const ranked = [...by].filter(([g]) => g !== 'everything else').sort((a, b) => b[1] - a[1])
    const share = (x: number) => Math.round((x / spentTotal) * 100)
    if (ranked[0]) f.top = { group: ranked[0][0], pct: share(ranked[0][1]) }
    if (ranked[1] && share(ranked[1][1]) >= 8) f.second = { group: ranked[1][0], pct: share(ranked[1][1]) }

    // Per vendor: monthly totals, counts, same-day repeats.
    const vendors = new Map<string, { group: string; byMonth: Map<string, number>; count: number; days: Map<string, number[]> }>()
    for (const r of spentNow) {
      const name = r.counterparty?.trim()
      if (!name) continue
      const v = vendors.get(name) ?? { group: GROUP[r.category!] ?? 'everything else', byMonth: new Map(), count: 0, days: new Map() }
      v.byMonth.set(monthOf(r.date), (v.byMonth.get(monthOf(r.date)) ?? 0) + Math.abs(r.amount.minor))
      v.count++
      v.days.set(r.date, [...(v.days.get(r.date) ?? []), Math.abs(r.amount.minor)])
      vendors.set(name, v)
    }
    const [first, , last] = months.now
    let jump: Facts['priceJump']
    let freq: Facts['frequent']
    let doubles: Facts['doubles']
    for (const [name, v] of vendors) {
      if (v.group === 'payroll' || v.group === 'taxes' || v.group === 'rent' || v.group === 'utilities') continue
      // Fees are charged per sale, so the same fee twice on one day is two sales, not a double charge.
      const perSale = v.group === 'fees'
      const a = v.byMonth.get(first!)
      const b = v.byMonth.get(last!)
      // Same vendor, once a month at both ends (a subscription), clearly more at the end.
      if (a && b && a >= 1_000 && v.count <= 4 && b >= a * 1.4) {
        const p = pct(b, a)
        if (!jump || p > jump.pct) jump = { name, group: v.group, pct: p }
      }
      const perMonth = Math.round(v.count / 3)
      // A habit is small and often (a coffee, a ride); a supplier's order isn't, whatever its category says.
      const avg = [...v.byMonth.values()].reduce((t, x) => t + x, 0) / v.count
      if (perMonth >= 6 && avg < 100_00 && HABIT_GROUPS.has(v.group) && (!freq || perMonth > freq.perMonth)) freq = { name, group: v.group, perMonth }
      let n = 0
      for (const amounts of v.days.values()) {
        const seen = new Set<number>()
        for (const x of amounts) (seen.has(x) ? n++ : seen.add(x))
      }
      if (!perSale && n > 0 && (!doubles || n > doubles.count)) doubles = { name, count: n }
    }
    if (jump) f.priceJump = jump
    if (freq) f.frequent = freq
    if (doubles) f.doubles = doubles
    const spentBefore = total(pnl.before)
    if (spentBefore > 0) f.spendChangePct = pct(spentTotal, spentBefore)
  }
  const inNow = pnl.now.revenue
  const inBefore = pnl.before.revenue
  if (inNow > 0 && inBefore > 0) f.revenueChangePct = pct(inNow, inBefore)
  const fees = (pnl.now.spend.processor_fees ?? 0) + (pnl.now.spend.bank_fees ?? 0)
  if (inNow > 0 && fees > 0) f.feesPct = Math.round((fees / inNow) * 1000) / 10
  if (runwayMonths !== undefined) f.runwayMonths = runwayMonths
  return f
}

/** Why there's nothing to say, or null when there is. */
export function refusal(mood: Mood, reconciled: boolean, facts: Facts): string | null {
  if (!reconciled) return mood === 'roast' ? 'Your books are too honest to roast today: a few things still need a look.' : 'A few things still need a look. Once they’re settled, there’s plenty to cheer.'
  if (mood === 'roast' && typeof facts.runwayMonths === 'number' && facts.runwayMonths < 6) return 'Not today. With under six months of runway, nobody needs a roast.'
  return null
}

/** Up to `max` lines, best first. Names only when `names` is on. Deterministic: the same facts give the same lines. */
export function lines(mood: Mood, f: Facts, opts: { names: boolean; max?: number }): string[] {
  const who = (v: { name: string; group: string }) => (opts.names ? v.name : (VENDOR[v.group] ?? `one ${v.group} vendor`))
  const Who = (v: { name: string; group: string }) => cap(who(v))
  const out: string[] = []
  const add = (s: string | null | undefined) => void (s && out.push(s))
  if (mood === 'roast') {
    if (f.top) add(f.top.group === 'payroll' ? `Payroll is ${f.top.pct}% of what you spend. Your team is the product, and also the entire budget.` : `${cap(f.top.group)} is ${f.top.pct}% of everything you spend. Bold to have a favorite.`)
    if (f.second) add(SECOND[f.second.group]?.(f.second.pct) ?? `${cap(f.second.group)} takes ${f.second.pct}%. A solid supporting role.`)
    if (f.priceJump) add(`${Who(f.priceJump)} raised its price ${f.priceJump.pct}% and you didn’t blink. Admirable loyalty.`)
    if (f.frequent) add(`${Who(f.frequent)}, ${f.frequent.perMonth} times a month. That’s not a habit, it’s a subscription without the discount.`)
    if (f.doubles) {
      const d = opts.names ? f.doubles.name : 'one vendor'
      add(f.doubles.count === 1 ? `${cap(d)} charged you twice for the same thing, and the books caught it before you did.` : `${f.doubles.count} double charges from ${d}. The books noticed. Just saying.`)
    }
    if (f.feesPct !== undefined && f.feesPct >= 2.5) add(`Card fees take ${f.feesPct}% of what comes in. Your payment processor thanks you for your service.`)
    if (f.spendChangePct !== undefined && Math.abs(f.spendChangePct) >= 5) add(f.spendChangePct > 0 ? `Spending is up ${f.spendChangePct}% on the quarter before. Ambition has a line item.` : `Spending is down ${-f.spendChangePct}% on the quarter before. Someone found the cancel button.`)
    if (f.revenueChangePct !== undefined && Math.abs(f.revenueChangePct) >= 5) add(f.revenueChangePct > 0 ? `Revenue is up ${f.revenueChangePct}% on the quarter before. Annoyingly hard to roast.` : `Revenue dipped ${-f.revenueChangePct}% on the quarter before. Even graphs need a nap.`)
  } else {
    if (f.runwayMonths === null) add('You’re not burning cash. Rare air.')
    else if (typeof f.runwayMonths === 'number' && f.runwayMonths >= 6) add(`${f.runwayMonths} months of runway. Plenty of road ahead.`)
    if (f.revenueChangePct !== undefined && f.revenueChangePct >= 3) add(`Revenue is up ${f.revenueChangePct}% on the quarter before. The work is showing.`)
    if (f.spendChangePct !== undefined && f.spendChangePct <= -5) add(`Spending is down ${-f.spendChangePct}% on the quarter before. Discipline looks good on you.`)
    if (f.top) add(f.top.group === 'payroll' ? `${f.top.pct}% of what you spend goes to your people. That’s a team worth betting on.` : `${f.top.pct}% of your spending goes to ${f.top.group}. You know exactly where the money matters.`)
    if (f.doubles) add('The books caught a double charge before it slipped by. Nothing gets past you now.')
    if (f.feesPct !== undefined && f.feesPct < 2.5) add(`Fees are only ${f.feesPct}% of what comes in. Lean where it counts.`)
  }
  return out.slice(0, opts.max ?? 3)
}

/** The runner-up, roasted in its own words. */
const SECOND: Record<string, (p: number) => string> = {
  rent: (p) => `Rent is ${p}% of what you spend. Your landlord thinks of you fondly.`,
  'what you sell': (p) => `${p}% goes on what you sell. At least the inventory is loyal.`,
  software: (p) => `${p}% goes to software. Every problem has a subscription.`,
  marketing: (p) => `${p}% on marketing. Somebody out there has definitely heard of you.`,
  food: (p) => `${p}% goes on food and drink. Somebody here has excellent taste.`,
  fees: (p) => `${p}% on fees. Money moving around is not free, as you’ve noticed.`,
  contractors: (p) => `${p}% on contractors. The team is bigger than the payroll says.`,
  travel: (p) => `${p}% on travel. The miles are going somewhere nice.`,
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The 3 complete months before `asOf` and the 3 before those, as YYYY-MM, with the dates the P&L reads. */
export function windows(asOf: string): { now: string[]; before: string[]; from: string; to: string; nowFrom: string; beforeTo: string } {
  const y = Number(asOf.slice(0, 4))
  const m = Number(asOf.slice(5, 7)) - 1
  const at = (k: number) => new Date(Date.UTC(y, m - k, 1)).toISOString().slice(0, 7)
  const now = [at(3), at(2), at(1)]
  const before = [at(6), at(5), at(4)]
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const beforeTo = new Date(Date.UTC(y, m - 3, 0)).toISOString().slice(0, 10)
  return { now, before, from: `${before[0]}-01`, to: end, nowFrom: `${now[0]}-01`, beforeTo }
}
