// The one line a SumUp connection shows in its drawer: paid out this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { emptyTotals, monthRows, type MonthTotals } from '@agfn/connector-sumup'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, totals: Partial<MonthTotals>): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `sumup:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ ...emptyTotals(), ...totals }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('paid out by SumUp, in the connection details', () => {
  it('is this month’s paid out figure per currency, and not gross sales', async () => {
    const srv = await startServer({ scripted: ['sumup'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'sumup', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'EUR', { sales: 900_00, paidOut: 512_30, fees: 14_20 }), snapshot(id, THIS_MONTH, 'CLP', { paidOut: 50_000 }), snapshot(id, '2026-09', 'EUR', { paidOut: 999_00 })])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 50_000, currency: 'CLP' }, { minor: 512_30, currency: 'EUR' }])
    } finally {
      await srv.close()
    }
  })
})
