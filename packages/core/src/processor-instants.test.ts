// Processor rows and balances carry instants: a payout at 02:00Z the next UTC day is still the same local day in
// New York, but after a 23:59Z balance. Checks compare by instant, so this is no gap; a real gap still fails.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, stripe, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('processor checks across a local-day edge (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z', timeZone: 'America/New_York' })
    const acme = await k.company('Acme')
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
    return { acme, st }
  }

  it('a payout just after an evening balance is not a gap', async () => {
    const { acme, st } = await setup()
    await k.engine.postBatch(k.ws, [
      snapshot(st, '2026-09-01T12:00:00Z', 0),
      stripe(st, '2026-09-02T15:00:00Z', 'charge', 10_000, 0),
      snapshot(st, '2026-09-02T23:59:00Z', 10_000), // 19:59 in New York
      stripe(st, '2026-09-03T02:00:00Z', 'payout', -10_000, 0), // 22:00 the same New York day
      snapshot(st, '2026-09-03T23:59:00Z', 0),
    ])
    const checks = (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.name === 'processor' || c.name === 'balance_identity')
    expect(checks.filter((c) => c.status !== 'ok').map((c) => c.message)).toEqual([])
  })

  it('a real gap still fails (no slack)', async () => {
    const { acme, st } = await setup()
    await k.engine.postBatch(k.ws, [
      snapshot(st, '2026-09-01T12:00:00Z', 0),
      stripe(st, '2026-09-02T15:00:00Z', 'charge', 10_000, 0),
      snapshot(st, '2026-09-02T23:59:00Z', 10_000),
      stripe(st, '2026-09-03T02:00:00Z', 'payout', -10_000, 0),
      snapshot(st, '2026-09-03T23:59:00Z', 500), // 5.00 nobody explains
    ])
    const failing = (await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => (c.name === 'processor' || c.name === 'balance_identity') && c.status !== 'ok')
    expect(failing.map((c) => c.name).sort()).toEqual(['balance_identity', 'processor'])
  })
})
