// The overview's day is the workspace's own day, as metrics use: at 8 pm in Los Angeles on Sep 30 it is already
// Oct 1 in UTC, and the overview used to answer for October (another month's burn, invoices not yet overdue).
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { invoice, makeKit, txn, usd, type Kit } from './test-kit.ts'

describe('overview day', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('uses the workspace time zone, like get_metric', async () => {
    k = await makeKit('memory', { now: '2026-10-01T03:00:00.000Z', timeZone: 'America/Los_Angeles' })
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-06-01', -300_000),
      txn(bank, '2026-07-01', -300_000),
      txn(bank, '2026-08-01', -300_000),
      txn(bank, '2026-09-01', -900_000),
      // Due Sep 30 local: not overdue yet on Sep 30.
      invoice(qb, { externalId: 'i', total: usd(10_000), issueDate: '2026-09-01', dueDate: '2026-09-30' }),
    ])
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const o = await createFinance(k.engine).reader.overview(scope)
    const metric = await k.engine.metric('net_burn', scope)
    // Sep 30 local: the last 3 full months are Jun-Aug (300,000 a month), not Jul-Sep.
    expect(metric.value).toEqual(usd(300_000))
    expect(o.entities[0]?.netBurn3mo).toEqual(usd(300_000))
    expect(o.attention.map((a) => a.kind)).not.toContain('overdue_invoice')
  })
})
