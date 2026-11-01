// Prompt packs (AGFN_MCP_PROMPTS=1): more guided workflows, grouped the way creators share them (docs/launch/creators.md:
// close, runway/CFO, SaaS MRR, small business, multi-company). They are ordinary MCP prompts, listed next to the three
// in prompts.ts, so clients show them in their prompt menus (Claude: /aggregate:runway). Each step starts with the tool
// it uses, so steps for tools this connection lacks are left out, and a test checks every step names a real tool.
//
// Credit: a pack names its creator only once they have agreed (credit stays undefined until then). Off while the Claude
// and ChatGPT directory reviews are open, because it changes the prompt list those reviews saw.

import * as z from 'zod/v4'
import type { PromptDef } from './prompts.ts'

export interface PromptPack {
  id: 'close' | 'cfo' | 'saas' | 'small_business' | 'multi_company'
  title: string
  /** The creator, once they've agreed to be named on the pack. */
  credit?: { name: string; url?: string }
  prompts: PromptDef[]
}

const company = z.string().max(120).describe('A company name, or leave empty for every company this connection can see.')
const month = z.string().regex(/^\d{4}-\d{2}$/, 'use YYYY-MM')
const RULE = 'Do not record or change anything on your own. If something should be fixed, show me the change with dry_run first and wait for my yes.'
const TOTALS = "Use Aggregate's numbers; don't add up rows yourself. Say \"unknown\" where data is missing; never guess."

function steps(has: (t: string) => boolean, list: Array<[string, string]>): string {
  return list
    .filter(([tool]) => has(tool))
    .map(([tool, text], i) => `${i + 1}. ${tool}${text.startsWith(':') ? '' : ' '}${text}`)
    .join('\n')
}
function previousMonth(today: string): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return d.toISOString().slice(0, 7)
}
function monthEnd(m: string): string {
  const [y, mm] = m.split('-').map(Number) as [number, number]
  return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10)
}
const scopeOf = (c: string | undefined) => (c ? `company "${c}"` : 'no company (all of them)')

export const PACKS: PromptPack[] = [
  {
    id: 'close',
    title: 'Month-end close',
    prompts: [
      {
        name: 'close_blockers',
        title: 'What blocks the close',
        description: 'Everything standing between you and a closed month: missing or mismatched accounts, items to decide, uncategorized rows.',
        args: z.object({ month: month.optional().describe('YYYY-MM (default: last month).'), company: company.optional() }),
        needs: ['get_coverage', 'list_review_items'],
        build(a, has, today) {
          const m = a.month ?? previousMonth(today)
          return [
            `What still blocks closing ${m}? Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['get_coverage', `from ${m} to ${m}: every account that is missing, mismatched or still in progress. Missing means unknown, not zero.`],
              ['list_review_items', ': what is waiting for a decision.'],
              ['query_transactions', `query "category:uncategorized" from ${m}-01 to ${monthEnd(m)}: how many rows and how much money still has no category.`],
              ['get_metric', 'data_health: which checks need a look.'],
            ]),
            '',
            'Give me a checklist, most important first, each item with its record id or account. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
      {
        name: 'accountant_review',
        title: 'Review the books like an accountant',
        description: 'A reviewer pass over a period: owner money, unusual items, unpaid invoices and bills, and anything that looks miscategorized.',
        args: z.object({ month: month.optional().describe('YYYY-MM (default: last month).'), company: company.optional() }),
        needs: ['query_transactions', 'get_owner_balance'],
        build(a, has, today) {
          const m = a.month ?? previousMonth(today)
          return [
            `Review ${m} the way an accountant would. Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['query_transactions', `group_by ["category"] measures ["money_in","money_out","count"] from ${m}-01 to ${monthEnd(m)}: anything in a surprising category.`],
              ['search_transactions', `from ${m}-01 to ${monthEnd(m)}, the largest rows: anything that looks personal, duplicated or in the wrong company.`],
              ['get_owner_balance', ': money between the owner and the company.'],
              ['query_invoices', 'group_by ["side","aging"]: what is owed both ways, by age.'],
              ['list_review_items', ': open questions.'],
            ]),
            '',
            'List the questions you would ask me, each with the record id. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
    ],
  },
  {
    id: 'cfo',
    title: 'Runway and CFO',
    prompts: [
      {
        name: 'runway',
        title: 'Runway, with a what-if',
        description: 'Cash, net burn and runway per company, and how a new monthly cost (a hire, a tool) would change runway.',
        args: z.object({ monthly_cost: z.string().regex(/^\d{1,9}(\.\d{1,2})?$/).optional().describe('A new monthly cost to test, e.g. 12000.'), company: company.optional() }),
        needs: ['get_overview', 'get_metric'],
        build(a, has) {
          const extra = a.monthly_cost ? ` Then show runway if net burn grew by ${a.monthly_cost} a month.` : ''
          return [
            `What is our runway?${extra} Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['get_overview', ': cash, card debt and runway per company.'],
              ['get_metric', 'net_burn and runway per company, with how they are computed.'],
              ['list_upcoming', 'days 60: large payments due that change the picture.'],
              ['list_recurring', ': the recurring costs behind the burn.'],
            ]),
            '',
            'Runway and net burn are per company. A combined runway is total cash over total net burn, never a sum of runways, and only when every company is burning cash. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
      {
        name: 'spending_change',
        title: 'Why did spending change?',
        description: 'Compares money out between two months by category and by vendor, and names the biggest movers.',
        args: z.object({ month: month.optional().describe('The month to explain, YYYY-MM (default: last month).'), company: company.optional() }),
        needs: ['query_transactions'],
        build(a, has, today) {
          const m = a.month ?? previousMonth(today)
          const before = previousMonth(`${m}-15`)
          return [
            `Why did spending change in ${m} compared with ${before}? Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['query_transactions', `group_by ["month","category"] measures ["money_out"] from ${before}-01 to ${monthEnd(m)}.`],
              ['query_transactions', `group_by ["month","counterparty"] measures ["money_out"] from ${before}-01 to ${monthEnd(m)}, limit 20.`],
              ['list_recurring', ': subscriptions that started, ended or changed price.'],
            ]),
            '',
            'Give the three biggest changes with amounts, and say which are one-offs. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
    ],
  },
  {
    id: 'saas',
    title: 'SaaS metrics',
    prompts: [
      {
        name: 'mrr_bridge',
        title: 'MRR bridge',
        description: 'How MRR moved month by month: new, expansion, contraction and churn, with churn rates.',
        args: z.object({ months: z.string().regex(/^\d{1,2}$/).optional().describe('How many months back (default 3).'), company: company.optional() }),
        needs: ['get_mrr_movements'],
        build(a, has) {
          const n = Math.min(Math.max(Number(a.months ?? 3) || 3, 1), 24)
          return [
            `Walk me through MRR over the last ${n} complete months. Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['get_mrr_movements', `for the last ${n} complete months: start, new, expansion, contraction, churn and end.`],
              ['get_metric', 'mrr, net_new_mrr and mrr_churn_rate for the last complete month.'],
            ]),
            '',
            'Show a small table per month, then the one thing that moved MRR most. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
      {
        name: 'zombie_subscriptions',
        title: 'Find zombie subscriptions',
        description: 'Recurring charges nobody may be using: tools, seats and duplicates, with what they cost a year.',
        args: z.object({ company: company.optional() }),
        needs: ['list_recurring'],
        build(a, has) {
          return [
            `Find subscriptions we may not need. Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['list_recurring', ': every active and suggested recurring charge, with amount and cadence.'],
              ['query_transactions', 'query "category:software" group_by ["counterparty"] measures ["money_out","count"] for the last 6 months.'],
            ]),
            '',
            'List likely duplicates and tools that look unused, with the yearly cost of each. I decide what to cancel; Aggregate never cancels anything. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
    ],
  },
  {
    id: 'small_business',
    title: 'Small business',
    prompts: [
      {
        name: 'who_owes_us',
        title: 'Who owes us money',
        description: 'Unpaid invoices by customer and by how overdue they are, biggest first.',
        args: z.object({ company: company.optional() }),
        needs: ['query_invoices'],
        build(a, has) {
          return [
            `Who owes us money, and how late is it? Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['query_invoices', 'side owed_to_you group_by ["aging"].'],
              ['query_invoices', 'side owed_to_you group_by ["counterparty"]: the customers with the most outstanding.'],
              ['get_metric', 'ar_open and ar_overdue.'],
            ]),
            '',
            'Name the top customers with amounts and days overdue. Aggregate never contacts customers; if I want a reminder, draft it for me to send. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
      {
        name: 'cash_this_month',
        title: 'Cash this month',
        description: 'Money in and out so far this month against last month, and what is still due before month end.',
        args: z.object({ company: company.optional() }),
        needs: ['query_transactions', 'get_overview'],
        build(a, has, today) {
          const m = today.slice(0, 7)
          const before = previousMonth(today)
          return [
            `How is cash doing this month (${m}-01 to ${today})? Use ${scopeOf(a.company)} in each call.`,
            '',
            steps(has, [
              ['get_overview', ': cash now, and anything needing attention.'],
              ['query_transactions', `measures ["money_in","money_out"] from ${m}-01 to ${today}, and from ${before}-01 to ${before}-${today.slice(8, 10)} to compare the same days.`],
              ['list_upcoming', `days ${Math.max(1, Number(monthEnd(m).slice(8, 10)) - Number(today.slice(8, 10)))}: bills and payroll still due this month.`],
            ]),
            '',
            'Three lines: in, out, and what is left to pay. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
    ],
  },
  {
    id: 'multi_company',
    title: 'Multi-company',
    prompts: [
      {
        name: 'all_companies',
        title: 'Every company side by side',
        description: 'Cash, net burn, runway and revenue for each company in one table, plus money moving between them.',
        args: z.object({}),
        needs: ['get_overview'],
        build(_a, has) {
          return [
            'Show every company I can see side by side. Use no company (all of them) in each call.',
            '',
            steps(has, [
              ['get_overview', ': cash, card debt and runway per company.'],
              ['get_metric', 'net_burn, revenue and intercompany_balance per company.'],
              ['query_transactions', 'group_by ["company","month"] measures ["money_in","money_out"] for the last 3 months.'],
            ]),
            '',
            'One table, one row per company. Never add runways together: a combined runway is total cash over total net burn, and only when every company is burning cash. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
      {
        name: 'which_company_pays',
        title: 'Which company pays for what',
        description: 'Spending by company and category, and rows that may sit in the wrong company.',
        args: z.object({ month: month.optional().describe('YYYY-MM (default: last month).') }),
        needs: ['query_transactions'],
        build(a, has, today) {
          const m = a.month ?? previousMonth(today)
          return [
            `Which company paid for what in ${m}? Use no company (all of them) in each call.`,
            '',
            steps(has, [
              ['query_transactions', `group_by ["company","category"] measures ["money_out"] from ${m}-01 to ${monthEnd(m)}.`],
              ['list_review_items', 'kinds ["which_company","whose_money"]: rows waiting for a company or owner.'],
            ]),
            '',
            'Flag anything that looks booked to the wrong company, with record ids. ' + TOTALS,
            RULE,
          ].join('\n')
        },
      },
    ],
  },
]

/** Every pack's prompts, with the creator named in the description once credited. */
export function packPrompts(): PromptDef[] {
  return PACKS.flatMap((pack) =>
    pack.prompts.map((p) => (pack.credit ? { ...p, description: `${p.description} From ${pack.credit.name}'s ${pack.title} pack.` } : p)),
  )
}
