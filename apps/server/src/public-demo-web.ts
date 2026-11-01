// The web app's no-sign-up demo (app.aggregate.finance/demo): the same dashboard, read-only, on the public demo's books
// (public-demo.ts). A request with no session and `x-agfn-public-demo: 1` runs as the demo's server-chosen person, in
// the demo's workspace, never one named by the request. Only an ALLOWLIST of reads works (a new GET route stays closed
// until it's added here on purpose); every write and every other read is 403. A real session always wins: a signed-in
// person is never switched into the demo. Anonymous, so the limits are at the door, in memory, like /demo/mcp.

import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import { MemoryRateLimiter } from '@agfn/mcp'

export const DEMO_HEADER = 'x-agfn-public-demo'
/** The sessionId a demo request carries, so /api/me can say "publicDemo" and leave out the reserved email. */
export const PUBLIC_DEMO_SESSION = 'public-demo'

const ID = '[A-Za-z0-9_-]{1,80}'
/** The reads the dashboard needs. Nothing about people, keys, AI connections, files, exports or settings. */
const READS: RegExp[] = [
  /^\/api\/me$/,
  /^\/api\/workspace$/,
  new RegExp(`^/api/entities/${ID}$`),
  new RegExp(`^/api/entities/${ID}/(transactions|equity|mrr)$`),
  new RegExp(`^/api/buckets/${ID}$`),
  /^\/api\/review$/,
  new RegExp(`^/api/connections/${ID}$`),
]

export function demoAllows(method: string, path: string): boolean {
  return method === 'GET' && READS.some((r) => r.test(path))
}

export const DEMO_READ_ONLY = 'This is a read-only demo. Sign up to use Aggregate with your own books.'

const perMinute = new MemoryRateLimiter()
const perDay = new MemoryRateLimiter()

/**
 * Everyone together, per minute (AGFN_PUBLIC_DEMO_WEB_PER_MIN). Answers are shared (demoCached), so a request costs
 * about nothing: staging, 2026-10-13, 50 busy visitors used about 2200 a minute at p95 150 ms.
 */
export const DEMO_WEB_PER_MIN = 12_000

/** null: go on as the demo person; otherwise the response to send. */
export async function demoGate(c: Context, ip: string | undefined, now = Date.now(), allPerMinute = DEMO_WEB_PER_MIN): Promise<Response | null> {
  if (!demoAllows(c.req.method, c.req.path)) return c.json({ error: 'demo_read_only', message: DEMO_READ_ONLY }, 403)
  const who = ip ?? 'unknown'
  const retry = (await perMinute.hit(`web:ip:${who}`, 120, 60_000, now)) || (await perDay.hit(`web:ip:${who}`, 3000, 86_400_000, now)) || (await perMinute.hit('web:all', allPerMinute, 60_000, now))
  if (retry > 0) {
    c.header('retry-after', String(retry))
    return c.json({ error: 'rate_limited', message: `The demo is busy. Try again in ${retry}s.` }, 429)
  }
  return null
}

/**
 * Every anonymous visitor sees the same read-only books, so an answer is shared for DEMO_CACHE_MS (5 min) instead of being
 * rebuilt per visitor (staging load test, 2026-10-13: 50 visitors, /api/workspace p50 5 s, all of it database pool
 * wait). Keyed by the demo's workspace, so the nightly rebuild (a new workspace) never serves yesterday's books. Only
 * 200s, and a bounded number of entries.
 */
export const DEMO_CACHE_MS = 5 * 60_000
const DEMO_CACHE_MAX = 500
type Cached = { at: number; status: number; type: string; body: ArrayBuffer }
const cache = new Map<string, Cached>()

export function demoCacheKey(workspaceId: string, url: string): string {
  const u = new URL(url)
  return `${workspaceId} ${u.pathname}${u.search}`
}

/** An answer older than DEMO_CACHE_MS is still served (and refreshed behind it) up to this age. */
export const DEMO_STALE_MS = 60 * 60_000
const refreshing = new Set<string>()
/** Marks the in-process refresh request (random per process, so no client can send it to skip the shared answer). */
export const DEMO_REFRESH_HEADER = 'x-agfn-demo-refresh'
export const DEMO_REFRESH_TOKEN = randomBytes(16).toString('hex')

/**
 * The shared answer for `key`, if any: `fresh` within DEMO_CACHE_MS; older (up to DEMO_STALE_MS) it's still served
 * at once and `refresh` is true for exactly one caller, who re-runs the request behind it (stale-while-revalidate),
 * so a quiet stretch never makes the next visitor wait for a miss (live: a miss adds ~0.7 s to the page). Everyone
 * else keeps getting the old answer while the refresh runs. The refresh request itself skips this (DEMO_REFRESH_TOKEN).
 */
export function demoCached(key: string, now = Date.now()): { hit: Cached; refresh: boolean } | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  const age = now - hit.at
  if (age < DEMO_CACHE_MS) return { hit, refresh: false }
  if (age < DEMO_STALE_MS) {
    const refresh = !refreshing.has(key)
    if (refresh) refreshing.add(key)
    return { hit, refresh }
  }
  cache.delete(key)
  return undefined
}

/** The refresh for `key` is done (stored or not): the next stale read may start another. */
export function demoRefreshed(key: string): void {
  refreshing.delete(key)
}

export async function demoRemember(key: string, res: Response, now = Date.now()): Promise<void> {
  if (res.status !== 200) return
  if (cache.size >= DEMO_CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, { at: now, status: res.status, type: res.headers.get('content-type') ?? 'application/json', body: await res.clone().arrayBuffer() })
}

/** Tests: make every shared answer `ms` older. */
export function ageDemoCacheForTests(ms: number): void {
  for (const v of cache.values()) v.at -= ms
}
