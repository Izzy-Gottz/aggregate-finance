// Accuracy sweep: three identical months (Jul–Sep 2026) for two companies, through the REAL connectors on
// provider-shaped synthetic data, then the real server and ledger. Cash, revenue, burn and runway must be exact.
//
// Harbor (shop): a Chase checking statement (CSV upload), Stripe and Square. Each month:
//   Stripe: a $1,000.00 charge (fee $29.30), a $100.00 refund, then a payout of $870.70 that lands in Chase.
//   Square: a $500.00 sale (fee $13.25), then a payout of $486.75 that lands in Chase.
//   Chase: rent −$2,000.00, the two payout deposits.
//   Revenue 1,000 − 100 + 500 = $1,400.00. Gross burn 2,000 + 29.30 + 13.25 + 100 refund = $2,142.55.
//   Net burn 2,142.55 − 1,500 (gross sales) = $642.55. Cash 50,000 + 3 × (870.70 + 486.75 − 2,000) = $48,072.35.
// Northwind (online): a SimpleFIN checking account and Shopify. Each month:
//   Shopify: a $2,000.00 sale (fee $58.30), then a payout of $1,941.70 that lands in the bank.
//   Bank: payroll −$8,000.00, software −$300.00, interest +$12.00, the Shopify deposit; one pending row (never counted).
//   Revenue $2,000.00. Gross burn 8,000 + 300 + 58.30 = $8,358.30. Net burn 8,358.30 − 2,000 − 12 = $6,346.30.
//   Cash: SimpleFIN's balance, $120,000.00.
// September adds refunds: Square refunds $50.00 of its sale (payout and deposit $436.75), Shopify refunds $100.00
// (payout and deposit $1,841.70). September: Harbor revenue $1,350.00, net burn $692.55, cash $48,022.35;
// Northwind revenue $1,900.00, net burn $6,446.30 (8,458.30 − 2,012: a refund adds to burn; money in counts the sale
// gross). Runway uses the 3-month average net burn.
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync, type ConnectorDeps } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch, type FixtureRoute } from '@agfn/connector-sdk/testing'
import { createStripeConnector } from '@agfn/connector-stripe'
import { createSquareConnector } from '@agfn/connector-square'
import { createShopifyConnector, SHOPIFY_API_VERSION } from '@agfn/connector-shopify'
import { createSimplefinConnector } from '@agfn/connector-simplefin'
import { connectAi, connectProvider, entities, minor, signIn, startServer, type Server, type Session } from './harness.ts'

const MONTHS = ['2026-07', '2026-08', '2026-09'] as const
const NOW = Date.parse('2026-10-10T12:00:00Z')
const secs = (iso: string) => Math.floor(Date.parse(iso) / 1000)
const deps = (routes: FixtureRoute[]): ConnectorDeps => ({ raw: new MemoryRawSink(), fetch: fixtureFetch(routes).fetch, clock: fakeClock(NOW) })

/** Connect with the real connector (its own connect()), then one full sync: the events it would hand the server. */
async function realEvents(connectionId: string, make: (d: ConnectorDeps) => { connect(i: Record<string, unknown>): Promise<{ secret: unknown; config: Record<string, unknown> }> } & Parameters<typeof runSync>[0], routes: FixtureRoute[], input: Record<string, unknown>, key: string): Promise<NormalizedEvent[]> {
  const c = make(deps(routes))
  const { secret, config } = await c.connect(input)
  const conn = { id: connectionId, workspaceId: 'ws', connectorKey: key, secret, config } as ConnectionRef
  return (await runSync(c, conn, null)).events
}

// ---------- Stripe ----------

const stripeList = (data: unknown[]) => ({ json: { object: 'list', data, has_more: false } })
function stripeRoutes(): FixtureRoute[] {
  const txns: Record<string, unknown[]> = {}
  const all: unknown[] = []
  const payouts: unknown[] = []
  for (const m of MONTHS) {
    const charge = { id: `txn_ch_${m}`, object: 'balance_transaction', amount: 100_000, fee: 2_930, net: 97_070, currency: 'usd', created: secs(`${m}-05T15:00:00Z`), available_on: secs(`${m}-07T00:00:00Z`), reporting_category: 'charge', status: 'available', type: 'charge', description: 'Order 1001', source: { id: `ch_${m}`, object: 'charge', billing_details: { name: 'Sample Customer' } } }
    const refund = { id: `txn_re_${m}`, object: 'balance_transaction', amount: -10_000, fee: 0, net: -10_000, currency: 'usd', created: secs(`${m}-12T15:00:00Z`), available_on: secs(`${m}-12T15:00:00Z`), reporting_category: 'refund', status: 'available', type: 'refund', source: { id: `re_${m}`, object: 'refund', charge: `ch_${m}` } }
    const payout = { id: `txn_po_${m}`, object: 'balance_transaction', amount: -87_070, fee: 0, net: -87_070, currency: 'usd', created: secs(`${m}-15T07:00:00Z`), available_on: secs(`${m}-15T07:00:00Z`), reporting_category: 'payout', status: 'available', type: 'payout', source: { id: `po_${m}`, object: 'payout' } }
    all.push(charge, refund, payout)
    txns[`po_${m}`] = [charge, refund]
    payouts.push({ id: `po_${m}`, object: 'payout', amount: 87_070, currency: 'usd', arrival_date: secs(`${m}-17T00:00:00Z`), created: secs(`${m}-15T07:00:00Z`), automatic: true, status: 'paid', balance_transaction: `txn_po_${m}`, statement_descriptor: null, trace_id: { status: 'supported', value: `TRACE-${m}` } })
  }
  return [
    { match: /^\/v1\/account(\?|$)/, respond: { json: { id: 'acct_harbor', object: 'account', business_profile: { name: 'Harbor Supply' }, default_currency: 'usd', country: 'US' } } },
    { match: /^\/v1\/balance(\?|$)/, respond: { json: { object: 'balance', available: [{ amount: 0, currency: 'usd' }], pending: [{ amount: 0, currency: 'usd' }], livemode: false } } },
    // A restricted key that can't write: Stripe answers the empty probes with 403.
    { method: 'POST', match: /^\/v1\/(refunds|payouts)(\?|$)/, respond: { status: 403, json: { error: { type: 'invalid_request_error', code: 'secret_key_required' } } } },
    { match: '/v1/balance_transactions', respond: (u) => stripeList((u.searchParams.get('payout') ? txns[u.searchParams.get('payout')!] : all) ?? []) },
    { match: /^\/v1\/payouts(\?|$)/, respond: stripeList(payouts) },
    { match: /^\/v1\/(invoices|subscriptions|customers|coupons)/, respond: stripeList([]) },
  ]
}

// ---------- Square ----------

function squareRoutes(): FixtureRoute[] {
  const L = 'LHARBOR1'
  const payments: unknown[] = []
  const payouts: unknown[] = []
  const entries: Record<string, unknown[]> = {}
  const refunds: unknown[] = []
  for (const m of MONTHS) {
    payments.push({ id: `pay_${m}`, status: 'COMPLETED', source_type: 'CARD', location_id: L, created_at: `${m}-08T15:00:00Z`, total_money: { amount: 50_000, currency: 'USD' }, processing_fee: [{ type: 'INITIAL', amount_money: { amount: 1_325, currency: 'USD' } }] })
    payouts.push({ id: `po_sq_${m}`, status: 'PAID', location_id: L, created_at: `${m}-10T07:00:00Z`, updated_at: `${m}-11T07:00:00Z`, amount_money: { amount: 48_675, currency: 'USD' }, destination: { type: 'BANK_ACCOUNT', id: 'bact_1' }, type: 'BATCH', arrival_date: `${m}-11` })
    entries[`po_sq_${m}`] = [{ id: `poe_${m}`, payout_id: `po_sq_${m}`, effective_at: `${m}-08T15:00:00Z`, type: 'CHARGE', gross_amount_money: { amount: 50_000, currency: 'USD' }, fee_amount_money: { amount: 1_325, currency: 'USD' }, net_amount_money: { amount: 48_675, currency: 'USD' }, type_charge_details: { payment_id: `pay_${m}` } }]
  }
  // September: $50.00 of the sale refunded on the 9th, before the payout (Square keeps its fee).
  refunds.push({ id: 'pay_2026-09_ref1', status: 'COMPLETED', payment_id: 'pay_2026-09', location_id: L, created_at: '2026-09-09T15:00:00Z', amount_money: { amount: 5_000, currency: 'USD' }, processing_fee: [] })
  entries['po_sq_2026-09']!.push({ id: 'poe_2026-09_r', payout_id: 'po_sq_2026-09', effective_at: '2026-09-09T15:00:00Z', type: 'REFUND', gross_amount_money: { amount: -5_000, currency: 'USD' }, fee_amount_money: { amount: 0, currency: 'USD' }, net_amount_money: { amount: -5_000, currency: 'USD' }, type_refund_details: { payment_id: 'pay_2026-09', refund_id: 'pay_2026-09_ref1' } })
  ;(payouts.at(-1) as { amount_money: { amount: number } }).amount_money.amount = 43_675
  const page = (key: string, rows: unknown[]) => ({ json: { [key]: rows } })
  return [
    { match: '/v2/merchants/me', respond: { json: { merchant: { id: 'MHARBOR', business_name: 'Harbor Supply', country: 'US', currency: 'USD', status: 'ACTIVE', main_location_id: L } } } },
    { match: '/v2/locations', respond: { json: { locations: [{ id: L, name: 'Harbor', merchant_id: 'MHARBOR', currency: 'USD', country: 'US', status: 'ACTIVE' }] } } },
    { match: /^\/v2\/payouts\/[^/]+\/payout-entries/, respond: (u) => page('payout_entries', entries[decodeURIComponent(u.pathname.split('/')[3] ?? '')] ?? []) },
    { match: /^\/v2\/payouts(\?|$)/, respond: page('payouts', payouts) },
    { match: /^\/v2\/payments(\?|$)/, respond: page('payments', payments) },
    { match: /^\/v2\/refunds(\?|$)/, respond: page('refunds', refunds) },
    { match: '/v2/invoices', respond: page('invoices', []) },
  ]
}

// ---------- Shopify ----------

function shopifyRoutes(): FixtureRoute[] {
  const amt = (a: string) => ({ amount: a, currencyCode: 'USD' })
  const txns: unknown[] = []
  const payouts: unknown[] = []
  for (const m of MONTHS) {
    const po = `gid://shopify/ShopifyPaymentsPayout/${m.replace('-', '')}`
    txns.push({ id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${m.replace('-', '')}1`, type: 'CHARGE', test: false, transactionDate: `${m}-20T14:00:00Z`, sourceType: 'CHARGE', sourceId: `50${m.slice(5)}`, sourceOrderTransactionId: `70${m.slice(5)}`, adjustmentReason: null, amount: amt('2000.00'), fee: amt('58.30'), net: amt('1941.70'), associatedPayout: { id: po, status: 'PAID' } })
    const zero = amt('0.00')
    const sep = m === '2026-09'
    // September: a $100.00 refund before the payout.
    if (sep) txns.push({ id: 'gid://shopify/ShopifyPaymentsBalanceTransaction/2026092', type: 'REFUND', test: false, transactionDate: '2026-09-20T18:00:00Z', sourceType: 'REFUND', sourceId: '5009r', sourceOrderTransactionId: '7009r', adjustmentReason: null, amount: amt('-100.00'), fee: amt('0.00'), net: amt('-100.00'), associatedPayout: { id: po, status: 'PAID' } })
    payouts.push({ id: po, legacyResourceId: m.replace('-', ''), issuedAt: `${m}-21T06:00:00Z`, status: 'PAID', transactionType: 'DEPOSIT', net: amt(sep ? '1841.70' : '1941.70'), summary: { adjustmentsFee: zero, adjustmentsGross: zero, advanceFees: zero, advanceGross: zero, chargesFee: amt('58.30'), chargesGross: amt('2000.00'), refundsFee: zero, refundsFeeGross: sep ? amt('-100.00') : zero, reservedFundsFee: zero, reservedFundsGross: zero, retriedPayoutsFee: zero, retriedPayoutsGross: zero } })
  }
  const conn = (rows: unknown[]) => ({ nodes: rows, pageInfo: { hasNextPage: false, endCursor: null } })
  const ok = (data: unknown) => ({ json: { data, extensions: { cost: { requestedQueryCost: 10, actualQueryCost: 10, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1990, restoreRate: 100 } } } } })
  return [
    {
      method: 'POST',
      match: `/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      respond: (_u, body) => {
        const q = (body as { query: string }).query
        if (q.includes('AggregateAccount')) return ok({ shop: { name: 'Northwind Store', myshopifyDomain: 'northwind.myshopify.com', currencyCode: 'USD' }, shopifyPaymentsAccount: { id: 'gid://shopify/ShopifyPaymentsAccount/1', activated: true, defaultCurrency: 'USD', balance: [amt('0.00')] } })
        if (q.includes('AggregateScopes')) return ok({ currentAppInstallation: { accessScopes: [{ handle: 'read_shopify_payments_payouts' }, { handle: 'read_shopify_payments_accounts' }] } })
        if (q.includes('AggregateBalanceTxns')) return ok({ shopifyPaymentsAccount: { balanceTransactions: conn(txns) } })
        if (q.includes('AggregatePayouts')) return ok({ shopifyPaymentsAccount: { payouts: conn(payouts) } })
        return { json: { errors: [{ message: 'unknown query' }] } }
      },
    },
  ]
}

// ---------- SimpleFIN ----------

function simplefinRoutes(): FixtureRoute[] {
  type Row = { id: string; posted: number; amount: string; description: string; transacted_at?: number; pending?: boolean; payee?: string }
  const t = (id: string, day: string, amount: string, description: string, extra: Partial<Row> = {}): Row => ({ id, posted: secs(`${day}T16:00:00Z`), amount, description, ...extra })
  const rows: Row[] = MONTHS.flatMap((m) => [
    t(`sw_${m}`, `${m}-03`, '-300.00', 'SAMPLE SOFTWARE CO'),
    t(`pay_${m}`, `${m}-15`, '-8000.00', 'GUSTO PAYROLL'),
    t(`shop_${m}`, `${m}-22`, m === '2026-09' ? '1841.70' : '1941.70', 'SHOPIFY PAYOUT', { payee: 'Shopify' }),
    t(`int_${m}`, `${m}-28`, '12.00', 'INTEREST PAYMENT'),
  ])
  rows.push({ id: 'pend_1', posted: 0, transacted_at: secs('2026-10-09T16:00:00Z'), amount: '-50.00', description: 'PENDING CARD HOLD', pending: true })
  const account = { id: 'NW-CHK', name: 'Northwind Checking 7788', currency: 'USD', balance: '120000.00', 'available-balance': '119950.00', 'balance-date': secs('2026-10-09T12:00:00Z'), org: { name: 'Sample Bank' } }
  return [
    { method: 'POST', match: '/simplefin/claim/northwind', respond: { text: 'https://user:pass@beta-bridge.simplefin.org/simplefin' } },
    {
      match: '/simplefin/accounts',
      respond: (u) => {
        const s = Number(u.searchParams.get('start-date') ?? 0)
        const e = Number(u.searchParams.get('end-date') ?? Infinity)
        if (u.searchParams.get('balances-only') === '1') return { json: { errlist: [], accounts: [account] } }
        return { json: { errlist: [], accounts: [{ ...account, transactions: rows.filter((r) => (r.posted || (r.transacted_at ?? 0)) >= s && (r.posted || (r.transacted_at ?? 0)) < e) }] } }
      },
    },
  ]
}

// ---------- Chase statement (CSV upload) ----------

function chaseCsv(): string {
  type Row = [string, string, number]
  const rows: Row[] = MONTHS.flatMap((m): Row[] => [
    [`${m}-01`, 'SAMPLE LANDLORD RENT', -2_000_00],
    [`${m}-11`, 'SQUARE INC SQ*PAYOUT', m === '2026-09' ? 436_75 : 486_75],
    [`${m}-17`, 'STRIPE TRANSFER ST-PAYOUT', 870_70],
  ])
  let bal = 50_000_00
  const lines = rows.map(([d, desc, c]) => {
    bal += c
    const [y, mo, day] = d.split('-')
    return `${c < 0 ? 'DEBIT' : 'CREDIT'},${mo}/${day}/${y},"${desc}",${(c / 100).toFixed(2)},${c < 0 ? 'ACH_DEBIT' : 'ACH_CREDIT'},${(bal / 100).toFixed(2)},,`
  })
  // Chase exports newest first.
  return ['Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #', ...lines.reverse()].join('\n') + '\n'
}

async function setup(): Promise<{ srv: Server; s: Session; E: Record<string, string> }> {
  const srv = await startServer({ scripted: ['simplefin', 'square', 'shopify'] })
  const s = await signIn(srv, 'sweep@example.com', 'Harbor')
  expect((await s.post('/api/entities', { name: 'Northwind' })).status).toBe(201)
  const E = await entities(s)

  const feed = async (key: 'stripe' | 'square' | 'shopify' | 'simplefin', entityId: string, name: string, events: (id: string) => Promise<NormalizedEvent[]>) => {
    const p = await connectProvider(srv, s, key, { entityId, name })
    const ev = await events(p.id)
    p.push(() => ev)
    const r = await p.sync()
    expect(r.status, `${key}: ${r.message ?? ''}`).toBe('ok')
    return p
  }
  await feed('stripe', E.Harbor!, 'Stripe', (id) => realEvents(id, (d) => createStripeConnector({}, d), stripeRoutes(), { apiKey: 'rk_test_51HarborRestricted' }, 'stripe'))
  await feed('square', E.Harbor!, 'Square', (id) => realEvents(id, (d) => createSquareConnector({ env: 'sandbox' }, d), squareRoutes(), { accessToken: 'EAAAsandboxHarborToken', env: 'sandbox' }, 'square'))
  await feed('shopify', E.Northwind!, 'Shopify', (id) => realEvents(id, (d) => createShopifyConnector({}, d), shopifyRoutes(), { shop: 'northwind.myshopify.com', accessToken: 'shpat_northwind_readonly_token_1' }, 'shopify'))
  const sf = await feed('simplefin', E.Northwind!, 'SimpleFIN', (id) =>
    realEvents(id, (d) => createSimplefinConnector({}, d), simplefinRoutes(), { apiKey: Buffer.from('https://beta-bridge.simplefin.org/simplefin/claim/northwind').toString('base64') }, 'simplefin'),
  )
  // The SimpleFIN account belongs to Northwind (the person answers "which company?" after connecting).
  const det = await s.get<{ accounts: Array<{ id: string }> }>(`/api/connections/${sf.id}`)
  const accts = det.body.accounts
  expect((await s.post('/api/accounts/assign', { assignments: accts.map((a) => ({ accountId: a.id, entityId: E.Northwind })) })).status).toBe(200)

  // Harbor's bank: a Chase CSV export, uploaded.
  const fd = new FormData()
  fd.set('file', new File([chaseCsv()], 'Chase.csv'))
  fd.set('entityId', E.Harbor!)
  const up = await srv.app.request('/api/documents', { method: 'POST', headers: { origin: 'http://localhost:8787', cookie: s.cookie() }, body: fd })
  expect(((await up.json()) as { state: string }).state).toBe('imported')
  return { srv, s, E }
}

describe('accuracy sweep: two companies, three identical months, real connectors', () => {
  it('cash, revenue, burn and runway are exact; payouts are never revenue twice; nothing is left to ask', async () => {
    const { srv, s } = await setup()
    try {
      const ai = await connectAi(srv, s)
      type Answer = { value: { amount: string } | number | null; state: string }
      const metric = (m: string, company: string, extra: Record<string, unknown> = {}) => ai.call<Answer>('get_metric', { metric: m, company, ...extra })
      const sep = { from: '2026-09-01', to: '2026-09-30' }
      const amount = async (m: string, company: string, extra: Record<string, unknown> = {}) => minor((await metric(m, company, extra)).value as { amount: string })

      // Harbor
      const aug = { from: '2026-08-01', to: '2026-08-31' }
      expect(await amount('cash', 'Harbor')).toBe(48_022_35)
      expect(await amount('revenue', 'Harbor', aug)).toBe(1_400_00)
      expect(await amount('net_burn', 'Harbor', aug)).toBe(642_55)
      expect(await amount('revenue', 'Harbor', sep)).toBe(1_350_00) // the Square refund is contra-revenue
      expect(await amount('gross_burn', 'Harbor', sep)).toBe(2_192_55)
      expect(await amount('net_burn', 'Harbor', sep)).toBe(692_55)
      expect((await metric('runway', 'Harbor')).value).toBe(72.8) // 48,022.35 ÷ (642.55 + 642.55 + 692.55) / 3

      // Northwind
      expect(await amount('cash', 'Northwind')).toBe(120_000_00)
      expect(await amount('revenue', 'Northwind', aug)).toBe(2_000_00)
      expect(await amount('gross_burn', 'Northwind', aug)).toBe(8_358_30)
      expect(await amount('net_burn', 'Northwind', aug)).toBe(6_346_30)
      expect(await amount('revenue', 'Northwind', sep)).toBe(1_900_00)
      expect(await amount('net_burn', 'Northwind', sep)).toBe(6_446_30)
      expect((await metric('runway', 'Northwind')).value).toBe(18.8) // 120,000 ÷ (6,346.30 × 2 + 6,446.30) / 3

      // Both together: the sums, to the cent.
      const both = 'all'
      expect(await amount('cash', both)).toBe(168_022_35)
      expect(await amount('revenue', both, sep)).toBe(3_250_00)
      expect(await amount('net_burn', both, sep)).toBe(7_138_85)

      // Every payout matched its bank deposit, and nothing else needs a person.
      const review = (await s.get<Array<{ kind: string; detail?: string }>>('/api/review')).body
      expect(review.map((r) => `${r.kind}: ${r.detail ?? ''}`)).toEqual([])
    } finally {
      await srv.close()
    }
  })
})
