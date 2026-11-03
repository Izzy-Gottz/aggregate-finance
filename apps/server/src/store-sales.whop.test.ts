// The one line a Whop connection shows in its drawer: the net of Whop's income statement this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-whop'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)
const FAMILIES = ['payments', 'refunds', 'fees']

const snapshot = (connectionId: string, month: string, currency: string, payments: number, refunds: number, fees: number): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `whop:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'cash', currency, rows: monthRows({ payments, refunds, fees }, FAMILIES, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('Whop’s income statement, in the connection details', () => {
  it('is this month’s net, in Whop’s sign', async () => {
    const srv = await startServer({ scripted: ['whop'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'whop', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'USD', 1000_00, -100_00, -30_00), snapshot(id, '2026-09', 'USD', 999_00, 0, 0)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 870_00, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
