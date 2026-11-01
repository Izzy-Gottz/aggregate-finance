import { afterEach, describe, expect, it } from 'vitest'
import { connect, connectPglite, migrateToLatest, type CoreTables, type DbHandle } from '@agfn/db'
import { DbRateLimiter, MemoryRateLimiter, type RateLimiter } from './ratelimit.ts'
import type { McpTables } from './store/schema.ts'

let h: DbHandle<CoreTables & McpTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

async function behaves(limiter: RateLimiter) {
  const t0 = 1_700_000_000_000
  for (let i = 0; i < 3; i++) expect(await limiter.hit('g1', 3, 60_000, t0 + i)).toBe(0)
  const retry = await limiter.hit('g1', 3, 60_000, t0 + 10)
  expect(retry).toBeGreaterThan(0)
  expect(retry).toBeLessThanOrEqual(60)
  // Other keys are independent.
  expect(await limiter.hit('g2', 3, 60_000, t0 + 10)).toBe(0)
  // Two windows later everything has expired.
  expect(await limiter.hit('g1', 3, 60_000, t0 + 130_000)).toBe(0)
}

describe('rate limiters', () => {
  it('memory', async () => {
    await behaves(new MemoryRateLimiter())
  })

  it('database (SQLite), shared between two instances', async () => {
    h = connect<CoreTables & McpTables>('sqlite::memory:')
    await migrateToLatest(h.db)
    await behaves(new DbRateLimiter(h.db))
    const a = new DbRateLimiter(h.db)
    const b = new DbRateLimiter(h.db)
    const t = 1_800_000_000_000
    expect(await a.hit('shared', 2, 60_000, t)).toBe(0)
    expect(await b.hit('shared', 2, 60_000, t + 1)).toBe(0)
    expect(await a.hit('shared', 2, 60_000, t + 2)).toBeGreaterThan(0)
    expect(await b.hit('shared', 2, 60_000, t + 3)).toBeGreaterThan(0)
  })

  it('database (Postgres via PGlite)', async () => {
    h = await connectPglite<CoreTables & McpTables>()
    await migrateToLatest(h.db)
    await behaves(new DbRateLimiter(h.db))
  })
})
