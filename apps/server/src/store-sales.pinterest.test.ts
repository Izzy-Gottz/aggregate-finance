// The one line a Pinterest connection shows in its drawer: ad spend this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-pinterest'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, minor: number): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `pinterest:${month}:USD`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency: 'USD', rows: monthRows(minor, 'USD') }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('spent on Pinterest ads, in the connection details', () => {
  it('is this month’s spend, and shows nothing until a sync has answered', async () => {
    const srv = await startServer({ scripted: ['pinterest'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'pinterest', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 34_56), snapshot(id, '2026-09', 999_00)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 34_56, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
