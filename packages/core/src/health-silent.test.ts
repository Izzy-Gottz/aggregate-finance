// A connected account that never reported a balance makes cash unknown, so the Workspace can't say "All reconciled"
// (seen on 43's Square staging run).
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, type Backend, type Kit } from './test-kit.ts'
import { createFinance } from './finance.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('data health: balances never reported (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('names the account until it reports; then all reconciled again', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const bank = await k.connection({ entityId: acme, key: 'mercury' })
    const acc = await k.account({ entityId: acme, connectionId: bank, name: 'Mercury' })
    let h = await k.engine.dataHealth(k.ws, [acme])
    expect(h.line).toBe('1 thing needs a look: 1 balance not reported yet')
    expect(h.items).toEqual([{ kind: 'stale_source', entityId: acme, text: "Mercury hasn't reported a balance yet", refId: acc.id }])
    await k.engine.post(k.ws, snapshot(acc, '2026-10-11T10:00:00.000Z', 12_000))
    h = await k.engine.dataHealth(k.ws, [acme])
    expect(h.line).toBe('All reconciled')
  })

  it('a synced processor balance with no sales yet is $0, not silent (Gumroad never sends a balance)', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const gr = await k.connection({ entityId: acme, key: 'gumroad' })
    const acc = await k.account({ entityId: acme, type: 'processor_balance', connectionId: gr, name: 'Seller balance (Gumroad)', includeInCash: true })
    expect((await k.engine.dataHealth(k.ws, [acme])).line).toBe('All reconciled')
    const [view] = await createFinance(k.engine).reader.accounts({ workspaceId: k.ws, entityIds: [acme] }, {})
    expect([view?.id, view?.balance]).toEqual([acc.id, { minor: 0, currency: 'USD' }])
  })
})
