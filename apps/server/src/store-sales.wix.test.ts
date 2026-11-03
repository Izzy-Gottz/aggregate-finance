// The one line a Wix connection shows in its drawer: net sales this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-wix'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, sales: number, refunds: number): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `wix:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ sales, refunds }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('sales reported by Wix, in the connection details', () => {
  it('is this month, less refunds', async () => {
    const srv = await startServer({ scripted: ['wix'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'wix', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'USD', 100_00, 25_00), snapshot(id, '2026-09', 'USD', 999_00, 0)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 75_00, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
