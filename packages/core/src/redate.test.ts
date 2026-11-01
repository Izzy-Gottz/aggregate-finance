// A time zone change (or records kept before there was one) moves balances and processor rows to the local day.
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryDirectory } from './memory-store.ts'
import { makeKit, snapshot, stripe, type Kit } from './test-kit.ts'

describe('re-dating instants to the local day', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('moves what fell on the wrong day, reposts it, and leaves the rest alone', async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z', timeZone: 'UTC' })
    const acme = await k.company('Acme')
    const proc = await k.account({ entityId: acme, name: 'Stripe', type: 'processor' as never })
    // 23:30 UTC on Sep 30 is 19:30 in New York: still Sep 30. 02:00 UTC on Oct 1 is Sep 30 in New York.
    await k.engine.postBatch(k.ws, [stripe(proc, '2026-09-30T23:30:00Z', 'charge', 10_000, 320), stripe(proc, '2026-10-01T02:00:00Z', 'charge', 5_000, 175), snapshot(proc, '2026-10-01T03:00:00Z', 14_505)])
    expect(await k.bal(acme, 'revenue', 'cash', '2026-09-30')).toBe(-10_000)
    ;(k.engine.directory as MemoryDirectory).setTimeZone(k.ws, 'America/New_York')
    await k.engine.directoryChanged(k.ws)
    expect(await k.bal(acme, 'revenue', 'cash', '2026-09-30')).toBe(-15_000)
    expect(await k.tb(acme)).toBe(0)
    const [snap] = await k.engine.store.listRecords(k.ws, { eventTypes: ['balance.snapshot'] })
    expect(snap?.date).toBe('2026-09-30')
    expect(await k.engine.redate(k.ws)).toBe(0) // nothing left to move
  })
})
