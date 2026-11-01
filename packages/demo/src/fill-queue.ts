// Hosted fills a few demos at a time (AGFN_DEMO_FILL_CONCURRENCY, hosted default 3): a fill is a year of made-up books
// generated, posted and settled. On one shared CPU, 5 at once pegged it (staging, 2026-10-13: loop lag up to 28 s, none
// finished in 35 min); on performance-2x, 5 at once finished in 128-162 s with loop lag under 1 s, so 3 leaves headroom
// (pool refills count against the same cap). Overflow waits in a first-come line; the page shows their place honestly.
//
// State lives in settings: `demo_fill_waiting` (in line, value = when it joined) until admitted, then `demo_fill_started`
// (value = when). A fill stops counting as running once the demo is ready, or after STALE_MS (a stuck fill can't hold
// the line forever; the watchdog keeps restarting it on its own). Reads across workspaces: call in bypass.

import type { Kysely } from 'kysely'
import { DEMO_KEY, PROFILE_KEYS } from '@agfn/connector-demo'
import { advisoryLock, ADVISORY_KEYS, type CoreTables } from '@agfn/db'
import { DEMO_READY_SETTING, isDemoReady } from './ai.ts'

export const DEMO_FILL_WAITING = 'demo_fill_waiting'
export const DEMO_FILL_STARTED = 'demo_fill_started'
const STALE_MS = 15 * 60_000
/** Until a few fills have finished here: about how long one takes. */
const DEFAULT_FILL_MS = 90_000

type Db = Kysely<CoreTables>

async function setFlag(db: Db, ws: string, key: string, at: string): Promise<void> {
  await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', key).execute()
  await db.insertInto('settings').values({ workspace_id: ws, key, value_json: JSON.stringify(at), updated_at: at }).execute()
}

/** Put a new demo in line (it starts filling when admitted). */
export async function queueDemoFill(db: Db, workspaceId: string, now: Date = new Date()): Promise<void> {
  await setFlag(db, workspaceId, DEMO_FILL_WAITING, now.toISOString())
}

async function flags(db: Db): Promise<{ waiting: Array<{ ws: string; at: string; pool: boolean }>; started: Array<{ ws: string; at: string; pool: boolean }> }> {
  const rows = await db.selectFrom('settings').select(['workspace_id', 'key', 'updated_at']).where('key', 'in', [DEMO_FILL_WAITING, DEMO_FILL_STARTED, 'demo_pool']).execute()
  const pooled = new Set(rows.filter((r) => r.key === 'demo_pool').map((r) => r.workspace_id))
  // People first, in arrival order; pool refills (pool.ts) only when nobody is waiting.
  const pick = (k: string) =>
    rows
      .filter((r) => r.key === k)
      .map((r) => ({ ws: r.workspace_id, at: r.updated_at, pool: pooled.has(r.workspace_id) }))
      .sort((a, b) => (a.pool !== b.pool ? (a.pool ? 1 : -1) : a.at < b.at ? -1 : a.at > b.at ? 1 : a.ws < b.ws ? -1 : 1))
  return { waiting: pick(DEMO_FILL_WAITING), started: pick(DEMO_FILL_STARTED) }
}

async function running(db: Db, started: Array<{ ws: string; at: string }>, now: Date): Promise<string[]> {
  const out: string[] = []
  const poolReady = new Set((await db.selectFrom('settings').select('workspace_id').where('key', '=', 'demo_pool_ready').execute()).map((r) => r.workspace_id))
  for (const s of started) if (now.getTime() - Date.parse(s.at) < STALE_MS && !poolReady.has(s.ws) && !(await isDemoReady(db, s.ws, () => now))) out.push(s.ws)
  return out
}

let admitting: Promise<unknown> = Promise.resolve()

/**
 * Admit the oldest demos in line while fewer than `limit` are filling. Returns, for each admitted one, its first demo
 * connection (profile order) for the caller to request. A demo whose people all left is dropped from the line.
 *
 * Count-then-admit runs one at a time: in this process (a chain) and across machines (a Postgres advisory lock), or 2-3
 * live machines admitting at once would each see a free slot and fill past `limit`. A demo is admitted only by whoever
 * removed its waiting flag, so two can never start the same one.
 */
export function admitDemoFills(db: Db, opts: { limit: number; now?: Date }): Promise<Array<{ workspaceId: string; connectionId: string }>> {
  const run = admitting.then(() => admitAcrossMachines(db, opts))
  admitting = run.catch(() => undefined)
  return run
}

/** The cross-machine half alone (exported for the two-pool test): the advisory lock around count-then-admit. */
export async function admitAcrossMachines(db: Db, opts: { limit: number; now?: Date }): Promise<Array<{ workspaceId: string; connectionId: string }>> {
  const release = await advisoryLock(db, ADVISORY_KEYS.demoFillAdmit)
  try {
    return await admitOneAtATime(db, opts)
  } finally {
    await release()
  }
}

async function admitOneAtATime(db: Db, opts: { limit: number; now?: Date }): Promise<Array<{ workspaceId: string; connectionId: string }>> {
  const now = opts.now ?? new Date()
  const { waiting, started } = await flags(db)
  let free = opts.limit - (await running(db, started, now)).length
  const out: Array<{ workspaceId: string; connectionId: string }> = []
  for (const w of waiting) {
    if (free <= 0) break
    const member = await db.selectFrom('memberships').select('person_id').where('workspace_id', '=', w.ws).where('revoked_at', 'is', null).executeTakeFirst()
    const took = await db.deleteFrom('settings').where('workspace_id', '=', w.ws).where('key', '=', DEMO_FILL_WAITING).executeTakeFirst()
    if (Number(took.numDeletedRows) !== 1) continue
    if (!member) continue
    const conns = await db.selectFrom('connections').select(['id', 'config_json']).where('workspace_id', '=', w.ws).where('connector_key', '=', DEMO_KEY).where('status', '=', 'active').execute()
    const order = (c: { config_json: string }) => {
      const i = (PROFILE_KEYS as readonly string[]).indexOf((JSON.parse(c.config_json) as { profile?: string }).profile ?? '')
      return i < 0 ? PROFILE_KEYS.length : i
    }
    const first = conns.sort((a, b) => order(a) - order(b))[0]
    await setFlag(db, w.ws, DEMO_FILL_STARTED, now.toISOString())
    free--
    if (first) out.push({ workspaceId: w.ws, connectionId: first.id })
  }
  return out
}

/** Is this demo in line? Its place (1 = next) and an honest estimate of the wait, from recent fills here. */
export async function demoFillPlace(db: Db, workspaceId: string, opts: { limit: number; now?: Date }): Promise<{ position: number; minutes: number } | null> {
  const now = opts.now ?? new Date()
  const { waiting, started } = await flags(db)
  const i = waiting.filter((w) => !w.pool).findIndex((w) => w.ws === workspaceId)
  if (i < 0) return null
  const fillMs = await typicalFillMs(db, started)
  // Ahead of it: those filling now (about half done, on average) and those in line before it, `limit` at a time.
  const ahead = (await running(db, started, now)).length / 2 + i
  return { position: i + 1, minutes: Math.max(1, Math.ceil(((ahead + 1) / Math.max(1, opts.limit)) * (fillMs / 60_000))) }
}

/**
 * The median time from admitted to ready over the last fills that finished; the default until there are three. The
 * latest 20 by start time (the line order puts pool refills last, which would pick old pool slots), and only times a
 * fill can take: a ready flag rewritten later (a pool slot handed over, a nightly catch-up) made "104 minutes" for a
 * 2-minute fill on staging.
 */
async function typicalFillMs(db: Db, started: Array<{ ws: string; at: string; pool: boolean }>): Promise<number> {
  // People's fills only: pool refills run in the background behind them and take longer (staging, 2026-10-15: "about
  // 8 minutes" shown for a 2-minute wait), and a handed-over pool slot has no fill record of its own (pool.ts handOver).
  const recent = started.filter((s) => !s.pool).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(-20)
  if (!recent.length) return DEFAULT_FILL_MS
  const ready = await db.selectFrom('settings').select(['workspace_id', 'updated_at']).where('key', '=', DEMO_READY_SETTING).where('workspace_id', 'in', recent.map((s) => s.ws)).execute()
  const at = new Map(ready.map((r) => [r.workspace_id, r.updated_at]))
  const took = recent.flatMap((s) => (at.has(s.ws) ? [Date.parse(at.get(s.ws)!) - Date.parse(s.at)] : [])).filter((ms) => ms > 0 && ms <= STALE_MS).sort((a, b) => a - b)
  return took.length >= 3 ? took[Math.floor(took.length / 2)]! : DEFAULT_FILL_MS
}

