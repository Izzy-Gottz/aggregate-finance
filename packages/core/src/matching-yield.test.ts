// A demo fill's matching ran every pass in one go, and its payout pass compared every payout with every bank row: on a
// shared CPU that held the event loop for seconds (staging, 2026-10-13). The engine's matcher now lets other work run
// between passes, and finds the same matches.
import { afterEach, describe, expect, it } from 'vitest'
import { findMatches, findMatchesYielding } from './matching.ts'
import { makeKit, stripe, txn, type Kit } from './test-kit.ts'

describe('matching lets other work run', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('yields between passes and proposes exactly what the one-go matcher does', async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const proc = await k.account({ entityId: acme, name: 'Stripe', type: 'processor' as never })
    const evs = []
    for (let i = 0; i < 200; i++) {
      const day = `2026-0${7 + (i % 3)}-${String(1 + (i % 27)).padStart(2, '0')}`
      evs.push(stripe(proc, day, 'payout', -(10_000 + i), 0), txn(bank, day, 10_000 + i, { counterparty: `Deposit ${i}` }))
    }
    await k.engine.postBatch(k.ws, evs)
    const store = k.engine.store
    const input = {
      records: await store.listRecords(k.ws, { statuses: ['posted', 'recorded'] }),
      accounts: new Map((await k.engine.directory.listSourceAccounts(k.ws)).map((a) => [a.id, a])),
      entities: new Map((await k.engine.directory.listEntities(k.ws)).map((e) => [e.id, e])),
      links: [],
      reportingMinor: new Map<string, number>(),
    }
    const once = findMatches(input)
    expect(once.filter((p) => p.type === 'payout').length).toBeGreaterThan(100)

    let ticks = 0
    let running = true
    const tick = (): void => {
      if (!running) return
      ticks++
      setImmediate(tick)
    }
    setImmediate(tick)
    const yielded = await findMatchesYielding(input)
    running = false
    expect(yielded).toEqual(once)
    expect(ticks).toBeGreaterThanOrEqual(10) // one per pass, give or take
  })
})
