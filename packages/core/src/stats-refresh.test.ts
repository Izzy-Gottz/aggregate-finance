// Planner statistics after an import (Postgres). Seen on hosted: once requests ran as the restricted app role, ANALYZE
// only warned and skipped, and statistics taken at a fill's first settle described nearly empty tables, so a fresh
// demo's reads took seconds. The refresh runs as the tables' owner, says so when it can't, and waits for a burst to end.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, rlsPool, withBypass, withWorkspace, type DbHandle } from '@agfn/db'
import { sql, type Kysely } from 'kysely'
import { KyselyLedgerStore } from './kysely-store.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('refreshStats on Postgres with row-level security', () => {
  let h: DbHandle<any> | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  async function setup(bypassAs?: string) {
    process.env.AGFN_PG_RLS = '1'
    let ready = false
    h = await connectPglite<any>({
      wrapPool: (p) => {
        const pool = rlsPool(exclusivePool(p), { role: 'agfn_app' })
        if (!bypassAs) return pool
        // A deployment where even bypass work lands on a role that doesn't own the tables.
        const wrapped = Object.create(pool)
        wrapped.connect = async () => {
          const c = await pool.connect()
          if (ready) await c.query(`set role ${bypassAs}`)
          return c
        }
        return wrapped
      },
    })
    await withBypass('test', async () => {
      await migrateToLatest(h!.db as Kysely<any>)
      await ensureAppRole(h!.db as Kysely<any>)
    })
    delete process.env.AGFN_PG_RLS
    ready = true
    return new KyselyLedgerStore(h.db as never)
  }

  it('runs as the owner even when called from inside a request (the restricted role)', async () => {
    const store = await setup()
    expect(await withWorkspace('ws_1', () => store.refreshStats())).toBe(true)
  })

  it('big tables are left to autoanalyze: an ANALYZE sample on a small compute evicted the hot pages (hosted, 13.8 s)', async () => {
    const store = await setup()
    await withBypass('test', () => (h!.db as Kysely<any>).executeQuery(sql`update pg_class set reltuples = 1600000 where relname = 'journal_lines'`.compile(h!.db as Kysely<any>)))
    expect(await withWorkspace('ws_1', () => store.refreshStats())).toBe(false)
  })

  it('a role that does not own the tables skips with one warning instead of silently', async () => {
    const store = await setup('agfn_app')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await withWorkspace('ws_1', () => store.refreshStats())).toBe(false)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/planner statistics not refreshed.*agfn_app/)
    warn.mockRestore()
  })
})

describe('when statistics are refreshed after imports', () => {
  let k: Kit
  afterEach(async () => {
    vi.useRealTimers()
    await k.close()
  })

  it('once, after a burst of settles goes quiet, not at its first settle; a long burst is spaced, the trailing run is not', async () => {
    k = await makeKit('memory')
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    const refresh = vi.fn(async () => true)
    ;(k.engine.store as { refreshStats?: () => Promise<boolean> }).refreshStats = refresh
    vi.useFakeTimers()
    const settle = async (n: number) => {
      await k.engine.postBatch(k.ws, [txn(bank, `2026-09-${String(n).padStart(2, '0')}`, -1_000 * n)], { settleLater: true })
      await k.engine.settle(k.ws, bank.connectionId as string)
    }
    for (let i = 1; i <= 4; i++) {
      await settle(i)
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(1)
    // The next company settles soon after and goes quiet: refreshed 5 s later, not held for a gap.
    await settle(10)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    // A long burst (a settle every 4 s): forced at 30 s, then not again within 30 s of that run.
    for (let i = 0; i < 20; i++) {
      await settle(11 + (i % 15))
      await vi.advanceTimersByTimeAsync(4_000)
    }
    const calls = refresh.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(calls).toBeLessThanOrEqual(4)
  })
})
