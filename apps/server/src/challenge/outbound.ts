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
