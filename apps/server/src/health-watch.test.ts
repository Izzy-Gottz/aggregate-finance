import { describe, expect, it, vi } from 'vitest'
import { BUSY_ALERT_MS, createHealthWatch } from './health-watch.ts'

describe('health watch', () => {
  it('counts busy answers, logs each with its wait, and alerts once a streak passes 2 minutes', async () => {
    let t = 0
    const alert = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watch = createHealthWatch(alert, () => t)
    watch.busy(Promise.resolve(), 0)
    t = 3000
    await Promise.resolve()
    await Promise.resolve()
    expect(warn.mock.calls.flat().join(' ')).toMatch(/healthz busy: database answered after \d+ ms \(busy 1 times/)
    t = BUSY_ALERT_MS - 1
    watch.busy(Promise.resolve(), t)
    expect(alert).not.toHaveBeenCalled()
    t = BUSY_ALERT_MS
    watch.busy(Promise.resolve(), t)
    watch.busy(Promise.resolve(), t)
    expect(alert).toHaveBeenCalledTimes(1)
    expect(alert.mock.calls[0]?.[0]).toBe('error')
    expect(watch.metrics()).toContain('agfn_healthz_busy_total 4')
    expect(watch.metrics()).toContain(`agfn_healthz_busy_streak_seconds ${BUSY_ALERT_MS / 1000}`)
    // A healthy answer ends the streak; the next long streak alerts again.
    watch.ok()
    expect(watch.metrics()).toContain('agfn_healthz_busy_streak_seconds 0')
    t += 1000
    watch.busy(Promise.resolve(), t)
    t += BUSY_ALERT_MS
    watch.busy(Promise.resolve(), t)
    expect(alert).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})
