import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cacheWarmer } from './warm.ts'

describe('cache warming after sync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a backfill that syncs page after page warms once, after it stops', async () => {
    const warmed: string[] = []
    const w = cacheWarmer(async (ws) => void warmed.push(ws), { delayMs: 8_000 })
    for (let i = 0; i < 5; i++) {
      w.schedule('ws_a')
      await vi.advanceTimersByTimeAsync(5_000) // the next page of the backfill
    }
    w.schedule('ws_b')
    expect(warmed).toEqual([])
    await vi.advanceTimersByTimeAsync(8_000)
    expect(warmed.sort()).toEqual(['ws_a', 'ws_b'])
  })

  it('waits while the workspace is still syncing, but not forever', async () => {
    const warmed: number[] = []
    let syncing = true
    const w = cacheWarmer(async () => void warmed.push(Date.now()), { delayMs: 8_000, busy: async () => syncing, maxWaitMs: 60_000 })
    w.schedule('ws')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(warmed).toEqual([]) // another connection is still importing
    syncing = false
    await vi.advanceTimersByTimeAsync(8_000)
    expect(warmed).toHaveLength(1)

    syncing = true
    w.schedule('ws')
    await vi.advanceTimersByTimeAsync(80_000)
    expect(warmed).toHaveLength(2) // a workspace that never goes quiet is still warmed after maxWaitMs
  })

  it('a change while warming means one more pass afterwards, never two at once', async () => {
    let active = 0
    let most = 0
    let passes = 0
    const w = cacheWarmer(
      async () => {
        active++
        most = Math.max(most, active)
        await new Promise((r) => setTimeout(r, 3_000))
        active--
        passes++
      },
      { delayMs: 1_000, fullGapMs: 0 },
    )
    w.schedule('ws')
    await vi.advanceTimersByTimeAsync(1_500) // warming
    w.schedule('ws')
    await vi.advanceTimersByTimeAsync(1_000) // fires while the first pass runs: queued, not run alongside
    w.schedule('ws') // and again: still one more pass
    await vi.advanceTimersByTimeAsync(20_000)
    expect([passes, most]).toEqual([2, 1])
  })

  it('warms one workspace at a time, so warms never hold every pooled connection at once', async () => {
    let active = 0
    let most = 0
    const done: string[] = []
    const w = cacheWarmer(async (ws) => {
      active++
      most = Math.max(most, active)
      await new Promise((r) => setTimeout(r, 1_000))
      active--
      done.push(ws)
    }, { delayMs: 8_000 })
    for (const ws of ['ws_a', 'ws_b', 'ws_c', 'ws_d']) w.schedule(ws)
    await vi.runAllTimersAsync() // until every queued warm has run, however many turns the queue takes
    expect(done.sort()).toEqual(['ws_a', 'ws_b', 'ws_c', 'ws_d'])
    expect(most).toBe(1)
  })

  it('a failed warm is logged, not thrown', async () => {
    const log = vi.fn()
    const w = cacheWarmer(async () => Promise.reject(new Error('database closed')), { delayMs: 10, log })
    w.schedule('ws')
    await w.flush()
    expect(log).toHaveBeenCalledWith('cache warm failed', { workspaceId: 'ws', error: 'database closed' })
  })

  it('a request that arrives while its workspace warms waits for it (capped); otherwise it doesn\u2019t wait', async () => {
    let finish!: () => void
    const w = cacheWarmer(() => new Promise<void>((r) => (finish = r)), { delayMs: 1_000 })
    let done = false
    await w.wait('ws_a', 4_000).then(() => (done = true))
    expect(done).toBe(true) // nothing running: no wait
    w.schedule('ws_a')
    await vi.advanceTimersByTimeAsync(1_000) // the warm starts and runs
    done = false
    const waiting = w.wait('ws_a', 4_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(500)
    expect(done).toBe(false)
    finish()
    await waiting
    expect(done).toBe(true)
    // A warm that hangs is waited on for at most the cap.
    w.schedule('ws_a')
    await vi.advanceTimersByTimeAsync(1_000)
    done = false
    const capped = w.wait('ws_a', 4_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(4_000)
    await capped
    expect(done).toBe(true)
  })

  it('a request waits only until its own scope is warmed, not for the whole warm', async () => {
    let finish!: () => void
    let mark!: (key: string) => void
    const w = cacheWarmer((_ws, ready) => {
      mark = ready
      return new Promise<void>((r) => (finish = r))
    }, { delayMs: 1_000 })
    w.schedule('ws_a')
    await vi.advanceTimersByTimeAsync(1_000)
    let done = false
    const waiting = w.wait('ws_a', 4_000, 'e1,e2').then(() => (done = true))
    await vi.advanceTimersByTimeAsync(100)
    expect(done).toBe(false)
    mark('e1,e2')
    await waiting
    expect(done).toBe(true)
    // Asked again for a part already ready: no wait at all, though the warm still runs.
    let again = false
    await w.wait('ws_a', 4_000, 'e1,e2').then(() => (again = true))
    expect(again).toBe(true)
    finish()
  })

  it('now: warms at once, even while syncing, and waits only so long', async () => {
    const warmed: string[] = []
    let finish!: () => void
    const w = cacheWarmer(async (ws) => {
      warmed.push(ws)
      await new Promise<void>((r) => (finish = r))
    }, { delayMs: 3_000, busy: async () => true })
    w.schedule('ws_a')
    let done = false
    const p = w.now('ws_a', 10_000).then(() => (done = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(warmed).toEqual(['ws_a'])
    finish()
    await p
    expect(done).toBe(true)
    // The scheduled one was replaced, not run as well.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(warmed).toEqual(['ws_a'])
    // A warm that doesn't end: now gives up waiting at the limit.
    let late = false
    const q = w.now('ws_b', 10_000).then(() => (late = true))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(late).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await q
    expect(late).toBe(true)
    finish()
  })

  it('soon: a write warms shortly, once per burst, and a read in between waits for it to start and finish', async () => {
    const warmed: number[] = []
    let finish!: () => void
    const w = cacheWarmer(async () => {
      warmed.push(Date.now())
      await new Promise<void>((r) => (finish = r))
    }, { delayMs: 3_000, busy: async () => true })
    const t0 = Date.now()
    w.soon('ws', 200)
    await vi.advanceTimersByTimeAsync(100)
    w.soon('ws', 200) // the next write of a burst
    let read = false
    const reading = w.wait('ws', 1_500).then(() => (read = true))
    await vi.advanceTimersByTimeAsync(250)
    expect(warmed).toEqual([t0 + 300]) // started though "busy": a write isn't a sync
    expect(read).toBe(false) // waiting on the warm now, not computing alongside it
    finish()
    await reading
    expect(read).toBe(true)
    expect(warmed).toHaveLength(1)
  })

  it('write warms are narrow and spaced: a burst merges into one, a sync stays full, a read waits only for one due now', async () => {
    const runs: Array<string[] | 'full'> = []
    const w = cacheWarmer(async (_ws, _ready, only) => void runs.push(only ? [...only].sort() : 'full'), { delayMs: 3_000, writeGapMs: 5_000 })
    w.soon('ws', 200, ['e1'])
    await vi.advanceTimersByTimeAsync(250)
    expect(runs).toEqual([['e1']])
    // A burst within the gap: one more warm, 5 s after the last, covering every company it touched.
    w.soon('ws', 200, ['e2'])
    w.soon('ws', 200, ['e3', 'e2'])
    // A read now doesn't sit out its budget for a warm seconds away.
    let read = false
    void w.wait('ws', 1_500).then(() => (read = true))
    await vi.advanceTimersByTimeAsync(10)
    expect(read).toBe(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(runs).toEqual([['e1'], ['e2', 'e3']])
    // A sync's full warm already due takes a write along with it.
    w.schedule('ws')
    w.soon('ws', 200, ['e4'])
    await vi.advanceTimersByTimeAsync(3_000)
    expect(runs).toEqual([['e1'], ['e2', 'e3'], 'full'])
  })

  it('a sync warms a workspace at most once per fullGapMs, and the machine rests between warms', async () => {
    const at: Array<[string, number]> = []
    const t0 = Date.now()
    const w = cacheWarmer(async (ws) => void at.push([ws, Date.now() - t0]), { delayMs: 3_000, fullGapMs: 30_000, restMs: 1_000 })
    // A demo importing connection after connection: a sync settles every 10 s.
    for (let i = 0; i < 4; i++) {
      w.schedule('ws_a')
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await vi.advanceTimersByTimeAsync(40_000)
    expect(at.filter(([ws]) => ws === 'ws_a').map(([, t]) => t)).toEqual([3_000, 33_000])
    // Two workspaces due at once: one after the other, a rest between.
    at.length = 0
    const t1 = Date.now() - t0
    w.schedule('ws_b')
    w.schedule('ws_c')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(at.map(([ws, t]) => [ws, t - t1])).toEqual([['ws_b', 3_000], ['ws_c', 4_000]])
  })
})
