import { sql, type Kysely } from 'kysely'
import { newId } from './ids.ts'
import type { CoreTables, JobsTable } from './schema.ts'

/**
 * Background jobs on the database itself: no Redis, no paid cron (MASTER.md §9 / architecture brief).
 * Claiming uses a conditional UPDATE so several workers (hosted web + worker roles) never run the same job twice.
 */

export interface EnqueueOptions {
  workspaceId?: string | null
  runAt?: Date
  /**
   * At most one queued job per (kind, uniqueKey), and never two running at once: a job asked for while its twin runs
   * (a sync re-queueing its own next page) waits in the queue until that run ends, instead of being dropped.
   */
  uniqueKey?: string
  maxAttempts?: number
  /** With uniqueKey: a queued twin is moved to runAt even if that is later (a fixed daily time replacing a drifted one). */
  exactRunAt?: boolean
}

export type Job = JobsTable & { payload: unknown }

export type JobHandler = (job: Job, signal: AbortSignal) => Promise<void>

const iso = (d: Date) => d.toISOString()

/** The database refused a write that would make a second queued or running twin (jobs_one_queued / jobs_one_running). */
function isTwinConflict(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  // Postgres unique_violation, or SQLite's "UNIQUE constraint failed".
  return e?.code === '23505' || (typeof e?.message === 'string' && /UNIQUE constraint failed: jobs\./.test(e.message))
}

/** A release whose workers haven't heartbeated for this long is gone (its machines stopped). */
export const RELEASE_LIVE_MS = 2 * 60_000

export class JobQueue {
  private db: Kysely<CoreTables>
  constructor(db: Kysely<CoreTables>) {
    this.db = db
  }

  /**
   * Queues a job. With a uniqueKey the database keeps at most one queued twin (jobs_one_queued): the insert does nothing
   * when one is already waiting, and that one is moved instead (sooner, or to a fixed daily time). Two machines asking
   * at once never queue two.
   */
  async enqueue(kind: string, payload: unknown, opts: EnqueueOptions = {}): Promise<string | null> {
    const now = new Date()
    const id = newId()
    const row = {
      id,
      workspace_id: opts.workspaceId ?? null,
      kind,
      payload_json: JSON.stringify(payload ?? null),
      status: 'queued' as const,
      run_at: iso(opts.runAt ?? now),
      attempts: 0,
      max_attempts: opts.maxAttempts ?? 8,
      lease_until: null,
      locked_by: null,
      last_error: null,
      unique_key: opts.uniqueKey ?? null,
      created_at: iso(now),
      updated_at: iso(now),
    }
    if (!opts.uniqueKey) {
      await this.db.insertInto('jobs').values(row).execute()
      return id
    }
    // A waiting twin can be claimed between the insert and the read: then queue again (twice at most).
    for (let tries = 0; tries < 3; tries++) {
      const ins = await this.db
        .insertInto('jobs')
        .values(row)
        // Word for word the index's condition (0521): SQLite matches a partial index to ON CONFLICT only that way.
        .onConflict((oc) => oc.columns(['kind', 'unique_key']).where(sql<boolean>`status = 'queued'`).doNothing())
        .returning('id')
        .executeTakeFirst()
      if (ins) return id
      const existing = await this.db
        .selectFrom('jobs')
        .select(['id', 'run_at', 'payload_json'])
        .where('kind', '=', kind)
        .where('unique_key', '=', opts.uniqueKey)
        .where('status', '=', 'queued')
        .executeTakeFirst()
      if (existing) {
        // Asked for sooner than it's waiting (the next demo import, behind the hourly round's spread-out start): the
        // earlier time wins.
        const at = iso(opts.runAt ?? now)
        // A daily job at a fixed time (Worker dailyAtUtc) is only ever moved by its own schedule: an ordinary enqueue
        // (a machine on an older release during a deploy) must not pull it to now, or every restart runs it.
        const fixed = !opts.exactRunAt && existing.payload_json.includes('"dailyAtUtc"')
        if (opts.exactRunAt) {
          // Its own schedule: the time, and the payload that marks it as fixed (a job queued by an older release says
          // only "recurring").
          const json = JSON.stringify(payload ?? null)
          if (at !== existing.run_at || json !== existing.payload_json) await this.db.updateTable('jobs').set({ run_at: at, payload_json: json, updated_at: iso(now) }).where('id', '=', existing.id).where('status', '=', 'queued').execute()
        } else if (at < existing.run_at && !fixed) await this.db.updateTable('jobs').set({ run_at: at, updated_at: iso(now) }).where('id', '=', existing.id).where('status', '=', 'queued').execute()
        return null
      }
    }
    return null
  }

  /**
   * The release guard. Each worker heartbeats its release; a release is "newer" when it was first seen later (a deploy
   * brings it up). Only workers of the newest release still heartbeating (RELEASE_LIVE_MS) claim jobs; the others are
   * cordoned: they finish what they hold, renewing its leases, and claim nothing. During a deploy's overlap the old
   * release would otherwise claim jobs the new one created, and run them on code that doesn't know what they mean
   * (live, 2026-10-13: a demo pool slot finished by a pre-pool release, stuck for good).
   * Known edge: a rollback that redeploys an image already seen keeps its old first_seen, so its workers stay cordoned
   * until the newer release's heartbeats age out (RELEASE_LIVE_MS after those machines stop). Set AGFN_RELEASE to a
   * fresh value per deploy (boot.ts) to make any deploy count as new.
   */
  async heartbeatRelease(release: string, now = new Date()): Promise<void> {
    await this.db
      .insertInto('worker_releases')
      .values({ release, first_seen: iso(now), last_seen: iso(now) })
      .onConflict((oc) => oc.column('release').doUpdateSet({ last_seen: iso(now) }))
      .execute()
  }

  /** Whether `release` is the newest release with a live heartbeat (none at all: yes). */
  async isNewestRelease(release: string, now = new Date()): Promise<boolean> {
    const newest = await this.db
      .selectFrom('worker_releases')
      .select('release')
      .where('last_seen', '>=', iso(new Date(now.getTime() - RELEASE_LIVE_MS)))
      .orderBy('first_seen', 'desc')
      .orderBy('release', 'desc')
      .limit(1)
      .executeTakeFirst()
    return !newest || newest.release === release
  }

  /** Claims one ready job (queued and due, or running with an expired lease). */
  async claim(workerId: string, kinds: string[], leaseMs: number, now = new Date()): Promise<Job | null> {
    if (kinds.length === 0) return null
    for (let tries = 0; tries < 5; tries++) {
      const candidate = await this.db
        .selectFrom('jobs')
        .selectAll()
        .where('kind', 'in', kinds)
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'queued'), eb('run_at', '<=', iso(now))]),
            eb.and([eb('status', '=', 'running'), eb('lease_until', '<', iso(now))]),
          ]),
        )
        // Not while its twin (same kind and unique key) is running: one run at a time. A twin whose lease ran out is
        // claimed itself (it's a candidate too), so the waiting one still runs after it.
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('jobs as twin')
                .select('twin.id')
                .whereRef('twin.kind', '=', 'jobs.kind')
                .whereRef('twin.unique_key', '=', 'jobs.unique_key')
                .whereRef('twin.id', '!=', 'jobs.id')
                .where('twin.status', '=', 'running'),
            ),
          ),
        )
        .orderBy('run_at')
        .limit(1)
        .executeTakeFirst()
      if (!candidate) return null
      let res: { numUpdatedRows: bigint }
      try {
        res = await this.db
          .updateTable('jobs')
          .set({
            status: 'running',
            locked_by: workerId,
            lease_until: iso(new Date(now.getTime() + leaseMs)),
            attempts: candidate.attempts + 1,
            updated_at: iso(now),
          })
          .where('id', '=', candidate.id)
          .where('status', '=', candidate.status)
          .where('attempts', '=', candidate.attempts)
          .executeTakeFirstOrThrow()
      } catch (err) {
        // Another machine started its twin since this one was read (jobs_one_running): not this one, not now.
        if (isTwinConflict(err)) return null
        throw err
      }
      if (Number(res.numUpdatedRows) === 1) {
        return { ...candidate, status: 'running', locked_by: workerId, attempts: candidate.attempts + 1, payload: JSON.parse(candidate.payload_json) }
      }
    }
    return null
  }

  /**
   * Extends a running job's lease. False when this claim was lost (the lease ran out and someone claimed it again):
   * `attempts` tells this claim from a later one by the same worker.
   */
  async renew(job: Job, leaseMs: number, now = new Date()): Promise<boolean> {
    const r = await this.db
      .updateTable('jobs')
      .set({ lease_until: iso(new Date(now.getTime() + leaseMs)), updated_at: iso(now) })
      .where('id', '=', job.id)
      .where('status', '=', 'running')
      .where('locked_by', '=', job.locked_by)
      .where('attempts', '=', job.attempts)
      .executeTakeFirst()
    return Number(r.numUpdatedRows) === 1
  }

  /** Only this claim's own run can finish it: a stale run never marks a newer claim done. */
  async complete(job: Job): Promise<void> {
    await this.db
      .updateTable('jobs')
      .set({ status: 'done', lease_until: null, updated_at: iso(new Date()) })
      .where('id', '=', job.id)
      .where('locked_by', '=', job.locked_by)
      .where('attempts', '=', job.attempts)
      .execute()
  }

  /** Exponential backoff with jitter: 30s, 1m, 2m … capped at 6h; dead after max_attempts. */
  async fail(job: Job, err: unknown, now = new Date()): Promise<void> {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
    const dead = job.attempts >= job.max_attempts
    const delay = Math.min(30_000 * 2 ** (job.attempts - 1), 6 * 3600_000)
    const jitter = Math.floor(delay * 0.1 * ((job.attempts * 7919) % 10) / 10)
    const retry = (status: 'dead' | 'queued' | 'done', lastError: string) =>
      this.db
        .updateTable('jobs')
        .set({ status, run_at: iso(new Date(now.getTime() + delay + jitter)), lease_until: null, locked_by: null, last_error: lastError, updated_at: iso(now) })
        .where('id', '=', job.id)
        // A stale run (its lease ran out and the job was claimed again) must not requeue the job under the new run.
        .where('locked_by', '=', job.locked_by)
        .where('attempts', '=', job.attempts)
        .execute()
    try {
      await retry(dead ? 'dead' : 'queued', message)
    } catch (err) {
      // A twin was queued while this one ran (jobs_one_queued): that one runs next and does the same work, so this
      // one is finished instead of waiting beside it.
      if (!isTwinConflict(err)) throw err
      await retry('done', `${message.slice(0, 1900)} (a queued twin runs instead)`)
    }
  }

  /** Deletes finished jobs older than the cutoff. */
  async prune(olderThan: Date): Promise<number> {
    const r = await this.db.deleteFrom('jobs').where('status', '=', 'done').where('updated_at', '<', iso(olderThan)).executeTakeFirst()
    return Number(r.numDeletedRows)
  }
}

export interface WorkerOptions {
  workerId: string
  handlers: Record<string, JobHandler>
  leaseMs?: number
  pollMs?: number
  concurrency?: number
  /** Recurring jobs: kind → interval. Re-enqueued with a uniqueKey so restarts never duplicate them. */
  every?: Record<string, number>
  /**
   * Daily jobs at a fixed UTC time: kind → minutes after midnight UTC. Due at the next such time from the clock, never
   * from the last run, so they don't drift (the nightly backup had drifted to 18:50Z, mid-afternoon in the US).
   */
  dailyAtUtc?: Record<string, number>
  onError?: (job: Job, err: unknown) => void
  /** This worker's release (JobQueue.heartbeatRelease): set, it claims only while its release is the newest. */
  release?: string
  /**
   * Whether this process is ready for traffic (the ready gate). Its release is announced only then, so a deploy that
   * fails its health check and is aborted never cordons the machines it was replacing. Until then it claims nothing.
   */
  releaseReady?: () => boolean
  /** Called once when a newer release takes over job claims (a log line). */
  onCordon?: (release: string) => void
}

/** Polling worker loop. stop() waits for running jobs (graceful shutdown). */
export class Worker {
  private queue: JobQueue
  private opts: Required<Omit<WorkerOptions, 'onError' | 'every' | 'dailyAtUtc' | 'release' | 'releaseReady' | 'onCordon'>> & Pick<WorkerOptions, 'onError' | 'every' | 'dailyAtUtc' | 'release' | 'releaseReady' | 'onCordon'>
  private running = new Set<Promise<void>>()
  private abort = new AbortController()
  private timer: NodeJS.Timeout | undefined
  private stopped = false
  private filling: Promise<void> | undefined
  private cordoned = false

  constructor(queue: JobQueue, opts: WorkerOptions) {
    this.queue = queue
    this.opts = { leaseMs: 5 * 60_000, pollMs: 1000, concurrency: 4, ...opts }
  }

  async start(): Promise<void> {
    for (const [kind, ms] of Object.entries(this.opts.every ?? {})) {
      await this.queue.enqueue(kind, { recurring: ms }, { uniqueKey: `recurring:${kind}` })
    }
    for (const [kind, minutes] of Object.entries(this.opts.dailyAtUtc ?? {})) {
      await this.queue.enqueue(kind, { dailyAtUtc: minutes }, { uniqueKey: `recurring:${kind}`, runAt: nextDailyUtc(minutes, new Date()), exactRunAt: true })
    }
    this.tick()
  }

  private tick = (): void => {
    if (this.stopped) return
    this.filling = this.fill()
      .catch((err) => this.opts.onError?.({ kind: 'worker.fill' } as Job, err))
      .finally(() => {
        this.filling = undefined
        if (!this.stopped) this.timer = setTimeout(this.tick, this.opts.pollMs)
      })
  }

  /** Runs ready jobs until none are left or concurrency is full. Exposed for tests. */
  async fill(): Promise<void> {
    const kinds = Object.keys(this.opts.handlers)
    // Cordoned while a newer release runs: what this worker holds keeps running (and renewing); nothing new is claimed.
    if (this.opts.release) {
      if (this.opts.releaseReady && !this.opts.releaseReady()) return
      await this.queue.heartbeatRelease(this.opts.release)
      if (!(await this.queue.isNewestRelease(this.opts.release))) {
        if (!this.cordoned) this.opts.onCordon?.(this.opts.release)
        this.cordoned = true
        return
      }
      this.cordoned = false
    }
    while (!this.stopped && this.running.size < this.opts.concurrency) {
      const job = await this.queue.claim(this.opts.workerId, kinds, this.opts.leaseMs)
      if (!job) return
      const p = this.run(job).finally(() => this.running.delete(p))
      this.running.add(p)
    }
  }

  private async run(job: Job): Promise<void> {
    const handler = this.opts.handlers[job.kind]
    // Keep the lease while the handler runs: a long sync must not be claimed and run a second time alongside itself.
    const leaseMs = this.opts.leaseMs
    const heartbeat = setInterval(() => {
      void this.queue.renew(job, leaseMs).catch((err) => this.opts.onError?.(job, err))
    }, Math.max(10, Math.floor(leaseMs / 3)))
    heartbeat.unref?.()
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`)
      await handler(job, this.abort.signal)
      await this.queue.complete(job)
      const every = this.opts.every?.[job.kind]
      if (every) await this.queue.enqueue(job.kind, job.payload, { uniqueKey: `recurring:${job.kind}`, runAt: new Date(Date.now() + every) })
      const daily = this.opts.dailyAtUtc?.[job.kind]
      if (daily !== undefined) await this.queue.enqueue(job.kind, job.payload, { uniqueKey: `recurring:${job.kind}`, runAt: nextDailyUtc(daily, new Date()), exactRunAt: true })
    } catch (err) {
      this.opts.onError?.(job, err)
      await this.queue.fail(job, err)
    } finally {
      clearInterval(heartbeat)
    }
  }

  async drain(): Promise<void> {
    await Promise.all([...this.running])
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.abort.abort()
    await this.filling
    await this.drain()
  }
}

/** The next time strictly after `now` that is `minutes` past midnight UTC. */
export function nextDailyUtc(minutes: number, now: Date): Date {
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, minutes))
  return at > now ? at : new Date(at.getTime() + 86_400_000)
}
