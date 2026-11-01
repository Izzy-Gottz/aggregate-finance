// One log line per MCP initialize or tools/list call: which method, how long, which status. Nothing else (no token,
// client, workspace or arguments), so a slow or failed tool load can be told apart from a client-side race.

import type { MiddlewareHandler } from 'hono'

const TIMED = new Set(['initialize', 'tools/list'])
const MAX_PEEK = 64 * 1024

/** The timed JSON-RPC methods in a request body (one message or a batch); [] when there are none or it isn't JSON. */
export function timedMethods(body: string): string[] {
  let msg: unknown
  try {
    msg = JSON.parse(body)
  } catch {
    return []
  }
  const all = Array.isArray(msg) ? msg : [msg]
  return all.map((m) => (m && typeof m === 'object' ? (m as { method?: unknown }).method : undefined)).filter((m): m is string => typeof m === 'string' && TIMED.has(m))
}

export function mcpTiming(log: (line: string, fields: Record<string, unknown>) => void = (l, f) => console.info(l, f)): MiddlewareHandler {
  return async (c, next) => {
    const len = Number(c.req.header('content-length') ?? 0)
    // Only small bodies with a stated length are read twice; streamed or large ones pass through untimed.
    if (c.req.method !== 'POST' || !len || len > MAX_PEEK) return next()
    const methods = timedMethods(await c.req.raw.clone().text().catch(() => ''))
    if (!methods.length) return next()
    const start = performance.now()
    await next()
    log('[agfn] mcp', { method: methods.join(','), ms: Math.round(performance.now() - start), status: c.res.status })
  }
}
