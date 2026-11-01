// Red-team: the web app's no-sign-up demo (public-demo-web.ts). Only allowed reads, only the demo's workspace whatever
// the request names, never for a signed-in person, nothing at all when the demo is off, limited at the door.
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso } from '@agfn/db'
import { publicDemoGrantShape } from '@agfn/mcp'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpFor } from './modules.ts'
import { deleteIfMemberless } from './orphans.ts'
import { PublicDemo } from './public-demo.ts'
import { Hono } from 'hono'
import { ageDemoCacheForTests, DEMO_CACHE_MS, demoAllows, demoGate, DEMO_HEADER, DEMO_WEB_PER_MIN } from './public-demo-web.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start(opts: { enabled?: boolean } = {}) {
  const outbox: string[] = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', CLIENT_IP_HEADER: 'fly-client-ip' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, mcp: (svc) => mcpFor(svc) })
  const s = booted.services
  const db = s.db
  const buildDemo = async (personId: string) => {
    const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
    await db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
    return ids.workspaceId
  }
  const demo = new PublicDemo({
    db,
    buildDemo,
    createGrant: (workspaceId, personId, now) => s.mcp!.control.createPublicDemoGrant({ workspaceId, personId }, { shape: publicDemoGrantShape(now) }),
    cleanup: (ids) => deleteIfMemberless({ db, files: s.files, sync: s.sync }, ids),
    getGrant: (ws, id) => s.mcp!.service.store.getGrant(ws, id),
    pollMs: 1,
  })
  if (opts.enabled !== false) s.publicDemo = demo
  const app = createApp(s)
  const realPerson = newId()
  await db.insertInto('people').values({ id: realPerson, auth_user_id: null, name: 'Real', email: 'real@acme.example', created_at: nowIso() }).execute()
  const real = await createWorkspace(db, { personId: realPerson, workspaceName: 'Acme', firstCompanyName: 'Acme Secret Holdings' })
  const req = (path: string, init: { method?: string; headers?: Record<string, string>; ip?: string; body?: unknown } = {}) =>
    app.request(path, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', origin: BASE, 'fly-client-ip': init.ip ?? '203.0.113.9', [DEMO_HEADER]: '1', ...init.headers }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) })
  const signIn = async (email: string) => {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
    const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  return { app, s, demo, real, req, signIn }
}

describe('web demo: allowlist', () => {
  it('allows only the dashboard reads', () => {
    for (const p of ['/api/me', '/api/workspace', '/api/entities/e_1', '/api/entities/e_1/transactions', '/api/entities/e_1/equity', '/api/entities/e_1/mrr', '/api/buckets/b_1', '/api/review', '/api/connections/c_1']) expect(demoAllows('GET', p), p).toBe(true)
    for (const p of ['/api/preferences', '/api/ai/g_1', '/api/ai/activity/latest', '/api/share', '/api/documents', '/api/documents/d/file', '/api/entities/e_1/equity/ocf', '/api/inbound/e_1', '/api/connectors', '/api/connections/c_1/shared', '/api/export', '/api/usage', '/api/entities/e_1/../../preferences'])
      expect(demoAllows('GET', p), p).toBe(false)
    for (const m of ['POST', 'PATCH', 'PUT', 'DELETE']) expect(demoAllows(m, '/api/workspace')).toBe(false)
  })
})

describe('web demo', () => {
  it('reads the demo books as the demo, and nothing else', async () => {
    const t = await start()
    expect((await t.req('/api/me')).status).toBe(503) // books not built yet
    await t.demo.rebuild()
    const me = (await (await t.req('/api/me')).json()) as { publicDemo?: boolean; email: string; workspaceId: string }
    expect(me.publicDemo).toBe(true)
    expect(me.email).toBe('')
    const ws = (await (await t.req('/api/workspace')).json()) as { entities: Array<{ id: string; name: string }> }
    expect(ws.entities.map((e) => e.name)).toContain('Northwind')
    // Naming another workspace changes nothing: the demo's own books come back.
    const other = (await (await t.req('/api/workspace', { headers: { 'x-agfn-workspace': t.real.workspaceId } })).json()) as { entities: Array<{ name: string }> }
    expect(JSON.stringify(other)).not.toContain('Acme Secret Holdings')
    // Another workspace's company is not found.
    expect((await t.req(`/api/entities/${t.real.companyId}`)).status).toBe(404)
    // Writes and other reads: 403, read-only.
    for (const [method, path] of [['POST', '/api/entries/cash'], ['POST', '/api/workspaces'], ['DELETE', '/api/workspace'], ['PATCH', '/api/preferences'], ['GET', '/api/preferences'], ['GET', '/api/share'], ['POST', '/api/share'], ['POST', '/api/ai/keys']] as const) {
      const r = await t.req(path, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: {} }) })
      expect(r.status, `${method} ${path}`).toBe(403)
      expect(((await r.json()) as { error: string }).error).toBe('demo_read_only')
    }
    // No header, no session: still a plain sign-in.
    expect((await t.app.request('/api/workspace', { headers: { origin: BASE } })).status).toBe(401)
  }, 60_000)

  it('a signed-in person is never switched into the demo', async () => {
    const t = await start()
    await t.demo.rebuild()
    const cookie = await t.signIn('person@example.com')
    const me = (await (await t.req('/api/me', { headers: { cookie } })).json()) as { publicDemo?: boolean; email: string }
    expect(me.publicDemo).toBeUndefined()
    expect(me.email).toBe('person@example.com')
  }, 60_000)

  it('does nothing when the public demo is off', async () => {
    const t = await start({ enabled: false })
    expect((await t.req('/api/me')).status).toBe(401)
    expect((await t.app.request('/demo')).status).toBe(404)
  }, 60_000)

  it('opens from /demo and is limited per address', async () => {
    const t = await start()
    await t.demo.rebuild()
    const r = await t.app.request('/demo')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/#/?demo=1')
    let last = 200
    for (let i = 0; i < 121 && last !== 429; i++) last = (await t.req('/api/review', { ip: '198.51.100.7' })).status
    expect(last).toBe(429)
    // Someone else is unaffected.
    expect((await t.req('/api/review', { ip: '198.51.100.8' })).status).toBe(200)
  }, 60_000)

  it('shares an answer between visitors until the books are rebuilt', async () => {
    const t = await start()
    await t.demo.rebuild()
    const names = async (ip: string) => ((await (await t.req('/api/workspace', { ip })).json()) as { entities: Array<{ name: string }> }).entities.map((e) => e.name)
    expect(await names('198.51.100.20')).toContain('Northwind')
    // Changed underneath: another visitor still gets the shared answer, without rebuilding it.
    const pr = (await t.demo.principal())!
    await t.s.db.updateTable('entities').set({ name: 'Renamed' }).where('workspace_id', '=', pr.workspaceId).where('name', '=', 'Northwind').execute()
    expect(await names('198.51.100.21')).toContain('Northwind')
    // The nightly rebuild is a new workspace: fresh answers at once.
    await t.demo.rebuild()
    expect((await t.demo.principal())!.workspaceId).not.toBe(pr.workspaceId)
    expect(await names('198.51.100.22')).toContain('Northwind')
    expect(((await (await t.req('/api/workspace', { ip: '198.51.100.23' })).json()) as { me: { workspaceId: string } }).me.workspaceId).toBe((await t.demo.principal())!.workspaceId)
  }, 60_000)

  it('caps all visitors together at AGFN_PUBLIC_DEMO_WEB_PER_MIN (default 12000)', async () => {
    expect(DEMO_WEB_PER_MIN).toBe(12_000)
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, AGFN_PUBLIC_DEMO_WEB_PER_MIN: '7' }).publicDemoWebPerMinute).toBe(7)
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }).publicDemoWebPerMinute).toBeUndefined()
    const app = new Hono()
    const now = Date.parse('2031-01-01T00:00:00Z') // its own minute: no other test's hits
    app.get('/api/review', async (c) => (await demoGate(c, c.req.header('x-ip'), now, 3)) ?? c.text('ok'))
    // Three different addresses, then a fourth is refused: the cap is for everyone together.
    const codes = []
    for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) codes.push((await app.request('/api/review', { headers: { 'x-ip': ip } })).status)
    expect(codes).toEqual([200, 200, 200, 429])
  })

  it('serves an older answer at once and refreshes it behind (stale-while-revalidate)', async () => {
    const t = await start()
    await t.demo.rebuild()
    const pr = (await t.demo.principal())!
    const names = async (ip: string) => ((await (await t.req('/api/workspace', { ip })).json()) as { entities: Array<{ name: string }> }).entities.map((e) => e.name)
    expect(await names('198.51.100.30')).toContain('Northwind')
    await t.s.db.updateTable('entities').set({ name: 'Renamed' }).where('workspace_id', '=', pr.workspaceId).where('name', '=', 'Northwind').execute()
    ageDemoCacheForTests(DEMO_CACHE_MS + 1000)
    // Past the window: the old answer at once (no visitor waits), and one refresh starts behind it.
    expect(await names('198.51.100.31')).toContain('Northwind')
    expect(await names('198.51.100.32')).toContain('Northwind')
    let fresh: string[] = []
    for (let i = 0; i < 50 && !fresh.includes('Renamed'); i++) {
      await new Promise((r) => setTimeout(r, 20))
      fresh = await names('198.51.100.33')
    }
    expect(fresh).toContain('Renamed')
    // A client can't skip the shared answer by sending the refresh header without the process's token.
    const r = (await (await t.req('/api/workspace', { ip: '198.51.100.34', headers: { 'x-agfn-demo-refresh': 'guess' } })).json()) as { entities: Array<{ name: string }> }
    expect(r.entities.map((e) => e.name)).toContain('Renamed')
  }, 60_000)
})
