// The one line a Zeffy connection shows in its drawer: this month's online payments less refunds. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-zeffy'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, sales: number, refunds: number): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `zeffy:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ received: sales, refunds }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('online payments received through Zeffy, in the connection details', () => {
  it('is this month’s online payments less refunds, one line per currency, never added together', async () => {
    const srv = await startServer({ scripted: ['zeffy'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'zeffy', { entityId: company, config: { zone: 'America/Toronto' } })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'CAD', 1000_00, 150_25), snapshot(id, THIS_MONTH, 'USD', 119_00, 19_00), snapshot(id, '2026-09', 'CAD', 999_00, 0)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([
        { minor: 849_75, currency: 'CAD' },
        { minor: 100_00, currency: 'USD' },
      ])
    } finally {
      await srv.close()
    }
  })
})
