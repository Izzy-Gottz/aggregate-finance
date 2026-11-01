// cashHistory answers the `cash` metric for many days in one pass: it must agree with the metric on every day.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, txn, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('cash history (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('equals the cash metric on each day: provider balances where read, the ledger before them, every currency', async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const chk = await k.account({ entityId: acme, name: 'Checking' })
    const sav = await k.account({ entityId: acme, name: 'Savings' })
    const eur = await k.account({ entityId: acme, name: 'Euro account', currency: 'EUR' })
    const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex' })
    for (const d of ['2026-05-31', '2026-06-30', '2026-07-05', '2026-07-31', '2026-08-30', '2026-08-31', '2026-09-30', '2026-10-09']) k.rates.set(d, 'EUR', 'USD', d < '2026-08-01' ? '1.10' : '1.07')
    await k.engine.postBatch(k.ws, [
      txn(chk, '2026-06-10', 50_000, { counterparty: 'Client' }),
      txn(chk, '2026-07-12', -20_000, { counterparty: 'Rent' }),
      snapshot(chk, '2026-07-31', 130_000),
      txn(chk, '2026-08-15', -5_000, { counterparty: 'Tools' }),
      snapshot(chk, '2026-08-31T09:00:00Z', 124_000),
      snapshot(chk, '2026-08-31T18:00:00Z', 125_000), // the later read that day wins
      txn(sav, '2026-07-01', 300_000, { counterparty: 'Transfer in' }), // never read: ledger only
      txn(eur, '2026-07-05', 10_000, { counterparty: 'Kunde' }),
      snapshot(eur, '2026-09-30', 12_000),
      txn(card, '2026-08-02', -7_500, { counterparty: 'Notion' }),
    ])
    const days = ['2026-05-31', '2026-06-30', '2026-07-31', '2026-08-30', '2026-08-31', '2026-09-30', '2026-10-09']
    const history = await k.engine.cashHistory(k.ws, { entityIds: [acme], days })
    const metric = await Promise.all(days.map((to) => k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme], to })))
    expect(history).toEqual(metric.map((m) => m.value))
    expect(history[0]).toBeNull() // nothing reported yet: unknown, as the metric says
    expect(history[4]?.minor).toBeGreaterThan(0)
  })
})
