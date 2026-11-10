import { describe, expect, it } from 'vitest'
import { createOutboundSink, type OutboundCall } from './outbound.ts'

const call = (host: string): OutboundCall => ({ at: new Date().toISOString(), method: 'POST', host, path: '/x', status: 200, ms: 1, ws: null })
const flushMicro = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createOutboundSink', () => {
  it('persists every recorded call, and record never blocks (returns synchronously)', async () => {
    const written: OutboundCall[] = []
    const sink = createOutboundSink(async (calls) => void written.push(...calls))
    for (let i = 0; i < 5; i++) {
      const r = sink.record(call(`h${i}`))
      expect(r).toBeUndefined() // synchronous, non-awaitable
    }
    await sink.flush()
    expect(written.map((c) => c.host)).toEqual(['h0', 'h1', 'h2', 'h3', 'h4'])
    expect(sink.stats()).toEqual({ queued: 0, dropped: 0 })
  })

  it('retries a failed batch once, then succeeds — nothing lost', async () => {
    let attempts = 0
    const written: OutboundCall[] = []
    const sink = createOutboundSink(
      async (calls) => {
        attempts++
        if (attempts === 1) throw new Error('db blip')
        written.push(...calls)
      },
      { retryMs: 1 },
    )
    sink.record(call('h0'))
    await sink.flush()
    expect(attempts).toBe(2) // first fails, retry succeeds
    expect(written.map((c) => c.host)).toEqual(['h0'])
    expect(sink.stats().dropped).toBe(0)
  })

  it('gives up after one retry (never throws), counting the drop', async () => {
    const sink = createOutboundSink(async () => { throw new Error('db down') }, { retryMs: 1 })
    sink.record(call('h0'))
    await expect(sink.flush()).resolves.toBeUndefined() // flush never rejects
    expect(sink.stats().dropped).toBe(1)
  })

  it('bounds the queue: when the db is down, oldest rows drop instead of growing memory', async () => {
    let gate: () => void = () => {}
    const written: OutboundCall[] = []
    // First insert hangs until released, so the queue fills behind it.
    let first = true
    const sink = createOutboundSink(
      async (calls) => {
        if (first) {
          first = false
          await new Promise<void>((r) => (gate = r))
        }
        written.push(...calls)
      },
      { max: 3, batch: 1, retryMs: 1 },
    )
    for (let i = 0; i < 10; i++) sink.record(call(`h${i}`)) // 1 in flight, rest queued; cap 3 → oldest dropped
    expect(sink.stats().queued).toBeLessThanOrEqual(3)
    expect(sink.stats().dropped).toBeGreaterThan(0)
    gate()
    await sink.flush()
    // The most recent rows survived; total handled = written + dropped covers all 10.
    expect(written.length + sink.stats().dropped).toBe(10)
    expect(written.at(-1)?.host).toBe('h9')
  })

  it('flush drains rows that arrive while a drain is already running', async () => {
    const written: OutboundCall[] = []
    const sink = createOutboundSink(async (calls) => { await flushMicro(); written.push(...calls) }, { batch: 1 })
    sink.record(call('a'))
    const flushing = sink.flush()
    sink.record(call('b')) // arrives mid-drain
    await flushing
    await sink.flush()
    expect(written.map((c) => c.host).sort()).toEqual(['a', 'b'])
  })
})
