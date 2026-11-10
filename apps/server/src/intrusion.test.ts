import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import type { AlertLevel } from './alerts.ts'
import { createHash, createHmac } from 'node:crypto'
import { intrusionGuard, isScannerPath, THRESHOLDS, type FlagLine, type IntrusionMode, type TraceLine } from './intrusion.ts'

const IP_HEADER = 'fly-client-ip'
const SECRET = 'intrusion-test-secret-0123456789abcdef'
/** The tag the guard must produce for an IP under SECRET — a keyed HMAC, never a bare hash of the address. */
const tagFor = (ip: string) => createHmac('sha256', SECRET).update(`intrusion-ip:${ip}`).digest('hex').slice(0, 12)

function harness(mode: IntrusionMode) {
  let t = 1_000_000
  const alerts: Array<{ level: AlertLevel; message: string; fields: Record<string, unknown> }> = []
  const logs: Array<TraceLine | FlagLine> = []
  const app = new Hono()
  app.use('*', intrusionGuard({ mode, ipHeader: IP_HEADER, secret: SECRET, alert: (level, message, fields = {}) => alerts.push({ level, message, fields }), log: (line) => logs.push(line), now: () => t }))
  app.get('/healthz', (c) => c.json({ ok: true }))
  app.get('/ok', (c) => c.json({ ok: true }))
  app.get('/limited', (c) => c.json({ error: 'rate_limited' }, 429))
  app.post('/api/signin/code', (c) => c.json({ error: 'wrong_code' }, 400))
  // The MCP endpoint's OAuth challenge, with or without a (stale) token.
  app.post('/mcp', (c) => c.json({ error: 'invalid_token' }, 401, { 'www-authenticate': 'Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource"' }))
  // A REST route that refuses a bad agent key, and the web app's "Please sign in." for an expired session.
  app.get('/api/v1/overview', (c) => c.json({ error: 'unauthorized' }, 401))
  app.get('/api/me', (c) => c.json({ message: 'Please sign in.' }, 401))
  app.notFound((c) => c.json({ error: 'not_found' }, 404))
  const hit = (path: string, init: RequestInit & { ip?: string } = {}) => {
    const { ip = '203.0.113.7', ...rest } = init
    return app.request(path, { ...rest, headers: { ...(ip ? { [IP_HEADER]: ip } : {}), ...((rest.headers as Record<string, string>) ?? {}) } })
  }
  return { hit, alerts, logs, advance: (ms: number) => (t += ms) }
}

const times = async (n: number, f: () => Response | Promise<Response>) => {
  for (let i = 0; i < n; i++) await f()
}

describe('intrusion guard', () => {
  it('knows scanner paths and leaves real ones alone', () => {
    for (const p of ['/.env', '/.env.production', '/.git/config', '/wp-admin/', '/wp-login.php', '/index.php', '/cgi-bin/luci', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/xmlrpc.php', '/actuator/health'])
      expect(isScannerPath(p), p).toBe(true)
    for (const p of ['/', '/mcp', '/api/v1/overview', '/.well-known/oauth-protected-resource', '/docs/connectors/plaid', '/environment', '/healthz'])
      expect(isScannerPath(p), p).toBe(false)
  })

  it('blocks a scanner for 15 minutes with a plain 429, then lets it back', async () => {
    const h = harness('block')
    await times(THRESHOLDS.scanner, () => h.hit('/.env'))
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toMatchObject({ level: 'warn', message: 'possible intrusion', fields: { kind: 'scanner', count: 3, status: 'blocked 15 min', source: tagFor('203.0.113.7') } })
    // The alert carries a keyed-HMAC tag for the IP, never the address.
    expect(JSON.stringify(h.alerts)).not.toContain('203.0.113.7')
    const blocked = await h.hit('/ok')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('900')
    // Another IP is unaffected, and health checks always pass.
    expect((await h.hit('/ok', { ip: '198.51.100.2' })).status).toBe(200)
    expect((await h.hit('/healthz')).status).toBe(200)
    h.advance(15 * 60_000 + 1)
    expect((await h.hit('/ok')).status).toBe(200)
  })

  it('needs the threshold: a single typo of a scanner path does nothing', async () => {
    const h = harness('block')
    await times(THRESHOLDS.scanner - 1, () => h.hit('/wp-login.php'))
    expect(h.alerts).toHaveLength(0)
    expect((await h.hit('/ok')).status).toBe(200)
  })

  it('counts hits only inside the 10-minute window', async () => {
    const h = harness('block')
    await times(THRESHOLDS.scanner - 1, () => h.hit('/.env'))
    h.advance(10 * 60_000 + 1)
    await h.hit('/.env')
    expect(h.alerts).toHaveLength(0)
  })

  it('flags a burst of wrong sign-in codes', async () => {
    const h = harness('block')
    await times(THRESHOLDS.auth_failures, () => h.hit('/api/signin/code', { method: 'POST' }))
    expect(h.alerts.map((a) => a.fields.kind)).toEqual(['auth_failures'])
    expect((await h.hit('/ok')).status).toBe(429)
  })

  it('flags bad credentials on an authenticated route', async () => {
    const h = harness('block')
    await times(THRESHOLDS.auth_failures, () => h.hit('/api/v1/overview', { headers: { authorization: 'Bearer agfn_wrong' } }))
    expect(h.alerts.map((a) => a.fields.kind)).toEqual(['auth_failures'])
  })

  it('flags repeated trips of our own rate limits', async () => {
    const h = harness('block')
    await times(THRESHOLDS.rate_limited, () => h.hit('/limited'))
    expect(h.alerts.map((a) => a.fields.kind)).toEqual(['rate_limited'])
  })

  it('never counts the MCP/OAuth 401 challenge, with or without a stale token, or an expired web session', async () => {
    const h = harness('block')
    await times(50, () => h.hit('/mcp', { method: 'POST' }))
    await times(50, () => h.hit('/mcp', { method: 'POST', headers: { authorization: 'Bearer expired' } }))
    await times(50, () => h.hit('/api/me'))
    expect(h.alerts).toHaveLength(0)
    expect((await h.hit('/ok')).status).toBe(200)
  })

  it('detect mode alerts once per window and never blocks', async () => {
    const h = harness('detect')
    await times(THRESHOLDS.scanner * 4, () => h.hit('/.env'))
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]!.fields.status).toBe('detected (not blocked)')
    expect((await h.hit('/ok')).status).toBe(200)
    h.advance(10 * 60_000 + 1)
    await times(THRESHOLDS.scanner, () => h.hit('/.env'))
    expect(h.alerts).toHaveLength(2)
  })

  it('a forged cf-connecting-ip on a direct request can only block the sender, not someone else', async () => {
    const h = harness('block')
    // A scanner hits from its own (non-Cloudflare) fly-client-ip while forging cf-connecting-ip to a victim's address.
    await times(THRESHOLDS.scanner, () => h.hit('/.env', { ip: '203.0.113.7', headers: { 'cf-connecting-ip': '198.51.100.99' } }))
    // The sender's real IP is blocked; the forged victim IP is untouched and still gets through.
    expect((await h.hit('/ok', { ip: '203.0.113.7' })).status).toBe(429)
    expect((await h.hit('/ok', { ip: '198.51.100.99' })).status).toBe(200)
  })

  it('does nothing when off, or with no trusted client IP', async () => {
    const off = harness('off')
    await times(10, () => off.hit('/.env'))
    expect(off.alerts).toHaveLength(0)
    const noIp = harness('block')
    await times(10, () => noIp.hit('/.env', { ip: '' }))
    expect(noIp.alerts).toHaveLength(0)
    expect((await noIp.hit('/ok', { ip: '' })).status).toBe(200)
  })
})

describe('intrusion guard: answers and exclusions', () => {
  it('answers scanner paths with a plain 404 in every mode, never the web app fallback', async () => {
    for (const mode of ['detect', 'block', 'off'] as const) {
      const app = new Hono()
      app.use('*', intrusionGuard({ mode, ipHeader: IP_HEADER, secret: SECRET }))
      // The web app's fallback page, which would otherwise answer every unknown path with a 200.
      app.get('*', (c) => c.html('<!doctype html><div id="app"></div>'))
      for (const p of ['/.git/config', '/.env', '/wp-admin/']) {
        const res = await app.request(p, { headers: { [IP_HEADER]: '203.0.113.9' } })
        expect(res.status, `${mode} ${p}`).toBe(404)
        expect(await res.json()).toEqual({ error: 'not_found' })
      }
      expect((await app.request('/ok')).status).toBe(200)
    }
  })

  it('does not count Better Auth OAuth limiter 429s (several AI clients registering behind one NAT)', async () => {
    let alerts = 0
    const app = new Hono()
    app.use('*', intrusionGuard({ mode: 'block', ipHeader: IP_HEADER, secret: SECRET, alert: () => void alerts++ }))
    app.post('/api/auth/oauth2/register', (c) => c.json({ message: 'Too many requests' }, 429))
    app.get('/ok', (c) => c.json({ ok: true }))
    for (let i = 0; i < THRESHOLDS.rate_limited * 4; i++) await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { [IP_HEADER]: '203.0.113.9' } })
    expect(alerts).toBe(0)
    expect((await app.request('/ok', { headers: { [IP_HEADER]: '203.0.113.9' } })).status).toBe(200)
  })
})

describe('intrusion guard: source tag is a keyed HMAC', () => {
  it('tags the IP with a keyed HMAC, not a reversible bare hash', async () => {
    const h = harness('detect')
    await times(THRESHOLDS.scanner, () => h.hit('/.env'))
    const source = h.alerts[0]!.fields.source as string
    expect(source).toBe(tagFor('203.0.113.7'))
    // Not the unkeyed sha256 anyone with the alert could brute-force over the small IPv4 space.
    const bare = createHash('sha256').update('203.0.113.7').digest('hex').slice(0, 12)
    expect(source).not.toBe(bare)
  })

  it('a different secret gives a different tag for the same IP (stable per environment)', async () => {
    const other = createHmac('sha256', 'a-totally-different-env-secret-9876543210').update('intrusion-ip:203.0.113.7').digest('hex').slice(0, 12)
    expect(tagFor('203.0.113.7')).not.toBe(other)
  })
})

describe('intrusion guard: per-request trace after a flag', () => {
  it('logs one line per request from a flagged tag — tag, method, path (no query), status, ms — never the IP', async () => {
    const h = harness('detect')
    await times(THRESHOLDS.scanner, () => h.hit('/.env')) // flags the tag
    const flagged = h.logs.filter((l): l is FlagLine => l.event === 'intrusion_flagged')
    expect(flagged).toHaveLength(1)
    expect(flagged[0]).toMatchObject({ tag: tagFor('203.0.113.7'), kind: 'scanner', count: 3, paths: '/.env /.env /.env' })

    // Subsequent requests from that tag are traced, path only, no query string.
    await h.hit('/api/v1/overview?token=secret123&q=foo', { method: 'GET' })
    await h.hit('/mcp', { method: 'POST' })
    const traces = h.logs.filter((l): l is TraceLine => l.event === 'intrusion_trace')
    expect(traces.map((t) => [t.method, t.path, t.status])).toEqual([
      ['GET', '/api/v1/overview', 401],
      ['POST', '/mcp', 401],
    ])
    expect(traces.every((t) => t.tag === tagFor('203.0.113.7') && typeof t.ms === 'number')).toBe(true)
    // Never the raw IP, never the query string, anywhere in the trace output.
    const dump = JSON.stringify(h.logs)
    expect(dump).not.toContain('203.0.113.7')
    expect(dump).not.toContain('token=secret123')

    // Another IP, not flagged, is never traced.
    await h.hit('/ok', { ip: '198.51.100.2' })
    expect(h.logs.filter((l): l is TraceLine => l.event === 'intrusion_trace').some((t) => t.path === '/ok')).toBe(false)
  })

  it('stops tracing after 60 minutes and caps the window at 200 lines', async () => {
    const h = harness('detect')
    await times(THRESHOLDS.scanner, () => h.hit('/.env'))
    for (let i = 0; i < 250; i++) await h.hit('/ok')
    const traced = () => h.logs.filter((l) => l.event === 'intrusion_trace').length
    expect(traced()).toBe(200) // capped, even though 250 requests came through
    h.advance(60 * 60_000 + 1)
    await h.hit('/ok')
    expect(traced()).toBe(200) // window closed, no new lines
  })
})
