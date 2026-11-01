// Confirming a suggested bill payment inside one ledger transaction moves it onto AP, even after the transaction read
// both ends' links in one call. The union of from/to probes returned such a link twice, cached twice; saving the decision
// updated one copy and the stale one won, so the payment stayed an expense (demo tidy: AP $28.7k over the open bills).
import { afterEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, txn, type Backend, type Kit } from './test-kit.ts'

describe.each(['memory', 'sqlite', 'pglite'] as Backend[])('a decision inside a transaction (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('reposts the payment after both ends were read together', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme })
    const a = await k.account({ entityId: acme, name: 'Checking', connectionId: conn })
    await k.engine.postBatch(k.ws, [
      invoice(conn, { direction: 'payable', number: 'PPC-1', counterparty: 'Pier Packaging Co', issueDate: '2026-09-01', dueDate: '2026-09-15', total: { minor: 40_000, currency: 'USD' } }),
      txn(a, '2026-09-10', -20_000, { counterparty: 'Pier Packaging Co', rawText: 'PIER PACKAGING CO ACH PPC-1' }),
      txn(a, '2026-09-13', -20_000, { counterparty: 'Pier Packaging Co', rawText: 'PIER PACKAGING CO ACH PPC-1' }),
    ])
    const links = (await k.engine.store.listLinks(k.ws, { statuses: ['proposed'] })).filter((l) => l.type === 'invoice_payment')
    expect(links).toHaveLength(2)
    expect(await k.bal(acme, 'ap', 'accrual')).toBe(-40_000)
    await k.engine.transaction(async () => {
      // Both ends in one read, as the matcher and the transaction list do.
      expect(await k.engine.store.listLinks(k.ws, { recordIds: [links[0]!.fromId, links[0]!.toId, links[1]!.fromId, links[1]!.toId] })).toHaveLength(2)
      for (const l of links) await k.engine.decideLink(k.ws, l.id, 'confirmed', null)
    })
    expect(await k.bal(acme, 'ap', 'accrual')).toBe(0)
  })
})
