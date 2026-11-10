// "Your AI is already connected": once the demo books are filled, a demo grant for Claude is created and it makes one
// small write (S7's seedDemoAi), so the activity feed shows what an AI reading and recording looks like.

import type { Kysely } from 'kysely'
import { DEMO_KEY, demoCaughtUp, PROFILE_KEYS, PROFILES } from '@agfn/connector-demo'
import { nowIso, withBypass, type CoreTables } from '@agfn/db'

/** Claimed when tidying and seeding start (so two workers don't both run them). Not "ready": numbers still move. */
export const DEMO_AI_SETTING = 'demo_ai_seeded'
/** A seeding claim this old, on a demo still not ready, was left by a process that stopped (a deploy): taken over. */
export const CLAIM_STALE_MS = 10 * 60_000
/** Written only after the tidy and the AI write both succeeded: the demo's books are final. */
export const DEMO_READY_SETTING = 'demo_ready'

export interface DemoAiWrite {
  company: string
  amount: string
  currency: string
  date: string
  counterparty: string
  description: string
}

export type SeedDemoAi = (input: { workspaceId: string; personId: string; clientName?: string; write: DemoAiWrite }) => Promise<unknown>

/** The AI's one write: a weekend market's takings for the café, two days ago. */
export function demoAiWrite(today: string): DemoAiWrite {
  const date = new Date(Date.parse(today + 'T00:00:00Z') - 2 * 86_400_000).toISOString().slice(0, 10)
  return { company: PROFILES.harbor.entityName, amount: '420.00', currency: 'USD', date, counterparty: 'Farmers market', description: 'Farmers market sales' }
}

/** The sync engine's job kind (packages/sync SYNC_JOB); its unique_key is the connection id. */
const SYNC_JOB = 'connection.sync'

/**
 * Seeds the demo AI once every demo connection has caught up to today AND no other sync job for the workspace is still
 * running or about to run: a cursor is saved per page, before that job finishes posting and matching, so a caught-up
 * cursor alone doesn't mean the books are final. `connectionId` is the connection whose job is calling (from
 * afterSync): its own job is still "running" while this runs, so it's not counted. Safe to call after every sync;
 * returns true only on the call that seeded. Does nothing outside demo workspaces.
 */
export async function seedDemoAiWhenReady(
  deps: { db: Kysely<CoreTables>; seed: SeedDemoAi; tidy?: (workspaceId: string) => Promise<unknown>; warm?: (workspaceId: string) => Promise<unknown>; now?: () => Date; log?: (msg: string, fields: Record<string, unknown>) => void },
  workspaceId: string,
  connectionId?: string,
  opts: { seedAi?: boolean } = {},
): Promise<boolean> {
  const { db } = deps
  // The challenge deployment reuses these demo books for each player, but must NOT pre-connect a "Claude (demo)" AI or
  // make its sample write: a player brings their own AI, and a seeded write would show up as an "AI did this" the
  // player never caused — misleading tier-C judging (the write is copied into challenge_activity). The books still get
  // tidied, warmed and marked ready; only the AI grant and its write are skipped.
  const seedAi = opts.seedAi !== false
  const flags = await db.selectFrom('settings').select(['key', 'value_json', 'updated_at']).where('workspace_id', '=', workspaceId).where('key', 'in', ['demo', DEMO_AI_SETTING, DEMO_READY_SETTING, 'demo_pool_ready']).execute()
  if (!flags.some((f) => f.key === 'demo' && f.value_json === 'true')) return false
  // Already claimed: done, or under way elsewhere, unless the claim is stale on a demo still not ready (below).
  const claim = flags.find((f) => f.key === DEMO_AI_SETTING)
  const staleBefore = new Date((deps.now?.() ?? new Date()).getTime() - CLAIM_STALE_MS).toISOString()
  if (claim && (claim.updated_at >= staleBefore || flags.some((f) => f.key === DEMO_READY_SETTING || f.key === 'demo_pool_ready'))) return false

  const today = (deps.now?.() ?? new Date()).toISOString().slice(0, 10)
  const conns = await db.selectFrom('connections').select(['cursor', 'status']).where('workspace_id', '=', workspaceId).where('connector_key', '=', DEMO_KEY).execute()
  // Every demo connection caught up, or failed (it shows its own error and retries; the rest of the demo is final).
  const caught = (c: { cursor: string | null; status: string }) => c.status === 'active' && demoCaughtUp(c.cursor, deps.now?.() ?? new Date())
  const failed = (c: { status: string }) => c.status === 'error' || c.status === 'needs_reauth'
  if (!conns.some(caught) || !conns.every((c) => caught(c) || failed(c))) return false
  // Another connection's job still posting, or a next page queued (the engine re-queues 5 s out): not final yet. The
  // last job to finish will call again.
  const soon = new Date((deps.now?.() ?? new Date()).getTime() + 60_000).toISOString()
  let busy = db
    .selectFrom('jobs')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', SYNC_JOB)
    .where((eb) => eb.or([eb('status', '=', 'running'), eb.and([eb('status', '=', 'queued'), eb('run_at', '<=', soon)])]))
  if (connectionId) busy = busy.where('unique_key', '!=', connectionId)
  // Read jobs across row-level security explicitly: whatever context the caller runs in, a running job must be seen.
  const q = busy
  if (await withBypass('demo:ready-check', () => q.executeTakeFirst())) return false

  const owner = await db
    .selectFrom('memberships')
    .select('person_id')
    .where('workspace_id', '=', workspaceId)
    .where('role', '=', 'owner')
    .where('revoked_at', 'is', null)
    .executeTakeFirst()
  if (!owner) return false

  // Claim first so two workers finishing at once don't both seed (seedDemoAi is idempotent anyway). A claim left by a
  // process that died before the demo was ready (a deploy) is taken over once it's CLAIM_STALE_MS old, so the
  // watchdog's re-run can finish it instead of finding it claimed for good.
  const claimed = await db
    .insertInto('settings')
    .values({ workspace_id: workspaceId, key: DEMO_AI_SETTING, value_json: 'true', updated_at: nowIso() })
    .onConflict((oc) => oc.doNothing())
    .executeTakeFirst()
  if (!claimed.numInsertedOrUpdatedRows) {
    const retaken = await db.updateTable('settings').set({ updated_at: nowIso() }).where('workspace_id', '=', workspaceId).where('key', '=', DEMO_AI_SETTING).where('updated_at', '<', staleBefore).executeTakeFirst()
    if (!Number(retaken.numUpdatedRows)) return false
    deps.log?.('demo: finishing a fill a stopped process left', { workspaceId })
  }
  deps.log?.('demo: tidying and seeding', { workspaceId, connectionId })
  try {
    // A year of fake books arrives with hundreds of "same money?" questions; answer most of them first so the demo
    // shows a realistic handful, then let the AI make its write (it shows up as the newest activity).
    await deps.tidy?.(workspaceId)
    // A pooled demo (pool.ts) stops here: no AI is seeded for the reserved person. It's warmed and marked ready to hand
    // over; the seed runs for whoever it's handed to.
    if (await db.selectFrom('settings').select('key').where('workspace_id', '=', workspaceId).where('key', '=', 'demo_pool').executeTakeFirst()) {
      await deps.warm?.(workspaceId).catch(() => undefined)
      await db.insertInto('settings').values({ workspace_id: workspaceId, key: 'demo_pool_ready', value_json: 'true', updated_at: nowIso() }).onConflict((oc) => oc.doNothing()).execute()
      deps.log?.('demo pool: filled, ready to hand over', { workspaceId })
      return true
    }
    if (seedAi) await deps.seed({ workspaceId, personId: owner.person_id, clientName: 'Claude (demo)', write: demoAiWrite(today) })
    // The first page after "Filling the demo…" reads answers computed here, not cold (staging: 2.3 s for the first overview).
    await deps.warm?.(workspaceId).catch((err: unknown) => deps.log?.('demo: warm failed', { workspaceId, error: err instanceof Error ? err.message : String(err) }))
    await db
      .insertInto('settings')
      .values({ workspace_id: workspaceId, key: DEMO_READY_SETTING, value_json: 'true', updated_at: nowIso() })
      .onConflict((oc) => oc.doNothing())
      .execute()
  } catch (err) {
    deps.log?.('demo: tidy/seed failed, will retry after the next sync', { workspaceId, error: err instanceof Error ? err.message : String(err) })
    await db.deleteFrom('settings').where('workspace_id', '=', workspaceId).where('key', '=', DEMO_AI_SETTING).execute()
    throw err
  }
  deps.log?.('demo: ready', { workspaceId })
  return true
}

/**
 * Is the demo filled (every connection caught up, tidied, AI seeded)? The UI shows "Filling the demo…" until then.
 * Demos seeded before the ready marker existed only have the claim: treat a claim older than 10 minutes as ready.
 */
export async function isDemoReady(db: Kysely<CoreTables>, workspaceId: string, now: () => Date = () => new Date()): Promise<boolean> {
  const rows = await db.selectFrom('settings').select(['key', 'updated_at']).where('workspace_id', '=', workspaceId).where('key', 'in', [DEMO_READY_SETTING, DEMO_AI_SETTING]).execute()
  if (rows.some((r) => r.key === DEMO_READY_SETTING)) return true
  const claim = rows.find((r) => r.key === DEMO_AI_SETTING)
  return !!claim && now().getTime() - Date.parse(claim.updated_at) > 10 * 60_000
}

/**
 * Demo connections import one after another (Northwind, Bluebird, Harbor, Personal): they would only wait on the
 * workspace's ledger lock if run together. Called after a sync: once `connectionId` (a demo connection) has caught up,
 * or failed (`opts.failed`), returns the next demo connection that hasn't started yet, or null.
 */
export async function nextDemoImport(db: Kysely<CoreTables>, workspaceId: string, connectionId: string, now: Date, opts: { failed?: boolean } = {}): Promise<string | null> {
  const rows = await db.selectFrom('connections').select(['id', 'cursor', 'config_json', 'status']).where('workspace_id', '=', workspaceId).where('connector_key', '=', DEMO_KEY).execute()
  const me = rows.find((r) => r.id === connectionId)
  // A failed import doesn't hold up the rest: the next one starts, and the failed one retries on its own.
  if (!me || (!opts.failed && !demoCaughtUp(me.cursor, now))) return null
  const next = rows.filter((r) => r.status === 'active' && r.cursor === null).sort((a, b) => profileOrder(a) - profileOrder(b))[0]
  return next?.id ?? null
}

/** Northwind, Bluebird, Harbor, Personal: the order demo connections import in. */
function profileOrder(r: { config_json: string }): number {
  const p = (JSON.parse(r.config_json) as { profile?: string }).profile ?? ''
  const i = (PROFILE_KEYS as readonly string[]).indexOf(p)
  return i < 0 ? PROFILE_KEYS.length : i
}

/**
 * The watchdog for the demo fill (boot.ts, every minute). The chain moves only from a sync's own hooks, so a job lost
 * to a restart or deploy, or a hook that threw, leaves the demo "Filling…" for good. For each unfinished demo with no
 * sync job queued or running and none touched for `quietMs`, the connection to request: one stopped mid-import first,
 * else the next not started, else (all caught up, never marked ready) a caught-up one, whose sync re-runs the
 * ready check. Reads across workspaces: call it in bypass. The public demo rebuilds itself (public-demo.ts).
 */
export async function stalledDemoImports(db: Kysely<CoreTables>, opts: { now?: Date; quietMs?: number } = {}): Promise<Array<{ workspaceId: string; connectionId: string }>> {
  const now = opts.now ?? new Date()
  const quietSince = new Date(now.getTime() - (opts.quietMs ?? 120_000)).toISOString()
  const flags = await db.selectFrom('settings').select(['workspace_id', 'key']).where('key', 'in', ['demo', 'public_demo', DEMO_READY_SETTING, 'demo_fill_waiting', 'demo_pool_ready']).execute()
  const byWs = new Map<string, Set<string>>()
  for (const f of flags) byWs.set(f.workspace_id, (byWs.get(f.workspace_id) ?? new Set()).add(f.key))
  const out: Array<{ workspaceId: string; connectionId: string }> = []
  for (const [ws, keys] of byWs) {
    // Still in line for a fill slot (fill-queue.ts): not stalled, waiting its turn.
    if (!keys.has('demo') || keys.has('public_demo') || keys.has(DEMO_READY_SETTING) || keys.has('demo_fill_waiting') || keys.has('demo_pool_ready')) continue
    // Not isDemoReady: its stale-claim fallback (show the books after 10 min) would skip exactly the fills a stopped
    // process left mid-way; re-running one lets seedDemoAiWhenReady take the stale claim over and finish it.
    const member = await db.selectFrom('memberships').select('person_id').where('workspace_id', '=', ws).where('revoked_at', 'is', null).executeTakeFirst()
    if (!member) continue
    const jobs = await db.selectFrom('jobs').select(['status', 'run_at', 'updated_at']).where('workspace_id', '=', ws).where('kind', '=', SYNC_JOB).orderBy('updated_at', 'desc').limit(20).execute()
    // A job queued far ahead (the hourly round spreads start times over the hour) isn't progress: requesting the
    // import pulls it forward (JobQueue.enqueue).
    const soon = new Date(now.getTime() + (opts.quietMs ?? 120_000)).toISOString()
    if (jobs.some((j) => j.status === 'running' || (j.status === 'queued' && j.run_at <= soon)) || (jobs[0] && jobs[0].updated_at > quietSince)) continue
    const conns = (await db.selectFrom('connections').select(['id', 'cursor', 'config_json', 'status']).where('workspace_id', '=', ws).where('connector_key', '=', DEMO_KEY).where('status', '=', 'active').execute()).sort(
      (a, b) => profileOrder(a) - profileOrder(b),
    )
    const pick = conns.find((c) => c.cursor !== null && !demoCaughtUp(c.cursor, now)) ?? conns.find((c) => c.cursor === null) ?? conns[0]
    if (pick) out.push({ workspaceId: ws, connectionId: pick.id })
  }
  return out
}

/** A demo connection still importing its history (shown as syncing, even while it waits its turn). */
export const demoImporting = (connectorKey: string, cursor: string | null, now: Date): boolean => connectorKey === DEMO_KEY && !demoCaughtUp(cursor, now)
