import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, nextDailyUtc, JobQueue, RELEASE_LIVE_MS, Worker, type CoreTables, type DbHandle } from './index.ts'

let h: DbHandle<CoreTables>
let q: JobQueue
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  q = new JobQueue(h.db)
})
afterEach(() => h.close())

describe('JobQueue', () => {
  it('claims a job once', async () => {
    await q.enqueue('sync', { a: 1 })
    const a = await q.claim('w1', ['sync'], 60_000)
    const b = await q.claim('w2', ['sync'], 60_000)
    expect(a?.payload).toEqual({ a: 1 })
    expect(b).toBeNull()
  })

  it('dedupes by unique key while queued', async () => {
    expect(await q.enqueue('sync', {}, { uniqueKey: 'conn1' })).not.toBeNull()
    expect(await q.enqueue('sync', {}, { uniqueKey: 'conn1' })).toBeNull()
  })

  // A sync re-queues its own next page while it still runs: that must wait its turn, not be dropped (the demo import
  // chain stalled on it), and must not run alongside the first.
  it('a job asked for while its twin runs waits, then runs after it', async () => {
    const t0 = new Date()
    await q.enqueue('sync', { page: 1 }, { uniqueKey: 'conn1' })
    const first = (await q.claim('w1', ['sync'], 60_000, t0))!
    expect(await q.enqueue('sync', { page: 2 }, { uniqueKey: 'conn1' })).not.toBeNull()
    expect(await q.enqueue('sync', { page: 3 }, { uniqueKey: 'conn1' })).toBeNull()
    expect(await q.claim('w2', ['sync'], 60_000, new Date())).toBeNull()
    await q.complete(first)
    expect((await q.claim('w2', ['sync'], 60_000, new Date()))?.payload).toEqual({ page: 2 })
  })

  it('asking again sooner pulls a waiting job forward, never back', async () => {
    const later = new Date(Date.now() + 30 * 60_000)
    await q.enqueue('sync', {}, { uniqueKey: 'conn1', runAt: later })
    expect(await q.claim('w', ['sync'], 60_000)).toBeNull()
    await q.enqueue('sync', {}, { uniqueKey: 'conn1', runAt: new Date(Date.now() + 60 * 60_000) })
    expect((await h.db.selectFrom('jobs').select('run_at').executeTakeFirstOrThrow()).run_at).toBe(later.toISOString())
    await q.enqueue('sync', {}, { uniqueKey: 'conn1' })
    expect(await q.claim('w', ['sync'], 60_000)).not.toBeNull()
  })

  it('reclaims an expired lease', async () => {
    await q.enqueue('sync', {})
    const t0 = new Date()
    expect(await q.claim('w1', ['sync'], 1000, t0)).not.toBeNull()
    expect(await q.claim('w2', ['sync'], 1000, new Date(t0.getTime() + 500))).toBeNull()
    const again = await q.claim('w2', ['sync'], 1000, new Date(t0.getTime() + 2000))
    expect(again?.attempts).toBe(2)
  })

  it('backs off on failure and dies after max attempts', async () => {
    await q.enqueue('sync', {}, { maxAttempts: 2 })
    const now = new Date()
    const j1 = await q.claim('w', ['sync'], 1000, now)
    await q.fail(j1!, new Error('boom'), now)
    expect(await q.claim('w', ['sync'], 1000, now)).toBeNull()
    const later = new Date(now.getTime() + 60_000)
    const j2 = await q.claim('w', ['sync'], 1000, later)
    expect(j2?.attempts).toBe(2)
    await q.fail(j2!, new Error('boom'), later)
    const row = await h.db.selectFrom('jobs').selectAll().executeTakeFirstOrThrow()
    expect(row.status).toBe('dead')
    expect(row.last_error).toBe('boom')
  })
})

describe('JobQueue leases', () => {
  it('a renewed lease is not reclaimed; a stale claim can neither renew, finish nor requeue the newer one', async () => {
    await q.enqueue('sync', {})
    const t0 = new Date()
    const first = (await q.claim('w', ['sync'], 1000, t0))!
    expect(await q.renew(first, 1000, new Date(t0.getTime() + 800))).toBe(true)
    expect(await q.claim('w', ['sync'], 1000, new Date(t0.getTime() + 1500))).toBeNull()
    // Not renewed in time: the same worker claims it again (attempt 2).
    const second = (await q.claim('w', ['sync'], 1000, new Date(t0.getTime() + 2000)))!
    expect(second.attempts).toBe(2)
    expect(await q.renew(first, 1000)).toBe(false)
    await q.fail(first, new Error('stale'))
    await q.complete(first)
    expect(await h.db.selectFrom('jobs').select(['status', 'attempts']).executeTakeFirstOrThrow()).toEqual({ status: 'running', attempts: 2 })
    await q.complete(second)
    expect((await h.db.selectFrom('jobs').select('status').executeTakeFirstOrThrow()).status).toBe('done')
  })
})

describe('Worker', () => {
  it('keeps the lease while a handler runs longer than it, so the job never runs twice at once', async () => {
    await q.enqueue('slow', {})
    let running = 0
    let most = 0
    let release!: () => void
    const done = new Promise<void>((r) => (release = r))
    const w = new Worker(q, {
      workerId: 'w',
      // Several renewals per run, with room for a busy machine (60 ms flaked under the full suite's load).
      leaseMs: 300,
      pollMs: 5,
      concurrency: 4,
      handlers: {
        slow: async () => {
          running++
          most = Math.max(most, running)
          await done
          running--
        },
      },
    })
    await w.start()
    await new Promise((r) => setTimeout(r, 1200))
    release()
    await w.stop()
    expect(most).toBe(1)
    expect((await h.db.selectFrom('jobs').select(['status', 'attempts']).executeTakeFirstOrThrow())).toEqual({ status: 'done', attempts: 1 })
  })


  it('runs handlers, records failures, and stops gracefully', async () => {
    const seen: unknown[] = []
    const w = new Worker(q, {
      workerId: 'w',
      pollMs: 10_000,
      handlers: {
        ok: async (job) => void seen.push(job.payload),
        bad: async () => {
          throw new Error('nope')
        },
      },
    })
    await q.enqueue('ok', 1)
    await q.enqueue('ok', 2)
    await q.enqueue('bad', 3)
    await w.fill()
    await w.drain()
    expect(seen.sort()).toEqual([1, 2])
    const bad = await h.db.selectFrom('jobs').selectAll().where('kind', '=', 'bad').executeTakeFirstOrThrow()
    expect(bad.status).toBe('queued')
    expect(bad.last_error).toBe('nope')
    await w.stop()
  })

  it('re-enqueues recurring jobs exactly once', async () => {
    const w = new Worker(q, { workerId: 'w', pollMs: 10_000, handlers: { tick: async () => {} }, every: { tick: 60_000 } })
    await w.start()
    await w.stop()
    const w2 = new Worker(q, { workerId: 'w2', pollMs: 10_000, handlers: { tick: async () => {} }, every: { tick: 60_000 } })
    await w2.start()
    await w2.stop()
    const rows = await h.db.selectFrom('jobs').selectAll().where('kind', '=', 'tick').execute()
    expect(rows.filter((r) => r.status === 'queued' || r.status === 'running')).toHaveLength(1)
  })
})

// The nightly backup ran "every 24 h from the last run" and drifted to 18:50Z, peak US hours (2026-10-13).
describe('daily jobs at a fixed UTC time', () => {
  it('next time is from the clock: later today, else tomorrow', () => {
    expect(nextDailyUtc(7 * 60, new Date('2026-10-13T05:00:00Z')).toISOString()).toBe('2026-10-13T07:00:00.000Z')
    expect(nextDailyUtc(7 * 60, new Date('2026-10-13T07:00:00Z')).toISOString()).toBe('2026-10-14T07:00:00.000Z')
    expect(nextDailyUtc(7 * 60, new Date('2026-10-13T18:50:00Z')).toISOString()).toBe('2026-10-14T07:00:00.000Z')
    expect(nextDailyUtc(7 * 60, new Date('2026-12-31T23:59:00Z')).toISOString()).toBe('2027-01-01T07:00:00.000Z')
  })

  it('a drifted queued run is moved to the fixed time at start, and each run schedules the next one there', async () => {
    // What live has: the old 24 h-interval job, queued for 18:50Z.
    const drifted = new Date(Date.now() + 3 * 3600_000)
    await q.enqueue('backup', { recurring: 86_400_000 }, { uniqueKey: 'recurring:backup', runAt: drifted })
    const ran: string[] = []
    const w = new Worker(q, { workerId: 'w', pollMs: 10_000, handlers: { backup: async (j) => void ran.push(j.id) }, dailyAtUtc: { backup: 7 * 60 } })
    await w.start()
    const queued = async () => h.db.selectFrom('jobs').select(['id', 'run_at']).where('kind', '=', 'backup').where('status', '=', 'queued').execute()
    const at = nextDailyUtc(7 * 60, new Date()).toISOString()
    expect((await queued()).map((r) => r.run_at)).toEqual([at])
    await w.stop()

    // Due now (the machine was asleep at 07:00): it runs, and the next one is at 07:00Z again, not 24 h from now.
    await h.db.updateTable('jobs').set({ run_at: new Date(Date.now() - 1000).toISOString() }).where('kind', '=', 'backup').execute()
    const w2 = new Worker(q, { workerId: 'w2', pollMs: 10_000, handlers: { backup: async (j) => void ran.push(j.id) }, dailyAtUtc: { backup: 7 * 60 } })
    // Started without its own enqueue moving it: claim straight away.
    await w2.fill()
    await w2.drain()
    expect(ran).toHaveLength(1)
    const next = await queued()
    expect(next).toHaveLength(1)
    expect(next[0]!.run_at).toBe(nextDailyUtc(7 * 60, new Date()).toISOString())
    expect(next[0]!.run_at.slice(11)).toBe('07:00:00.000Z')
    await w2.stop()
  })
})

describe('a daily job keeps its fixed time across restarts', () => {
  it('a boot (new or old release) never runs it early: dailyAtUtc pins it, an ordinary enqueue does not pull it in', async () => {
    const at = nextDailyUtc(7 * 60, new Date()).toISOString()
    const boot = async (id: string, opts: Partial<ConstructorParameters<typeof Worker>[1]>) => {
      const w = new Worker(q, { workerId: id, pollMs: 10_000, handlers: { backup: async () => {} }, ...opts })
      await w.start()
      await w.stop()
    }
    const queued = () => h.db.selectFrom('jobs').select(['run_at', 'status']).where('kind', '=', 'backup').execute()
    // What live has: the job an older release queued (24 h interval), due in an hour.
    await q.enqueue('backup', { recurring: 86_400_000 }, { uniqueKey: 'recurring:backup', runAt: new Date(Date.now() + 3600_000) })
    await boot('new1', { dailyAtUtc: { backup: 7 * 60 } })
    // A machine still on the release before (24 h interval: enqueue for now) boots during the deploy.
    await boot('old', { every: { backup: 86_400_000 } })
    await q.enqueue('backup', {}, { uniqueKey: 'recurring:backup' })
    await boot('new2', { dailyAtUtc: { backup: 7 * 60 } })
    expect(await queued()).toEqual([{ run_at: at, status: 'queued' }])
    // Nothing is due now, so a worker claims nothing.
    expect(await q.claim('w', ['backup'], 60_000)).toBeNull()
  })
})

describe('release guard (a deploy overlap)', () => {
  it('the old release stops claiming once the new one heartbeats, and finishes what it holds', async () => {
    const ran: Array<[string, string]> = []
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const worker = (id: string, rel: string) =>
      new Worker(q, {
        workerId: id,
        release: rel,
        pollMs: 10_000,
        handlers: {
          slow: async () => {
            await held
            ran.push([id, 'slow'])
          },
          job: async (j) => void ran.push([id, (j.payload as { n: string }).n]),
        },
      })
    const oldW = worker('old', 'image-A')
    // The old release is alone: it claims, and is mid-way through a long job when the deploy starts.
    await q.enqueue('slow', {})
    await oldW.fill()
    // The new release comes up (its first heartbeat), and queues jobs only it understands.
    const newW = worker('new', 'image-B')
    await q.heartbeatRelease('image-B', new Date(Date.now() + 1000))
    await q.enqueue('job', { n: 'one' })
    await q.enqueue('job', { n: 'two' })
    await oldW.fill()
    expect(ran).toEqual([])
    await newW.fill()
    await newW.drain()
    expect(ran).toEqual([['new', 'one'], ['new', 'two']])
    // The old worker still finishes the job it held.
    release()
    await oldW.drain()
    expect(ran.at(-1)).toEqual(['old', 'slow'])
    await oldW.stop()
    await newW.stop()
  })

  it('workers on the same release all claim, and an old release resumes once the new one is gone', async () => {
    const ran: string[] = []
    const w = (id: string, rel: string) => new Worker(q, { workerId: id, release: rel, pollMs: 10_000, concurrency: 1, handlers: { job: async () => void ran.push(id) } })
    const a1 = w('a1', 'image-A')
    const a2 = w('a2', 'image-A')
    await q.enqueue('job', {})
    await q.enqueue('job', {})
    await a2.fill()
    await a1.fill()
    await Promise.all([a1.drain(), a2.drain()])
    expect(ran.sort()).toEqual(['a1', 'a2'])
    // A newer release that then stopped (rolled back, or its machines gone): after RELEASE_LIVE_MS the old one claims again.
    const past = new Date(Date.now() - RELEASE_LIVE_MS - 5000)
    await q.heartbeatRelease('image-B', past)
    await h.db.updateTable('worker_releases').set({ first_seen: new Date(Date.now() + 1000).toISOString(), last_seen: past.toISOString() }).where('release', '=', 'image-B').execute()
    await q.enqueue('job', {})
    await a1.fill()
    await a1.drain()
    expect(ran.filter((x) => x === 'a1')).toHaveLength(2)
    await a1.stop()
    await a2.stop()
  })

  it('a new release that never passes its ready gate (an aborted deploy) does not cordon the old one', async () => {
    const ran: string[] = []
    let ready = false
    const cordons: string[] = []
    const oldW = new Worker(q, { workerId: 'old', release: 'image-A', pollMs: 10_000, onCordon: (r) => cordons.push(r), handlers: { job: async () => void ran.push('old') } })
    const newW = new Worker(q, { workerId: 'new', release: 'image-B', releaseReady: () => ready, pollMs: 10_000, handlers: { job: async () => void ran.push('new') } })
    await oldW.fill()
    await q.enqueue('job', {})
    await newW.fill()
    await oldW.fill()
    await oldW.drain()
    expect(ran).toEqual(['old'])
    // Ready: announced (a little later than the old release), and it takes over; the old one logs once.
    ready = true
    await new Promise((r) => setTimeout(r, 5))
    await newW.fill()
    await q.enqueue('job', {})
    await oldW.fill()
    await oldW.fill()
    await newW.fill()
    await newW.drain()
    expect(ran).toEqual(['old', 'new'])
    expect(cordons).toEqual(['image-A'])
    await oldW.stop()
    await newW.stop()
  })
})

