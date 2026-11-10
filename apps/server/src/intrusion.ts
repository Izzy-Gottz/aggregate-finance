/**
 * Intrusion detection and prevention, in the app (AGFN_INTRUSION). Per client IP, over a 10-minute window, it counts three
 * signals: requests for paths only scanners ask for (/.env, /wp-admin, any .php), failed sign-ins (a wrong email code, or
 * a credential sent and refused), and trips of our own rate limits (429). Crossing a threshold alerts the operator and,
 * in block mode, answers that IP with a plain 429 for 15 minutes. Never a permanent ban.
 *
 * The normal MCP/OAuth challenge never counts: an AI client's first call has no token and gets a 401 with
 * `resource_metadata`, and every directory reviewer's client does exactly that. A browser whose session expired gets a
 * 401 too, with no credential header, so it doesn't count either.
 *
 * Detect is the default (alerts only); `block` turns on the cool-off; `off` skips the counting. Scanner paths answer a
 * plain 404 in every mode. Without a trusted client-IP
 * header (local dev) there's no IP to key on, so nothing is counted. State is in memory: one machine per app today.
 */
import { createHmac } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import type { Alert } from './alerts.ts'
import { clientIp } from './security.ts'

export type IntrusionMode = 'detect' | 'block' | 'off'
export type Signal = 'scanner' | 'auth_failures' | 'rate_limited'

const WINDOW_MS = 10 * 60_000
const COOL_OFF_MS = 15 * 60_000
/** Once flagged, record one line per request from that tag for this long, to see what it's actually probing. */
const TRACE_MS = 60 * 60_000
/** A hard cap on trace lines per tag per window, so a fast sprayer can't flood the log. */
const TRACE_MAX = 200
/** Hits within the window before an IP is flagged. A typo is one scanner hit; a scanner sends dozens. */
export const THRESHOLDS: Record<Signal, number> = { scanner: 3, auth_failures: 10, rate_limited: 5 }
const MAX_TRACKED = 10_000

const SCANNER_PATH =
  /^\/(?:\.env|\.git\/|\.aws\/|\.ssh\/|\.svn\/|\.htaccess|\.htpasswd|\.DS_Store|\.vscode\/|wp-admin|wp-login|wp-content|wp-includes|wordpress\/|xmlrpc|phpmyadmin|pma\/|myadmin|cgi-bin\/|vendor\/phpunit|server-status|actuator|boaform|HNAP1|owa\/|autodiscover\/|config\.json$|backup\.(?:sql|zip|tar)|dump\.sql)|\.(?:php\d?|asp|aspx|jsp|cgi)(?:$|\/)/i

/** True for a path that nothing on this server serves and scanners routinely try. */
export function isScannerPath(path: string): boolean {
  return SCANNER_PATH.test(path)
}

/** Which signal, if any, one finished request adds. */
export function signalFor(req: { method: string; path: string; headers: Headers }, res: { status: number; headers: Headers }): Signal | undefined {
  if (isScannerPath(req.path)) return 'scanner'
  // Better Auth's own OAuth limiter (5 client registrations a minute per IP) isn't counted: an office of AI clients
  // registering at once behind one NAT trips it without being an attack.
  if (res.status === 429) return /\/oauth2\//.test(req.path) ? undefined : 'rate_limited'
  // A wrong email code (400) or too many wrong codes (429, counted above as a rate limit).
  if (req.method === 'POST' && req.path === '/api/signin/code' && res.status === 400) return 'auth_failures'
  if (res.status === 401 && req.headers.has('authorization') && !/resource_metadata/i.test(res.headers.get('www-authenticate') ?? '')) return 'auth_failures'
  return undefined
}

type Track = {
  hits: Record<Signal, Array<{ at: number; path: string }>>
  blockedUntil: number
  flagged: Partial<Record<Signal, number>>
  /** While now < traceUntil, log one line per request from this tag (set when it's flagged). */
  traceUntil: number
  /** Lines logged in the current trace window, capped at TRACE_MAX. */
  traced: number
}

/**
 * A short, stable tag for an IP: enough to match one environment's alerts to each other, without putting addresses in
 * the alert. Keyed HMAC, not a bare hash — alerts leave our servers (webhook/Telegram) and the IPv4 space is small
 * enough to brute-force an unkeyed sha256, so the server-side secret (AUTH_SECRET) is what stops reversal. Stable per
 * environment (each has its own secret), so it does NOT correlate the same IP across live and staging — that's done
 * from the raw IP in the proxy logs, never from this tag.
 */
const tag = (secret: string, ip: string) => createHmac('sha256', secret).update(`intrusion-ip:${ip}`).digest('hex').slice(0, 12)

/** One line per request from an already-flagged tag: the keyed tag, method, path (no query), status, timing. No IP. */
export type TraceLine = { event: 'intrusion_trace'; tag: string; method: string; path: string; status: number; ms: number }
/** Logged once when a tag is flagged: the paths (no query) that tripped it, for the security log — never the alert. */
export type FlagLine = { event: 'intrusion_flagged'; tag: string; kind: Signal; count: number; paths: string }

export function intrusionGuard(opts: { mode: IntrusionMode; ipHeader: string | undefined; secret: string; alert?: Alert; log?: (line: TraceLine | FlagLine) => void; now?: () => number }): MiddlewareHandler {
  const now = opts.now ?? Date.now
  const seen = new Map<string, Track>()
  const prune = (t: number) => {
    if (seen.size < MAX_TRACKED) return
    for (const [ip, tr] of seen) if (tr.blockedUntil <= t && tr.traceUntil <= t && Object.values(tr.hits).every((h) => !h.length || h[h.length - 1]!.at <= t - WINDOW_MS)) seen.delete(ip)
    // Still full of live entries (a wide spray): drop the oldest-inserted, so memory stays bounded.
    for (const ip of seen.keys()) {
      if (seen.size < MAX_TRACKED) break
      seen.delete(ip)
    }
  }
  // One line per request from a tag inside its trace window, capped. c.req.path is the pathname only (no query string),
  // and nothing here reads the query, headers or body — only method, path, status and timing.
  const trace = (ip: string, track: Track, c: Parameters<MiddlewareHandler>[0], started: number) => {
    if (track.traced >= TRACE_MAX) return
    track.traced++
    opts.log?.({ event: 'intrusion_trace', tag: tag(opts.secret, ip), method: c.req.method, path: c.req.path, status: c.res.status, ms: now() - started })
  }
  return async (c, next) => {
    const started = now()
    // Paths only scanners ask for get a plain 404, never the web app's fallback page with a 200 (a 200 on /.git/config
    // reads as a leak in any scan report), and still count as scanner hits below.
    const scanner = isScannerPath(c.req.path)
    const answer = async () => {
      if (scanner) c.res = c.json({ error: 'not_found' }, 404)
      else await next()
    }
    if (opts.mode === 'off' || c.req.path === '/healthz') return answer()
    const ip = clientIp(c.req.raw.headers, opts.ipHeader)
    if (!ip) return answer()
    const t = now()
    const existing = seen.get(ip)
    if (opts.mode === 'block' && existing && existing.blockedUntil > t) {
      const wait = Math.ceil((existing.blockedUntil - t) / 1000)
      c.res = c.json({ error: 'rate_limited', message: 'Too many suspicious requests from this network. Try again in 15 minutes.' }, 429, { 'retry-after': String(wait) })
      if (existing.traceUntil > t) trace(ip, existing, c, started)
      return
    }
    await answer()
    // A tag already under a trace window: record this request before we weigh whether it adds a new signal.
    if (existing && existing.traceUntil > t) trace(ip, existing, c, started)
    const signal = signalFor({ method: c.req.method, path: c.req.path, headers: c.req.raw.headers }, c.res)
    if (!signal) return
    let track = existing
    if (!track) {
      prune(t)
      track = { hits: { scanner: [], auth_failures: [], rate_limited: [] }, blockedUntil: 0, flagged: {}, traceUntil: 0, traced: 0 }
      seen.set(ip, track)
    }
    const hits = (track.hits[signal] = track.hits[signal].filter((h) => h.at > t - WINDOW_MS))
    hits.push({ at: t, path: c.req.path })
    if (hits.length < THRESHOLDS[signal]) return
    // One alert (and one block) per IP and signal per window. The cool-off outlasts the window, so a block that runs out
    // and is earned again alerts again.
    if ((track.flagged[signal] ?? -Infinity) > t - WINDOW_MS) return
    track.flagged[signal] = t
    // Open (or reopen) the per-request trace window; a lapsed window resets the line budget.
    if (track.traceUntil <= t) track.traced = 0
    track.traceUntil = t + TRACE_MS
    if (opts.mode === 'block') track.blockedUntil = t + COOL_OFF_MS
    // The paths that tripped it (path only, no query) go to the security log, never into the outbound alert text.
    opts.log?.({ event: 'intrusion_flagged', tag: tag(opts.secret, ip), kind: signal, count: hits.length, paths: hits.map((h) => h.path).join(' ') })
    opts.alert?.('warn', 'possible intrusion', { kind: signal, count: hits.length, status: opts.mode === 'block' ? 'blocked 15 min' : 'detected (not blocked)', source: tag(opts.secret, ip) })
  }
}
