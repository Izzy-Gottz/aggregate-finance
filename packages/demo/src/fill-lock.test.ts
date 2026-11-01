// Two live machines admitting from the demo line at the same moment must not fill past the limit, nor start one demo
// twice (c7's multi-machine audit, docs/qa/c7-multimachine-2026-10-15.md). Two handles on one SQLite file stand in for two
// machines here; set AGFN_TEST_PG_URL to also run it on two separate Postgres pools (the advisory lock's real job).
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { admitAcrossMachines, admitDemoFills } from './fill-queue.ts'
import { createDemoWorkspace, queueDemoFill } from './index.ts'

const url = process.env.AGFN_TEST_PG_URL
const T0 = new Date('2026-10-15T18:00:00Z')
const handles: Array<DbHandle<CoreTables>> = []
const dirs: string[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function lineOf(db: DbHandle<CoreTables>['db'], n: number): Promise<string[]> {
  const keys = loadKeyRing({ AGFN_MASTER_KEY: randomBytes(32).toString('base64') })
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const personId = newId()
    await db.insertInto('people').values({ id: personId, auth_user_id: null, name: `P${i}`, email: `p${i}-${personId}@example.com`, created_at: nowIso() }).execute()
    const d = await createDemoWorkspace({ db, keys, now: () => T0 }, { personId, historyDays: 5 })
    await queueDemoFill(db, d.workspaceId, new Date(T0.getTime() + i * 1000))
    out.push(d.workspaceId)
  }
  return out
}

describe('the demo line on two machines', () => {
  it('admits one demo in all when both machines admit at once with a limit of 1 (SQLite file, two handles)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-fill-lock-'))
    dirs.push(dir)
    const a = connect<CoreTables>(`sqlite:${join(dir, 'agfn.db')}`)
    handles.push(a)
    await migrateToLatest(a.db)
    const b = connect<CoreTables>(`sqlite:${join(dir, 'agfn.db')}`)
    handles.push(b)
    await lineOf(a.db, 3)
    const now = new Date(T0.getTime() + 10_000)
    const [x, y] = await Promise.all([admitDemoFills(a.db, { limit: 1, now }), admitDemoFills(b.db, { limit: 1, now })])
    const admitted = [...x, ...y].map((r) => r.workspaceId)
    expect(admitted).toHaveLength(1)
  })

  it.runIf(!!url)('admits at most the limit across two separate Postgres pools', async () => {
    const a = connect<CoreTables>(url!)
    handles.push(a)
    await migrateToLatest(a.db)
    const b = connect<CoreTables>(url!)
    handles.push(b)
    await a.db.deleteFrom('settings').where('key', 'in', ['demo_fill_waiting', 'demo_fill_started']).execute()
    await lineOf(a.db, 4)
    const now = new Date(T0.getTime() + 10_000)
    const [x, y] = await Promise.all([admitAcrossMachines(a.db, { limit: 2, now }), admitAcrossMachines(b.db, { limit: 2, now })])
    const admitted = [...x, ...y].map((r) => r.workspaceId)
    expect(admitted).toHaveLength(2)
    expect(new Set(admitted).size).toBe(2)
  })
})
