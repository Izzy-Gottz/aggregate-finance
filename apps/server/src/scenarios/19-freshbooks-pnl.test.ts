// A hand-computed FreshBooks month, replayed: the real connector reads the fixture, its events go through the real
// server and ledger, and our accrual P&L must equal FreshBooks' own report to the cent. The sum, in dollars:
//   Income   invoices 1,000.00 (+ 80.00 tax, not income) + 450.00 (300.00 + 200.50 - 50.50 discount) + 250.00 = 1,700.00
//   Costs    bill 150.25 (Materials, cost of goods)                                                            = 150.25
//   Expenses bill 400.00 + expense 89.75 + journal 120.00                                                      = 609.75
//   Net      1,700.00 - 150.25 - 609.75                                                                         = 940.00
// The second part: a sale in Stripe and in FreshBooks is asked about once, and counts once after a yes.
import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { createFreshBooksConnector } from '@agfn/connector-freshbooks'
import { FIXTURE, routes, type Fixture } from '../../../../packages/connectors/freshbooks/src/test-routes.ts'
import { connectAi, connectProvider, entities, minor, READ_WRITE_ALL, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
const AMT = (amount: string) => ({ amount, code: 'USD' })

async function connectorEvents(connectionId: string, fix: Fixture = FIXTURE): Promise<NormalizedEvent[]> {
  const ff = fixtureFetch(routes(fix))
  const c = createFreshBooksConnector({ deps: { raw: new MemoryRawSink(), fetch: ff.fetch, clock: fakeClock(Date.parse('2026-10-10T12:00:00Z')), random: () => 0.5 }, oauth: { clientId: 'c', clientSecret: 's', redirectUri: 'https://x/cb' } })
  const conn: ConnectionRef = { id: connectionId, workspaceId: 'ws', connectorKey: 'freshbooks', secret: { tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.parse('2026-10-11T00:00:00Z') } }, config: { accountId: 'ACCT1', businessUuid: 'biz-uuid-1', baseCurrency: 'USD', pnlMonths: 1 } }
  return (await runSync(c, conn, null)).events
}

type Report = { sections: Array<{ name: string; total: { amount: string } }>; total: { amount: string } }
const SEP = { from: '2026-09-01', to: '2026-09-30' }

async function september(fix?: Fixture) {
  const srv = await startServer({ scripted: ['freshbooks'] })
  try {
    const s = await signIn(srv, 'founder19@example.test', 'Acme')
    const E = await entities(s)
    const books = await connectProvider(srv, s, 'freshbooks', { entityId: E.Acme, name: 'FreshBooks' })
    const events = await connectorEvents(books.id, fix)
    books.push(() => events)
    expect(await books.sync()).toMatchObject({ status: 'ok' })
    const ai = await connectAi(srv, s)
    const got = (await ai.call<{ reports: Report[] }>('get_reports', { kind: 'profit_and_loss', company: 'Acme', ...SEP, basis: 'accrual' })).reports[0]!
    const sec = (n: string) => minor(got.sections.find((x) => x.name === n)?.total) ?? 0
    const drawer = await s.get<{ odd: Array<{ label: string; detail: string }> }>(`/api/entities/${E.Acme}`)
    await ai.close()
    return { net: minor(got.total), income: sec('Revenue'), cogs: sec('Cost of revenue'), expenses: sec('Operating expenses'), odd: drawer.body.odd }
  } finally {
    await srv.close()
  }
}

describe('scenario 19: FreshBooks', { timeout: 120_000 }, () => {
  it("our accrual P&L equals FreshBooks' report to the cent", async () => {
    const r = await september()
    expect({ net: r.net, income: r.income, cogs: r.cogs, expenses: r.expenses }).toEqual({ net: 94_000, income: 170_000, cogs: 15_025, expenses: 60_975 })
    // The report fed provider_report, and it agreed.
    expect(r.odd.filter((c) => /net income/.test(c.detail))).toEqual([])
  })

  it('FreshBooks is real books: a report that disagrees is flagged, by name, with what we can’t read', async () => {
    const fix = structuredClone(FIXTURE)
    const sep = fix.profit_and_loss['2026-09'] as Record<string, unknown>
    fix.profit_and_loss['2026-09'] = { ...sep, net_profit: { ...(sep.net_profit as object), total: AMT('900.00') } }
    const r = await september(fix)
    const flagged = r.odd.filter((c) => /net income/.test(c.detail))
    expect(flagged.length).toBeGreaterThan(0)
    for (const f of flagged) {
      expect(f.detail).toContain('$940.00 here and $900.00 in FreshBooks.')
      expect(f.detail).toContain('credit notes')
    }
  })

  const sale = (c: string, name: string, gross = 100_000) => [
    { type: 'account.upsert', externalId: 'bal', connectionId: c, name: 'Stripe balance', accountType: 'processor_balance', currency: 'USD' },
    { type: 'processor.balance_txn', externalId: 'ch_1', connectionId: c, accountExternalId: 'bal', at: '2026-09-13T10:00:00Z', kind: 'charge', gross: usd(gross), fee: usd(0), net: usd(gross), counterparty: name },
  ]
  /** One invoice, paid: $1,000.00 with no tax. */
  const oneSale = (organization: string, tax = false): Fixture => ({
    ...structuredClone(FIXTURE),
    invoices: [{ ...(FIXTURE.invoices as Array<Record<string, unknown>>)[0], organization, amount: AMT(tax ? '1080.00' : '1000.00'), paid: AMT(tax ? '1080.00' : '1000.00'), lines: [{ name: 'Consulting', amount: AMT('1000.00') }] }],
    payments: [{ ...(FIXTURE.payments as Array<Record<string, unknown>>)[0], amount: AMT(tax ? '1080.00' : '1000.00') }],
    expenses: [],
    bills: [],
    bill_payments: [],
    manualJournalEntries: [],
    profit_and_loss: {},
  })

  async function stripeAndBooks(stripeName: string, booksName: string, tax = false) {
    const srv = await startServer({ scripted: ['freshbooks'] })
    const s = await signIn(srv, 'founder19b@example.test', 'Acme')
    const E = await entities(s)
    const stripe = await connectProvider(srv, s, 'stripe', { entityId: E.Acme, name: 'Stripe' })
    stripe.push((c) => sale(c, stripeName, tax ? 108_000 : 100_000) as never)
    expect((await stripe.sync()).status).toBe('ok')
    const books = await connectProvider(srv, s, 'freshbooks', { entityId: E.Acme, name: 'FreshBooks' })
    const events = await connectorEvents(books.id, oneSale(booksName, tax))
    books.push(() => events)
    expect(await books.sync()).toMatchObject({ status: 'ok' })
    const ai = await connectAi(srv, s, READ_WRITE_ALL)
    const revenue = async (basis: 'cash' | 'accrual') => minor((await ai.call<{ reports: Report[] }>('get_reports', { kind: 'profit_and_loss', company: 'Acme', ...SEP, basis })).reports[0]!.sections.find((x) => x.name === 'Revenue')?.total) ?? 0
    const metric = async () => minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'revenue', company: 'Acme', ...SEP })).value)
    const review = async () => (await s.get<Array<{ id: string; title: string }>>('/api/review')).body.filter((i) => i.title.startsWith('Same money?'))
    return { s, srv, ai, revenue, metric, review }
  }

  it('the same sale in Stripe and FreshBooks: one proposed link, then it counts once', async () => {
    const { s, srv, ai, revenue, metric, review } = await stripeAndBooks('Globex Corp', 'Globex Corp')
    try {
      const asked = await review()
      expect(asked).toHaveLength(1)
      // Still counted in both until confirmed. These are the numbers the report quotes.
      const proposed = { cash: await revenue('cash'), accrual: await revenue('accrual') }
      expect(proposed).toEqual({ cash: 200_000, accrual: 200_000 })
      expect(await metric()).toBe(200_000)
      expect((await s.post(`/api/review/${asked[0]!.id}`, { action: 'confirm' })).status).toBe(200)
      expect({ cash: await revenue('cash'), accrual: await revenue('accrual') }).toEqual({ cash: 100_000, accrual: 100_000 })
      expect(await metric()).toBe(100_000)
      expect(await review()).toHaveLength(0)
    } finally {
      await ai.close()
      await srv.close()
    }
  })

  it('with sales tax: the invoice stays gross so it matches, and only the net is revenue once confirmed', async () => {
    const { s, srv, ai, revenue, review } = await stripeAndBooks('Globex Corp', 'Globex Corp', true)
    try {
      const asked = await review()
      expect(asked).toHaveLength(1)
      expect({ cash: await revenue('cash'), accrual: await revenue('accrual') }).toEqual({ cash: 208_000, accrual: 208_000 })
      expect((await s.post(`/api/review/${asked[0]!.id}`, { action: 'confirm' })).status).toBe(200)
      expect({ cash: await revenue('cash'), accrual: await revenue('accrual') }).toEqual({ cash: 100_000, accrual: 100_000 })
    } finally {
      await ai.close()
      await srv.close()
    }
  })

  it('different customer names are not asked about, so the sale stays counted twice (docs/guides/limits.md)', async () => {
    const { srv, ai, revenue, review } = await stripeAndBooks('Umbrella', 'Globex Corp')
    try {
      expect(await review()).toHaveLength(0)
      expect(await revenue('cash')).toBe(200_000)
    } finally {
      await ai.close()
      await srv.close()
    }
  })
})
