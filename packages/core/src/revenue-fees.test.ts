// Revenue is gross of processor fees; the fees are their own expense, and the metric says so (an AI summing the
// net processor rows would otherwise get a different number).
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, type Kit } from './test-kit.ts'

describe('revenue and processor fees', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('charges count at gross, fees post to Processor fees, and the formula explains the difference', async () => {
    k = await makeKit('memory', { now: '2026-10-11T20:00:00.000Z' })
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'stripe' })
    const acc = await k.account({ entityId: acme, type: 'processor_balance', connectionId: conn })
    await k.engine.postBatch(k.ws, [stripe(acc, '2026-10-05', 'charge', 25_000, 755), stripe(acc, '2026-10-06', 'charge', 8_900, 288)])
    const rev = await k.engine.metric('revenue', { workspaceId: k.ws, entityIds: [acme], from: '2026-10-01', to: '2026-10-11', basis: 'cash' } as never)
    expect(rev.value).toEqual({ minor: 33_900, currency: 'USD' })
    expect(rev.formula).toContain('Gross of processor fees')
    expect(await k.bal(acme, 'processor_fees', 'cash')).toBe(1_043)
  })
})
