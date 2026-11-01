// Demo workspace: three fake companies and a Personal space (MASTER §4: self-host first run opens this until real keys
// are added). All dates are relative to `now`, so the demo always looks current. No real names, accounts or numbers.

import type { ConnectorDescription, DataType, GrantShape, MetricAnswer, Money } from '@agfn/contracts'
import type {
  AccountRow,
  AiActivity,
  AiDetail,
  BucketDetail,
  CompanyDetail,
  ConnectionSummary,
  EntitySummary,
  Explained,
  Me,
  Preferences,
  ReviewItem,
  TxnRow,
} from './types.ts'
import { gridFor } from '../lib/roles.ts'

const DAY = 86_400_000

export const usd = (dollars: number): Money => ({ minor: Math.round(dollars * 100), currency: 'USD' })

export const ALL_DATA: DataType[] = ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'payroll', 'equity', 'documents', 'reports']

export const CONNECTORS: ConnectorDescription[] = [
  { key: 'plaid', name: 'Bank or card', group: 'banks', provides: ['balances', 'transactions'], freshness: 'updates within minutes', auth: 'link_widget' },
  { key: 'simplefin', name: 'SimpleFIN Bridge', group: 'banks', provides: ['balances', 'transactions'], freshness: 'updates once a day', auth: 'api_key' },
  { key: 'stripe', name: 'Stripe', group: 'payments', provides: ['balances', 'transactions', 'invoices'], freshness: 'live', auth: 'oauth' },
  { key: 'quickbooks', name: 'QuickBooks', group: 'accounting', provides: ['invoices', 'bills', 'reports'], freshness: 'hourly', auth: 'oauth' },
  { key: 'xero', name: 'Xero', group: 'accounting', provides: ['invoices', 'bills', 'reports'], freshness: 'hourly', auth: 'oauth' },
  { key: 'mercury', name: 'Mercury', group: 'spend', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'api_key' },
  { key: 'brex', name: 'Brex', group: 'spend', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'api_key' },
  { key: 'ramp', name: 'Ramp', group: 'spend', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'api_key' },
  { key: 'paypal', name: 'PayPal', group: 'payments', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'oauth' },
  { key: 'square', name: 'Square', group: 'payments', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'oauth' },
  { key: 'shopify', name: 'Shopify Payments', group: 'payments', provides: ['balances', 'transactions'], freshness: 'hourly', auth: 'oauth' },
  { key: 'rippling', name: 'Rippling', group: 'payroll', provides: ['payroll'], freshness: 'daily', auth: 'oauth' },
  { key: 'deel', name: 'Deel', group: 'payroll', provides: ['payroll'], freshness: 'daily', auth: 'oauth' },
  { key: 'justworks', name: 'Justworks', group: 'payroll', provides: ['payroll'], freshness: 'daily', auth: 'oauth' },
  { key: 'carta', name: 'Carta or Pulley export', group: 'equity', provides: ['equity'], freshness: 'when you upload', auth: 'file' },
  { key: 'files', name: 'Statement or CSV', group: 'files', provides: ['transactions', 'documents'], freshness: 'when you upload', auth: 'file' },
]

function metric(name: MetricAnswer['name'], value: MetricAnswer['value'], now: number, formula: string, extra: Partial<MetricAnswer> = {}): MetricAnswer {
  return {
    name,
    value,
    basis: 'cash',
    asOf: new Date(now - 2 * 3600_000).toISOString(),
    includedAccounts: [],
    excludedAccounts: [],
    staleSources: [],
    pendingReviewCount: 0,
    agentEntriesIncluded: 0,
    rowIds: [],
    formula,
    state: 'ok',
    ...extra,
  }
}

export interface DemoState {
  me: Me
  entities: EntitySummary[]
  connections: ConnectionSummary[]
  ais: AiDetail[]
  aiPaused: boolean
  companies: Record<string, CompanyDetail>
  transactions: Record<string, TxnRow[]>
  buckets: Record<string, BucketDetail>
  review: ReviewItem[]
  prefs: Preferences
  signedIn: boolean
}

export function demoState(now: number = Date.now(), opts: { signedIn?: boolean; empty?: boolean } = {}): DemoState {
  const t = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString()
  const d = (daysFromNow: number) => new Date(now + daysFromNow * DAY).toISOString().slice(0, 10)
  // The last full calendar month (payroll_cost's default period), as 'YYYY-MM'.
  const lastMonth = () => d(-new Date(now).getUTCDate()).slice(0, 7)

  const me: Me = {
    personId: 'p_owner',
    name: 'Dana Reyes',
    email: 'dana@example.com',
    workspaceId: 'w_demo',
    mcpUrl: 'https://app.aggregate.finance/mcp',
    selfHosted: false,
    demo: true,
    investments: true,
  }

  const entities: EntitySummary[] = opts.empty
    ? []
    : [
        { id: 'e_acme', kind: 'company', name: 'Acme', currency: 'USD', cash: usd(284_410), hidden: false },
        { id: 'e_nex', kind: 'company', name: 'Bluebird Studio', currency: 'USD', cash: usd(96_200), hidden: false },
        { id: 'e_cla', kind: 'company', name: 'Harbor Coffee', currency: 'USD', cash: usd(32_270), hidden: false },
        { id: 'e_personal', kind: 'personal', name: 'Personal', currency: 'USD', cash: usd(18_904), hidden: false },
      ]

  const connections: ConnectionSummary[] = opts.empty
    ? []
    : [
        { id: 'c_chase', connectorKey: 'plaid', name: 'Chase', entityNames: ['Acme'], status: 'ok', lastSyncAt: t(2), accountCount: 2 },
        { id: 'c_stripe_nex', connectorKey: 'stripe', name: 'Stripe', entityNames: ['Bluebird Studio'], status: 'ok', lastSyncAt: t(5 / 60), accountCount: 1 },
        { id: 'c_mercury', connectorKey: 'mercury', name: 'Mercury', entityNames: ['Harbor Coffee'], status: 'needs_reauth', lastSyncAt: t(30), accountCount: 1, message: 'Mercury stopped sharing data yesterday. Your data until then is safe.' },
      ]

  const claudeShape: GrantShape = {
    entityIds: 'all',
    dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'buckets', 'reports'],
    write: true,
    reviewMode: 'instant',
    expiresAt: new Date(now + 90 * DAY).toISOString(),
  }
  const gptShape: GrantShape = {
    entityIds: ['e_acme'],
    dataTypes: ['balances', 'transactions'],
    write: false,
    reviewMode: 'instant',
    expiresAt: new Date(now + 30 * DAY).toISOString(),
  }

  const claudeActivity: AiActivity[] = [
    { id: 'a1', grantId: 'g_claude', client: 'Claude', at: t(2 / 60), kind: 'read', summary: 'asked for cash in each company', result: '3 companies · 6 accounts' },
    { id: 'a2', grantId: 'g_claude', client: 'Claude', at: t(0.1), kind: 'write', summary: 'added $1,200 cash from Lee’s Deli to Acme', result: 'applied', recordId: 'r_cash1', status: 'applied', undoUntil: new Date(now + 30 * DAY).toISOString() },
    { id: 'a3', grantId: 'g_claude', client: 'Claude', at: t(26), kind: 'write', summary: 'created the Rent bucket in Acme', result: 'applied', recordId: 'b_rent', status: 'applied', undoUntil: new Date(now + 29 * DAY).toISOString() },
    { id: 'a4', grantId: 'g_claude', client: 'Claude', at: t(27), kind: 'read', summary: 'asked which invoices are overdue', result: '2 invoices · $12,400' },
  ]
  const gptActivity: AiActivity[] = [
    { id: 'a5', grantId: 'g_gpt', client: 'ChatGPT', at: t(30), kind: 'blocked', summary: 'asked for Bluebird Studio payroll', result: 'no access, so we said no' },
    { id: 'a6', grantId: 'g_gpt', client: 'ChatGPT', at: t(31), kind: 'read', summary: 'asked for Acme’s balance', result: '2 accounts' },
  ]
  const ais: AiDetail[] = opts.empty
    ? []
    : [
        { grantId: 'g_claude', client: 'Claude', personName: 'Dana', shape: claudeShape, lastUsedAt: t(2 / 60), paused: false, connectedAt: t(24 * 3), via: 'claude.ai', activity: claudeActivity },
        { grantId: 'g_gpt', client: 'ChatGPT', personName: 'Dana', shape: gptShape, lastUsedAt: t(30), paused: false, connectedAt: t(24 * 7), via: 'chatgpt.com', activity: gptActivity },
      ]

  const acmeAccounts: AccountRow[] = [
    { id: 'ac1', name: 'Business Checking', institution: 'Chase', mask: '4021', kind: 'bank', balance: usd(162_410), asOf: t(2), stale: false },
    { id: 'ac2', name: 'Business Savings', institution: 'Chase', mask: '7710', kind: 'bank', balance: usd(120_000), asOf: t(2), stale: false },
    { id: 'ac3', name: 'Cash on hand', institution: 'Cash', kind: 'cash', balance: usd(2_000), asOf: t(0.1), stale: false, addedBy: 'Claude' },
    { id: 'ac4', name: 'Business Gold', institution: 'Amex', mask: '1009', kind: 'card', balance: usd(-8_214), asOf: t(2), stale: false },
  ]

  const cashExplained = (rows: AccountRow[], name: string): Explained => {
    const cashRows = rows.filter((a) => a.kind === 'bank' || a.kind === 'cash' || a.kind === 'payments')
    return {
      label: `Cash in ${name}`,
      answer: metric('cash', usd(cashRows.reduce((a, r) => a + (r.balance?.minor ?? 0) / 100, 0)), now, 'Sum of current balances of bank, payments and cash-on-hand accounts. Cards and loans are not cash.', {
        includedAccounts: cashRows.map((r) => r.id),
        excludedAccounts: rows.filter((a) => !cashRows.includes(a)).map((a) => ({ id: a.id, reason: a.kind === 'card' ? 'card balance (money owed, not cash)' : 'not cash' })),
        agentEntriesIncluded: cashRows.filter((r) => r.addedBy).length,
      }),
      rows: cashRows.map((r) => ({ id: r.id, label: `${r.kind === 'cash' ? '' : r.institution + ' '}${r.name}${r.mask ? ' ··' + r.mask : ''}`, detail: r.addedBy ? `added by ${r.addedBy}` : undefined, amount: r.balance! })),
    }
  }

  const runway = (months: number, burn: number, name: string): CompanyDetail['runway'] => ({
    months,
    state: 'ok',
    explained: {
      label: `Runway for ${name}`,
      answer: metric('runway', months, now, 'Cash ÷ average net burn over the last 3 full months. Transfers between your own accounts and Stripe payouts are not burn.'),
      rows: [
        { id: 'm1', label: 'Net burn, 3 months ago', amount: usd(-burn * 1.05) },
        { id: 'm2', label: 'Net burn, 2 months ago', amount: usd(-burn * 0.97) },
        { id: 'm3', label: 'Net burn, last month', amount: usd(-burn * 0.98) },
      ],
    },
  })

  const companies: Record<string, CompanyDetail> = opts.empty
    ? {}
    : {
        e_acme: {
          entity: entities[0]!,
          asOf: t(2),
          cash: cashExplained(acmeAccounts, 'Acme'),
          runway: runway(19, 14_900, 'Acme'),
          trend: [212, 220, 231, 240, 236, 251, 262, 259, 270, 268, 279, 284],
          accounts: acmeAccounts,
          owedToYou: {
            total: usd(38_900),
            overdue: usd(12_400),
            aging: [
              { label: 'Not due', amount: usd(26_500) },
              { label: '1–30 days', amount: usd(4_400) },
              { label: '31–60 days', amount: usd(8_000) },
              { label: '60+ days', amount: usd(0) },
            ],
            invoices: [
              { id: 'i1', counterparty: 'Brightline Co', number: 'INV-1042', total: usd(8_000), open: usd(8_000), dueDate: d(-34), source: 'Stripe' },
              { id: 'i2', counterparty: 'Hale & Sons', number: '#77', total: usd(4_400), open: usd(4_400), dueDate: d(-12), source: 'paper, added by Claude' },
              { id: 'i3', counterparty: 'Okafor Studio', number: 'INV-1047', total: usd(2_400), open: usd(2_400), dueDate: d(3), source: 'Stripe' },
              { id: 'i4', counterparty: 'Northwind', number: 'INV-1049', total: usd(30_000), open: usd(24_100), dueDate: d(21), source: 'QuickBooks · partly paid' },
            ],
          },
          bills: {
            dueSoon: usd(14_120),
            rows: [
              { id: 'bl1', name: 'Payroll', amount: usd(9_800), dueDate: d(6), detail: 'Gusto · detected from Chase' },
              { id: 'bl2', name: 'Office rent', amount: usd(2_980), dueDate: d(23), detail: 'Rent bucket · monthly' },
              { id: 'bl3', name: 'Cole LLP', amount: usd(1_340), dueDate: d(14), detail: 'PDF bill · emailed in' },
            ],
          },
          buckets: [
            { id: 'b_rent', name: 'Rent', line: '$2,980 monthly · next ' + new Date(now + 23 * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), status: 'upcoming' },
            { id: 'b_loan', name: 'Loan from Dana', line: '$15,000 at 5% · $412 monthly · 31 left', status: 'ok' },
            { id: 'b_contractors', name: 'Contractors', line: '4 people · $6,100 last month', status: 'ok' },
          ],
          payroll: {
            nextRun: { date: d(6), amount: usd(9_800), provider: 'Gusto' },
            lastMonth: { month: lastMonth(), amount: usd(9_640) },
            headcount: { employees: 4, contractors: 2 },
            runs: [
              { id: 'pr1', date: d(-8), gross: usd(12_100), net: usd(9_640), provider: 'Gusto' },
              { id: 'pr2', date: d(-22), gross: usd(12_100), net: usd(9_640), provider: 'Gusto' },
              { id: 'pr3', date: d(-38), gross: usd(11_900), net: usd(9_520), provider: 'Gusto' },
            ],
          },
          equity: {
            fullyDilutedShares: 10_000_000,
            holders: [
              { name: 'Dana Reyes', role: 'Founder', percent: 62.0 },
              { name: 'Option pool', role: '1,500,000 · 410,000 granted', percent: 15.0 },
              { name: 'Seed investors', role: '3 holders', percent: 23.0 },
            ],
            convertibles: [
              { id: 'sf1', investor: 'Kite Ventures', kind: 'SAFE', amount: usd(250_000), cap: usd(8_000_000), date: d(-200) },
              { id: 'sf2', investor: 'R. Cohen', kind: 'SAFE', amount: usd(50_000), cap: usd(6_000_000), discountPct: 20, date: d(-260) },
            ],
          },
          whoseMoney: [
            { id: 'w1', label: 'Acme owes you', amount: usd(612), detail: '6 expenses you paid personally' },
            { id: 'w2', label: 'Bluebird Studio owes Acme', amount: usd(3_000), detail: 'Acme paid Bluebird Studio’s AWS bill · Sep 18' },
          ],
          odd: [
            { id: 'o1', label: 'Figma charged twice', detail: '$75 on Oct 2 and Oct 3 · Amex ··1009', tone: 'amber', recordIds: ['t_fig1', 't_fig2'] },
            { id: 'o2', label: '$20,000 deposit with no source', detail: 'Chase ··4021 · loan or investment?', tone: 'grey' },
          ],
          hasTransactions: true,
        },
        e_nex: {
          entity: entities[1]!,
          asOf: t(5 / 60),
          cash: cashExplained(
            [
              { id: 'nx1', name: 'Operating', institution: 'Chase', mask: '9933', kind: 'bank', balance: usd(81_320), asOf: t(2), stale: false },
              { id: 'nx2', name: 'Balance', institution: 'Stripe', kind: 'payments', balance: usd(14_880), asOf: t(5 / 60), stale: false },
            ],
            'Bluebird Studio',
          ),
          runway: runway(9, 10_700, 'Bluebird Studio'),
          trend: [140, 135, 131, 128, 122, 118, 112, 109, 104, 101, 98, 96],
          accounts: [
            { id: 'nx1', name: 'Operating', institution: 'Chase', mask: '9933', kind: 'bank', balance: usd(81_320), asOf: t(2), stale: false },
            { id: 'nx2', name: 'Balance', institution: 'Stripe', kind: 'payments', balance: usd(14_880), asOf: t(5 / 60), stale: false },
          ],
          owedToYou: null,
          bills: { dueSoon: usd(1_340), rows: [{ id: 'nb1', name: 'AWS', amount: usd(1_340), dueDate: d(9), detail: 'monthly · detected from Amex' }] },
          buckets: [],
          payroll: null,
          equity: null,
          whoseMoney: [{ id: 'nw1', label: 'Bluebird Studio owes Acme', amount: usd(3_000), detail: 'Acme paid Bluebird Studio’s AWS bill · Sep 18' }],
          odd: [],
          hasTransactions: true,
        },
        e_cla: {
          entity: entities[2]!,
          asOf: t(30),
          cash: cashExplained([{ id: 'cl1', name: 'Checking', institution: 'Mercury', mask: '5512', kind: 'bank', balance: usd(32_270), asOf: t(30), stale: true }], 'Harbor Coffee'),
          runway: runway(4, 8_100, 'Harbor Coffee'),
          trend: [61, 58, 55, 52, 50, 47, 45, 42, 40, 37, 35, 32],
          accounts: [{ id: 'cl1', name: 'Checking', institution: 'Mercury', mask: '5512', kind: 'bank', balance: usd(32_270), asOf: t(30), stale: true }],
          owedToYou: null,
          bills: null,
          buckets: [],
          payroll: null,
          equity: null,
          whoseMoney: [],
          odd: [{ id: 'co1', label: 'Mercury needs you to sign in again', detail: 'Numbers are from yesterday', tone: 'red' }],
          hasTransactions: true,
        },
        e_personal: {
          entity: entities[3]!,
          asOf: t(2),
          cash: cashExplained([{ id: 'ps1', name: 'Personal Checking', institution: 'Chase', mask: '1188', kind: 'bank', balance: usd(18_904), asOf: t(2), stale: false }], 'Personal'),
          runway: null,
          trend: [],
          accounts: [{ id: 'ps1', name: 'Personal Checking', institution: 'Chase', mask: '1188', kind: 'bank', balance: usd(18_904), asOf: t(2), stale: false }],
          owedToYou: null,
          bills: null,
          buckets: [],
          payroll: null,
          equity: null,
          whoseMoney: [{ id: 'pw1', label: 'Acme owes you', amount: usd(612), detail: '6 expenses you paid personally' }],
          odd: [],
          hasTransactions: true,
          holdings: [
            { id: 'ph1', name: 'VTI', detail: 'Vanguard Total Stock Market ETF', quantity: '42.5', value: usd(12_316.5), account: 'Fidelity ··7730' },
            { id: 'ph2', name: 'AAPL', detail: 'Apple Inc.', quantity: '30', value: usd(6_840), account: 'Fidelity ··7730' },
            { id: 'ph3', name: 'Cash', detail: '', quantity: '1250', value: usd(1_250), account: 'Fidelity ··7730' },
          ],
          holdingsTotal: [usd(20_406.5)],
        },
      }

  const transactions: Record<string, TxnRow[]> = {
    e_acme: [
      { id: 'tx1', date: d(0), description: 'Cash from Lee’s Deli', amount: usd(1_200), account: 'Cash on hand', detail: 'added by Claude', addedBy: 'Claude' },
      { id: 'tx2', date: d(0), description: 'Stripe payout', amount: usd(6_120), account: 'Chase ··4021', detail: 'linked to 14 Stripe charges' },
      { id: 'tx3', date: d(-1), description: 'Figma', amount: usd(-75), account: 'Amex ··1009', detail: 'Software' },
      { id: 'tx4', date: d(-1), description: 'Transfer to Savings', amount: usd(-20_000), account: 'Chase ··4021', detail: 'between your accounts · not spend', kind: 'transfer' },
      { id: 'tx5', date: d(-2), description: 'WeWork', amount: usd(-2_980), account: 'Chase ··4021', detail: 'Rent bucket' },
      { id: 'tx6', date: d(-3), description: 'Gusto net pay', amount: usd(-9_640), account: 'Chase ··4021', detail: 'Payroll' },
      { id: 'tx7', date: d(-4), description: 'Brightline Co', amount: usd(4_000), account: 'Chase ··4021', detail: 'partial payment · INV-1038' },
      { id: 'tx8', date: d(-6), description: 'AWS', amount: usd(-412.37), account: 'Amex ··1009', detail: 'Software' },
    ],
    e_nex: [
      { id: 'nt1', date: d(0), description: 'Stripe charges', amount: usd(2_310), account: 'Stripe', detail: '9 charges' },
      { id: 'nt2', date: d(-2), description: 'AWS', amount: usd(-1_340.22), account: 'Amex ··1009', detail: 'paid by Acme · Bluebird Studio owes Acme' },
    ],
    e_cla: [{ id: 'ct1', date: d(-1), description: 'Vercel', amount: usd(-20), account: 'Mercury ··5512', detail: 'Software' }],
    e_personal: [{ id: 'pt1', date: d(-1), description: 'Uber (for Acme)', amount: usd(-38.4), account: 'Chase ··1188', detail: 'Acme owes you' }],
  }

  const buckets: Record<string, BucketDetail> = {
    b_rent: {
      id: 'b_rent',
      entityId: 'e_acme',
      name: 'Rent',
      fields: [
        { key: 'landlord', label: 'Landlord', type: 'text', value: 'WeWork' },
        { key: 'deposit', label: 'Deposit', type: 'money', value: '$5,960' },
        { key: 'lease_end', label: 'Lease ends', type: 'date', value: d(420) },
      ],
      schedule: { amount: usd(2_980), cadence: 'monthly', dueDay: 1, endDate: d(420) },
      rules: [{ id: 'ru1', text: 'Bank payments to WEWORK → here' }],
      payments: [
        { id: 'bp0', date: d(23), amount: usd(2_980), status: 'upcoming', detail: 'expected' },
        { id: 'bp1', date: d(-2), amount: usd(2_980), status: 'paid', detail: 'Chase ··4021' },
        { id: 'bp2', date: d(-32), amount: usd(2_980), status: 'paid', detail: 'Chase ··4021' },
        { id: 'bp3', date: d(-62), amount: usd(2_980), status: 'missed', detail: 'no matching payment found' },
      ],
      createdBy: { name: 'Claude', isAi: true, at: t(26) },
      undoUntil: new Date(now + 29 * DAY).toISOString(),
    },
    b_loan: {
      id: 'b_loan',
      entityId: 'e_acme',
      name: 'Loan from Dana',
      fields: [
        { key: 'principal', label: 'Borrowed', type: 'money', value: '$15,000' },
        { key: 'rate', label: 'Interest', type: 'number', value: '5%' },
      ],
      schedule: { amount: usd(412), cadence: 'monthly', dueDay: 15, endDate: d(940) },
      rules: [{ id: 'ru2', text: 'Transfers to D. RUIZ → here' }],
      payments: [{ id: 'lp1', date: d(-24), amount: usd(412), status: 'paid', detail: 'Chase ··4021' }],
      createdBy: { name: 'you', isAi: false, at: t(24 * 40) },
      undoUntil: null,
    },
    b_contractors: {
      id: 'b_contractors',
      entityId: 'e_acme',
      name: 'Contractors',
      fields: [{ key: 'people', label: 'People', type: 'number', value: '4' }],
      schedule: null,
      rules: [{ id: 'ru3', text: 'Deel payouts → here' }],
      payments: [{ id: 'cp1', date: d(-9), amount: usd(6_100), status: 'paid', detail: 'Deel' }],
      createdBy: { name: 'Claude', isAi: true, at: t(24 * 12) },
      undoUntil: new Date(now + 18 * DAY).toISOString(),
    },
  }

  const review: ReviewItem[] = opts.empty
    ? []
    : [
        { id: 'rv1', kind: 'match', title: 'Same money?', detail: 'Cash from Lee’s Deli $1,200 (added by Claude) and a $1,200 deposit at Chase ··4021 today', entityName: 'Acme', amount: usd(1_200), createdAt: t(0.05), confirmLabel: 'Link them', rejectLabel: 'Not the same' },
        { id: 'rv2', kind: 'whose_money', title: 'Loan or investment?', detail: '$20,000 deposit from A. Morgan to Chase ··4021', entityName: 'Acme', amount: usd(20_000), createdAt: t(20), answers: [{ label: 'A loan to the company', values: { kind: 'owner_loan' } }, { label: 'An investment', values: { kind: 'owner_investment' } }, { label: 'Between my companies', values: { kind: 'intercompany' } }] },
        { id: 'rv3', kind: 'rule', title: 'Always put Figma under Software?', detail: 'You did this 3 times', entityName: 'Acme', createdAt: t(40), confirmLabel: 'Make it a rule', rejectLabel: 'No' },
        { id: 'rv4', kind: 'document', title: 'Cole LLP October.pdf', detail: 'Emailed in. Your AI hasn’t read it yet.', entityName: 'Acme', createdAt: t(50), confirmLabel: 'Mark read', rejectLabel: 'Delete', editable: [{ key: 'amount', label: 'Amount', value: '' }, { key: 'due', label: 'Due', value: '' }] },
      ]

  const prefs: Preferences = {
    signIn: { passkeys: [{ id: 'pk1', name: 'MacBook Touch ID', addedAt: t(24 * 3) }], apple: true, google: false, email: me.email },
    companies: entities.filter((e) => e.kind === 'company').map((e) => ({ id: e.id, name: e.name, currency: e.currency, fiscalYearStartMonth: 1 })),
    aiReviewMode: false,
    notifications: { mondayEmail: true, blockedAsk: true },
    people: [
      { id: 'p_owner', name: 'Dana Reyes', email: me.email, role: 'owner', entityIds: 'all', grid: gridFor('owner'), pending: false },
      { id: 'p_maria', name: 'Maria (Cole LLP)', email: 'maria@cole.example', role: 'accountant', entityIds: ['e_acme'], grid: gridFor('accountant'), pending: true },
    ],
    recovery: { applicable: me.selfHosted, savedAt: null },
    theme: 'light',
    timeZone: 'America/New_York',
  }

  return { me, entities, connections, ais, aiPaused: false, companies, transactions, buckets, review, prefs, signedIn: opts.signedIn ?? true }
}
