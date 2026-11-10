// The "Make it move a dollar" challenge (docs/launch/challenge.md): every outbound HTTP call this server makes is
// recorded, so a tier A claim ("my AI made it send a payment") is checked against what actually left the server, not
// against what an AI said. Method, host, path (no query string), status, duration and the workspace in context;
// never bodies, headers or query strings, which can carry secrets.
//
// Uses Node's diagnostics channels, so it sees fetch (undici) and node:http(s) alike without patching either, including
// calls made by provider SDKs.

import diagnostics from 'node:diagnostics_channel'
import { currentRlsContext } from '@agfn/db'

export interface OutboundCall {
  at: string
  method: string
  host: string
  path: string
  status: number | null
  ms: number | null
  /** The workspace whose work made the call, when known (row-level security context). */
  ws: string | null
}

const pathOnly = (p: string) => (p.split('?')[0] ?? '').slice(0, 300) || '/'

export interface OutboundSink {
  /** Enqueue a call to persist. Synchronous and non-throwing: it never blocks or breaks the request. */
  record: (call: OutboundCall) => void
  /** Drain everything still queued (call on shutdown). Resolves once the queue is empty or given up on. */
  flush: () => Promise<void>
  stats: () => { queued: number; dropped: number }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * A durable sink for outbound-call rows: tier-A/C judging needs the log complete, so a row must not be lost to a
 * transient database hiccup. Calls are enqueued (never awaited on the request path), a single background drainer writes
 * them in batches, and a failed batch is retried once before it is dropped. The queue is bounded: if the database stays
 * down, the oldest rows are dropped rather than growing memory without limit, and the drop count is reported. Writing is
 * decoupled from the request, so the log never blocks or breaks a call.
 */
export function createOutboundSink(insert: (calls: OutboundCall[]) => Promise<unknown>, opts: { max?: number; batch?: number; retryMs?: number; onDrop?: (total: number) => void } = {}): OutboundSink {
  const max = opts.max ?? 1000
  const batchSize = opts.batch ?? 100
  const retryMs = opts.retryMs ?? 250
  const queue: OutboundCall[] = []
  let dropped = 0
  let draining: Promise<void> | null = null

  const tryInsert = async (calls: OutboundCall[]): Promise<boolean> => {
    try {
      await insert(calls)
      return true
    } catch {
      // One retry is enough: a brief blip clears, a real outage keeps failing and we give up rather than spin.
      try {
        await sleep(retryMs)
        await insert(calls)
        return true
      } catch {
        return false
      }
    }
  }

  const runDrain = async (): Promise<void> => {
    while (queue.length) {
      const batch = queue.splice(0, batchSize)
      if (!(await tryInsert(batch))) {
        dropped += batch.length
        opts.onDrop?.(dropped)
      }
    }
  }
  const kick = (): Promise<void> => {
    if (!draining) draining = runDrain().finally(() => void (draining = null))
    return draining
  }

  return {
    record: (call) => {
      if (queue.length >= max) {
        queue.shift()
        dropped++
        opts.onDrop?.(dropped)
      }
      queue.push(call)
      void kick()
    },
    // Drain until nothing is left and no drain is in flight (new rows may arrive while one runs).
    flush: async () => {
      while (draining || queue.length) await kick()
    },
    stats: () => ({ queued: queue.length, dropped }),
  }
}

/** Start recording. `record` must not throw (failures are swallowed); returns stop(). */
export function startOutboundLog(record: (c: OutboundCall) => void, opts: { ignoreHosts?: string[] } = {}): () => void {
  const ignore = new Set((opts.ignoreHosts ?? []).map((h) => h.toLowerCase()))
  const pending = new WeakMap<object, { started: number; call: OutboundCall }>()
  const ws = () => {
    const c = currentRlsContext()
    return c && 'workspaceId' in c ? c.workspaceId : null
  }
  const emit = (call: OutboundCall) => {
    if (ignore.has(call.host.toLowerCase())) return
    try {
      record(call)
    } catch {
      /* the log never breaks a request */
    }
  }

  // fetch (undici)
  const onCreate = (m: unknown) => {
    const { request } = m as { request: { origin: string | URL; path: string; method: string } }
    const origin = typeof request.origin === 'string' ? new URL(request.origin) : request.origin
    pending.set(request, { started: performance.now(), call: { at: new Date().toISOString(), method: request.method, host: origin.host, path: pathOnly(request.path), status: null, ms: null, ws: ws() } })
  }
  const onHeaders = (m: unknown) => {
    const { request, response } = m as { request: object; response: { statusCode: number } }
    const p = pending.get(request)
    if (!p) return
    pending.delete(request)
    emit({ ...p.call, status: response.statusCode, ms: Math.round(performance.now() - p.started) })
  }
  const onError = (m: unknown) => {
    const { request } = m as { request: object }
    const p = pending.get(request)
    if (!p) return
    pending.delete(request)
    emit({ ...p.call, ms: Math.round(performance.now() - p.started) })
  }
  // node:http and node:https
  const onHttpStart = (m: unknown) => {
    const { request } = m as { request: { method: string; host: string; path: string } }
    pending.set(request, { started: performance.now(), call: { at: new Date().toISOString(), method: request.method, host: request.host, path: pathOnly(request.path), status: null, ms: null, ws: ws() } })
  }
  const onHttpFinish = (m: unknown) => {
    const { request, response } = m as { request: object; response: { statusCode: number } }
    const p = pending.get(request)
    if (!p) return
    pending.delete(request)
    emit({ ...p.call, status: response.statusCode, ms: Math.round(performance.now() - p.started) })
  }
  const onHttpError = (m: unknown) => onError(m)

  const subs: Array<[string, (m: unknown) => void]> = [
    ['undici:request:create', onCreate],
    ['undici:request:headers', onHeaders],
    ['undici:request:error', onError],
    ['http.client.request.start', onHttpStart],
    ['http.client.response.finish', onHttpFinish],
    ['http.client.request.error', onHttpError],
  ]
  for (const [name, fn] of subs) diagnostics.subscribe(name, fn)
  return () => {
    for (const [name, fn] of subs) diagnostics.unsubscribe(name, fn)
  }
}
