import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from './index.ts'

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('newId', () => {
  it('is 26 chars, unique and sortable by time', () => {
    const a = newId(1_700_000_000_000)
    const b = newId(1_700_000_000_001)
    expect(a).toHaveLength(26)
    expect(a < b).toBe(true)
    expect(new Set(Array.from({ length: 1000 }, () => newId())).size).toBe(1000)
  })

  it('sorts in creation order within one millisecond (files cursor: id > last)', () => {
    const ids = Array.from({ length: 1000 }, () => newId(1_700_000_000_500))
    expect([...ids].sort()).toEqual(ids)
    expect(new Set(ids).size).toBe(1000)
    expect(ids.every((id) => id.startsWith(ids[0]!.slice(0, 10)))).toBe(true)
  })
})

describe('sqlite + migrations', () => {
  it('migrates and round-trips core rows', async () => {
    h = connect<CoreTables>('sqlite::memory:')
    const res = await migrateToLatest(h.db)
    expect(res.results?.some((r) => r.migrationName === '0001_core' && r.status === 'Success')).toBe(true)

    const ws = newId()
    await h.db.insertInto('workspaces').values({ id: ws, name: 'Test', base_currency: 'USD', created_at: nowIso() }).execute()
    await h.db
      .insertInto('entities')
      .values({ id: newId(), workspace_id: ws, kind: 'company', name: 'Acme', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null })
      .execute()
    const rows = await h.db.selectFrom('entities').selectAll().where('workspace_id', '=', ws).execute()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('Acme')

    // Re-running is a no-op.
    const again = await migrateToLatest(h.db)
    expect(again.results).toEqual([])
  })

  it('enforces foreign keys', async () => {
    h = connect<CoreTables>('sqlite::memory:')
    await migrateToLatest(h.db)
    await expect(
      h.db.insertInto('memberships').values({ id: newId(), workspace_id: 'nope', person_id: 'nope', role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute(),
    ).rejects.toThrow()
  })
})

// A starved pool fails a checkout with one clear line (pool state, call site) instead of hanging (2026-10-13 stall).
describe('pool checkout timeout', () => {
  it('turns pg’s connect timeout into a named busy error and logs the pool state once per failure', async () => {
    const { failFastCheckout, PoolBusyError } = await import('./index.ts')
    const pool = { connect: async () => { throw new Error('timeout exceeded when trying to connect') } }
    const stats = [{ name: 'main', totalCount: 3, idleCount: 0, waitingCount: 7, options: { max: 3 } }]
    const warns: string[] = []
    const ow = console.warn
    console.warn = (m: string) => void warns.push(m)
    try {
      await expect(failFastCheckout(pool, stats, 15_000).connect()).rejects.toBeInstanceOf(PoolBusyError)
    } finally {
      console.warn = ow
    }
    expect(warns).toHaveLength(1)
    expect(warns[0]).toMatch(/database pool busy: no connection within 15000 ms \(main: max 3, open 3, idle 0, waiting 7\) at /)
    // Any other failure passes through untouched.
    const broken = { connect: async () => { throw new Error('ECONNREFUSED') } }
    await expect(failFastCheckout(broken, stats).connect()).rejects.toThrow('ECONNREFUSED')
  })
})
