// Hosted fills one demo at a time; the rest wait in a fair first-come line and are told their place honestly.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { admitDemoFills, createDemoWorkspace, demoFillPlace, queueDemoFill } from './index.ts'

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const T0 = new Date('2026-10-13T18:00:00Z')
const at = (s: number) => new Date(T0.getTime() + s * 1000)

async function setup(n: number) {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const keys = loadKeyRing({ AGFN_MASTER_KEY: randomBytes(32).toString('base64') })
  const demos: Array<{ ws: string; first: string; personId: string }> = []
  for (let i = 0; i < n; i++) {
    const personId = newId()
    await h.db.insertInto('people').values({ id: personId, auth_user_id: null, name: `P${i}`, email: `p${i}@example.com`, created_at: nowIso() }).execute()
    const d = await createDemoWorkspace({ db: h.db, keys, now: () => T0 }, { personId, historyDays: 5 })
    demos.push({ ws: d.workspaceId, first: d.connections[0]!, personId })
  }
  return { db: h.db, demos }
}

async function setupMore(db: DbHandle<CoreTables>['db'], n: number): Promise<string[]> {
  const keys = loadKeyRing({ AGFN_MASTER_KEY: randomBytes(32).toString('base64') })
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const personId = newId()
    await db.insertInto('people').values({ id: personId, auth_user_id: null, name: `Q${i}`, email: `q${i}@example.com`, created_at: nowIso() }).execute()
    out.push((await createDemoWorkspace({ db, keys, now: () => T0 }, { personId, historyDays: 5 })).workspaceId)
  }
  return out
}

describe('the demo fill line', () => {
  it('admits one at a time in arrival order, tells the rest their place, and moves on when a fill finishes', async () => {
    const { db, demos } = await setup(3)
    const [a, b, c] = demos as [(typeof demos)[0], (typeof demos)[0], (typeof demos)[0]]
    // Arrival order, not id order.
    await queueDemoFill(db, b.ws, at(1))
    await queueDemoFill(db, a.ws, at(2))
    await queueDemoFill(db, c.ws, at(3))
    expect(await demoFillPlace(db, a.ws, { limit: 1, now: at(4) })).toEqual({ position: 2, minutes: 3 })

    // The first in line starts, with its first company's import; the others wait.
    expect(await admitDemoFills(db, { limit: 1, now: at(5) })).toEqual([{ workspaceId: b.ws, connectionId: b.first }])
    expect(await admitDemoFills(db, { limit: 1, now: at(6) })).toEqual([])
    expect(await demoFillPlace(db, b.ws, { limit: 1, now: at(6) })).toBeNull()
    expect(await demoFillPlace(db, a.ws, { limit: 1, now: at(6) })).toEqual({ position: 1, minutes: 3 })
    expect(await demoFillPlace(db, c.ws, { limit: 1, now: at(6) })).toEqual({ position: 2, minutes: 4 })

    // B finishes: A is next.
    await db.insertInto('settings').values({ workspace_id: b.ws, key: 'demo_ready', value_json: 'true', updated_at: at(65).toISOString() }).execute()
    expect(await admitDemoFills(db, { limit: 1, now: at(66) })).toEqual([{ workspaceId: a.ws, connectionId: a.first }])

    // A gets stuck: after 15 minutes it no longer holds the line, and C starts.
    expect(await admitDemoFills(db, { limit: 1, now: at(66 + 14 * 60) })).toEqual([])
    expect(await admitDemoFills(db, { limit: 1, now: at(66 + 16 * 60) })).toEqual([{ workspaceId: c.ws, connectionId: c.first }])
  })

  it('estimates from real fill times: a ready flag written hours after the start (a pool slot handed over) is not a fill time', async () => {
    const { db, demos } = await setup(6)
    const ready = (ws: string, s: number) => db.insertInto('settings').values({ workspace_id: ws, key: 'demo_ready', value_json: 'true', updated_at: at(s).toISOString() }).execute()
    const started = (ws: string, s: number) => db.insertInto('settings').values({ workspace_id: ws, key: 'demo_fill_started', value_json: 'true', updated_at: at(s).toISOString() }).execute()
    // Three pool slots that started long ago and were marked ready hours later (handed over, caught up overnight).
    for (const [i, d] of demos.slice(0, 3).entries()) {
      await db.insertInto('settings').values({ workspace_id: d.ws, key: 'demo_pool', value_json: 'true', updated_at: at(i).toISOString() }).execute()
      await started(d.ws, i)
      await ready(d.ws, 3 * 3600 + i)
    }
    // Two person fills that took 80 seconds each.
    await started(demos[3]!.ws, 4000)
    await ready(demos[3]!.ws, 4080)
    await started(demos[4]!.ws, 4100)
    await ready(demos[4]!.ws, 4180)
    await started(demos[5]!.ws, 4200)
    await ready(demos[5]!.ws, 4280)
    const waiter = (await setupMore(db, 1))[0]!
    await queueDemoFill(db, waiter, at(5000))
    // Next in line with nothing filling and 3 slots: a third of an 80 s fill, so about a minute, not hours.
    expect(await demoFillPlace(db, waiter, { limit: 3, now: at(5001) })).toEqual({ position: 1, minutes: 1 })
  })

  it('pool refills, slower behind people, are not in the estimate', async () => {
    const { db, demos } = await setup(6)
    const flag = (ws: string, key: string, s: number) => db.insertInto('settings').values({ workspace_id: ws, key, value_json: 'true', updated_at: at(s).toISOString() }).execute()
    // Three pool refills that took 8 minutes each (still in the pool).
    for (const [i, d] of demos.slice(0, 3).entries()) {
      await flag(d.ws, 'demo_pool', i)
      await flag(d.ws, 'demo_fill_started', 100 + i)
      await flag(d.ws, 'demo_pool_ready', 100 + i + 480)
    }
    // Three people's fills of 150 s.
    for (const [i, d] of demos.slice(3).entries()) {
      await flag(d.ws, 'demo_fill_started', 1000 + i * 200)
      await flag(d.ws, 'demo_ready', 1150 + i * 200)
    }
    const waiter = (await setupMore(db, 1))[0]!
    await queueDemoFill(db, waiter, at(2000))
    // Next in line, 3 slots free: a third of a 150 s fill, so 1 minute (8-minute refills would have made it 3).
    expect(await demoFillPlace(db, waiter, { limit: 3, now: at(2001) })).toEqual({ position: 1, minutes: 1 })
  })

  it('a person waiting goes ahead of pool refills, and pool refills don\u2019t count against their place', async () => {
    const { db, demos } = await setup(2)
    const [pool, person] = demos as [(typeof demos)[0], (typeof demos)[0]]
    await db.insertInto('settings').values({ workspace_id: pool.ws, key: 'demo_pool', value_json: 'true', updated_at: at(0).toISOString() }).execute()
    await queueDemoFill(db, pool.ws, at(1))
    await queueDemoFill(db, person.ws, at(2))
    expect(await demoFillPlace(db, person.ws, { limit: 1, now: at(3) })).toEqual({ position: 1, minutes: 2 })
    expect(await admitDemoFills(db, { limit: 1, now: at(4) })).toEqual([{ workspaceId: person.ws, connectionId: person.first }])
  })

  it('a wider limit admits that many at once, and a demo whose people left is dropped from the line', async () => {
    const { db, demos } = await setup(3)
    const [a, b, c] = demos as [(typeof demos)[0], (typeof demos)[0], (typeof demos)[0]]
    for (const [i, d] of [a, b, c].entries()) await queueDemoFill(db, d.ws, at(i))
    await db.updateTable('memberships').set({ revoked_at: nowIso() }).where('workspace_id', '=', a.ws).execute()
    expect((await admitDemoFills(db, { limit: 2, now: at(10) })).map((x) => x.workspaceId)).toEqual([b.ws, c.ws])
    expect(await demoFillPlace(db, a.ws, { limit: 2, now: at(10) })).toBeNull()
  })
})
