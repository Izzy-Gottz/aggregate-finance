// The one line an AdSense connection shows in its drawer: estimated earnings this month. App only.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { monthRows } from '@agfn/connector-adsense'
import { connectProvider, entities, SCENARIO_TODAY, signIn, startServer } from './scenarios/harness.ts'

const THIS_MONTH = SCENARIO_TODAY.slice(0, 7)

const snapshot = (connectionId: string, month: string, currency: string, earned: number, paid: number): NormalizedEvent =>
  ({ type: 'report.snapshot', externalId: `adsense:${month}:${currency}`, connectionId, kind: 'profit_and_loss', from: `${month}-01`, to: `${month}-28`, basis: 'accrual', currency, rows: monthRows({ earned, paid }, currency) }) as NormalizedEvent

type Detail = { storeSales?: Array<{ minor: number; currency: string }> }

describe('earned on AdSense, in the connection details', () => {
  it('is this month’s estimate, and not what was paid', async () => {
    const srv = await startServer({ scripted: ['adsense'] })
    try {
      const s = await signIn(srv, `owner${Math.random().toString(36).slice(2, 9)}@example.com`, 'Demo Company')
      const company = (await entities(s))['Demo Company']!
      const source = await connectProvider(srv, s, 'adsense', { entityId: company, config: {} })
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body).not.toHaveProperty('storeSales')
      source.push((id) => [snapshot(id, THIS_MONTH, 'USD', 34_56, 1108_05), snapshot(id, '2026-09', 'USD', 999_00, 0)])
      await source.sync()
      expect((await s.get<Detail>(`/api/connections/${source.id}`)).body.storeSales).toEqual([{ minor: 34_56, currency: 'USD' }])
    } finally {
      await srv.close()
    }
  })
})
