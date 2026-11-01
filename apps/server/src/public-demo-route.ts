// The door to the public demo (public-demo.ts): anonymous, so every limit is here. Per IP (a minute and a day), for
// everyone together (a minute), how many calls run at once, and the body size. Over a limit: 429 "busy" with
// Retry-After, before any work. Mounted on the main app at /demo/mcp, or on its own demo app (AGFN_ROLE=demo) at /mcp
// and /demo/mcp, so demo load can be kept off the machines real people use.
import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { AgfnHttp, MemoryRateLimiter } from '@agfn/mcp'
import { clientIp } from './security.ts'
import type { Services } from './services.ts'

/** Largest request body the demo accepts (a tool call is a few hundred bytes). */
export const PUBLIC_DEMO_MAX_BODY = 64 * 1024

export function mountPublicDemo(app: Hono<any>, s: Services, paths: string[]): void {
  const door = createPublicDemoDoor(s)
  for (const path of paths) app.all(path, (c) => door(c, path))
}

/**
 * The demo's door as a handler: (request, path) → response, with the limits shared by every path it serves. Also used
 * by /mcp for a demo key (app.ts), so a health checker that can only send a bearer token reaches the same demo.
 */
export function createPublicDemoDoor(s: Services): (c: Context, path: string) => Promise<Response> {
  const { config } = s
  // Per IP leaves room for an agent platform sending many users from a few egress IPs; the global per-minute cap is the
  // real ceiling (demo reads are cached, about 1 ms each).
  const limits = { perIpMinute: 120, perIpDay: 3000, allMinute: config.publicDemoPerMinute ?? 300, inFlight: config.publicDemoMaxInFlight ?? 4 }
  // In memory, per machine: no database write per anonymous call. One limiter per window length (each sweeps by its own).
  const perMinute = new MemoryRateLimiter()
  const perDay = new MemoryRateLimiter()
  let running = 0
  // A burst waits briefly for a slot instead of a 429: agent apps (Lindy, n8n) fire several tool calls at once, and the
  // demo's reads are cached, so a slot frees in milliseconds. Bounded: at most QUEUE_MAX wait, each for QUEUE_WAIT_MS.
  // slot() resolves true with the slot already counted in running.
  const waiting: Array<() => void> = []
  const QUEUE_MAX = 32
  const QUEUE_WAIT_MS = 10_000
  const slot = (): Promise<boolean> => {
    if (running < limits.inFlight) {
      running++
      return Promise.resolve(true)
    }
    if (waiting.length >= QUEUE_MAX) return Promise.resolve(false)
    return new Promise((resolve) => {
      const go = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        const i = waiting.indexOf(go)
        if (i >= 0) waiting.splice(i, 1)
        resolve(false)
      }, QUEUE_WAIT_MS)
      waiting.push(go)
    })
  }
  const busy = (c: Context, retry: number) => {
    c.header('retry-after', String(retry))
    return c.json({ error: 'rate_limited', message: `The public demo is busy. Try again in ${retry}s, or connect your own books at aggregate.finance.` }, 429)
  }
  const tooLarge = (c: Context) => c.json({ error: 'too_large', message: 'That request is too large for the demo.' }, 413)
  const handlers = new Map<string, AgfnHttp | null>()
  const httpFor = (path: string) => {
    if (!handlers.has(path))
      handlers.set(
        path,
        s.mcp && s.publicDemo
          ? new AgfnHttp(s.mcp.service, {
              resourceUrl: `${config.baseUrl}${path}`,
              allowedOrigins: [new URL(config.baseUrl).origin],
              clientIp: (req) => clientIp(req.headers, config.clientIpHeader),
              fixedPrincipal: () => s.publicDemo!.principal(),
              onError: (err) => console.error('[agfn] public demo error', err instanceof Error ? err.message : String(err)),
            })
          : null,
      )
    return handlers.get(path)!
  }
  return async (c, path) => {
    const http = httpFor(path)
    if (!http) return c.notFound()
    if (Number(c.req.header('content-length') ?? '0') > PUBLIC_DEMO_MAX_BODY) return tooLarge(c)
    const now = Date.now()
    const ip = clientIp(c.req.raw.headers, config.clientIpHeader) ?? 'unknown'
    const retry = (await perMinute.hit(`ip:${ip}`, limits.perIpMinute, 60_000, now)) || (await perDay.hit(`ip:${ip}`, limits.perIpDay, 86_400_000, now)) || (await perMinute.hit('all', limits.allMinute, 60_000, now))
    if (retry > 0) return busy(c, retry)
    // No content-length (chunked): read it here, capped, so the cap can't be dodged.
    let req = c.req.raw
    let protocolOnly = req.method !== 'POST'
    if (req.method === 'POST') {
      const body = await req.arrayBuffer()
      if (body.byteLength > PUBLIC_DEMO_MAX_BODY) return tooLarge(c)
      protocolOnly = isProtocolOnly(body)
      req = new Request(req.url, { method: 'POST', headers: req.headers, body })
    }
    // initialize, tools/list, ping and notifications do no ledger work: they don't take a slot.
    if (protocolOnly) return http.fetch(req)
    // Only so many at once; the rest queue briefly (above) instead of starving everything else on the machine.
    if (!(await slot())) return busy(c, 2)
    try {
      return await http.fetch(req)
    } finally {
      // Hand the slot straight to the next in line (running stays the same), or free it.
      const next = waiting.shift()
      if (next) next()
      else running--
    }
  }
}

const PROTOCOL_METHODS = new Set(['initialize', 'ping', 'tools/list', 'prompts/list', 'resources/list', 'resources/templates/list'])

/** Whether a JSON-RPC body (one message or a batch) only asks for protocol housekeeping, not a tool call. */
function isProtocolOnly(body: ArrayBuffer): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown
    const msgs = Array.isArray(parsed) ? parsed : [parsed]
    return msgs.length > 0 && msgs.every((m) => {
      const method = (m as { method?: unknown } | null)?.method
      return typeof method === 'string' && (PROTOCOL_METHODS.has(method) || method.startsWith('notifications/'))
    })
  } catch {
    return false
  }
}

/** A demo key (AGFN_PUBLIC_DEMO_KEYS holds their sha256): a bearer token that reaches the public demo at /mcp. */
export function isPublicDemoKey(authorization: string | undefined, hashes: readonly string[] | undefined): boolean {
  if (!hashes?.length) return false
  const m = /^Bearer\s+(agfn_demo_[A-Za-z0-9_-]{32,})$/i.exec(authorization ?? '')
  return Boolean(m && hashes.includes(createHash('sha256').update(m[1]!).digest('hex')))
}
