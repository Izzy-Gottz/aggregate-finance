// The one line a Mollie connection shows in its drawer: this month's net from sales, after Mollie's fees. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-mollie'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, payments: number, refunds: number, fees: number, payouts: number): NormalizedEvent =>
  ({
    type: 'report.snapshot',
    externalId: `mollie:${month}:${currency}`,
    connectionId,
    kind: 'profit_and_loss',
    from: `${month}-01`,
    to: `${month}-28`,
    basis: 'cash',
    currency,
    rows: monthRows({ kinds: { payments, refunds, chargebacks: 0, 'fee-prepayments': fees, transfers: payouts }, close: 0 }, currency),
  }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('sales in Mollie, in the connection details', () => {
  it('is this month’s payments less refunds and fees, payouts left out', async () => {
    const srv = await startServer({ scripted: ['mollie'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'mollie', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'EUR', 1000_00, -100_00, -30_00, -500_00), snapshot(id, '2026-09', 'EUR', 999_00, 0, 0, 0)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 870_00, currency: 'EUR' }])
    } finally {
      await srv.close()
    }
  })
})
