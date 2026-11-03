// The one line a Lightspeed connection shows in its drawer: net sales reported by the store this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { emptyTotals, monthRows, type MonthTotals } from '@agfn/connector-lightspeed'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, totals: Partial<MonthTotals>): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `lightspeed:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ ...emptyTotals(), ...totals }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('sales reported by a Lightspeed store, in the connection details', () => {
  it('is this month’s net sales: refunds out, tax never in', async () => {
    const srv = await startServer({ scripted: ['lightspeed'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'lightspeed', { entityId: company, config: { currency: 'USD' } })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, '2026-09', 'USD', { sales: 999_00 }), snapshot(id, THIS_MONTH, 'USD', { sales: 1150_05, refundedSales: 20_10, tax: 92_01, refundedTax: 1_61 })])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 1129_95, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
