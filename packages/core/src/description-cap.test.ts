// A processor row's own description is display-only provider text: kept, but never more than 500 characters.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, type Kit } from './test-kit.ts'

describe('processor descriptions', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('are kept as given, capped at 500 characters', async () => {
    k = await makeKit('memory')
    const acme = await k.company('Acme')
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
    await k.engine.postBatch(k.ws, [
      stripe(st, '2026-09-01T14:00:00.000Z', 'charge', 18_00, 82, { externalId: 'a', description: 'Subscription update' }),
      stripe(st, '2026-09-01T15:00:00.000Z', 'charge', 32_00, 123, { externalId: 'b', description: 'x'.repeat(2_000) }),
    ])
    const rows = await k.engine.store.listRecords(k.ws, { eventTypes: ['processor.balance_txn'] })
    const desc = (id: string) => {
      const e = rows.find((r) => r.externalId === id)?.event
      return e?.type === 'processor.balance_txn' ? e.description : undefined
    }
    expect(desc('a')).toBe('Subscription update')
    expect(desc('b')).toHaveLength(500)
  })
})
