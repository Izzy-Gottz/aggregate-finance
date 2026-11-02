import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type {
  AccountUpsert,
  BalanceSnapshot,
  ConnectionRef,
  InvoiceUpsert,
  NormalizedEvent,
  ProcessorBalanceTxn,
  SubscriptionUpsert,
} from '@agfn/contracts'
import { MemoryRawSink, dedupeEvents, runSync } from '@agfn/connector-sdk'
import { balanceRole, counterpartyOf, mapBalanceTxn } from './map.ts'
import { assertRedacted, assertValidEvents, fakeClock, fixtureFetch, runConnectorContract, type FixtureRoute } from '@agfn/connector-sdk/testing'
import {
  STRIPE_FULL_ACCESS_HOSTED_WARNING,
  STRIPE_FULL_ACCESS_WARNING,
  STRIPE_KEY_CAN_WRITE_WARNING,
  STRIPE_SECRET_KEY_REFUSED,
  STRIPE_API_VERSION,
  STRIPE_COUPONS_WARNING,
  STRIPE_TIERS_WARNING,
  createStripeConnector,
  interpretStripeEvent,
  roundHalfAway,
  signStripePayload,
  subscriptionHistory,
  subscriptionMrr,
  txnKind,
  type StripeConnectorOptions,
} from './index.ts'
import type { StripeBalanceTransaction, StripeCoupon, StripeDiscount, StripeInvoice, StripePrice, StripeSubscription } from './types.ts'

const fx = JSON.parse(readFileSync(new URL('../fixtures/redacted/account.json', import.meta.url), 'utf8')) as {
  account: unknown
  balance: unknown
  txn_pages: Record<string, unknown>
  payouts: unknown
  payout_txns: Record<string, unknown>
  invoices: unknown
  invoice_lines: Record<string, unknown>
  open_invoices: unknown
  invoice_partial_paid_later: unknown
  subscriptions: unknown
  coupons: Record<string, unknown>
}

const KEY = 'rk_test_51ExampleRestrictedKey'
const WHSEC = 'whsec_test_example'
const OPTS: StripeConnectorOptions = { webhookSecret: WHSEC }
const conn: ConnectionRef = {
  id: 'conn_stripe',
  workspaceId: 'ws1',
  connectorKey: 'stripe',
  secret: { apiKey: KEY },
  config: { accountId: 'acct_test_1', displayName: 'Example Co', livemode: false, keyType: 'restricted', warnings: [] },
}

const notFound = { status: 404, json: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such object' } } }
const path = (p: string) => (u: URL) => u.pathname === p

function routes(extra: FixtureRoute[] = []): FixtureRoute[] {
  return [
    ...extra,
    { match: path('/v1/account'), respond: { json: fx.account } },
    { match: path('/v1/balance'), respond: { json: fx.balance } },
    {
      match: path('/v1/balance_transactions'),
      respond: (u) => {
        const payout = u.searchParams.get('payout')
        const page = payout ? fx.payout_txns[payout] : fx.txn_pages[u.searchParams.get('starting_after') ?? '']
        return page ? { json: page } : notFound
      },
    },
    { match: path('/v1/payouts'), respond: { json: fx.payouts } },
    {
      match: (u) => u.pathname === '/v1/invoices' && u.searchParams.get('status') === 'open',
      respond: { json: fx.open_invoices },
    },
    { match: path('/v1/invoices'), respond: { json: fx.invoices } },
    {
      match: (u) => /^\/v1\/invoices\/[^/]+\/lines$/.test(u.pathname),
      respond: (u) => {
        const id = u.pathname.split('/')[3] ?? ''
        const p = fx.invoice_lines[id]
        return p && u.searchParams.get('starting_after') ? { json: p } : notFound
      },
    },
    { match: path('/v1/subscriptions'), respond: { json: fx.subscriptions } },
    {
      match: (u) => u.pathname.startsWith('/v1/customers/'),
      respond: (u) => {
        const c = ({ cus_test_1: { id: 'cus_test_1', name: 'Lumen Health', email: 'billing@lumen.example' }, cus_test_2: { id: 'cus_test_2', name: null, email: 'ap@ferris.example' } } as Record<string, unknown>)[u.pathname.split('/')[3] ?? '']
        return c ? { json: c } : notFound
      },
    },
    {
      match: (u) => u.pathname.startsWith('/v1/coupons/'),
      respond: (u) => {
        const c = fx.coupons[u.pathname.split('/')[3] ?? '']
        return c ? { json: c } : notFound
      },
    },
  ]
}

function make(extra: FixtureRoute[] = [], opts: StripeConnectorOptions = OPTS) {
  const f = fixtureFetch(routes(extra))
  const raw = new MemoryRawSink()
  const clock = fakeClock()
  const saved: unknown[] = []
  const connector = createStripeConnector(opts, { raw, fetch: f.fetch, clock, saveSecret: async (_id, sec) => void saved.push(sec) })
  return { connector, conn, calls: f.calls, raw, clock, saved }
}

const byId = <T extends NormalizedEvent>(events: NormalizedEvent[], type: T['type'], id: string) =>
  dedupeEvents(events).find((e) => e.type === type && e.externalId === id) as T | undefined

describe('stripe contract', () => {
  it('passes the connector contract on the fixture account', async () => {
    const report = await runConnectorContract({
      make: () => make(),
      signs: {
        txn_test_charge1: '+',
        txn_test_refund1: '-',
        txn_test_dispute1: '-',
        po_test_1: '-',
        txn_test_eur1: '+',
        txn_test_fee1: '-',
      },
      minEvents: 15,
    })
    // balance, 2 txn pages, payouts, 1 payout's txns, invoices, open re-scan, subscriptions.
    expect(report.pages).toBe(8)
  })

  it('fixture is redacted', () => {
    assertRedacted(fx)
  })

  it('sends the pinned version and bearer auth, and only GETs', async () => {
    const { connector, calls } = make()
    await runSync(connector, conn, null)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) {
      expect(c.method).toBe('GET')
      expect(c.headers['stripe-version']).toBe(STRIPE_API_VERSION)
      expect(c.headers.authorization).toBe(`Bearer ${KEY}`)
      expect(c.headers['stripe-account']).toBeUndefined()
    }
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.[a-z]+$/)
  })
})

describe('stripe mapping', () => {
  it('maps balances: one processor account per currency, current = available + pending + reserved', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    expect(byId<AccountUpsert>(events, 'account.upsert', 'acct_test_1:USD')).toMatchObject({
      accountType: 'processor_balance',
      currency: 'USD',
      name: 'Example Co Stripe balance (USD)',
      institution: 'Stripe',
    })
    expect(byId<AccountUpsert>(events, 'account.upsert', 'acct_test_1:EUR')?.currency).toBe('EUR')
    expect(byId<BalanceSnapshot>(events, 'balance.snapshot', 'acct_test_1:USD@2026-10-09')).toMatchObject({
      accountExternalId: 'acct_test_1:USD',
      at: '2026-10-09T12:00:00.000Z',
      current: { minor: 176000, currency: 'USD' },
      available: { minor: 150000, currency: 'USD' },
    })
    expect(byId<BalanceSnapshot>(events, 'balance.snapshot', 'acct_test_1:EUR@2026-10-09')).toMatchObject({
      current: { minor: 3850, currency: 'EUR' },
      available: { minor: 3850, currency: 'EUR' },
    })
  })

  it('maps balance transactions with exact gross/fee/net, kinds and payout attribution', async () => {
    const { connector } = make()
    const { events } = await runSync(connector, conn, null)
    const t = (id: string) => byId<ProcessorBalanceTxn>(events, 'processor.balance_txn', id)
    expect(t('txn_test_charge1')).toMatchObject({
      accountExternalId: 'acct_test_1:USD',
      at: '2026-10-01T10:00:00.000Z',
      kind: 'charge',
      gross: { minor: 10000, currency: 'USD' },
      fee: { minor: 320, currency: 'USD' },
      net: { minor: 9680, currency: 'USD' },
      payoutExternalId: 'po_test_1',
      sourceExternalId: 'ch_test_1',
      customer: 'cus_test_1',
      // Named by the customer, not its cus_ id (which stays the external ref).
      counterparty: 'Lumen Health',
    })
    expect(t('txn_test_eur1')?.counterparty).toBe('ap@ferris.example')
    // Refund: returned fee is a negative fee.
    expect(t('txn_test_refund1')).toMatchObject({
      kind: 'refund',
      gross: { minor: -5000 },
      fee: { minor: -150 },
      net: { minor: -4850 },
      payoutExternalId: 'po_test_1',
      sourceExternalId: 're_test_1',
    })
    // Dispute is booked by Stripe as an adjustment with reporting_category 'dispute'.
    expect(t('txn_test_dispute1')).toMatchObject({ kind: 'dispute', gross: { minor: -2500 }, fee: { minor: 1500 }, net: { minor: -4000 } })
    expect(t('txn_test_dispute1')?.payoutExternalId).toBeUndefined()
    // The payout row is keyed by the payout id.
    expect(t('po_test_1')).toMatchObject({ kind: 'payout', gross: { minor: -4830 }, fee: { minor: 0 }, net: { minor: -4830 }, payoutExternalId: 'po_test_1', sourceExternalId: 'po_test_1', linkRefs: { trace_id: 'TRACE0001' }, arrivalDate: '2026-10-06' })
    expect(t('txn_test_payout1')).toBeUndefined()
    expect(t('txn_test_eur1')).toMatchObject({ accountExternalId: 'acct_test_1:EUR', gross: { minor: 4000, currency: 'EUR' }, fee: { minor: 150 }, net: { minor: 3850 }, customer: 'cus_test_2' })
    expect(t('txn_test_fee1')).toMatchObject({ kind: 'fee', gross: { minor: -500 }, net: { minor: -500 } })
    expect(t('txn_test_fee1')?.sourceExternalId).toBeUndefined()
    // The settled rows add up to the payout.
    const settled = ['txn_test_charge1', 'txn_test_refund1'].reduce((s, id) => s + (t(id)?.net.minor ?? 0), 0)
    expect(settled + (t('po_test_1')?.net.minor ?? 0)).toBe(0)
  })

  it('maps type → kind', () => {
    expect(txnKind('payment')).toBe('charge')
    expect(txnKind('payment_refund')).toBe('refund')
    expect(txnKind('adjustment', 'dispute_reversal')).toBe('dispute')
    expect(txnKind('adjustment', 'other_adjustment')).toBe('adjustment')
    expect(txnKind('payout_failure')).toBe('payout')
    expect(txnKind('application_fee')).toBe('fee')
    expect(txnKind('stripe_fx_fee')).toBe('fee')
    expect(txnKind('transfer_refund')).toBe('transfer')
    expect(txnKind('reserve_hold')).toBe('other')
    expect(['reserved_funds', 'advance_funding', 'anticipation_repayment', 'topup', 'charge'].map(balanceRole)).toEqual(['other_assets', 'other_assets', 'other_liabilities', 'clearing_payouts', undefined])
  })

  it('maps invoices: partially paid, tax, every line (follows the lines endpoint), no email', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    expect(byId<InvoiceUpsert>(events, 'invoice.upsert', 'in_test_partial')).toEqual({
      type: 'invoice.upsert',
      externalId: 'in_test_partial',
      connectionId: 'conn_stripe',
      rawRef: expect.stringMatching(/^raw_/),
      direction: 'receivable',
      number: 'EX-0002',
      counterparty: 'Example Customer Two',
      issueDate: '2026-10-03',
      dueDate: '2026-11-01',
      total: { minor: 33000, currency: 'USD' },
      amountPaid: { minor: 10000, currency: 'USD' },
      status: 'partially_paid',
      subtotal: { minor: 30000, currency: 'USD' },
      tax: { minor: 3000, currency: 'USD' },
      lines: [
        { description: 'Seats', amount: { minor: 20000, currency: 'USD' }, quantity: 2 },
        { description: 'Setup', amount: { minor: 10000, currency: 'USD' }, quantity: 1 },
      ],
    })
    const paid = byId<InvoiceUpsert>(events, 'invoice.upsert', 'in_test_paid')
    expect(paid).toMatchObject({ status: 'paid', total: { minor: 10000 }, amountPaid: { minor: 10000 }, tax: { minor: 0 }, issueDate: '2026-09-15' })
    expect(paid?.dueDate).toBeUndefined()
    expect(JSON.stringify(events)).not.toContain('@example.com')
    const lineCall = calls.find((c) => c.url.includes('/v1/invoices/in_test_partial/lines'))
    expect(new URL(lineCall?.url ?? 'https://x').searchParams.get('starting_after')).toBe('il_test_p1')
  })

  it('maps subscriptions with Stripe-definition MRR (golden)', async () => {
    const { connector, calls } = make()
    const { events } = await runSync(connector, conn, null)
    const s = (id: string) => byId<SubscriptionUpsert>(events, 'subscription.upsert', id)
    // 4900/month; the metered API item is excluded.
    expect(s('sub_test_monthly')).toMatchObject({
      customer: 'cus_test_1',
      status: 'active',
      mrr: { minor: 4900, currency: 'USD' },
      interval: 'month',
      intervalCount: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      currentPeriodEnd: '2026-11-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      items: [{ priceExternalId: 'price_test_pro', product: 'prod_test_pro', quantity: 1, amount: { minor: 4900, currency: 'USD' } }],
    })
    // 1200.00/year × 2 seats = 2400.00/year = 200.00/month, less 20% coupon = 160.00.
    expect(s('sub_test_yearly')).toMatchObject({
      mrr: { minor: 16000, currency: 'USD' },
      interval: 'year',
      items: [{ priceExternalId: 'price_test_annual', quantity: 2, amount: { minor: 240000, currency: 'USD' } }],
    })
    // Canceled: still upserted (status change), MRR 0.
    expect(s('sub_test_canceled')).toMatchObject({
      status: 'canceled',
      mrr: { minor: 0, currency: 'USD' },
      canceledAt: '2026-08-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:00:00.000Z',
    })
    const subCall = new URL(calls.find((c) => c.url.includes('/v1/subscriptions'))?.url ?? 'https://x')
    expect(subCall.searchParams.get('status')).toBe('all')
    expect(subCall.searchParams.getAll('expand[]')).toEqual(['data.discounts', 'data.items.data.discounts'])
    expect(calls.filter((c) => c.url.includes('/v1/coupons/coup_test_20'))).toHaveLength(1)
  })

  it('incremental cycle: high-water overlap, and an open invoice that got paid is re-read', async () => {
    let second = false
    const { connector, calls } = make([
      {
        // Second cycle: nothing new in the created window and nothing open any more (it was paid).
        match: (u) => second && u.pathname === '/v1/invoices',
        respond: { json: { object: 'list', has_more: false, data: [] } },
      },
      { match: (u) => second && u.pathname === '/v1/invoices/in_test_partial', respond: { json: fx.invoice_partial_paid_later } },
    ])
    const first = await runSync(connector, conn, null)
    expect(first.complete).toBe(true)
    // Backfill: no created filter.
    const firstTxnCall = new URL(calls.find((c) => c.url.includes('/v1/balance_transactions'))?.url ?? 'https://x')
    expect(firstTxnCall.searchParams.get('created[gte]')).toBeNull()
    second = true
    const n = calls.length
    const next = await runSync(connector, conn, first.cursor)
    expect(next.complete).toBe(true)
    const later = calls.slice(n).map((c) => new URL(c.url))
    const txn = later.find((u) => u.pathname === '/v1/balance_transactions' && !u.searchParams.get('payout'))
    // Newest txn 2026-10-06T10:00Z (1791280800) minus 3 days.
    expect(txn?.searchParams.get('created[gte]')).toBe(String(1791280800 - 3 * 86400))
    expect(later.find((u) => u.pathname === '/v1/payouts')?.searchParams.get('arrival_date[gte]')).toBe(String(1791244800 - 3 * 86400))
    expect(later.find((u) => u.pathname === '/v1/invoices' && !u.searchParams.get('status'))?.searchParams.get('created[gte]')).toBe(
      String(1791021600 - 3 * 86400),
    )
    expect(byId<InvoiceUpsert>(next.events, 'invoice.upsert', 'in_test_partial')).toMatchObject({ status: 'paid', amountPaid: { minor: 33000 } })
    assertValidEvents(dedupeEvents(next.events), { connectionId: conn.id })
    // Third cycle: the paid invoice is no longer watched.
    const m = calls.length
    await runSync(connector, conn, next.cursor)
    expect(calls.slice(m).some((c) => new URL(c.url).pathname === '/v1/invoices/in_test_partial')).toBe(false)
  })

  it('reads a connected account through the Stripe-Account header', async () => {
    const { connector, calls } = make()
    await connector.sync({ ...conn, config: { ...conn.config, stripeAccount: 'acct_test_connected' } }, null)
    expect(calls[0]?.headers['stripe-account']).toBe('acct_test_connected')
  })
})

describe('stripe MRR normalization', () => {
  const price = (over: Partial<StripePrice> & { interval?: 'day' | 'week' | 'month' | 'year'; count?: number }): StripePrice => ({
    id: 'price_x',
    object: 'price',
    currency: 'usd',
    unit_amount: 1000,
    billing_scheme: 'per_unit',
    recurring: { interval: over.interval ?? 'month', interval_count: over.count ?? 1, usage_type: 'licensed' },
    ...over,
  })
  const sub = (items: Array<{ price: StripePrice; quantity?: number; discounts?: StripeDiscount[] }>, over: Partial<StripeSubscription> = {}): StripeSubscription => ({
    id: 'sub_x',
    object: 'subscription',
    customer: 'cus_x',
    currency: 'usd',
    status: 'active',
    start_date: 1767225600,
    created: 1767225600,
    items: { object: 'list', has_more: false, data: items.map((i, n) => ({ id: `si_${n}`, object: 'subscription_item', ...i })) },
    ...over,
  })
  const coupon = (c: Partial<StripeCoupon>): StripeCoupon => ({ id: 'c', object: 'coupon', duration: 'forever', ...c })
  const disc = (c: StripeCoupon, end: number | null = null): StripeDiscount => ({ id: 'di', object: 'discount', source: { type: 'coupon', coupon: c }, end })
  const lookup = (d: StripeDiscount) => (typeof d.source?.coupon === 'object' ? (d.source.coupon ?? undefined) : undefined)
  const now = 1791547200
  const mrr = (s: StripeSubscription) => subscriptionMrr(s, lookup, now).mrr.minor

  it('normalizes intervals to monthly, rounding once', () => {
    expect(mrr(sub([{ price: price({ interval: 'week' }) }]))).toBe(4333) // 1000 × 52 / 12 = 4333.33
    expect(mrr(sub([{ price: price({ interval: 'day', unit_amount: 100 }) }]))).toBe(3042) // 100 × 365 / 12 = 3041.67
    expect(mrr(sub([{ price: price({ interval: 'month', count: 3, unit_amount: 1000 }) }]))).toBe(333)
    expect(mrr(sub([{ price: price({ interval: 'year', unit_amount: 1000 }) }, { price: price({ interval: 'year', unit_amount: 1000 }) }]))).toBe(167) // 2000/12 = 166.67, rounded once
    // Sub-cent unit price: 0.5 × 1 → half rounds away from zero.
    expect(mrr(sub([{ price: price({ unit_amount: null, unit_amount_decimal: '0.5' }) }]))).toBe(1)
    expect(roundHalfAway({ n: -5n, d: 2n })).toBe(-3)
  })

  it('applies quantity, percent and amount-off discounts, excludes metered, tiered without its tiers, tax and inactive', () => {
    expect(mrr(sub([{ price: price({ unit_amount: 4900 }), quantity: 3 }]))).toBe(14700)
    expect(mrr(sub([{ price: price({ unit_amount: 4900 }) }], { discounts: [disc(coupon({ amount_off: 500, currency: 'usd' }))] }))).toBe(4400)
    // amount_off on a yearly plan is per invoice: 120.00 off a year = 10.00/month.
    expect(mrr(sub([{ price: price({ interval: 'year', unit_amount: 120000 }) }], { discounts: [disc(coupon({ amount_off: 12000, currency: 'usd' }))] }))).toBe(9000)
    expect(mrr(sub([{ price: price({ unit_amount: 1000 }) }], { discounts: [disc(coupon({ percent_off: 33.5 }))] }))).toBe(665) // 665.0
    // Item-level discount only hits its item.
    expect(mrr(sub([{ price: price({ unit_amount: 1000 }), discounts: [disc(coupon({ percent_off: 50 }))] }, { price: price({ unit_amount: 1000 }) }]))).toBe(1500)
    // Amount off larger than the plan floors at 0; wrong currency is ignored.
    expect(mrr(sub([{ price: price({ unit_amount: 1000 }) }], { discounts: [disc(coupon({ amount_off: 5000, currency: 'usd' }))] }))).toBe(0)
    expect(mrr(sub([{ price: price({ unit_amount: 1000 }) }], { discounts: [disc(coupon({ amount_off: 500, currency: 'eur' }))] }))).toBe(1000)
    // 'once' coupons and ended repeating coupons don't reduce MRR.
    expect(mrr(sub([{ price: price({}) }], { discounts: [disc(coupon({ percent_off: 50, duration: 'once' }))] }))).toBe(1000)
    expect(mrr(sub([{ price: price({}) }], { discounts: [disc(coupon({ percent_off: 50, duration: 'repeating' }), now - 1)] }))).toBe(1000)
    expect(mrr(sub([{ price: price({}) }], { discounts: [disc(coupon({ percent_off: 50, duration: 'repeating' }), now + 86400)] }))).toBe(500)
    expect(mrr(sub([{ price: price({}) }, { price: price({ recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }) }]))).toBe(1000)
    expect(mrr(sub([{ price: price({}) }, { price: price({ billing_scheme: 'tiered', unit_amount: null }) }]))).toBe(1000)
    expect(mrr(sub([{ price: price({}) }], { status: 'past_due' }))).toBe(1000)
    for (const status of ['trialing', 'unpaid', 'paused', 'canceled', 'incomplete', 'incomplete_expired'] as const) {
      expect(mrr(sub([{ price: price({}) }], { status }))).toBe(0)
    }
  })
})

describe('stripe MRR of tiered prices', () => {
  // Stripe's own examples (docs.stripe.com/subscriptions/pricing-models/tiered-pricing).
  const FONTS = [
    { up_to: 5, unit_amount: 700 },
    { up_to: 10, unit_amount: 650 },
    { up_to: null, unit_amount: 600 },
  ]
  const FLAT = [
    { up_to: 5, unit_amount: 500, flat_amount: 1000 },
    { up_to: 10, unit_amount: 400, flat_amount: 2000 },
    { up_to: 15, unit_amount: 300, flat_amount: 3000 },
    { up_to: 20, unit_amount: 200, flat_amount: 4000 },
    { up_to: null, unit_amount: 100, flat_amount: 5000 },
  ]
  const tiered = (mode: 'graduated' | 'volume', tiers: StripePrice['tiers'], over: Partial<StripePrice> = {}): StripePrice => ({
    id: 'price_t',
    object: 'price',
    currency: 'usd',
    unit_amount: null,
    billing_scheme: 'tiered',
    tiers_mode: mode,
    tiers,
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
    ...over,
  })
  const sub = (price: StripePrice, quantity: number, over: Partial<StripeSubscription> = {}): StripeSubscription => ({
    id: 'sub_t',
    object: 'subscription',
    customer: 'cus_t',
    currency: 'usd',
    status: 'active',
    start_date: 1767225600,
    created: 1767225600,
    items: { object: 'list', has_more: false, data: [{ id: 'si_t', object: 'subscription_item', price, quantity }] },
    ...over,
  })
  const none = () => undefined
  const mrr = (price: StripePrice, quantity: number, over: Partial<StripeSubscription> = {}) => subscriptionMrr(sub(price, quantity, over), none, 1791547200).mrr.minor

  it('volume: the whole quantity at the tier it falls in', () => {
    for (const [q, want] of [[1, 700], [5, 3500], [6, 3900], [20, 12000], [25, 15000]] as const) expect(mrr(tiered('volume', FONTS), q)).toBe(want)
  })
  it('graduated: each tier its share', () => {
    for (const [q, want] of [[1, 700], [5, 3500], [6, 4150], [20, 12750], [25, 15750]] as const) expect(mrr(tiered('graduated', FONTS), q)).toBe(want)
  })
  it('flat amounts: the reached tier (volume) or every tier reached (graduated); quantity 0 bills the first flat amount', () => {
    expect(mrr(tiered('volume', FLAT), 12)).toBe(6600) // 12 × 3 + 30
    expect(mrr(tiered('graduated', FLAT), 12)).toBe(11100) // (25 + 10) + (20 + 20) + (6 + 30)
    expect(mrr(tiered('volume', FLAT), 0)).toBe(1000)
    expect(mrr(tiered('graduated', FLAT), 0)).toBe(1000)
    expect(mrr(tiered('graduated', FLAT), 5)).toBe(3500) // exactly at a boundary: the next tier's flat amount isn't reached
  })
  it('tiers in any order, sub-cent decimals, yearly prices, discounts; no tiers read is left out', () => {
    expect(mrr(tiered('graduated', [...FONTS].reverse()), 6)).toBe(4150)
    expect(mrr(tiered('volume', [{ up_to: null, unit_amount_decimal: '0.25' }]), 6)).toBe(2) // 1.5 rounds away from zero
    expect(mrr(tiered('volume', FONTS, { recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } }), 20)).toBe(1000) // 12000 / 12
    const half: StripeDiscount = { id: 'di', object: 'discount', source: { type: 'coupon', coupon: { id: 'c', object: 'coupon', duration: 'forever', percent_off: 50 } }, end: null }
    const c = (d: StripeDiscount) => (typeof d.source?.coupon === 'object' ? (d.source.coupon ?? undefined) : undefined)
    expect(subscriptionMrr(sub(tiered('graduated', FONTS), 6, { discounts: [half] }), c, 1791547200).mrr.minor).toBe(2075)
    expect(mrr(tiered('graduated', null), 6)).toBe(0)
    expect(mrr(tiered('graduated', FONTS, { recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } }), 6)).toBe(0)
    const r = subscriptionMrr(sub(tiered('graduated', FONTS), 6), none, 1791547200).items[0]!
    expect(r).toMatchObject({ counted: true, amount: { minor: 4150, currency: 'USD' } })
  })
  it('per-unit prices with transform_quantity bill the divided quantity', () => {
    const per = (round: 'up' | 'down'): StripePrice => ({ id: 'price_p', object: 'price', currency: 'usd', unit_amount: 1000, billing_scheme: 'per_unit', transform_quantity: { divide_by: 10, round }, recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } })
    expect(mrr(per('up'), 11)).toBe(2000)
    expect(mrr(per('down'), 11)).toBe(1000)
  })
})

describe('stripe tiered prices in sync', () => {
  const tieredSub = {
    id: 'sub_tiered',
    object: 'subscription',
    customer: 'cus_test_1',
    currency: 'usd',
    status: 'active',
    start_date: 1767225600,
    created: 1767225600,
    items: { object: 'list', has_more: false, data: [{ id: 'si_tiered', object: 'subscription_item', quantity: 6, price: { id: 'price_tiered', object: 'price', currency: 'usd', unit_amount: null, billing_scheme: 'tiered', tiers_mode: 'graduated', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }] },
  }
  const subsRoute: FixtureRoute = { match: path('/v1/subscriptions'), respond: { json: { object: 'list', has_more: false, data: [tieredSub] } } }
  const withTiers = { ...tieredSub.items.data[0]!, price: { ...tieredSub.items.data[0]!.price, tiers: [{ up_to: 5, unit_amount: 700 }, { up_to: null, unit_amount: 650 }] } }
  const drain = async (extra: FixtureRoute[]) => {
    const { connector, calls } = make(extra)
    const events: NormalizedEvent[] = []
    const warnings: string[] = []
    let cursor: string | null = null
    for (;;) {
      const r = await connector.sync(conn, cursor)
      events.push(...r.events)
      warnings.push(...(r.warnings ?? []))
      cursor = r.cursor
      if (!r.hasMore) break
    }
    return { events, warnings, calls }
  }

  it('reads the items again with their tiers and values them', async () => {
    const items: FixtureRoute = {
      match: (u) => u.pathname === '/v1/subscription_items' && u.searchParams.get('subscription') === 'sub_tiered' && u.searchParams.getAll('expand[]').includes('data.price.tiers'),
      respond: { json: { object: 'list', has_more: false, data: [withTiers] } },
    }
    const { events, warnings } = await drain([subsRoute, items])
    expect(warnings).toEqual([])
    const s = byId<SubscriptionUpsert>(events, 'subscription.upsert', 'sub_tiered')
    expect(s?.mrr.minor).toBe(4150) // 5 × 7.00 + 1 × 6.50
    expect(s?.items).toEqual([{ priceExternalId: 'price_tiered', quantity: 6, amount: { minor: 4150, currency: 'USD' } }])
  })

  it('a key that cannot read the tiers leaves those items out, says so, and the rest still syncs', async () => {
    const deny = { status: 403, json: { error: { type: 'invalid_request_error', message: "The provided key 'rk_test_****' does not have the required permissions for this endpoint on account 'acct_test_1'. Having the 'rak_plan_read' permission would allow this request to continue." } } }
    const { events, warnings } = await drain([subsRoute, { match: path('/v1/subscription_items'), respond: deny }])
    expect(warnings).toEqual([STRIPE_TIERS_WARNING])
    const s = byId<SubscriptionUpsert>(events, 'subscription.upsert', 'sub_tiered')
    expect(s?.mrr.minor).toBe(0)
    expect(s?.items).toEqual([])
  })
})

describe('stripe MRR history from invoices', () => {
  const sub: StripeSubscription = {
    id: 'sub_h', object: 'subscription', customer: 'cus_h', currency: 'usd', status: 'active', start_date: 1767225600, created: 1767225600,
    items: { object: 'list', has_more: false, data: [{ id: 'si_seat', object: 'subscription_item', quantity: 1, price: { id: 'p', object: 'price', currency: 'usd', unit_amount: 5000, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } } }] },
  }
  const line = (amount: number, start: number, extra: { proration?: boolean; item?: string; off?: number; sub?: string } = {}) => ({
    id: `il_${start}_${amount}`, amount, currency: 'usd', period: { start, end: start + 2_592_000 },
    discount_amounts: extra.off ? [{ amount: extra.off }] : [],
    parent: { type: 'subscription_item_details', subscription_item_details: { subscription: extra.sub ?? 'sub_h', subscription_item: extra.item ?? 'si_seat', proration: extra.proration ?? false } },
  })
  const inv = (id: string, status: StripeInvoice['status'], lines: ReturnType<typeof line>[]): StripeInvoice =>
    ({ id, object: 'invoice', currency: 'usd', status, created: lines[0]?.period.start ?? 0, total: 0, subtotal: 0, amount_due: 0, amount_paid: 0, lines: { object: 'list', has_more: false, data: lines } }) as StripeInvoice
  const JAN = 1767225600, FEB = 1769904000, MAR = 1772323200, APR = 1775001600

  it('dates each change in the period it was billed, starting at the subscription start', () => {
    const h = subscriptionHistory(sub, [
      inv('in_4', 'paid', [line(9000, APR), line(-2000, APR, { proration: true })]),
      inv('in_1', 'paid', [line(3000, JAN + 3600)]),
      inv('in_2', 'paid', [line(3000, FEB)]),
      inv('in_3', 'open', [line(5000, MAR), line(4000, MAR, { item: 'si_old' })]),
      inv('in_void', 'void', [line(99_999, MAR)]),
    ], new Set(), APR + 86_400)
    expect(h).toEqual([
      { at: JAN, mrr: { minor: 3000, currency: 'USD' } },
      { at: MAR, mrr: { minor: 9000, currency: 'USD' } },
    ])
  })

  it('nets discounts, makes yearly monthly, leaves metered items and the future out', () => {
    const yearly: StripeSubscription = { ...sub, items: { ...sub.items, data: [{ ...sub.items.data[0]!, price: { ...sub.items.data[0]!.price, recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' } } }] } }
    const h = subscriptionHistory(yearly, [
      inv('in_1', 'paid', [line(120_000, JAN, { off: 12_000 }), line(777, JAN, { item: 'si_metered' })]),
      inv('in_2', 'paid', [line(240_000, APR)]),
    ], new Set(['si_metered']), MAR)
    expect(h).toEqual([{ at: JAN, mrr: { minor: 9000, currency: 'USD' } }])
  })
})

describe('stripe subscription history in sync', () => {
  const Y1 = 1748736000 // 2025-06-01, the subscription's start
  const Y2 = 1780272000 // 2026-06-01
  const yline = (amount: number, start: number) => ({ id: `il_${start}`, amount, currency: 'usd', period: { start, end: start + 31_536_000 }, discount_amounts: [], parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_test_yearly', subscription_item: 'si_test_y1', proration: false } } })
  const yinv = (id: string, amount: number, start: number) => ({ id, object: 'invoice', currency: 'usd', status: 'paid', created: start, total: amount, subtotal: amount, amount_due: amount, amount_paid: amount, lines: { object: 'list', has_more: false, data: [yline(amount, start)] } })
  const history: FixtureRoute = {
    match: (u) => u.pathname === '/v1/invoices' && u.searchParams.get('subscription') === 'sub_test_yearly',
    respond: { json: { object: 'list', has_more: false, data: [yinv('in_y2', 192_000, Y2), yinv('in_y1', 60_000, Y1)] } },
  }

  it('the first full pass dates past MRR changes from invoices; later passes leave them out', async () => {
    const { connector } = make([history])
    const first = await runSync(connector, conn, null)
    const y = byId<SubscriptionUpsert>(first.events, 'subscription.upsert', 'sub_test_yearly')
    expect(y?.mrr.minor).toBe(16_000)
    expect(y?.changes).toEqual([
      { at: new Date(Y1 * 1000).toISOString(), mrr: { minor: 5_000, currency: 'USD' } },
      { at: new Date(Y2 * 1000).toISOString(), mrr: { minor: 16_000, currency: 'USD' } },
    ])
    expect(byId<SubscriptionUpsert>(first.events, 'subscription.upsert', 'sub_test_monthly')).not.toHaveProperty('changes')
    const again = await runSync(connector, conn, first.cursor)
    expect(byId<SubscriptionUpsert>(again.events, 'subscription.upsert', 'sub_test_yearly')).not.toHaveProperty('changes')
  })

  it("rows carry Stripe's own description, keys scrubbed", () => {
    const t = { id: 'txn_d', object: 'balance_transaction', amount: 100, fee: 0, net: 100, currency: 'usd', created: Y2, type: 'charge', description: 'Subscription update for rk_live_abc123' } as StripeBalanceTransaction
    expect(mapBalanceTxn(t, 'acct_1', 'c1', 'raw').description).toBe('Subscription update for rk_***')
  })
})

describe('stripe errors', () => {
  const err = (status: number, type: string, message: string, code?: string) => ({ status, json: { error: { type, message, ...(code ? { code } : {}) } } })

  it('401 is auth (not retried) and health says needs_reauth', async () => {
    const bad = err(401, 'invalid_request_error', `Invalid API Key provided: ${KEY.slice(0, 12)}****`)
    const { connector, calls } = make([{ match: path('/v1/balance'), respond: bad }])
    await expect(runSync(connector, conn, null)).rejects.toMatchObject({ kind: 'auth', status: 401 })
    expect(calls).toHaveLength(1)
    const h = await connector.health(conn)
    expect(h.status).toBe('needs_reauth')
    expect(h.message).not.toContain('rk_test_51')
  })

  it('a restricted key missing a permission is auth with a message naming it', async () => {
    const denied = err(
      403,
      'invalid_request_error',
      `The provided key '${KEY.slice(0, 12)}****' does not have the required permissions for this endpoint on account 'acct_test_1'. Having the 'rak_balance_transaction_source_read' permission would allow this request to continue.`,
    )
    const { connector } = make([{ match: path('/v1/balance_transactions'), respond: denied }])
    const e = await runSync(connector, conn, null).catch((x: unknown) => x)
    expect(e).toMatchObject({ kind: 'auth', code: 'permission_missing', permission: 'rak_balance_transaction_source_read' })
    expect((e as Error).message).toContain("'rak_balance_transaction_source_read' permission")
    expect((e as Error).message).not.toContain('rk_test_51')
  })

  it('a restricted key missing an optional permission skips that resource with a warning', async () => {
    const deny = (perm: string) =>
      err(403, 'invalid_request_error', `The provided key '${KEY.slice(0, 12)}****' does not have the required permissions for this endpoint on account 'acct_test_1'. Having the '${perm}' permission would allow this request to continue.`)
    const drain = async (extra: FixtureRoute[]) => {
      const { connector } = make(extra)
      const events: NormalizedEvent[] = []
      const warnings: string[] = []
      let cursor: string | null = null
      for (;;) {
        const r = await connector.sync(conn, cursor)
        events.push(...r.events)
        warnings.push(...(r.warnings ?? []))
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return { events, warnings }
    }
    const full = await drain([])
    expect(full.warnings).toEqual([])
    const count = (evs: NormalizedEvent[], type: NormalizedEvent['type']) => evs.filter((e) => e.type === type).length

    const subs = await drain([{ match: path('/v1/subscriptions'), respond: deny('rak_subscription_read') }])
    expect(subs.warnings).toEqual(['Stripe subscriptions were skipped: the restricted key is missing Read access (rak_subscription_read).'])
    expect(count(subs.events, 'subscription.upsert' as NormalizedEvent['type'])).toBe(0)
    expect(count(subs.events, 'invoice.upsert')).toBe(count(full.events, 'invoice.upsert'))

    const inv = await drain([{ match: (u) => u.pathname.startsWith('/v1/invoices'), respond: deny('rak_invoice_read') }])
    expect(inv.warnings).toEqual(['Stripe invoices were skipped: the restricted key is missing Read access (rak_invoice_read).'])
    expect(count(inv.events, 'invoice.upsert')).toBe(0)
    expect(count(inv.events, 'subscription.upsert' as NormalizedEvent['type'])).toBe(count(full.events, 'subscription.upsert' as NormalizedEvent['type']))

    const po = await drain([{ match: path('/v1/payouts'), respond: deny('rak_payout_read') }])
    expect(po.warnings).toEqual(['Stripe payouts were skipped: the restricted key is missing Read access (rak_payout_read).'])
    expect(count(po.events, 'processor.balance_txn')).toBeGreaterThan(0)

    const cp = await drain([{ match: (u) => u.pathname.startsWith('/v1/coupons/'), respond: deny('rak_coupon_read') }])
    expect(cp.warnings).toEqual([STRIPE_COUPONS_WARNING])
  })

  it('429 honors Retry-After and retries; api_error is retried; invalid_request_error is permanent', async () => {
    let n = 0
    const limited = make([
      { match: (u) => u.pathname === '/v1/balance' && n++ === 0, respond: { ...err(429, 'invalid_request_error', 'Too many requests', 'rate_limit'), headers: { 'retry-after': '2' } } },
    ])
    const r = await runSync(limited.connector, conn, null, { maxPages: 1 })
    expect(r.events.length).toBeGreaterThan(0)
    expect(limited.clock.sleeps).toContain(2000)

    let m = 0
    const flaky = make([{ match: (u) => u.pathname === '/v1/balance' && m++ < 2, respond: err(500, 'api_error', 'Something went wrong') }])
    await runSync(flaky.connector, conn, null, { maxPages: 1 })
    expect(flaky.calls.filter((c) => c.url.endsWith('/v1/balance'))).toHaveLength(3)

    const invalid = make([{ match: path('/v1/balance'), respond: err(400, 'invalid_request_error', 'Received unknown parameter: x') }])
    await expect(runSync(invalid.connector, conn, null)).rejects.toMatchObject({ kind: 'permanent' })
    expect((await limited.connector.health(conn)).status).toBe('ok')
    const always = make([{ match: path('/v1/balance'), respond: err(429, 'rate_limit_error', 'slow down') }])
    expect((await always.connector.health(conn)).status).toBe('rate_limited')
  })

  it('a malformed stored secret is auth; a bad cursor is cursor_invalid', async () => {
    const { connector } = make()
    await expect(connector.sync({ ...conn, secret: { apiKey: 'nope' } }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.sync({ ...conn, secret: null }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.sync(conn, 'garbage!')).rejects.toMatchObject({ kind: 'cursor_invalid' })
  })
})

describe('stripe connect', () => {
  const canWrite = { status: 400, json: { error: { type: 'invalid_request_error', code: 'parameter_missing', message: 'Missing required param: amount.' } } }
  const cannot = { status: 403, json: { error: { type: 'invalid_request_error', message: "The provided key 'rk_test_****' does not have the required permissions for this endpoint on account 'acct_test_1'. Having the 'rak_refund_write' permission would allow this request to continue." } } }
  const post = (p: string) => (u: URL, init: RequestInit | undefined) => u.pathname === p && init?.method === 'POST'

  it('checks a restricted key can’t move money with requests that can never succeed (only these exact empty bodies)', async () => {
    const { connector, calls } = make([{ match: post('/v1/refunds'), respond: cannot }, { match: post('/v1/payouts'), respond: cannot }])
    const out = await connector.connect({ apiKey: KEY })
    expect(out.config).not.toHaveProperty('canWrite')
    const writes = calls.filter((c) => c.method !== 'GET')
    expect(writes.map((c) => [c.method, new URL(c.url).pathname, new URL(c.url).search, c.body])).toEqual([
      ['POST', '/v1/refunds', '', {}],
      ['POST', '/v1/payouts', '', {}],
    ])
  })

  it('says so plainly when a restricted key could refund or pay out', async () => {
    const { connector } = make([{ match: post('/v1/refunds'), respond: canWrite }, { match: post('/v1/payouts'), respond: cannot }])
    const out = await connector.connect({ apiKey: KEY })
    expect(out.config).toMatchObject({ keyType: 'restricted', canWrite: true })
    expect(out.config.warnings).toContain(STRIPE_KEY_CAN_WRITE_WARNING)
    const r = await runSync(connector, { ...conn, config: { ...conn.config, canWrite: true } }, null)
    expect(r.complete).toBe(true)
  })

  it('hosted: a full secret key is refused with the restricted-key steps; restricted keys and the app still work', async () => {
    const { connector, calls } = make([], { ...OPTS, hosted: true })
    await expect(connector.connect({ apiKey: 'sk_live_51ExampleSecretKey' })).rejects.toMatchObject({ kind: 'invalid_input', forUser: true, message: STRIPE_SECRET_KEY_REFUSED })
    expect(calls).toHaveLength(0)
    expect(STRIPE_SECRET_KEY_REFUSED).toMatch(/Create restricted key.*Balance, Balance transaction sources, Payouts, Invoices, Subscriptions, Coupons and Customers/)
    expect((await connector.connect({ apiKey: KEY })).config).toMatchObject({ keyType: 'restricted' })
  })

  it('a full-access key is named on the connection after every full sync (hosted: switch; self-hosted: advice)', async () => {
    const drain = async (c: ReturnType<typeof make>['connector'], cfg: Record<string, unknown>) => {
      const seen: Array<string[] | undefined> = []
      let cursor: string | null = null
      for (;;) {
        const r = await c.sync({ ...conn, config: { ...conn.config, ...cfg } }, cursor)
        seen.push(r.warnings)
        cursor = r.cursor
        if (!r.hasMore) break
      }
      return seen.at(-1) ?? []
    }
    expect(await drain(make([], { ...OPTS, hosted: true }).connector, { keyType: 'secret' })).toContain(STRIPE_FULL_ACCESS_HOSTED_WARNING)
    expect(await drain(make().connector, { keyType: 'secret' })).toContain(STRIPE_FULL_ACCESS_WARNING)
    expect(await drain(make().connector, {})).not.toContain(STRIPE_FULL_ACCESS_WARNING)
  })

  it('verifies a restricted key with /v1/account and stores account details', async () => {
    const { connector, calls } = make()
    const out = await connector.connect({ apiKey: KEY })
    expect(out.secret).toEqual({ apiKey: KEY })
    expect(out.config).toEqual({
      accountId: 'acct_test_1',
      displayName: 'Example Co',
      defaultCurrency: 'USD',
      livemode: false,
      keyType: 'restricted',
      warnings: ['This is a test-mode key: only Stripe test data will be synced.'],
    })
    expect(new URL(calls[0]?.url ?? 'https://x').pathname).toBe('/v1/account')
  })

  it('warns on a full secret key, and passes stripeAccount through', async () => {
    const { connector, calls } = make()
    const out = await connector.connect({ apiKey: 'sk_live_51ExampleSecretKey', stripeAccount: 'acct_test_1' })
    expect(out.config).toMatchObject({ keyType: 'secret', livemode: true, stripeAccount: 'acct_test_1' })
    expect(out.config.warnings).toContain(STRIPE_FULL_ACCESS_WARNING)
    expect(calls[0]?.headers['stripe-account']).toBe('acct_test_1')
  })

  it('falls back to /v1/balance when the key cannot read the account', async () => {
    const denied = {
      status: 403,
      json: { error: { type: 'invalid_request_error', message: "The provided key 'rk_test_****' does not have the required permissions for this endpoint on account 'acct_test_9'. Having the 'rak_accounts_kyc_basic_read' permission would allow this request to continue." } },
    }
    const { connector, calls } = make([{ match: path('/v1/account'), respond: denied }])
    const out = await connector.connect({ apiKey: KEY })
    expect(out.config).toMatchObject({ accountId: 'acct_test_9', displayName: 'acct_test_9', defaultCurrency: 'USD' })
    expect(calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url).pathname)).toEqual(['/v1/account', '/v1/balance'])
  })

  it('validates input', async () => {
    const { connector, calls } = make()
    await expect(connector.connect({})).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: 'pk_test_51ExamplePublishable' })).rejects.toMatchObject({ kind: 'invalid_input', message: expect.stringMatching(/publishable/) })
    await expect(connector.connect({ apiKey: 'hello' })).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.connect({ apiKey: KEY, stripeAccount: 'cus_1' })).rejects.toMatchObject({ kind: 'invalid_input' })
    expect(calls).toHaveLength(0)
    const rejected = make([{ match: path('/v1/account'), respond: { status: 401, json: { error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } } } }])
    await expect(rejected.connector.connect({ apiKey: KEY })).rejects.toMatchObject({ kind: 'auth' })
    const invalid = make([{ match: path('/v1/account'), respond: { status: 400, json: { error: { type: 'invalid_request_error', message: 'No such account' } } } }])
    await expect(invalid.connector.connect({ apiKey: KEY, stripeAccount: 'acct_test_zz' })).rejects.toMatchObject({ kind: 'invalid_input' })
  })

  it('begin asks for a restricted key', async () => {
    const { connector } = make()
    const ctx = { workspaceId: 'ws1', redirectUri: 'https://meridn.example.com/cb', state: 's', userRef: 'u' }
    expect(await connector.begin(ctx)).toMatchObject({
      kind: 'api_key',
      label: 'Stripe restricted API key (read-only)',
      helpUrl: 'https://dashboard.stripe.com/apikeys/create',
      placeholder: 'rk_live_...',
    })
    expect(connector.describe()).toMatchObject({ key: 'stripe', group: 'payments', auth: 'api_key' })
  })
})

describe('stripe webhooks', () => {
  const body = JSON.stringify({ id: 'evt_test_1', object: 'event', type: 'payout.paid', account: 'acct_test_1', data: { object: { id: 'po_test_1' } } })
  const nowSec = Math.floor(fakeClock().now() / 1000)

  it('is omitted without a signing secret', () => {
    expect(make([], {}).connector.webhook).toBeUndefined()
  })

  it('accepts a valid signature, including one of several v1 values and rotated secrets', async () => {
    const hook = make().connector.webhook
    await expect(hook?.verify({ headers: { 'stripe-signature': signStripePayload(WHSEC, body, nowSec) }, body })).resolves.toBeUndefined()
    const good = signStripePayload(WHSEC, body, nowSec).split(',')[1]
    const multi = `t=${nowSec},v1=${'0'.repeat(64)},${good},v0=deadbeef`
    await expect(hook?.verify({ headers: { 'stripe-signature': multi }, body })).resolves.toBeUndefined()
    const rotated = make([], { webhookSecret: ['whsec_old', WHSEC] }).connector.webhook
    await expect(rotated?.verify({ headers: { 'stripe-signature': signStripePayload(WHSEC, body, nowSec) }, body })).resolves.toBeUndefined()
  })

  it('rejects tampered, stale, future, unsigned and wrong-secret webhooks', async () => {
    const hook = make().connector.webhook
    const v = (h: Record<string, string>, b = body) => hook?.verify({ headers: h, body: b })
    await expect(v({ 'stripe-signature': signStripePayload(WHSEC, body, nowSec) }, body.replace('payout.paid', 'payout.failed'))).rejects.toMatchObject({ kind: 'auth' })
    await expect(v({ 'stripe-signature': signStripePayload(WHSEC, body, nowSec - 301) })).rejects.toThrow(/too old/)
    await expect(v({ 'stripe-signature': signStripePayload(WHSEC, body, nowSec + 301) })).rejects.toThrow(/future/)
    await expect(v({})).rejects.toThrow(/missing/)
    await expect(v({ 'stripe-signature': 'v1=abc' })).rejects.toThrow(/malformed/)
    await expect(v({ 'stripe-signature': signStripePayload('whsec_other', body, nowSec) })).rejects.toThrow(/no matching/)
    // Within tolerance is fine.
    await expect(v({ 'stripe-signature': signStripePayload(WHSEC, body, nowSec - 299) })).resolves.toBeUndefined()
  })

  it('interprets event types', () => {
    const w = (o: object, fallback?: string) => interpretStripeEvent({ headers: {}, body: JSON.stringify({ id: 'evt_1', object: 'event', ...o }) }, fallback)
    expect(w({ type: 'payout.paid', account: 'acct_c' })).toEqual({ action: 'sync', dedupeKey: 'stripe:evt_1', reason: 'payout.paid', match: { field: 'accountId', value: 'acct_c' } })
    for (const type of ['balance.available', 'charge.refunded', 'invoice.paid', 'customer.subscription.updated', 'charge.dispute.created']) {
      expect(w({ type, account: 'acct_c' }).action).toBe('sync')
    }
    expect(w({ type: 'account.application.deauthorized', account: 'acct_c' }).action).toBe('disconnected')
    expect(w({ type: 'customer.created', account: 'acct_c' }).action).toBe('ignore')
    // Direct (non-Connect) endpoint: no account on the event → configured account id.
    expect(w({ type: 'invoice.paid' }, 'acct_test_1').match).toEqual({ field: 'accountId', value: 'acct_test_1' })
    expect(w({ type: 'invoice.paid' }).action).toBe('ignore')
    expect(interpretStripeEvent({ headers: {}, body: 'nope' }).action).toBe('ignore')
    const hook = make([], { webhookSecret: WHSEC, webhookAccountId: 'acct_test_1' }).connector.webhook
    expect(hook?.interpret({ headers: {}, body: JSON.stringify({ id: 'evt_2', type: 'charge.succeeded' }) }).match?.value).toBe('acct_test_1')
  })
})

describe('stripe sign-in (Stripe Apps OAuth)', () => {
  const APP: StripeConnectorOptions = { appClientId: 'ca_test_app', appSecretKey: 'sk_test_platformExample1' }
  const token = (n: number) => ({ json: { access_token: `sk_test_oauthAccess${n}`, refresh_token: `rt_test_refresh${n}`, stripe_user_id: 'acct_test_1', livemode: false, expires_in: 3600 } })

  describe('disconnect', () => {
    const sign = (over: Record<string, unknown> = {}) => ({ ...conn, secret: { kind: 'oauth', apiKey: 'sk_test_oauthAccess1', refreshToken: 'rt_test_refresh1', livemode: true }, config: { ...conn.config, keyType: 'oauth', accountId: 'acct_test_1', ...over } })
    const at = (u: URL) => u.origin + u.pathname === 'https://connect.stripe.com/oauth/deauthorize'

    it('a sign-in is deauthorized at Stripe with our key for its mode', async () => {
      const { connector, calls } = make([{ match: at, respond: () => ({ json: { stripe_user_id: 'acct_test_1' } }) }], APP)
      expect(await connector.disconnect!(sign() as never)).toBeUndefined()
      const call = calls.find((c) => String(c.url).includes('/oauth/deauthorize'))!
      expect(call.body).toEqual({ client_id: 'ca_test_app', stripe_user_id: 'acct_test_1' })
    })

    it('an app install Stripe won\'t deauthorize says to uninstall it, never silently', async () => {
      const { connector } = make([{ match: at, respond: () => ({ status: 400, json: { error: 'invalid_client', error_description: 'not connected' } }) }], APP)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        expect(await connector.disconnect!(sign() as never)).toEqual({ notRevoked: expect.stringContaining('View app details → Uninstall app') })
        const logged = warn.mock.calls.flat().join(' ')
        expect(logged).toContain('status 400')
        expect(logged).not.toMatch(/sk_|rt_|acct_|ca_test/)
      } finally {
        warn.mockRestore()
      }
    })

    it('says why no call was made', async () => {
      const { connector, calls } = make([], APP)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        expect(await connector.disconnect!(sign({ accountId: undefined }) as never)).toEqual({ notRevoked: expect.stringContaining('View app details → Uninstall app') })
        expect(warn.mock.calls.flat().join(' ')).toContain('account false')
        expect(calls.some((c) => String(c.url).includes('/oauth/deauthorize'))).toBe(false)
      } finally {
        warn.mockRestore()
      }
    })

    it('a pasted key says to roll it', async () => {
      const { connector, conn: c } = make()
      expect(await connector.disconnect!(c as never)).toEqual({ notRevoked: expect.stringContaining('Roll or delete the key') })
    })
  })

  it('offers the guided key paste without an app, and a sign-in link with one', async () => {
    const paste = await make().connector.begin({ workspaceId: 'ws1', redirectUri: 'https://app.example.com/api/connectors/stripe/callback', state: 's1', userRef: 'u' })
    expect(paste).toMatchObject({ kind: 'api_key', helpUrl: 'https://dashboard.stripe.com/apikeys/create' })
    expect((paste as { steps?: string[]; permissions?: string[] }).steps).toHaveLength(3)
    const { connector } = make([], APP)
    expect(connector.describe().auth).toBe('oauth')
    const b = await connector.begin({ workspaceId: 'ws1', redirectUri: 'https://app.example.com/api/connectors/stripe/callback', state: 's1', userRef: 'u' })
    const u = new URL((b as { url: string }).url)
    expect(u.origin + u.pathname).toBe('https://marketplace.stripe.com/oauth/v2/authorize')
    expect(Object.fromEntries(u.searchParams)).toEqual({ client_id: 'ca_test_app', redirect_uri: 'https://app.example.com/api/connectors/stripe/callback', state: 's1' })
  })

  it('uses the External test install link before the app is published, and ignores links that aren\'t Stripe\'s', async () => {
    const begin = async (appAuthorizeUrl: string) => {
      const b = await make([], { ...APP, appAuthorizeUrl }).connector.begin({ workspaceId: 'ws1', redirectUri: 'https://app.example.com/api/connectors/stripe/callback', state: 's1', userRef: 'u' })
      return new URL((b as { url: string }).url)
    }
    const t = await begin('https://marketplace.stripe.com/oauth/v2/chnlink_test123/authorize?client_id=ca_other&redirect_uri=https://x.example')
    expect(t.origin + t.pathname).toBe('https://marketplace.stripe.com/oauth/v2/chnlink_test123/authorize')
    expect(Object.fromEntries(t.searchParams)).toEqual({ client_id: 'ca_test_app', redirect_uri: 'https://app.example.com/api/connectors/stripe/callback', state: 's1' })
    for (const bad of ['https://evil.example/oauth/v2/authorize', 'http://marketplace.stripe.com/oauth/v2/authorize', 'not a url']) {
      const u = await begin(bad)
      expect(u.origin + u.pathname).toBe('https://marketplace.stripe.com/oauth/v2/authorize')
    }
  })

  it('exchanges the code with our own key, reads the account, and stores the tokens', async () => {
    const { connector, calls } = make([{ match: path('/v1/oauth/token'), respond: token(1) }], APP)
    const out = await connector.connect({ code: 'ac_test_code' })
    expect(out.secret).toMatchObject({ kind: 'oauth', apiKey: 'sk_test_oauthAccess1', refreshToken: 'rt_test_refresh1', expiresAt: expect.any(String) })
    expect(out.config).toMatchObject({ accountId: 'acct_test_1', keyType: 'oauth', livemode: false })
    const ex = calls.find((c) => c.url.endsWith('/v1/oauth/token'))
    expect(ex?.headers.authorization).toBe(`Basic ${Buffer.from('sk_test_platformExample1:').toString('base64')}`)
    expect(ex?.body).toMatchObject({ grant_type: 'authorization_code', code: 'ac_test_code' })
    // The account is read with the new token, not our key.
    expect(calls.find((c) => c.url.endsWith('/v1/account'))?.headers.authorization).toBe('Bearer sk_test_oauthAccess1')
  })

  it('refreshes an expiring token before syncing and hands back the rotated one', async () => {
    const { connector, calls, clock, saved } = make([{ match: path('/v1/oauth/token'), respond: token(2) }], APP)
    const soon = new Date(clock.now() + 60_000).toISOString()
    const signedIn = { ...conn, secret: { kind: 'oauth', apiKey: 'sk_test_oauthAccess1', refreshToken: 'rt_test_refresh1', expiresAt: soon } }
    const page = await connector.sync(signedIn, null)
    expect(page.updatedSecret).toMatchObject({ kind: 'oauth', apiKey: 'sk_test_oauthAccess2', refreshToken: 'rt_test_refresh2' })
    // Saved the moment it's issued, before any page could fail.
    expect(saved).toEqual([page.updatedSecret])
    expect(calls[0]?.body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt_test_refresh1' })
    expect(calls.find((c) => c.url.includes('/v1/balance'))?.headers.authorization).toBe('Bearer sk_test_oauthAccess2')
    // A token with time left is used as is.
    const later = { ...signedIn, secret: { ...signedIn.secret, expiresAt: new Date(clock.now() + 3_000_000).toISOString() } }
    expect((await connector.sync(later, null)).updatedSecret).toBeUndefined()
  })

  const LIVE_KEY = 'sk_live_platformExample1'
  const TEST_KEY = 'sk_test_platformExample2'
  const BOTH: StripeConnectorOptions = { appClientId: 'ca_test_app', appSecretKey: LIVE_KEY, appTestSecretKey: TEST_KEY }
  const basic = (k: string) => `Basic ${Buffer.from(`${k}:`).toString('base64')}`
  const modeToken = (livemode: boolean) => ({ json: { access_token: `${livemode ? 'sk_live' : 'sk_test'}_oauthAccess9`, refresh_token: 'rt_refresh9', stripe_user_id: 'acct_test_1', livemode, expires_in: 3600 } })
  const wrongMode = { status: 400, json: { error: 'invalid_grant', error_description: 'Authorization code provided does not belong to you' } }
  /** Accepts only `key`; the other mode's key gets Stripe's refusal. */
  const acceptsOnly = (key: string, livemode: boolean): FixtureRoute[] => [
    { match: (u, init) => u.pathname === '/v1/oauth/token' && new Headers(init?.headers).get('authorization') === basic(key), respond: modeToken(livemode) },
    { match: path('/v1/oauth/token'), respond: wrongMode },
  ]
  const tokenCalls = (calls: Array<{ url: string; headers: Record<string, string | undefined> }>) => calls.filter((c) => c.url.endsWith('/v1/oauth/token')).map((c) => c.headers.authorization)

  it('a live install is exchanged with the live key and remembers livemode', async () => {
    const { connector, calls } = make([...acceptsOnly(LIVE_KEY, true)], BOTH)
    const out = await connector.connect({ code: 'ac_live_code' })
    expect(out.secret).toMatchObject({ kind: 'oauth', livemode: true })
    expect(out.config).toMatchObject({ livemode: true })
    expect(tokenCalls(calls)).toEqual([basic(LIVE_KEY)])
  })

  it('a test-mode install refused by the live key is retried once with the test key', async () => {
    const { connector, calls } = make([...acceptsOnly(TEST_KEY, false)], BOTH)
    const out = await connector.connect({ code: 'ac_test_code' })
    expect(out.secret).toMatchObject({ kind: 'oauth', apiKey: 'sk_test_oauthAccess9', livemode: false })
    expect(out.config).toMatchObject({ livemode: false })
    expect(tokenCalls(calls)).toEqual([basic(LIVE_KEY), basic(TEST_KEY)])
    // Without a test key there is nothing to retry with.
    const liveOnly = make([...acceptsOnly(TEST_KEY, false)], { appClientId: 'ca_test_app', appSecretKey: LIVE_KEY })
    await expect(liveOnly.connector.connect({ code: 'ac_test_code' })).rejects.toMatchObject({ kind: 'auth', code: 'invalid_grant' })
    expect(tokenCalls(liveOnly.calls)).toHaveLength(1)
  })

  it('a test key alone enables sign-in and is used for the exchange', async () => {
    const { connector, calls } = make([...acceptsOnly(TEST_KEY, false)], { appClientId: 'ca_test_app', appTestSecretKey: TEST_KEY })
    expect(connector.describe().auth).toBe('oauth')
    expect((await connector.connect({ code: 'ac_test_code' })).secret).toMatchObject({ livemode: false })
    expect(tokenCalls(calls)).toEqual([basic(TEST_KEY)])
  })

  it('refreshes with the key for the install’s mode; secrets without livemode use the live key', async () => {
    const refreshWith = async (livemode: boolean | undefined) => {
      const { connector, calls, clock } = make([{ match: path('/v1/oauth/token'), respond: modeToken(livemode !== false) }], BOTH)
      const secret = { kind: 'oauth', apiKey: 'sk_x_oauthAccess1', refreshToken: 'rt_refresh1', expiresAt: new Date(clock.now() + 60_000).toISOString(), ...(livemode === undefined ? {} : { livemode }) }
      const page = await connector.sync({ ...conn, secret }, null)
      return { auth: tokenCalls(calls), updated: page.updatedSecret }
    }
    const test = await refreshWith(false)
    expect(test.auth).toEqual([basic(TEST_KEY)])
    expect(test.updated).toMatchObject({ livemode: false })
    expect((await refreshWith(true)).auth).toEqual([basic(LIVE_KEY)])
    expect((await refreshWith(undefined)).auth).toEqual([basic(LIVE_KEY)])
  })

  it('health never refreshes: an expired token is ok until the next sync, a 401 is needs_reauth', async () => {
    const { connector, calls, clock } = make([{ match: path('/v1/oauth/token'), respond: token(2) }], APP)
    const expired = { ...conn, secret: { kind: 'oauth', apiKey: 'sk_test_oauthAccess1', refreshToken: 'rt_test_refresh1', expiresAt: new Date(clock.now() - 1000).toISOString() } }
    const h = await connector.health(expired)
    expect(h.status).toBe('ok')
    expect(h.message).toMatch(/next sync/)
    expect(calls).toHaveLength(0)
    // Close to expiry (sync would refresh): health just uses the stored token.
    const soon = { ...expired, secret: { ...expired.secret, expiresAt: new Date(clock.now() + 60_000).toISOString() } }
    expect(await connector.health(soon)).toEqual({ status: 'ok' })
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v1/balance'])
    expect(calls[0]?.headers.authorization).toBe('Bearer sk_test_oauthAccess1')
    const revoked = make([{ match: path('/v1/balance'), respond: { status: 401, json: { error: { type: 'invalid_request_error', message: 'Expired API Key provided' } } } }], APP)
    expect((await revoked.connector.health(soon)).status).toBe('needs_reauth')
    expect(tokenCalls(revoked.calls)).toHaveLength(0)
  })
})

describe('stripe counterparty names', () => {
  it('customer name or email, else the payment\'s own details, else a plain label; never the cus_ id', () => {
    const names = new Map([['cus_a', 'Lumen Health'], ['cus_gone', '']])
    expect(counterpartyOf({ id: 'ch', object: 'charge', customer: 'cus_a' }, 'cus_a', names)).toBe('Lumen Health')
    expect(counterpartyOf({ id: 'ch', object: 'charge', customer: 'cus_gone', billing_details: { name: 'Dana Ruiz' } }, 'cus_gone', names)).toBe('Dana Ruiz')
    expect(counterpartyOf({ id: 'ch', object: 'charge', receipt_email: 'x@y.example' }, undefined, names)).toBe('x@y.example')
    expect(counterpartyOf({ id: 'ch', object: 'charge', description: 'Test order' }, undefined)).toBe('Test order')
    // Without Customers: Read, a subscription charge has only Stripe's generic text.
    expect(counterpartyOf({ id: 'ch', object: 'charge', customer: 'cus_b', description: 'Subscription creation' }, 'cus_b')).toBe('Stripe customer')
    expect(counterpartyOf(undefined, undefined)).toBeUndefined()
  })

  it('a restricted key without Customers: Read still syncs, naming payments from their own details', async () => {
    const denied = { status: 403, json: { error: { type: 'invalid_request_error', code: 'permission_missing', message: 'no customers' } } }
    const { connector } = make([{ match: (u) => u.pathname.startsWith('/v1/customers/'), respond: denied }])
    const out = await runSync(connector, conn, null)
    const charge = out.events.find((e) => e.type === 'processor.balance_txn' && e.externalId === 'txn_test_charge1') as { counterparty?: string; customer?: string } | undefined
    expect(charge?.customer).toBe('cus_test_1')
    expect(charge?.counterparty).not.toMatch(/^cus_/)
  })
})
