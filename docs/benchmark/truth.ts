// Ground truth for the Finance Agent Benchmark: every answer computed straight from the benchmark's events (and, for
// the planted cases and bills, from the generator that made them), never through Aggregate's ledger or tools, so the
// product isn't grading itself. Writes questions.json next to this file.
//
//   node docs/benchmark/truth.ts          (deterministic: the same file every run)
import { writeFileSync } from 'node:fs'
import type { InvoiceUpsert, NormalizedEvent, PayrollRun, ProcessorBalanceTxn, SubscriptionUpsert, TxnUpsert } from '@agfn/contracts'
import { glassWeek, glassMonday } from '@agfn/connector-demo'
import { BENCHMARK, benchmarkEvents } from './events.ts'

type Answer = { type: 'money' | 'number' | 'percent' | 'date' | 'text' | 'count'; value: number | string }
export interface Question {
  id: string
  category: string
  question: string
  answer: Answer
  tolerance: { abs?: number; rel?: number }
  as_of: string
  notes: string
}

const AS_OF = BENCHMARK.asOf
const FY = { from: '2025-10-01', to: '2026-09-30', name: 'the fiscal year October 2025 through September 2026' }
const PY = { from: '2024-10-01', to: '2025-09-30', name: 'the fiscal year October 2024 through September 2025' }
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
const dollars = (minor: number) => Math.round(minor) / 100
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const inRange = (d: string, r: { from: string; to: string }) => d >= r.from && d <= r.to
const monthRange = (ym: string) => ({ from: `${ym}-01`, to: `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}` })
const EXACT = { abs: 0.01 }

export async function buildQuestions(): Promise<Question[]> {
  const ev = await benchmarkEvents()
  const txns = ev.filter((e): e is TxnUpsert & { connectionId: string } => e.type === 'txn.upsert')
  const ptx = ev.filter((e): e is ProcessorBalanceTxn & { connectionId: string } => e.type === 'processor.balance_txn')
  const day = (p: ProcessorBalanceTxn) => p.at.slice(0, 10)
  const acct = (id: string) => txns.filter((t) => t.accountExternalId === id)
  const charges = (account: string, r: { from: string; to: string }, prefix?: string) => ptx.filter((p) => p.kind === 'charge' && p.accountExternalId === account && inRange(day(p), r) && (!prefix || p.externalId.startsWith(prefix)))
  const payouts = (account: string, r: { from: string; to: string }) => ptx.filter((p) => p.kind === 'payout' && p.accountExternalId === account && inRange(day(p), r))
  const snap = new Map(ev.filter((e) => e.type === 'balance.snapshot').map((e) => [e.externalId, e.type === 'balance.snapshot' ? e.current.minor : 0]))
  const balance = (account: string, date: string) => {
    const v = snap.get(`${account}@${date}`)
    if (v === undefined) throw new Error(`no balance for ${account} on ${date}`)
    return v
  }

  // Sales by channel (gross, before processor fees).
  const inStore = (r: { from: string; to: string }) => sum(charges('hc-processor:USD', r, 'hc-sales-').map((p) => p.gross.minor))
  const beans = (r: { from: string; to: string }) => sum(charges('hc-processor:USD', r, 'hc-bean-').map((p) => p.gross.minor))
  const online = (r: { from: string; to: string }) => sum(charges('hc-shopify:USD', r).map((p) => p.gross.minor))
  const cash = (r: { from: string; to: string }) => sum(acct('hc-cash').filter((t) => t.externalId.endsWith('-sales') && inRange(t.date, r)).map((t) => t.amount.minor))
  const sales = (r: { from: string; to: string }) => inStore(r) + beans(r) + online(r) + cash(r)
  const fees = (account: string, r: { from: string; to: string }, prefix?: string) => sum(charges(account, r, prefix).map((p) => p.fee.minor))

  const q: Question[] = []
  const add = (category: string, question: string, answer: Answer, tolerance: Question['tolerance'], notes: string) =>
    q.push({ id: `${category}-${String(q.filter((x) => x.category === category).length + 1).padStart(2, '0')}`, category, question, answer, tolerance, as_of: AS_OF, notes })
  const money = (minor: number): Answer => ({ type: 'money', value: dollars(minor) })
  const count = (n: number): Answer => ({ type: 'count', value: n })
  const percent = (x: number): Answer => ({ type: 'percent', value: Math.round(x * 10000) / 100 })

  // ---------------------------------------------------------------- balances (12)
  const names: Array<[string, string]> = [['hc-checking', 'checking account balance'], ['hc-savings', 'savings account balance'], ['hc-cash', 'cash drawer balance'], ['hc-processor:USD', 'balance held at Stripe'], ['hc-shopify:USD', 'balance held at Shopify']]
  for (const [id, name] of names) add('balances', `What was Harbor Coffee's ${name} at the end of the day on ${AS_OF}?`, money(balance(id, AS_OF)), EXACT, 'From the provider balance on that day.')
  add('balances', `How much did Harbor Coffee owe on its business card at the end of the day on ${AS_OF}?`, money(-balance('hc-card', AS_OF)), EXACT, 'Card balance owed, as a positive amount.')
  for (const d of ['2025-12-31', '2026-06-30', '2025-09-30']) add('balances', `What was the checking account balance on ${d}?`, money(balance('hc-checking', d)), EXACT, 'Month-end balance.')
  add('balances', `What was the savings account balance on 2025-03-31?`, money(balance('hc-savings', '2025-03-31')), EXACT, 'Month-end balance.')
  add('balances', `What was Harbor Coffee's total cash on ${AS_OF}: checking, savings, the cash drawer, and money held at Stripe and Shopify?`, money(sum(names.map(([id]) => balance(id, AS_OF)))), EXACT, 'Sum of the five balances; the card is a liability and not included.')
  add('balances', `How much did Harbor Coffee owe on its business card on 2026-08-31?`, money(-balance('hc-card', '2026-08-31')), EXACT, 'Month-end card balance, as a positive amount.')

  // ---------------------------------------------------------------- sales (16)
  const channels = 'in-store card sales (Stripe), Bean Club subscriptions (Stripe), online orders (Shopify) and cash sales'
  add('sales', `What were Harbor Coffee's total gross sales in ${FY.name}? Count ${channels}, before processor fees.`, money(sales(FY)), EXACT, 'Gross charges plus counted cash sales. Transfers, payouts and mobile check deposits are not counted.')
  add('sales', `What were total gross sales in ${PY.name}, counted the same way (${channels}, before fees)?`, money(sales(PY)), EXACT, 'Same definition as sales-01.')
  add('sales', `By what percentage did total gross sales grow from ${PY.name} to ${FY.name}?`, percent(sales(FY) / sales(PY) - 1), { abs: 0.1 }, 'Percent, e.g. 12.34 for 12.34%. Same sales definition.')
  add('sales', `How much did in-store card sales through Stripe bring in (gross) in ${FY.name}?`, money(inStore(FY)), EXACT, 'Stripe charges for in-store sales, not Bean Club.')
  add('sales', `How much did Bean Club subscriptions bring in (gross charges) in ${FY.name}?`, money(beans(FY)), EXACT, 'Stripe subscription charges.')
  add('sales', `How much did online orders through Shopify bring in (gross) in ${FY.name}?`, money(online(FY)), EXACT, 'Shopify order totals.')
  add('sales', `How much were cash sales in ${FY.name}?`, money(cash(FY)), EXACT, 'Cash counted into the drawer at close.')
  for (const ym of ['2026-07', '2026-08', '2026-09']) add('sales', `What were total gross sales in ${monthName(ym)} (${channels})?`, money(sales(monthRange(ym))), EXACT, 'Same definition as sales-01.')
  const fyMonths = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 7))
  const best = [...fyMonths].sort((a, b) => sales(monthRange(b)) - sales(monthRange(a)))[0] as string
  add('sales', `Which month in ${FY.name} had the highest total gross sales?`, { type: 'text', value: monthName(best) }, {}, 'Month and year, e.g. "July 2026".')
  const q3 = { from: '2026-07-01', to: '2026-09-30' }
  const q3p = { from: '2025-07-01', to: '2025-09-30' }
  add('sales', `By what percentage did total gross sales in July–September 2026 change compared with July–September 2025?`, percent(sales(q3) / sales(q3p) - 1), { abs: 0.1 }, 'Percent. Same sales definition.')
  const sep = monthRange('2026-09')
  add('sales', `What were average daily in-store card sales (Stripe, gross, Bean Club excluded) in September 2026?`, money(inStore(sep) / 30), { abs: 0.5 }, 'September total ÷ 30 days.')
  add('sales', `How much did Shopify online orders bring in (gross) in August 2026?`, money(online(monthRange('2026-08'))), EXACT, '')
  add('sales', `How much were cash sales in September 2026?`, money(cash(sep)), EXACT, '')
  add('sales', `How much did Bean Club charges total (gross) in September 2026?`, money(beans(sep)), EXACT, '')

  // ---------------------------------------------------------------- fees (8)
  add('fees', `How much did Stripe keep in fees in ${FY.name}?`, money(fees('hc-processor:USD', FY)), EXACT, 'In-store and Bean Club charges.')
  add('fees', `How much did Shopify keep in fees in ${FY.name}?`, money(fees('hc-shopify:USD', FY)), EXACT, '')
  add('fees', `What were total payment processing fees (Stripe and Shopify) in ${FY.name}?`, money(fees('hc-processor:USD', FY) + fees('hc-shopify:USD', FY)), EXACT, '')
  add('fees', `How much were Stripe fees in September 2026?`, money(fees('hc-processor:USD', sep)), EXACT, '')
  add('fees', `What were Stripe and Shopify fees as a percentage of the gross sales that went through them in ${FY.name}?`, percent((fees('hc-processor:USD', FY) + fees('hc-shopify:USD', FY)) / (inStore(FY) + beans(FY) + online(FY))), { abs: 0.05 }, 'Percent; cash sales excluded from the base.')
  add('fees', `How much were Shopify fees in August 2026?`, money(fees('hc-shopify:USD', monthRange('2026-08'))), EXACT, '')
  add('fees', `How much did Stripe keep in fees on Bean Club charges in ${FY.name}?`, money(fees('hc-processor:USD', FY, 'hc-bean-')), EXACT, '')
  add('fees', `What were total payment processing fees (Stripe and Shopify) in ${PY.name}?`, money(fees('hc-processor:USD', PY) + fees('hc-shopify:USD', PY)), EXACT, '')

  // ---------------------------------------------------------------- payouts (10)
  const sp = payouts('hc-processor:USD', FY)
  const sh = payouts('hc-shopify:USD', FY)
  add('payouts', `How many payouts did Stripe send to the bank in ${FY.name}?`, count(sp.length), {}, '')
  add('payouts', `How much did Stripe pay out to the bank in total in ${FY.name}?`, money(-sum(sp.map((p) => p.net.minor))), EXACT, 'Net of fees.')
  add('payouts', `How many payouts did Shopify send to the bank in ${FY.name}?`, count(sh.length), {}, 'Shopify pays out weekly.')
  add('payouts', `How much did Shopify pay out to the bank in total in ${FY.name}?`, money(-sum(sh.map((p) => p.net.minor))), EXACT, '')
  const biggest = [...sp].sort((a, b) => a.net.minor - b.net.minor)[0] as ProcessorBalanceTxn
  add('payouts', `What was the largest single Stripe payout in ${FY.name}?`, money(-biggest.net.minor), EXACT, '')
  add('payouts', `On what date did the largest Stripe payout of ${FY.name} arrive?`, { type: 'date', value: day(biggest) }, {}, 'YYYY-MM-DD.')
  const firstSepMonday = glassMonday('2026-09-01')
  const shopSep = payouts('hc-shopify:USD', { from: firstSepMonday, to: firstSepMonday })[0] as ProcessorBalanceTxn
  add('payouts', `How much was the Shopify payout that arrived on ${firstSepMonday}?`, money(-shopSep.net.minor), EXACT, '')
  add('payouts', `How much money was sitting in Stripe, not yet paid out, at the end of ${AS_OF}?`, money(balance('hc-processor:USD', AS_OF)), EXACT, 'That day’s charges, paid out the next day.')
  const po = 'hc-po-2026-09-15'
  add('payouts', `The Stripe payout that reached the bank on 2026-09-15 covered how many charges?`, count(ptx.filter((p) => p.kind === 'charge' && p.payoutExternalId === po).length), {}, 'In-store sales for the day count as one charge each day; Bean Club charges count one each.')
  add('payouts', `How much did Stripe deposit into checking in September 2026?`, money(sum(acct('hc-checking').filter((t) => inRange(t.date, sep) && t.counterparty === 'Stripe').map((t) => t.amount.minor))), EXACT, 'Bank deposits from Stripe.')

  // ---------------------------------------------------------------- transfers and reconciliation (10)
  const own = (r: { from: string; to: string }, from: string, to: string) => sum(acct(to).filter((t) => inRange(t.date, r) && t.amount.minor > 0 && /TRANSFER FROM (SAV|CHK)/.test(t.rawText ?? '') && (from === 'hc-savings' ? /FROM SAV/.test(t.rawText ?? '') : /FROM CHK/.test(t.rawText ?? ''))).map((t) => t.amount.minor))
  add('transfers', `How much money moved from savings to checking in ${FY.name}?`, money(own(FY, 'hc-savings', 'hc-checking')), EXACT, 'Transfers between Harbor’s own accounts; none carries a shared reference.')
  add('transfers', `How much money moved from checking to savings in ${FY.name}?`, money(own(FY, 'hc-checking', 'hc-savings')), EXACT, '')
  add('transfers', `By how much did the savings balance change over ${FY.name}?`, money(balance('hc-savings', FY.to) - balance('hc-savings', '2025-09-30')), EXACT, 'Negative if it went down.')
  const untagged = [...Array(200).keys()].map((i) => new Date(Date.parse(glassMonday(BENCHMARK.glass)) + i * 7 * 86_400_000).toISOString().slice(0, 10)).filter((m) => m <= AS_OF).map((m) => glassWeek({ seed: BENCHMARK.seed, start: BENCHMARK.start, glass: BENCHMARK.glass }, m).planted).filter((p) => p.kind === 'untagged_transfer' && inRange(p.date, FY))
  add('transfers', `How many transfers between Harbor's checking and savings accounts happened in ${FY.name}?`, count(untagged.length), {}, 'Each transfer counted once (it shows in both accounts).')
  add('transfers', `On what date did $15,000.00 move from savings into checking?`, { type: 'date', value: acct('hc-checking').find((t) => t.amount.minor === 15_000_00 && /FROM SAV/.test(t.rawText ?? ''))!.date }, {}, 'A transfer, not income.')
  const cashDeps = acct('hc-checking').filter((t) => inRange(t.date, FY) && t.rawText === 'BRANCH DEPOSIT CASH')
  add('transfers', `How much cash was taken from the drawer and deposited at the bank in ${FY.name}?`, money(sum(cashDeps.map((t) => t.amount.minor))), EXACT, 'Weekly branch deposits.')
  add('transfers', `How many cash deposits were made at the bank in ${FY.name}?`, count(cashDeps.length), {}, '')
  const mobile = acct('hc-checking').filter((t) => inRange(t.date, FY) && t.rawText === 'MOBILE CHECK DEPOSIT')
  add('transfers', `How much came in through mobile check deposits in ${FY.name}?`, money(sum(mobile.map((t) => t.amount.minor))), EXACT, 'Catering orders paid by check; they carry no name in the bank.')
  add('transfers', `How many mobile check deposits were there in ${FY.name}?`, count(mobile.length), {}, '')
  const sepIn = acct('hc-checking').filter((t) => inRange(t.date, sep) && t.amount.minor > 0)
  const notOwn = sepIn.filter((t) => !['Stripe', 'Shopify', 'Cash deposit', 'Transfer from savings', 'Transfer from checking'].includes(t.counterparty ?? ''))
  add('transfers', `In September 2026, how much money came into checking that was NOT a Stripe or Shopify payout and NOT a transfer from Harbor's own accounts (savings or the cash drawer)?`, money(sum(notOwn.map((t) => t.amount.minor))), EXACT, 'What is left is outside money (here: mobile check deposits).')

  // ---------------------------------------------------------------- expenses (16)
  const out = (r: { from: string; to: string }, counterparty: string) => -sum(acct('hc-checking').filter((t) => inRange(t.date, r) && t.counterparty === counterparty && t.amount.minor < 0).map((t) => t.amount.minor))
  const runs = (r: { from: string; to: string }) => ev.filter((e): e is PayrollRun & { connectionId: string } => e.type === 'payroll.run' && inRange(e.payDate, r))
  add('expenses', `How much rent did Harbor Coffee pay in ${FY.name}?`, money(out(FY, 'Pier 9 Properties')), EXACT, '')
  add('expenses', `What is Harbor Coffee's monthly rent?`, money(out(sep, 'Pier 9 Properties')), EXACT, '')
  add('expenses', `How much left checking for payroll (ADP) in ${FY.name}?`, money(out(FY, 'ADP')), EXACT, 'Wages plus employer taxes, as debited.')
  add('expenses', `What was total gross payroll in ${FY.name}?`, money(sum(runs(FY).map((r) => r.gross.minor))), EXACT, 'From the payroll runs.')
  add('expenses', `How much were employer payroll taxes in ${FY.name}?`, money(sum(runs(FY).map((r) => r.employerTaxes.minor))), EXACT, '')
  add('expenses', `How much net pay did employees receive in ${FY.name}?`, money(sum(runs(FY).map((r) => r.net.minor))), EXACT, '')
  add('expenses', `How many payroll runs were there in ${FY.name}?`, count(runs(FY).length), {}, '')
  add('expenses', `What was the average gross payroll per run in ${FY.name}?`, money(sum(runs(FY).map((r) => r.gross.minor)) / runs(FY).length), { abs: 0.5 }, '')
  add('expenses', `How much was paid to Roastworks Coffee in ${FY.name}?`, money(out(FY, 'Roastworks Coffee')), EXACT, 'Coffee beans.')
  add('expenses', `How much was paid to Valley Dairy in ${FY.name}?`, money(out(FY, 'Valley Dairy')), EXACT, '')
  add('expenses', `How much were utilities (City Power & Water) in ${FY.name}?`, money(out(FY, 'City Power & Water')), EXACT, '')
  add('expenses', `What were average monthly utilities in ${FY.name}?`, money(out(FY, 'City Power & Water') / 12), { abs: 0.5 }, '')
  const software = (r: { from: string; to: string }) => -sum(acct('hc-card').filter((t) => inRange(t.date, r) && t.amount.minor < 0).map((t) => t.amount.minor))
  add('expenses', `How much did Harbor Coffee spend on software in ${FY.name}?`, money(software(FY)), EXACT, 'All software is on the business card.')
  add('expenses', `How much did Harbor Coffee spend on software in September 2026?`, money(software(sep)), EXACT, '')
  const sepOut = acct('hc-checking').filter((t) => inRange(t.date, sep) && t.amount.minor < 0).sort((a, b) => a.amount.minor - b.amount.minor)[0] as TxnUpsert
  add('expenses', `What was the largest single payment out of checking in September 2026?`, money(-sepOut.amount.minor), EXACT, 'One bank row.')
  const suppliers = ['Roastworks Coffee', 'Valley Dairy', 'Pier Packaging Co', 'Bayside Bakery Supply']
  add('expenses', `How much was paid to suppliers (Roastworks Coffee, Valley Dairy, Pier Packaging Co and Bayside Bakery Supply) in ${FY.name}?`, money(sum(suppliers.map((s) => out(FY, s)))), EXACT, 'Bank payments.')

  // ---------------------------------------------------------------- bills (10)
  const bills = ev.filter((e): e is InvoiceUpsert & { connectionId: string } => e.type === 'invoice.upsert' && e.direction === 'payable')
  const weeks = [...Array(200).keys()].map((i) => new Date(Date.parse(glassMonday(BENCHMARK.glass)) + i * 7 * 86_400_000).toISOString().slice(0, 10)).filter((m) => m <= AS_OF).map((m) => glassWeek({ seed: BENCHMARK.seed, start: BENCHMARK.start, glass: BENCHMARK.glass }, m))
  const paidBy = new Map(weeks.flatMap((w) => w.bills.map((b) => [b.number, sum(b.payments.filter((p) => p.date <= AS_OF).map((p) => p.minor))] as const)))
  const fyBills = bills.filter((b) => inRange(b.issueDate, FY))
  add('bills', `How many supplier bills were issued to Harbor Coffee in ${FY.name}?`, count(fyBills.length), {}, '')
  add('bills', `What was the total of supplier bills issued in ${FY.name}?`, money(sum(fyBills.map((b) => b.total.minor))), EXACT, '')
  add('bills', `How much did Pier Packaging Co bill in ${FY.name}?`, money(sum(fyBills.filter((b) => b.counterparty === 'Pier Packaging Co').map((b) => b.total.minor))), EXACT, '')
  add('bills', `How much did Bayside Bakery Supply bill in ${FY.name}?`, money(sum(fyBills.filter((b) => b.counterparty === 'Bayside Bakery Supply').map((b) => b.total.minor))), EXACT, '')
  const owed = bills.map((b) => ({ b, left: b.total.minor - (paidBy.get(b.number as string) ?? 0) })).filter((x) => x.left > 0)
  add('bills', `As of ${AS_OF}, how many supplier bills were not fully paid?`, count(owed.length), {}, 'Paid means bank payments toward the bill add up to its total.')
  add('bills', `As of ${AS_OF}, how much did Harbor Coffee still owe on supplier bills in total?`, money(sum(owed.map((x) => x.left))), EXACT, 'Bill totals less the bank payments made toward them (including small shortfalls).')
  const planted = weeks.map((w) => w.planted).filter((p) => inRange(p.date, FY))
  const short = planted.filter((p) => p.kind === 'near_amount')
  add('bills', `In ${FY.name}, how many bills were paid a little less than their total (short by under a dollar)?`, count(short.length), {}, '')
  add('bills', `What was the total of those shortfalls (bills paid slightly less than billed) in ${FY.name}?`, money(sum(weeks.filter((w) => w.planted.kind === 'near_amount' && inRange(w.planted.date, FY)).map((w) => (w.bills[1]!.total - w.bills[1]!.payments[0]!.minor)))), EXACT, '')
  add('bills', `In ${FY.name}, how many bills were paid in two separate payments?`, count(planted.filter((p) => p.kind === 'split_payment').length), {}, '')
  const lastBill = [...bills].sort((a, b) => (a.issueDate < b.issueDate ? 1 : a.issueDate > b.issueDate ? -1 : 0))[0] as InvoiceUpsert
  add('bills', `What is the number of the most recently issued supplier bill?`, { type: 'text', value: lastBill.number as string }, {}, 'e.g. "BBS-2101".')

  // ---------------------------------------------------------------- subscriptions (10)
  const subs = ev.filter((e): e is SubscriptionUpsert & { connectionId: string } => e.type === 'subscription.upsert')
  const end = (s: SubscriptionUpsert) => (s.endedAt ?? s.canceledAt)?.slice(0, 10)
  const mrrOn = (s: SubscriptionUpsert, d: string) => {
    if (s.startedAt.slice(0, 10) > d) return 0
    const e = end(s)
    if (e && e <= d) return 0
    return [...(s.changes ?? [])].reverse().find((c) => c.at.slice(0, 10) <= d)?.mrr.minor ?? s.mrr.minor
  }
  const mrr = (d: string) => sum(subs.map((s) => mrrOn(s, d)))
  add('subscriptions', `What was Harbor Coffee's Bean Club MRR (monthly recurring revenue) on ${AS_OF}?`, money(mrr(AS_OF)), EXACT, 'Active subscriptions at their current plan.')
  add('subscriptions', `What was the Bean Club's annual run rate (ARR) on ${AS_OF}?`, money(mrr(AS_OF) * 12), EXACT, 'MRR × 12.')
  add('subscriptions', `How many active Bean Club members were there on ${AS_OF}?`, count(subs.filter((s) => mrrOn(s, AS_OF) > 0).length), {}, '')
  add('subscriptions', `How many Bean Club members cancelled during ${FY.name}?`, count(subs.filter((s) => end(s) && inRange(end(s) as string, FY)).length), {}, '')
  add('subscriptions', `How many people joined the Bean Club during ${FY.name}?`, count(subs.filter((s) => inRange(s.startedAt.slice(0, 10), FY)).length), {}, '')
  const expansion = (r: { from: string; to: string }) => sum(subs.flatMap((s) => (s.changes ?? []).slice(1).filter((c) => inRange(c.at.slice(0, 10), r)).map((c) => c.mrr.minor - (s.changes ?? [])[(s.changes ?? []).indexOf(c) - 1]!.mrr.minor)))
  const churned = (r: { from: string; to: string }) => sum(subs.filter((s) => end(s) && inRange(end(s) as string, r)).map((s) => mrrOn(s, new Date(Date.parse(end(s) as string) - 86_400_000).toISOString().slice(0, 10))))
  const newMrr = (r: { from: string; to: string }) => sum(subs.filter((s) => inRange(s.startedAt.slice(0, 10), r)).map((s) => (s.changes?.[0]?.mrr.minor ?? s.mrr.minor)))
  add('subscriptions', `How much MRR did Bean Club upgrades add in September 2026 (expansion MRR)?`, money(expansion(sep)), EXACT, 'Increase in monthly value from members moving to a bigger plan.')
  add('subscriptions', `How much MRR was lost to cancellations in August 2026 (churned MRR)?`, money(churned(monthRange('2026-08'))), EXACT, 'The monthly value of members who left.')
  add('subscriptions', `What was net new MRR in September 2026 (new + expansion − churned)?`, money(newMrr(sep) + expansion(sep) - churned(sep)), EXACT, 'Bean Club has no downgrades or reactivations.')
  add('subscriptions', `What was Bean Club MRR on 2025-09-30?`, money(mrr('2025-09-30')), EXACT, '')
  add('subscriptions', `By what percentage did Bean Club MRR grow from 2025-09-30 to ${AS_OF}?`, percent(mrr(AS_OF) / mrr('2025-09-30') - 1), { abs: 0.1 }, 'Percent.')

  // ---------------------------------------------------------------- card (8)
  const card = ev.find((e) => e.type === 'account.upsert' && e.externalId === 'hc-card')
  const terms = card?.type === 'account.upsert' ? card.liability : undefined
  if (!terms) throw new Error('the card has no terms')
  add('card', `What is the APR on Harbor Coffee's business card?`, { type: 'percent', value: Number(terms.apr) }, { abs: 0.001 }, 'Percent.')
  add('card', `When is the next business card payment due?`, { type: 'date', value: terms.nextPaymentDueDate as string }, {}, 'YYYY-MM-DD.')
  add('card', `What was the balance on the last business card statement?`, money(terms.lastStatementBalance!.minor), EXACT, '')
  add('card', `What is the minimum payment due on the business card?`, money(terms.minimumPayment!.minor), EXACT, '')
  add('card', `What date was the last business card statement?`, { type: 'date', value: terms.lastStatementDate as string }, {}, 'YYYY-MM-DD.')
  add('card', `How much was paid toward the business card from checking in ${FY.name}?`, money(-sum(acct('hc-checking').filter((t) => inRange(t.date, FY) && t.counterparty === 'Business Card').map((t) => t.amount.minor))), EXACT, 'Monthly statement payments.')
  add('card', `How much was charged on the business card in ${FY.name}?`, money(software(FY)), EXACT, 'Purchases only, not payments.')
  add('card', `How many different vendors charged the business card in ${FY.name}?`, count(new Set(acct('hc-card').filter((t) => inRange(t.date, FY) && t.amount.minor < 0).map((t) => t.counterparty)).size), {}, '')

  return q
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const questions = await buildQuestions()
  const file = new URL('./questions.json', import.meta.url)
  writeFileSync(file, JSON.stringify({ benchmark: 'Finance Agent Benchmark v1', company: 'Harbor Coffee (synthetic)', data: BENCHMARK, questions }, null, 2) + '\n')
  console.log(`${questions.length} questions → ${file.pathname}`)
}
