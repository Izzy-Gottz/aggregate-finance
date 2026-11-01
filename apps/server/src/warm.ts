// Warm the ledger's derived results (checks, review, open items, coverage) once a sync settles, so the first page
// view after a sync doesn't pay for the whole-ledger pass. Debounced per workspace: a backfill that syncs page
// after page (each continuation 5 s apart) warms once, when it stops.
import { perfEnabled, perfLine, withPerfDetached, withWorkspace } from '@agfn/db'

export interface CacheWarmer {
  /** Note that a workspace changed; it's warmed `delayMs` after the last call. */
  schedule(workspaceId: string): void
  /** Run anything scheduled now and wait for it (tests, shutdown). */
  flush(): Promise<void>
  /**
   * If a warm of this workspace is running, wait for it (at most `maxMs`): a request that arrives meanwhile then reads
   * what it computed instead of doing the same work alongside it on a small pool. With `key`, stop waiting as soon as
   * the warm reports that part ready (a scope), not when the whole warm ends.
   */
  wait(workspaceId: string, maxMs: number, key?: string): Promise<void>
  /**
   * Warm a workspace now, without the delay or the busy check, and wait for it (at most `maxMs`; the warm carries on).
   * For a fill that is about to say it's ready: the first page then reads what was computed.
   */
  now(workspaceId: string, maxMs: number): Promise<void>
  /**
   * A write just changed these companies: warm everything-at-once and them after `delayMs` (short; the next read usually
   * follows at once and joins it, waiting for it to start too), at most once per writeGapMs. A burst of writes warms
   * once or twice, never once each; the full warm stays with syncs.
   */
  soon(workspaceId: string, delayMs: number, entityIds?: string[]): void
}

export interface CacheWarmerOptions {
  delayMs?: number
  /** True while the workspace is still syncing: warming then would only compete with it, so it waits again. */
  busy?: (workspaceId: string) => Promise<boolean>
  /** Warm anyway once it has waited this long for the workspace to go quiet (default 5 minutes). */
  maxWaitMs?: number
  log?: (m: string, f: Record<string, unknown>) => void
  /** A write's warm starts at most once per this long per workspace (default 5 s): a burst of writes warms once or twice. */
  writeGapMs?: number
  /**
   * A sync's (full) warm starts at most once per this long per workspace (default 30 s): a backfill or a demo importing
   * connection after connection warms once it settles, not after each (f8's 50-session test: 28 full warms a minute).
   */
  fullGapMs?: number
  /** Rest between queued warms on this machine (default 1 s), so requests get the CPU in between. */
  restMs?: number
}

/**
 * `only`: a write's warm, narrowed to the companies it touched (plus everything at once, which the warm always does
 * first). Without it, a full warm (after a sync): every scope requests ask for.
 */
export type WarmFn = (workspaceId: string, ready: (key: string) => void, only?: string[]) => Promise<void>

/** A read waits for a write's warm to start only when it's due this soon (a later one, held by writeGapMs, it doesn't). */
const WAIT_FOR_START_MS = 300

export function cacheWarmer(warm: WarmFn, opts: CacheWarmerOptions = {}): CacheWarmer {
  /** Parts of the running warm that are done, per workspace, and requests waiting on a part. */
  const readyKeys = new Map<string, Set<string>>()
  const waiters = new Map<string, Array<{ key: string; resolve: () => void }>>()
  const ready = (ws: string, key: string) => {
    readyKeys.get(ws)?.add(key)
    const list = waiters.get(ws) ?? []
    for (const w of list.filter((x) => x.key === key)) w.resolve()
    waiters.set(ws, list.filter((x) => x.key !== key))
  }
  const delayMs = opts.delayMs ?? 3_000
  const maxWaitMs = opts.maxWaitMs ?? 5 * 60_000
  /** When each workspace first asked to be warmed and hasn't been since. */
  const since = new Map<string, number>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const running = new Map<string, Promise<void>>()
  /** When a write's warm (soon) is due to start, per workspace. */
  const soonUntil = new Map<string, number>()
  /** What the next warm of each workspace covers: everything (a sync), or the companies writes touched since the last. */
  const pending = new Map<string, 'full' | Set<string>>()
  const lastWriteWarm = new Map<string, number>()
  const lastFullWarm = new Map<string, number>()
  const writeGapMs = opts.writeGapMs ?? 5_000
  const fullGapMs = opts.fullGapMs ?? 30_000
  const restMs = opts.restMs ?? 1_000
  const want = (ws: string, what: 'full' | string[]) => {
    const cur = pending.get(ws)
    if (what === 'full' || cur === 'full') return void pending.set(ws, 'full')
    pending.set(ws, new Set([...(cur ?? []), ...what]))
  }
  // One workspace at a time. A warm runs in one read transaction that holds a pooled connection while some of its reads
  // take another; several at once could hold every connection and wait on each other until Postgres ends them
  // (staging, 3 connections, 2026-10-11). Warming is background work: queued, it never takes more than two.
  let lane: Promise<unknown> = Promise.resolve()
  const oneAtATime = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = lane.then(fn, fn)
    lane = next.catch(() => undefined).then(() => (restMs > 0 ? new Promise<void>((r) => setTimeout(r, restMs).unref?.()) : undefined))
    return next
  }

  const run = async (ws: string, force = false): Promise<void> => {
    timers.delete(ws)
    if (!force && opts.busy && Date.now() - (since.get(ws) ?? Date.now()) < maxWaitMs) {
      const syncing = await withWorkspace(ws, () => (opts.busy as (w: string) => Promise<boolean>)(ws)).catch(() => false)
      if (syncing) {
        if (!timers.has(ws)) arm(ws)
        return
      }
    }
    since.delete(ws)
    const busy = running.get(ws)
    // Changed again while warming: one more pass when this one ends (what's pending stays), not a second one alongside.
    if (busy) return busy
    const what = pending.get(ws) ?? 'full'
    pending.delete(ws)
    if (what !== 'full') lastWriteWarm.set(ws, Date.now())
    else lastFullWarm.set(ws, Date.now())
    // Started from a sync's hook, the timer would count into that sync's perf line: measured on its own instead.
    readyKeys.set(ws, new Set())
    const work = () => withWorkspace(ws, () => (what === 'full' ? warm(ws, (key) => ready(ws, key)) : warm(ws, (key) => ready(ws, key), [...what])))
    const p = oneAtATime(() => (perfEnabled() ? withPerfDetached(work).then((r) => console.info(`[agfn] perf warm ${ws}: ${perfLine(r)}`)) : work()))
      .catch((err: unknown) => opts.log?.('cache warm failed', { workspaceId: ws, error: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        running.delete(ws)
        readyKeys.delete(ws)
        for (const w of waiters.get(ws) ?? []) w.resolve()
        waiters.delete(ws)
        const next = pending.get(ws)
        if (next === 'full') armFull(ws)
        else if (next) armWrite(ws, 0)
      })
    running.set(ws, p)
    return p
  }

  const arm = (ws: string, ms = delayMs, force = false): void => {
    const t = timers.get(ws)
    if (t) clearTimeout(t)
    const next = setTimeout(() => void run(ws, force), ms)
    next.unref?.()
    timers.set(ws, next)
  }

  const schedule = (ws: string): void => {
    if (!since.has(ws)) since.set(ws, Date.now())
    want(ws, 'full')
    armFull(ws)
  }

  /** A sync's warm: `delayMs` after the last call, and no sooner than fullGapMs after the last full warm. */
  const armFull = (ws: string): void => {
    const at = Math.max(Date.now() + delayMs, (lastFullWarm.get(ws) ?? 0) + fullGapMs)
    arm(ws, at - Date.now())
  }

  /** A write's warm: after `ms`, and no sooner than writeGapMs after the last one. Not held back by the busy check. */
  const armWrite = (ws: string, ms: number): void => {
    const at = Math.max(Date.now() + ms, (lastWriteWarm.get(ws) ?? 0) + writeGapMs)
    arm(ws, at - Date.now(), true)
    soonUntil.set(ws, at)
  }

  return {
    schedule,
    async wait(ws, maxMs, key) {
      // A write's warm about to start: wait for it to start, within the same budget, then wait on it as usual.
      const due = soonUntil.get(ws)
      const t0 = Date.now()
      if (!running.has(ws) && due !== undefined && due >= t0 && due - t0 <= WAIT_FOR_START_MS && timers.has(ws)) await new Promise<void>((r) => setTimeout(r, Math.min(due - t0 + 20, maxMs)).unref?.())
      const p = running.get(ws)
      if (!p) return
      maxMs = Math.max(0, maxMs - (Date.now() - t0))
      if (key && readyKeys.get(ws)?.has(key)) return
      let t: ReturnType<typeof setTimeout> | undefined
      const part = key ? new Promise<void>((resolve) => waiters.set(ws, [...(waiters.get(ws) ?? []), { key, resolve }])) : p
      await Promise.race([p, part, new Promise<void>((r) => (t = setTimeout(r, maxMs)))])
      if (t) clearTimeout(t)
    },
    async now(ws, maxMs) {
      const t = timers.get(ws)
      if (t) clearTimeout(t)
      want(ws, 'full')
      let limit: ReturnType<typeof setTimeout> | undefined
      await Promise.race([run(ws, true), new Promise<void>((r) => (limit = setTimeout(r, maxMs)))])
      if (limit) clearTimeout(limit)
    },
    soon(ws, ms, entityIds = []) {
      // A sync's full warm already due covers it.
      if (pending.get(ws) === 'full' && timers.has(ws)) return
      want(ws, entityIds)
      // While one runs, the pass after it picks this up.
      if (running.has(ws)) return
      armWrite(ws, ms)
    },
    async flush() {
      for (const [ws, t] of [...timers]) {
        if (!pending.has(ws)) want(ws, 'full')
        clearTimeout(t)
        void run(ws, true)
      }
      await Promise.all([...running.values()])
    },
  }
}
