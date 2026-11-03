// The one line a Harvest connection shows in its drawer: invoiced this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { emptyTotals, monthRows, type MonthTotals } from '@agfn/connector-harvest'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, totals: Partial<MonthTotals>): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `harvest:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ ...emptyTotals(), ...totals }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('invoiced in Harvest, in the connection details', () => {
  it('is this month’s invoiced figure per currency, and not the paid one', async () => {
    const srv = await startServer({ scripted: ['harvest'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'harvest', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'USD', { invoiced: 2325_50, tax: 110_24, paid: 2300_50 }), snapshot(id, THIS_MONTH, 'JPY', { invoiced: 50_000 }), snapshot(id, '2026-09', 'USD', { invoiced: 999_00 })])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 50_000, currency: 'JPY' }, { minor: 2325_50, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
