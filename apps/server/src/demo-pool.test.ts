// The demo pool (packages/demo pool.ts): a demo filled ahead of time is handed over cleanly. Nothing of the reserved
// person it was built for survives (no membership, invite, key, grant, session or activity), the audit trail starts
// with the new owner, and the demo is ready at once. With the pool empty, a new demo waits in the fill line.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { newId, nowIso, withBypass, type CoreTables } from '@agfn/db'
import { isDemoReady, poolStatus, stalledDemoImports } from '@agfn/demo'
import type { Kysely } from 'kysely'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { startDemoWorkspace, topUpDemoPool } from './demo-start.ts'
import { deleteIfMemberless } from './orphans.ts'

let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start() {
  const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent', AGFN_DEMO_POOL: '1', AGFN_DEMO_FILL_CONCURRENCY: '1' }
  booted = await boot({ config: { ...loadConfig(env), runWorker: false }, env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules(env)) })
  return booted
}

/** Run queued sync jobs like the worker would, until none are left (each sync's hooks admit the next fill). */
async function drain(b: Booted): Promise<void> {
  const db = b.services.db
  for (let i = 0; i < 40; i++) {
    const job = await withBypass('test', () => db.selectFrom('jobs').select(['id', 'unique_key']).where('kind', '=', 'connection.sync').where('status', '=', 'queued').orderBy('run_at').executeTakeFirst())
    if (!job) return
    await withBypass('test', () => db.deleteFrom('jobs').where('id', '=', job.id).execute())
    await withBypass('test', () => b.services.sync.sync(job.unique_key!))
  }
}

/** Every text column of every table that holds this value. */
async function mentions(db: Kysely<CoreTables>, value: string): Promise<string[]> {
  const out: string[] = []
  for (const t of await db.introspection.getTables()) {
    for (const c of t.columns) {
      if (!/char|text|^$/i.test(c.dataType)) continue
      const r = (await withBypass('test', () => (db as any).selectFrom(t.name).select((eb: any) => eb.fn.countAll().as('n')).where(c.name, '=', value).executeTakeFirst())) as { n: number | string }
      if (Number(r.n)) out.push(`${t.name}.${c.name}`)
    }
  }
  return out
}

describe('the demo pool', () => {
  it('hands a pooled demo over cleanly: nothing of the reserved person survives, and it is ready at once', async () => {
    const b = await start()
    const db = b.services.db
    await topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
    await drain(b)
    const { ready } = await withBypass('test', () => poolStatus(db))
    expect(ready).toHaveLength(1)
    const pooled = ready[0]!.ws
    const reserved = (await withBypass('test', () => db.selectFrom('memberships').select('person_id').where('workspace_id', '=', pooled).execute())).map((m) => m.person_id)
    expect(reserved).toHaveLength(1)
    // The scan does find it before the hand-over (so an empty result after means something).
    expect(await mentions(db, reserved[0]!)).toEqual(expect.arrayContaining(['memberships.person_id', 'people.id', 'connections.created_by']))
    // Not ready for anyone yet (no AI seeded for the reserved person).
    expect(await withBypass('test', () => isDemoReady(db, pooled))).toBe(false)

    const personId = newId()
    await withBypass('test', () => db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Ada', email: 'ada@example.com', created_at: nowIso() }).execute())
    const demo = await startDemoWorkspace(b.services, personId)
    expect(demo.workspaceId).toBe(pooled)
    expect(demo.created).toBe(true)
    expect(await withBypass('test', () => isDemoReady(db, pooled))).toBe(true)

    // Nothing anywhere still names the reserved person: no membership, invite, key, grant, session, activity, person row.
    expect(await mentions(db, reserved[0]!)).toEqual([])
    // The new owner owns it, and its Personal space; the audit trail starts with them (the demo AI's first write).
    const members = await withBypass('test', () => db.selectFrom('memberships').select(['person_id', 'role']).where('workspace_id', '=', pooled).where('revoked_at', 'is', null).execute())
    expect(members).toEqual([{ person_id: personId, role: 'owner' }])
    const personal = await withBypass('test', () => db.selectFrom('entities').select('owner_person_id').where('workspace_id', '=', pooled).where('kind', '=', 'personal').executeTakeFirstOrThrow())
    expect(personal.owner_person_id).toBe(personId)
    const pool = await withBypass('test', () => poolStatus(db))
    expect(pool.ready).toEqual([])

    // The pool is empty now: the next person's demo waits in the fill line instead.
    const next = newId()
    await withBypass('test', () => db.insertInto('people').values({ id: next, auth_user_id: null, name: 'Bo', email: 'bo@example.com', created_at: nowIso() }).execute())
    const theirs = await startDemoWorkspace(b.services, next)
    expect(theirs.workspaceId).not.toBe(pooled)
    expect(await withBypass('test', () => isDemoReady(db, theirs.workspaceId))).toBe(false)
    expect(await withBypass('test', () => db.selectFrom('settings').select('key').where('workspace_id', '=', theirs.workspaceId).where('key', 'in', ['demo_fill_waiting', 'demo_fill_started']).execute())).toHaveLength(1)
  }, 120_000)

  it('a slot finished as an ordinary demo (an older release during a deploy) is retired, and the pool refills', async () => {
    const b = await start()
    const db = b.services.db
    const top = () => topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
    await top()
    await drain(b)
    const slot = (await withBypass('test', () => poolStatus(db))).ready[0]!.ws
    // What live had (2026-10-13): demo_ready, the AI seeded, but no demo_pool_ready. It counts as "filling" for good.
    await withBypass('test', async () => {
      await db.deleteFrom('settings').where('workspace_id', '=', slot).where('key', '=', 'demo_pool_ready').execute()
      await db.insertInto('settings').values({ workspace_id: slot, key: 'demo_ready', value_json: 'true', updated_at: nowIso() }).execute()
    })
    expect((await withBypass('test', () => poolStatus(db))).filling).toEqual([slot])
    // The next run retires it (gone with its reserved person) and starts a new slot at once.
    await top()
    expect(await withBypass('test', () => db.selectFrom('workspaces').select('id').where('id', '=', slot).executeTakeFirst())).toBeUndefined()
    const after = await withBypass('test', () => poolStatus(db))
    expect(after.filling).toHaveLength(1)
    expect(after.filling[0]).not.toBe(slot)
    await drain(b)
    expect((await withBypass('test', () => poolStatus(db))).ready).toHaveLength(1)
  }, 120_000)

  it('a process killed after claiming the last step, before the slot was ready, is finished by the watchdog', async () => {
    const b = await start()
    const db = b.services.db
    await topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
    await drain(b)
    const slot = (await withBypass('test', () => poolStatus(db))).ready[0]!.ws
    // Killed mid-way: the claim (demo_ai_seeded) is written, demo_pool_ready never was.
    await withBypass('test', () => db.deleteFrom('settings').where('workspace_id', '=', slot).where('key', '=', 'demo_pool_ready').execute())
    const rerun = async () => {
      for (const st of await withBypass('test', () => stalledDemoImports(db))) await withBypass('test', () => b.services.sync.request(st.workspaceId, st.connectionId))
      await drain(b)
    }
    // A fresh claim may still be running elsewhere: left alone.
    await rerun()
    expect((await withBypass('test', () => poolStatus(db))).ready).toEqual([])
    // Once it's stale (the process is gone), the watchdog's re-run takes it over and the slot becomes ready.
    await withBypass('test', () => db.updateTable('settings').set({ updated_at: new Date(Date.now() - 11 * 60_000).toISOString() }).where('workspace_id', '=', slot).where('key', '=', 'demo_ai_seeded').execute())
    await rerun()
    expect((await withBypass('test', () => poolStatus(db))).ready.map((r) => r.ws)).toEqual([slot])
    expect(await withBypass('test', () => isDemoReady(db, slot))).toBe(false)
  }, 120_000)

  it('a slot filled on an earlier UTC day is caught up at hand-over, not left "syncing"', async () => {
    const b = await start()
    const db = b.services.db
    await topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
    await drain(b)
    const slot = (await withBypass('test', () => poolStatus(db))).ready[0]!.ws
    // Handed over after midnight UTC: its books stop at yesterday.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.now() + 86_400_000))
    try {
      // Still within the pool's age limit (filled late yesterday): only the date changed.
      await withBypass('test', () => db.updateTable('settings').set({ updated_at: nowIso() }).where('workspace_id', '=', slot).where('key', '=', 'demo_pool_ready').execute())
      // The watchdog already catches the idle slot up after midnight.
      const demoIds = (await withBypass('test', () => db.selectFrom('connections').select('id').where('workspace_id', '=', slot).where('connector_key', '=', 'demo').execute())).map((c) => c.id)
      await topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
      const afterTick = await withBypass('test', () => db.selectFrom('jobs').select('unique_key').where('kind', '=', 'connection.sync').where('status', '=', 'queued').where('workspace_id', '=', slot).execute())
      expect(new Set(afterTick.map((j) => j.unique_key))).toEqual(new Set(demoIds))
      // And the slot is still in the pool (not retired as broken).
      expect((await withBypass('test', () => poolStatus(db))).ready.map((r) => r.ws)).toContain(slot)
      await withBypass('test', () => db.deleteFrom('jobs').where('workspace_id', '=', slot).execute())
      const personId = newId()
      await withBypass('test', () => db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Cy', email: 'cy@example.com', created_at: nowIso() }).execute())
      expect((await startDemoWorkspace(b.services, personId)).workspaceId).toBe(slot)
      const demoConns = await withBypass('test', () => db.selectFrom('connections').select('id').where('workspace_id', '=', slot).where('connector_key', '=', 'demo').execute())
      const queued = await withBypass('test', () => db.selectFrom('jobs').select('unique_key').where('kind', '=', 'connection.sync').where('status', '=', 'queued').where('workspace_id', '=', slot).execute())
      expect(new Set(queued.map((j) => j.unique_key))).toEqual(new Set(demoConns.map((c) => c.id)))
    } finally {
      vi.useRealTimers()
    }
  }, 120_000)
})

