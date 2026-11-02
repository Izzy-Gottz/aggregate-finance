// A few demos kept filled ahead of time (hosted: AGFN_DEMO_POOL, default 5), so "Look around with made-up data" opens
// at once instead of waiting in the fill line (fill-queue.ts). Each pooled demo is built for a reserved system person
// nobody can sign in as (`@demo-pool.aggregate.invalid`), filled, tidied and warmed, and stops just before its AI is
// seeded. Handing one over moves it to the person who asked: their membership, their Personal space, their name on
// the connections, and the reserved person, its membership and anything it did are gone, so the audit trail starts
// with them. Then the AI seed runs for them, as in a fresh demo.
//
// Pool workspaces aren't anyone's: they're not sign-ups, not demos started (analytics), and the launch-day wipe and
// the orphan pass keep them. Reads across workspaces: call in bypass.

import { randomBytes } from 'node:crypto'
import type { Kysely } from 'kysely'
import { newId, nowIso, ownerOf, withWorkspace, type CoreTables } from '@agfn/db'
import { DEMO_READY_SETTING, demoAiWrite, type SeedDemoAi } from './ai.ts'

export const DEMO_POOL = 'demo_pool'
export const DEMO_POOL_READY = 'demo_pool_ready'
export const DEMO_POOL_EMAIL_DOMAIN = 'demo-pool.aggregate.invalid'
/** Books are built "as of today": a pooled demo older than this is rebuilt rather than handed over. */
export const POOL_MAX_AGE_MS = 20 * 3600_000

export const isPoolPerson = (email: string) => email.toLowerCase().endsWith(`@${DEMO_POOL_EMAIL_DOMAIN}`)

type Db = Kysely<CoreTables>
type AnyDb = Kysely<Record<string, Record<string, unknown>>>

/** The reserved person a new pooled demo is built for. The caller builds the demo for it, then calls markPooled. */
export async function newPoolPerson(db: Db): Promise<string> {
  const personId = newId()
  await db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Demo pool', email: `pool-${randomBytes(6).toString('hex')}@${DEMO_POOL_EMAIL_DOMAIN}`, created_at: nowIso() }).execute()
  return personId
}

export async function markPooled(db: Db, workspaceId: string): Promise<void> {
  await db.insertInto('settings').values({ workspace_id: workspaceId, key: DEMO_POOL, value_json: 'true', updated_at: nowIso() }).execute()
}

/** Pooled demos not handed over yet: filled and ready to hand over (oldest first), and still filling. */
export async function poolStatus(db: Db): Promise<{ ready: Array<{ ws: string; at: string }>; filling: string[] }> {
  const rows = await db.selectFrom('settings').select(['workspace_id', 'key', 'updated_at']).where('key', 'in', [DEMO_POOL, DEMO_POOL_READY]).execute()
  const pooled = new Set(rows.filter((r) => r.key === DEMO_POOL).map((r) => r.workspace_id))
  const ready = rows.filter((r) => r.key === DEMO_POOL_READY && pooled.has(r.workspace_id)).map((r) => ({ ws: r.workspace_id, at: r.updated_at })).sort((a, b) => (a.at < b.at ? -1 : 1))
  const readySet = new Set(ready.map((r) => r.ws))
  return { ready, filling: [...pooled].filter((ws) => !readySet.has(ws)) }
}

/**
 * Hand the oldest fresh pooled demo to `personId`: claimed atomically (two people asking at once never get the same
 * one), then everything the reserved person held moves or goes. Returns the workspace, or null when the pool is empty.
 * The caller then runs finishHandedOver (the AI seed) for the person.
 */
export async function takePoolDemo(db: Db, personId: string, now: Date = new Date()): Promise<string | null> {
  const { ready } = await poolStatus(db)
  for (const r of ready) {
    if (now.getTime() - Date.parse(r.at) > POOL_MAX_AGE_MS) continue
    const claimed = await db.deleteFrom('settings').where('workspace_id', '=', r.ws).where('key', '=', DEMO_POOL).executeTakeFirst()
    if (Number(claimed.numDeletedRows) !== 1) continue
    try {
      await withWorkspace(r.ws, () => handOver(db, r.ws, personId))
    } catch (err) {
      // Half handed over: never left claimed-but-stuck. Retired and memberless, so the orphan pass removes it, the pool
      // refills, and the caller falls back to a fresh demo.
      await withWorkspace(r.ws, async () => {
        await retirePoolDemo(db, r.ws)
        await db.deleteFrom('memberships').where('workspace_id', '=', r.ws).where('person_id', '=', personId).execute()
      }).catch(() => undefined)
      throw err
    }
    return r.ws
  }
  return null
}

async function handOver(db: Db, ws: string, personId: string): Promise<void> {
  const anyDb = db as unknown as AnyDb
  const owners = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select(['memberships.person_id', 'people.email']).where('memberships.workspace_id', '=', ws).execute()
  const reserved = owners.filter((o) => isPoolPerson(o.email)).map((o) => o.person_id)
  const at = nowIso()
  for (const sys of reserved) {
    // Its own doings go: the new owner's trail starts with them.
    await anyDb.deleteFrom('activity_log').where('workspace_id', '=', ws).where('person_id', '=', sys).execute().catch(() => undefined)
    await db.updateTable('entities').set({ owner_person_id: personId }).where('workspace_id', '=', ws).where('owner_person_id', '=', sys).execute()
    await db.updateTable('connections').set({ created_by: personId }).where('workspace_id', '=', ws).where('created_by', '=', sys).execute()
    await db.deleteFrom('memberships').where('workspace_id', '=', ws).where('person_id', '=', sys).execute()
  }
  await db.insertInto('memberships').values({ id: newId(), workspace_id: ws, person_id: personId, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: at, revoked_at: null }).execute()
  // Its fill (a pool refill, long done) isn't a person's: off the fill-time record, or the line's wait estimate would count
  // the minutes it sat in the pool (fill-queue.ts typicalFillMs).
  await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', 'in', [DEMO_POOL_READY, 'demo_fill_started']).execute()
  if (reserved.length) await ownerOf(db).deleteFrom('people').where('id', 'in', reserved).execute()
}

/** After a hand-over: the demo AI is seeded for its new owner (as a fresh demo's last step) and the demo is ready. */
export async function finishHandedOver(deps: { db: Db; seed: SeedDemoAi; now?: () => Date; log?: (m: string, f: Record<string, unknown>) => void }, ws: string, personId: string): Promise<void> {
  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  try {
    await deps.seed({ workspaceId: ws, personId, clientName: 'Claude (demo)', write: demoAiWrite(today) })
  } catch (err) {
    // The books are there either way; a demo without its sample AI connection is still a demo.
    deps.log?.('demo pool: AI seed after hand-over failed', { workspaceId: ws, error: err instanceof Error ? err.message : String(err) })
  }
  await deps.db.insertInto('settings').values({ workspace_id: ws, key: DEMO_READY_SETTING, value_json: 'true', updated_at: nowIso() }).onConflict((oc) => oc.doNothing()).execute()
}


/** A pooled demo still not filled after this long, and not waiting in the fill line, is stuck: rebuilt. */
export const POOL_STUCK_MS = 2 * 3600_000

/**
 * Pooled demos that will never become ready to hand over, so they'd hold the pool's one filling slot for good:
 * - finished as an ordinary demo (demo_ready, AI seeded for the reserved person): an older release's worker ran the
 *   fill's last step during a deploy's overlap (live, 2026-10-13: one slot, 0 ready, no refills);
 * - still filling POOL_STUCK_MS after it was pooled, and not in the fill line (waiting its turn is not stuck).
 * The watchdog retires them every run (demo-start.ts topUpDemoPool) and the pool refills.
 */
export async function brokenPoolDemos(db: Db, now: Date = new Date()): Promise<string[]> {
  const rows = await db.selectFrom('settings').select(['workspace_id', 'key', 'updated_at']).where('key', 'in', [DEMO_POOL, DEMO_POOL_READY, DEMO_READY_SETTING, 'demo_fill_waiting']).execute()
  const byWs = new Map<string, Map<string, string>>()
  for (const r of rows) byWs.set(r.workspace_id, (byWs.get(r.workspace_id) ?? new Map()).set(r.key, r.updated_at))
  const out: string[] = []
  for (const [ws, keys] of byWs) {
    const pooledAt = keys.get(DEMO_POOL)
    if (!pooledAt || keys.has(DEMO_POOL_READY)) continue
    if (keys.has(DEMO_READY_SETTING) || (!keys.has('demo_fill_waiting') && now.getTime() - Date.parse(pooledAt) > POOL_STUCK_MS)) out.push(ws)
  }
  return out
}

/** Pooled demos too old to hand over: their reserved person and membership go, leaving them for the orphan pass. */
export async function stalePoolDemos(dbh: Db, now: Date = new Date()): Promise<string[]> {
  const { ready } = await poolStatus(dbh)
  return ready.filter((r) => now.getTime() - Date.parse(r.at) > POOL_MAX_AGE_MS).map((r) => r.ws)
}

export async function retirePoolDemo(dbh: Db, ws: string): Promise<string[]> {
  const members = await dbh.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select(['memberships.person_id', 'people.email']).where('memberships.workspace_id', '=', ws).execute()
  const reserved = members.filter((m) => isPoolPerson(m.email)).map((m) => m.person_id)
  await dbh.deleteFrom('settings').where('workspace_id', '=', ws).where('key', 'in', [DEMO_POOL, DEMO_POOL_READY]).execute()
  if (!reserved.length) return []
  await dbh.deleteFrom('memberships').where('workspace_id', '=', ws).where('person_id', 'in', reserved).execute()
  // The person row goes only once the workspace is deleted (deletePoolPeople, every top-up): its connections and
  // entities still name it until then.
  return reserved
}

/**
 * Reserved pool people left with no membership (retired, or a hand-over that failed half-way): deleted once nothing
 * still names them. One whose workspace the orphan pass hasn't removed yet is kept for the next run.
 */
export async function deletePoolPeople(dbh: Db): Promise<number> {
  const orphans = await dbh
    .selectFrom('people')
    .select('id')
    .where('email', 'like', `%@${DEMO_POOL_EMAIL_DOMAIN}`)
    .where(({ not, exists, selectFrom }) => not(exists(selectFrom('memberships').select('memberships.id').whereRef('memberships.person_id', '=', 'people.id'))))
    .execute()
  let n = 0
  for (const p of orphans) {
    const r = await dbh.deleteFrom('people').where('id', '=', p.id).executeTakeFirst().catch(() => null)
    if (r && Number(r.numDeletedRows)) n++
  }
  return n
}
