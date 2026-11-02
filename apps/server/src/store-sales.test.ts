// The one line a WooCommerce connection shows in its drawer: sales reported by the store this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows, emptyTotals, type MonthTotals } from '@agfn/connector-woocommerce'
import { connectAi, connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)
const LAST_MONTH = '2026-09'

/** What the connector sends: its own rows, so a renamed row breaks this test rather than the drawer. */
const snapshot = (connectionId: string, month: string, currency: string, totals: Partial<MonthTotals>): NormalizedEvent =>
  ({
    type: 'report.snapshot',
    externalId: `woocommerce:${month}:${currency}`,
    connectionId,
    kind: 'profit_and_loss',
    from: `${month}-01`,
    to: `${month}-28`,
    basis: 'accrual',
    currency,
    rows: monthRows({ ...emptyTotals(), ...totals }, currency),
  }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }>; connectorKey: string }
const usd = (minor: number) => ({ minor, currency: 'USD' })

async function withStore(run: (a: { srv: Awaited<ReturnType<typeof startServer>>; s: Awaited<ReturnType<typeof signIn>>; company: string; store: Awaited<ReturnType<typeof connectProvider>> }) => Promise<void>) {
  const srv = await startServer({ scripted: ['woocommerce'] })
  try {
    const email = `owner${Math.random().toString(36).slice(2, 9)}@example.com`
    const s = await signIn(srv, email, 'Demo Company')
    const company = (await entities(s))['Demo Company']!
    const store = await connectProvider(srv, s, 'woocommerce', { entityId: company, config: { currency: 'USD' } })
    await run({ srv, s, company, store })
  } finally {
    await srv.close()
  }
}

describe('sales reported by the store, in the connection details', () => {
  it('is this month’s net sales: refunds out, tax and shipping never in', async () => {
    await withStore(async ({ s, store }) => {
      store.push((id) => [
        snapshot(id, LAST_MONTH, 'USD', { sales: 999_00 }),
        snapshot(id, THIS_MONTH, 'USD', { sales: 1_300_00, refundedSales: 65_44, shipping: 50_00, tax: 90_00, refundedShipping: 5_00, refundedTax: 3_00 }),
      ])
      await store.sync()
      const d = await s.get<Detail>(`/api/connections/${store.id}`)
      expect(d.status).toBe(200)
      expect(d.body.storeSales).toEqual([usd(1_234_56)])
    })
  })

  it('absent before there’s a snapshot', async () => {
    await withStore(async ({ s, store }) => {
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body).not.toHaveProperty('storeSales')
    })
  })

  it('absent when only an earlier month has one', async () => {
    await withStore(async ({ s, store }) => {
      store.push((id) => [snapshot(id, LAST_MONTH, 'USD', { sales: 500_00 })])
      await store.sync()
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body).not.toHaveProperty('storeSales')
    })
  })

  it('one line per currency, never added together', async () => {
    await withStore(async ({ s, store }) => {
      store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 }), snapshot(id, THIS_MONTH, 'EUR', { sales: 20_00 }), snapshot(id, THIS_MONTH, 'JPY', { sales: 3000 })])
      await store.sync()
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([{ minor: 20_00, currency: 'EUR' }, { minor: 3000, currency: 'JPY' }, usd(10_00)])
    })
  })

  it('a currency with nothing this month gets no line; a quiet store still shows its own at zero', async () => {
    await withStore(async ({ s, store }) => {
      store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 }), snapshot(id, THIS_MONTH, 'EUR', {})])
      await store.sync()
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([usd(10_00)])
    })
    await withStore(async ({ s, store }) => {
      store.push((id) => [snapshot(id, THIS_MONTH, 'USD', {}), snapshot(id, THIS_MONTH, 'EUR', {})])
      await store.sync()
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([usd(0)])
    })
  })

  it('net of refunds can be negative, and says so', async () => {
    await withStore(async ({ s, store }) => {
      store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00, refundedSales: 25_00 })])
      await store.sync()
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([usd(-15_00)])
    })
  })

  it('only WooCommerce: a QuickBooks report with the same shape shows nothing', async () => {
    await withStore(async ({ srv, s, company }) => {
      const books = await connectProvider(srv, s, 'quickbooks', { entityId: company })
      books.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 })])
      await books.sync()
      expect((await s.get<Detail>(`/api/connections/${books.id}`)).body).not.toHaveProperty('storeSales')
    })
  })

  it('another workspace gets a 404, not the figure', async () => {
    await withStore(async ({ srv, s, store }) => {
      store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 })])
      await store.sync()
      const stranger = await signIn(srv, 'stranger@example.com', 'Elsewhere Inc')
      const r = await stranger.get<Detail>(`/api/connections/${store.id}`)
      expect(r.status).toBe(404)
      expect(JSON.stringify(r.body)).not.toContain('1000')
      expect((await s.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([usd(10_00)])
    })
  })

  describe('a teammate in the same workspace', () => {
    const teammate = async (srv: Awaited<ReturnType<typeof startServer>>, s: Awaited<ReturnType<typeof signIn>>, company: string, grid: Record<string, string>) => {
      const email = 'teammate@example.com'
      const inv = await s.post<{ id: string }>('/api/people', { email, role: 'finance', entityIds: [company] })
      expect(inv.status).toBe(201)
      if (Object.keys(grid).length) expect((await s.send('PATCH', `/api/people/${inv.body.id}`, { grid })).status).toBe(200)
      return signIn(srv, email)
    }

    it.each([['reports'], ['balances']])('without %s for the company sees the connection, not the figure', async (dataType) => {
      await withStore(async ({ srv, s, company, store }) => {
        store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 })])
        await store.sync()
        const t = await teammate(srv, s, company, { [dataType]: 'none' })
        const d = await t.get<Detail>(`/api/connections/${store.id}`)
        expect(d.status).toBe(200)
        expect(d.body.connectorKey).toBe('woocommerce')
        expect(d.body).not.toHaveProperty('storeSales')
      })
    })

    it('who can view both sees it', async () => {
      await withStore(async ({ srv, s, company, store }) => {
        store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 })])
        await store.sync()
        const t = await teammate(srv, s, company, {})
        expect((await t.get<Detail>(`/api/connections/${store.id}`)).body.storeSales).toEqual([usd(10_00)])
      })
    })

    it('limited to another company sees no figure', async () => {
      await withStore(async ({ srv, s, store }) => {
        store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 10_00 })])
        await store.sync()
        const other = await s.post<{ id: string }>('/api/entities', { name: 'Side Project LLC' })
        const t = await teammate(srv, s, other.body.id, {})
        expect((await t.get<Detail>(`/api/connections/${store.id}`)).body).not.toHaveProperty('storeSales')
      })
    })
  })

  it('the AI’s tools don’t change: same list, same answers with and without the snapshots', async () => {
    await withStore(async ({ srv, s, company, store }) => {
      const stripe = await connectProvider(srv, s, 'quickbooks', { entityId: company })
      stripe.push((connectionId) => [{ type: 'invoice.upsert', externalId: 'i1', direction: 'receivable', number: 'A-1', counterparty: 'Globex', issueDate: '2026-10-02', dueDate: '2026-11-01', total: usd(50_000), amountPaid: usd(0), status: 'open', connectionId }] as NormalizedEvent[])
      await stripe.sync()
      const ai = await connectAi(srv, s)
      try {
        const answers = async () => ({
          tools: await ai.tools(),
          overview: await ai.try('get_overview'),
          pnl: await ai.try('get_reports', { kind: 'profit_and_loss', company: 'Demo Company', from: '2026-10-01', to: '2026-10-31', basis: 'accrual' }),
          cash: await ai.try('get_reports', { kind: 'profit_and_loss', company: 'Demo Company', from: '2026-10-01', to: '2026-10-31', basis: 'cash' }),
          coverage: await ai.try('get_coverage'),
        })
        // Only the clock may differ: as_of, and the "synced … ago" under freshness, in the data and quoted in the text.
        const stable = (x: unknown) => JSON.stringify(x).replace(/as_of[\\":]+[^"\\]+/g, 'as_of').replace(/freshness[\\":{]+[^}]*\}/g, 'freshness')
        // Synced once with nothing, so the only change below is the snapshots themselves.
        store.push(() => [])
        await store.sync()
        const before = await answers()
        expect(before.pnl.isError).toBe(false)
        store.push((id) => [snapshot(id, THIS_MONTH, 'USD', { sales: 987_654_00 })])
        await store.sync()
        const after = await answers()
        expect(after.tools).toEqual(before.tools)
        expect(stable(after)).toBe(stable(before))
        expect(JSON.stringify(after)).not.toContain('987')
      } finally {
        await ai.close()
      }
    })
  })
})
