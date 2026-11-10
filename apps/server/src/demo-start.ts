// A demo workspace that fills in the background (the app's "look around" button, and the challenge's player books):
// three fictional companies + Personal, imported one company after another by the demo connector (see boot.ts).
import type { LedgerEngine } from '@agfn/core'
import { admitDemoFills, brokenPoolDemos, createDemoWorkspace, deletePoolPeople, demoImporting, DEMO_FILL_WAITING, findDemoWorkspace, finishHandedOver, markPooled, newPoolPerson, poolStatus, queueDemoFill, retirePoolDemo, stalePoolDemos, takePoolDemo } from '@agfn/demo'
import { withBypass, withWorkspace } from '@agfn/db'
import { equityFor } from './equity.ts'
import { demoDocuments } from './reviewer.ts'
import type { Services } from './services.ts'

export async function startDemoWorkspace(s: Omit<Services, 'mcp'> & { mcp?: Services['mcp'] }, personId: string) {
  // A pooled demo, filled ahead of time, opens at once (pool.ts). Only for someone without a demo yet.
  if (s.config.demoPool && s.mcp && !(await withBypass('demo:find', () => findDemoWorkspace(s.db, personId)))) {
    const ws = await withBypass('demo:take', () => takePoolDemo(s.db, personId)).catch((err) => {
      console.warn('[agfn] demo pool: hand-over failed, filling a fresh demo', { error: err instanceof Error ? err.message : String(err) })
      return null
    })
    if (ws) {
      const mcp = s.mcp
      await withWorkspace(ws, () => finishHandedOver({ db: s.db, seed: (input) => mcp.service.seedDemoAi(input), log: (m, f) => console.warn(`[agfn] ${m}`, f) }, ws, personId))
      console.warn('[agfn] demo pool: handed over', { workspaceId: ws })
      // Filled on an earlier UTC day: its books stop at yesterday and the demo connections read as "syncing" until the
      // daily demo sync. Catch them up now (a day or so of made-up history, seconds).
      await catchUpDemo(s, [ws])
      const demo = await createDemoWorkspace({ db: s.db, keys: s.keys }, { personId })
      return { ...demo, created: true }
    }
  }
  return buildDemo(s, personId)
}

async function buildDemo(s: Omit<Services, 'mcp'>, personId: string, opts: { pool?: boolean } = {}) {
  // Buckets + rules need the real ledger engine; the cap table needs S6. Both are optional so a minimal server still works.
  const ledger = s.ledger as Partial<Pick<LedgerEngine, 'createBucket' | 'createRule'>>
  const extras = {
    ...(ledger.createBucket && ledger.createRule ? { buckets: s.ledger as unknown as Pick<LedgerEngine, 'createBucket' | 'createRule'> } : {}),
    equity: equityFor(s),
    documents: demoDocuments(s),
  }
  const demo = await createDemoWorkspace({ db: s.db, keys: s.keys, extras }, { personId })
  if (opts.pool) await withBypass('demo:pool', () => markPooled(s.db, demo.workspaceId))
  if (demo.created && demo.connections[0]) {
    // Hosted fills a few demos at a time: this one joins the line and starts when its turn comes (fill-queue.ts).
    if (s.config.demoFillConcurrency) {
      await withBypass('demo:queue', () => queueDemoFill(s.db, demo.workspaceId))
      await admitDemoFillsNow(s)
    }
    // Every connection still importing shows as syncing.
    else await withWorkspace(demo.workspaceId, () => s.sync.request(demo.workspaceId, demo.connections[0]!))
  }
  return demo
}

/**
 * Keep the pool topped up (every minute): pooled demos too old to hand over, or stuck (brokenPoolDemos), are retired
 * (left for the orphan pass), and
 * one new one is built when the pool is short, nothing for it is filling yet, and no person is waiting in the fill line.
 */
export async function topUpDemoPool(s: Omit<Services, 'mcp'>, deleteRetired: (ids: string[]) => Promise<unknown>): Promise<void> {
  const size = s.config.demoPool
  if (!size) return
  // Too old to hand over, or never going to be ready (brokenPoolDemos): retired every run, so one bad slot can't
  // block refills (a filling slot holds the pool's one build at a time).
  const stale = [...new Set([...(await withBypass('demo:pool', () => stalePoolDemos(s.db))), ...(await withBypass('demo:pool', () => brokenPoolDemos(s.db)))])]
  for (const ws of stale) await withBypass('demo:pool', () => retirePoolDemo(s.db, ws))
  if (stale.length) {
    console.warn('[agfn] demo pool: retired', { workspaceIds: stale })
    await deleteRetired(stale)
  }
  await withBypass('demo:pool', () => deletePoolPeople(s.db))
  const { ready, filling } = await withBypass('demo:pool', () => poolStatus(s.db))
  // Ready slots sit idle, so after 00:00Z their books stop at yesterday: catch them up (a day of made-up history), so
  // the next person's demo isn't "syncing" (the hand-over catches up too, for one that slips through).
  await catchUpDemo(s, ready.map((r) => r.ws))
  if (ready.length + filling.length >= size || filling.length) return
  const peopleWaiting = await withBypass('demo:pool', () => s.db.selectFrom('settings').select('workspace_id').where('key', '=', DEMO_FILL_WAITING).execute())
  if (peopleWaiting.length) return
  const personId = await withBypass('demo:pool', () => newPoolPerson(s.db))
  await buildDemo(s, personId, { pool: true })
}

/** Start the next demos in line while a fill slot is free (after a fill finishes, and every minute). */
export async function admitDemoFillsNow(s: Pick<Services, 'db' | 'sync' | 'config'>): Promise<number> {
  const limit = s.config.demoFillConcurrency
  if (!limit) return 0
  const admitted = await withBypass('demo:admit', () => admitDemoFills(s.db, { limit }))
  for (const a of admitted) await withWorkspace(a.workspaceId, () => s.sync.request(a.workspaceId, a.connectionId))
  return admitted.length
}

/** Requests a sync for each demo connection in these workspaces whose history stops before today (demoImporting). */
async function catchUpDemo(s: Pick<Services, 'db' | 'sync'>, workspaceIds: string[]): Promise<void> {
  const now = new Date()
  for (const ws of workspaceIds) {
    const conns = await withWorkspace(ws, () => s.db.selectFrom('connections').select(['id', 'connector_key', 'cursor']).where('workspace_id', '=', ws).where('status', '=', 'active').execute())
    for (const c of conns.filter((x) => demoImporting(x.connector_key, x.cursor, now))) await withWorkspace(ws, () => s.sync.request(ws, c.id))
  }
}

