// From 43's fresh-user e2e on staging (2026-10-13): long-overdue receivables aren't income expected today, and a
// connection added minutes ago that is still importing isn't "not synced in over a day".
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { invoice, makeKit, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('e2e fixes (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('upcoming: a receivable over 30 days late is left out; a late bill you owe is still due today', async () => {
    k = await makeKit(backend, { now: '2026-10-13T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    await k.engine.postBatch(k.ws, [
      invoice(qb, { externalId: 'old', number: 'INV-OLD', counterparty: 'Slow Co', total: usd(1_350_00), issueDate: '2026-06-01', dueDate: '2026-07-01' }),
      invoice(qb, { externalId: 'late', number: 'INV-LATE', counterparty: 'Late Co', total: usd(400_00), issueDate: '2026-09-01', dueDate: '2026-10-01' }),
      invoice(qb, { externalId: 'next', number: 'INV-NEXT', counterparty: 'Soon Co', total: usd(200_00), issueDate: '2026-10-01', dueDate: '2026-10-20' }),
      invoice(qb, { externalId: 'bill', number: 'B-1', counterparty: 'Landlord', direction: 'payable', total: usd(900_00), issueDate: '2026-06-01', dueDate: '2026-07-01' }),
    ])
    const up = await createFinance(k.engine).reader.upcoming({ workspaceId: k.ws, entityIds: [acme] }, 30)
    expect(up.map((u) => [u.kind, u.what, u.date]).sort()).toEqual([
      ['bill', 'B-1 Landlord', '2026-10-13'],
      ['expected_income', 'INV-LATE Late Co', '2026-10-13'],
      ['expected_income', 'INV-NEXT Soon Co', '2026-10-20'],
    ])
  })

  it('a connection still on its first import is not stale; one connected days ago that never synced is', async () => {
    k = await makeKit(backend, { now: '2026-10-13T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const fresh = await k.connection({ entityId: acme, key: 'demo', lastSuccessAt: null, createdAt: '2026-10-13T11:55:00.000Z' })
    const old = await k.connection({ entityId: acme, key: 'plaid', lastSuccessAt: null, createdAt: '2026-10-10T09:00:00.000Z' })
    const synced = await k.connection({ entityId: acme, key: 'stripe', lastSuccessAt: '2026-10-11T09:00:00.000Z' })
    const s = await createFinance(k.engine).reader.sources({ workspaceId: k.ws, entityIds: [acme] })
    const stale = Object.fromEntries(s.map((x) => [x.connectionId, x.stale]))
    expect(stale).toMatchObject({ [fresh]: false, [old]: true, [synced]: true })
    const h = await k.engine.dataHealth(k.ws, [acme])
    expect(h.items.filter((i) => i.kind === 'stale_source').map((i) => i.refId).sort()).toEqual([old, synced].sort())
  })
})
