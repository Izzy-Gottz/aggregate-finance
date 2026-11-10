// Red-team: the public no-sign-up demo (/demo/mcp) can't reach any other workspace, can't write, can't reach outside,
// survives its nightly swap mid-call, and is limited at the door.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso } from '@agfn/db'
import { ALL_DATA_TYPES, ALL_TOOLS, PUBLIC_DEMO_READ_ONLY, publicDemoGrantShape } from '@agfn/mcp'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { hostedConfigProblems, loadConfig } from './config.ts'
import { mcpFor } from './modules.ts'
import { deleteIfMemberless } from './orphans.ts'
import { planWipe } from './prelaunch-wipe.ts'
import { revokeUnboundOauthGrants } from './retention.ts'
import { PublicDemo, RETIRE_GRACE_MS, resyncConnections } from './public-demo.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start(opts: { enabled?: boolean; config?: Partial<Booted['services']['config']>; slow?: Promise<void> } = {}) {
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', CLIENT_IP_HEADER: 'fly-client-ip' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, mcp: (svc) => mcpFor(svc) })
  const s = booted.services
  const db = s.db
  let clock = new Date('2026-10-12T01:00:00Z')
  // A light demo workspace (the real one is filled by @agfn/demo; tested there): one company with one account.
  const buildDemo = async (personId: string) => {
    const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
    await db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
    for (const [key, status] of [['demo', 'active'], ['manual', 'active'], ['stripe', 'disconnected']] as const)
      await db.insertInto('connections').values({ id: newId(), workspace_id: ids.workspaceId, connector_key: key, entity_id: null, display_name: key, status, config_json: '{}', created_at: nowIso() }).execute()
    return ids.workspaceId
  }
  const resynced: string[] = []
  const demo = new PublicDemo({
    db,
    buildDemo,
    createGrant: (workspaceId, personId, now) => s.mcp!.control.createPublicDemoGrant({ workspaceId, personId }, { shape: publicDemoGrantShape(now) }),
    cleanup: (ids) => deleteIfMemberless({ db, files: s.files, sync: s.sync }, ids),
    getGrant: (ws, id) => s.mcp!.service.store.getGrant(ws, id),
    resync: async (ws) => (resynced.push(ws), resyncConnections(db, { request: async (_w, id) => void resynced.push(id) }, ws)),
    now: () => clock,
    pollMs: 1,
  })
  if (opts.enabled !== false) s.publicDemo = demo
  if (opts.slow) {
    const gate = opts.slow
    s.publicDemo = Object.assign(Object.create(demo), { principal: async () => (await gate, demo.principal()) })
  }
  Object.assign(s.config, opts.config ?? {})
  const app = createApp(s)
  let n = 0
  const call = async (name: string, args: Record<string, unknown> = {}, init: { headers?: Record<string, string>; path?: string; ip?: string } = {}) => {
    const res = await app.request(init.path ?? '/demo/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'fly-client-ip': init.ip ?? '203.0.113.1', ...init.headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++n, method: 'tools/call', params: { name, arguments: args } }),
    })
    return { status: res.status, text: await res.text() }
  }
  // A real customer, with a real company, in another workspace.
  const realPerson = newId()
  await db.insertInto('people').values({ id: realPerson, auth_user_id: null, name: 'Real', email: 'real@acme.example', created_at: nowIso() }).execute()
  const real = await createWorkspace(db, { personId: realPerson, workspaceName: 'Acme', firstCompanyName: 'Acme Secret Holdings' })
  return { app, db, s, demo, call, real, resynced, setClock: (d: Date) => (clock = d), now: () => clock }
}

describe('public demo (/demo/mcp)', () => {
  it('is a 404 unless turned on, and says "being rebuilt" until the books exist', async () => {
    const off = await start({ enabled: false })
    expect((await off.call('whoami')).status).toBe(404)
    await booted!.shutdown()
    booted = undefined
    const t = await start()
    const r = await t.call('whoami')
    expect(r.status).toBe(503)
    expect(r.text).toMatch(/being rebuilt/)
  })

  it('sees every kind of data, payroll and Personal included, read-only (made-up books; a P&L needs payroll)', async () => {
    const t = await start()
    await t.demo.rebuild()
    const p = (await t.demo.principal())!
    expect([...p.grant.dataTypes].sort()).toEqual([...ALL_DATA_TYPES].sort())
    expect(p.grant.write).toBe(false)
    const row = (await t.db.selectFrom('grants' as never).select(['data_types_json' as never]).where('id' as never, '=', p.grant.id as never).executeTakeFirstOrThrow()) as { data_types_json: string }
    expect([...JSON.parse(row.data_types_json)].sort()).toEqual([...ALL_DATA_TYPES].sort())
    // The server makes the real demo's grant with the same shape.
    expect(readFileSync(new URL('./boot.ts', import.meta.url), 'utf8')).toContain('createPublicDemoGrant({ workspaceId, personId }, { shape: publicDemoGrantShape(now) })')
  })

  it('a demo key at /mcp reaches the public demo (read-only), and nothing else does', async () => {
    const key = 'agfn_demo_' + 'k'.repeat(32)
    const hash = createHash('sha256').update(key).digest('hex')
    const t = await start({ config: { publicDemoKeyHashes: [hash] } })
    await t.demo.rebuild()
    const auth = (k: string) => ({ path: '/mcp', headers: { authorization: `Bearer ${k}` } })
    const who = await t.call('whoami', {}, auth(key))
    expect(who.status).toBe(200)
    expect(who.text).toMatch(/Northwind/)
    expect(who.text).not.toMatch(/Acme Secret/)
    expect((await t.call('add_entry', { company: 'Northwind', amount: '1.00', currency: 'USD', date: '2026-10-12', counterparty: 'x', description: 'x', idempotency_key: 'k' }, auth(key))).text).toContain(PUBLIC_DEMO_READ_ONLY)
    // A wrong demo key, or none, is the real /mcp's 401.
    expect((await t.call('whoami', {}, auth('agfn_demo_' + 'x'.repeat(32)))).status).toBe(401)
    expect((await t.call('whoami', {}, { path: '/mcp' })).status).toBe(401)
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, AGFN_PUBLIC_DEMO_KEYS: `${hash}, not-a-hash` }).publicDemoKeyHashes).toEqual([hash])
  })

  it('answers reads from the demo books only; no header, parameter or token reaches another workspace', async () => {
    const t = await start()
    await t.demo.rebuild()
    const who = await t.call('whoami')
    expect(who.status).toBe(200)
    expect(who.text).toMatch(/Northwind/)
    expect(who.text).not.toMatch(/Acme Secret/)
    const tries: Array<{ headers?: Record<string, string>; path?: string }> = [
      { headers: { authorization: 'Bearer agfn_live_0000000000000000000000000000' } },
      { headers: { 'x-agfn-workspace': t.real.workspaceId, 'x-workspace-id': t.real.workspaceId } },
      { headers: { cookie: 'better-auth.session_token=forged' } },
      { path: `/demo/mcp?workspace=${t.real.workspaceId}&workspaceId=${t.real.workspaceId}` },
    ]
    for (const x of tries) {
      const r = await t.call('get_overview', {}, x)
      expect(r.status, JSON.stringify(x)).toBe(200)
      expect(r.text).not.toMatch(/Acme Secret/)
    }
    // Only the MCP path: none of the REST or control surface.
    expect((await t.app.request('/demo/mcp/../v1/control/grants')).status).not.toBe(200)
  })

  it('refuses every write, and every tool that reaches outside Aggregate, with the demo message', async () => {
    const t = await start()
    await t.demo.rebuild()
    const refused = ALL_TOOLS.filter((x) => x.kind === 'write' || x.hints?.openWorldHint || x.name === 'refresh_balance' || x.name === 'share_answer')
    expect(refused.length).toBeGreaterThan(5)
    const p = (await t.demo.principal())!
    // Refused before the arguments are even read: whatever an AI sends, nothing runs.
    for (const tool of refused) {
      const r = await t.s.mcp!.service.callTool(p, tool.name, { company: 'Northwind', idempotency_key: 'k' })
      expect(r.ok, tool.name).toBe(false)
      if (!r.ok) expect(r.error.message, tool.name).toBe(PUBLIC_DEMO_READ_ONLY)
    }
    // The connection itself is read-only, and it writes no activity rows (visitors are anonymous): only counts.
    expect(p.grant.write).toBe(false)
    const rows = await (t.db as any).selectFrom('activity_log').select('id').where('workspace_id', '=', p.workspaceId).where('actor_kind', '=', 'agent').execute()
    expect(rows).toEqual([])
    expect(t.s.mcp!.service.publicDemoCounts.get('whoami:ok') ?? 0).toBe(0)
    await t.call('whoami')
    expect(t.s.mcp!.service.publicDemoCounts.get('whoami:ok')).toBe(1)
  })

  it('computes each read once a minute for every visitor together, per books', async () => {
    const t = await start()
    await t.demo.rebuild()
    const p = (await t.demo.principal())!
    const svc = t.s.mcp!.service
    const reads = vi.spyOn(svc.reader, 'entities')
    const runs = () => reads.mock.calls.length
    const first = await svc.callTool(p, 'whoami', {})
    expect(first.ok).toBe(true)
    const once = runs()
    expect(once).toBeGreaterThan(0)
    for (let i = 0; i < 4; i++) expect(await svc.callTool(p, 'whoami', {})).toEqual(first)
    expect(runs()).toBe(once)
    // A visitor changing its copy changes nobody else's.
    const mine = await svc.callTool(p, 'whoami', {})
    if (mine.ok) (mine.output as { data?: unknown }).data = 'changed'
    expect(await svc.callTool(p, 'whoami', {})).toEqual(first)
    // The next night's books are new books: nothing carries over.
    t.setClock(new Date('2026-10-13T00:05:00Z'))
    await t.demo.tick()
    await svc.callTool((await t.demo.principal())!, 'whoami', {})
    expect(runs()).toBeGreaterThan(once)
  })

  it('the nightly swap keeps calls already under way working, then retires the old books after the grace period', async () => {
    const t = await start()
    await t.demo.rebuild()
    const before = (await t.demo.principal())!
    // Next UTC day: the hourly tick rebuilds.
    t.setClock(new Date('2026-10-13T00:05:00Z'))
    await t.demo.tick()
    const after = (await t.demo.principal())!
    expect(after.workspaceId).not.toBe(before.workspaceId)
    // A call that started on yesterday's books still finishes on them.
    const inflight = await t.s.mcp!.service.callTool(before, 'whoami', {})
    expect(inflight.ok).toBe(true)
    // The same day: no second rebuild.
    await t.demo.tick()
    expect((await t.demo.principal())!.workspaceId).toBe(after.workspaceId)
    // After the grace period the old books are gone: their connection is revoked, the workspace deleted.
    t.setClock(new Date(t.now().getTime() + RETIRE_GRACE_MS + 1000))
    await t.demo.tick()
    expect(await t.db.selectFrom('workspaces').select('id').where('id', '=', before.workspaceId).executeTakeFirst()).toBeUndefined()
    const late = await t.s.mcp!.service.callTool(before, 'whoami', {})
    expect(late.ok).toBe(false)
    expect((await t.call('whoami')).status).toBe(200)
  })

  it('re-syncs the demo books every hour it does not rebuild them, so "last synced" is recent and true', async () => {
    const t = await start()
    await t.demo.rebuild()
    const ws = (await t.demo.principal())!.workspaceId
    expect(t.resynced).toEqual([])
    t.setClock(new Date('2026-10-12T02:00:00Z'))
    await t.demo.tick()
    // The live demo connection only: not the by-hand records, not a disconnected source.
    const live = await t.db.selectFrom('connections').select('id').where('workspace_id', '=', ws).where('connector_key', '=', 'demo').execute()
    expect(t.resynced).toEqual([ws, ...live.map((r) => r.id)])
    // A rebuild tick (next UTC day) builds fresh books instead.
    t.resynced.length = 0
    t.setClock(new Date('2026-10-13T00:05:00Z'))
    await t.demo.tick()
    expect(t.resynced).toEqual([])
    // The real engine queues a connection.sync job per live connection.
    const fresh = (await t.demo.principal())!.workspaceId
    expect(await resyncConnections(t.db, t.s.sync, fresh)).toBe(1)
    const jobs = await t.db.selectFrom('jobs').select(['kind', 'workspace_id']).where('workspace_id', '=', fresh).where('kind', '=', 'connection.sync').execute()
    expect(jobs.length).toBeGreaterThanOrEqual(1)
  })

  it('limits each IP (120 a minute) and caps the request size', async () => {
    const t = await start()
    await t.demo.rebuild()
    for (let i = 0; i < 120; i++) expect((await t.call('whoami', {}, { ip: '198.51.100.7' })).status).toBe(200)
    const limited = await t.call('whoami', {}, { ip: '198.51.100.7' })
    expect(limited.status).toBe(429)
    expect(limited.text).toMatch(/busy/)
    // Another visitor is unaffected.
    expect((await t.call('whoami', {}, { ip: '198.51.100.8' })).status).toBe(200)
    const big = await t.app.request('/demo/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'fly-client-ip': '198.51.100.9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { q: 'x'.repeat(70_000) } } }) })
    expect(big.status).toBe(413)
  })

  it('is left alone by cleanup: the never-connected sweep and the prelaunch wipe', async () => {
    const t = await start()
    await t.demo.rebuild()
    const p = (await t.demo.principal())!
    expect(await revokeUnboundOauthGrants(t.db, { now: new Date(Date.now() + 7 * 86_400_000) })).toBe(0)
    expect((await t.demo.principal())?.grant.id).toBe(p.grant.id)
    const plan = await planWipe(t.db)
    expect(plan.keepPeople.map((x) => x.id)).toContain(p.personId)
    expect(plan.keepWorkspaces.map((x) => x.id)).toContain(p.workspaceId)
    expect(plan.deleteWorkspaces.map((x) => x.id)).toContain(t.real.workspaceId)
  })

  it('caps calls running at once (a burst waits for a slot) and calls a minute for everyone together, with Retry-After', async () => {
    let open!: () => void
    const t = await start({ config: { publicDemoMaxInFlight: 1, publicDemoPerMinute: 3 }, slow: new Promise<void>((r) => (open = r)) })
    await t.demo.rebuild()
    const first = t.call('whoami', {}, { ip: '192.0.2.1' })
    await new Promise((r) => setTimeout(r, 20))
    // An agent app's parallel call queues behind the running one instead of getting a 429.
    const second = t.call('whoami', {}, { ip: '192.0.2.2' })
    await new Promise((r) => setTimeout(r, 20))
    open()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
    // Three a minute in all (the second one above counted), whatever the IP.
    expect((await t.call('whoami', {}, { ip: '192.0.2.3' })).status).toBe(200)
    const over = await t.app.request('/demo/mcp', { method: 'POST', headers: { 'content-type': 'application/json', 'fly-client-ip': '192.0.2.4' }, body: '{}' })
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it("an agent app's parallel burst from one IP all succeeds, and protocol calls don't take a slot", async () => {
    let open!: () => void
    const t = await start({ config: { publicDemoMaxInFlight: 2 }, slow: new Promise<void>((r) => (open = r)) })
    await t.demo.rebuild()
    // Two slow tool calls hold both slots; initialize, tools/list and eighteen more tool calls arrive meanwhile.
    const held = [t.call('whoami', {}, { ip: '203.0.113.9' }), t.call('whoami', {}, { ip: '203.0.113.9' })]
    await new Promise((r) => setTimeout(r, 20))
    const rpc = (method: string) =>
      t.app.request('/demo/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'fly-client-ip': '203.0.113.9' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } : {} }) })
    const protocol = [rpc('initialize'), rpc('tools/list')]
    const burst = Array.from({ length: 18 }, () => t.call('whoami', {}, { ip: '203.0.113.9' }))
    await new Promise((r) => setTimeout(r, 20))
    open()
    // None is turned away: the tool calls queue for a slot, the protocol calls never take one.
    expect((await Promise.all(protocol)).map((r) => r.status)).toEqual([200, 200])
    expect((await Promise.all([...held, ...burst])).map((r) => r.status)).toEqual(Array(20).fill(200))
  })

  it('on its own demo app (AGFN_ROLE=demo): /mcp and /demo/mcp serve the demo, nothing else is there', async () => {
    const t = await start({ config: { role: 'demo' } })
    await t.demo.rebuild()
    expect((await t.call('whoami', {}, { path: '/mcp' })).text).toMatch(/Northwind/)
    expect((await t.call('whoami')).status).toBe(200)
    for (const path of ['/', '/api/me', '/api/auth/sign-in/magic-link', '/v1/openapi.json', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await t.app.request(path)
      expect(r.status, path).toBe(404)
    }
  })

  it('the main app sends /demo/mcp to the demo app when AGFN_PUBLIC_DEMO_URL names it', async () => {
    const t = await start({ config: { publicDemoUrl: 'https://demo.aggregate.finance/mcp' } })
    const r = await t.app.request('/demo/mcp', { method: 'POST', body: '{}' })
    expect(r.status).toBe(308)
    expect(r.headers.get('location')).toBe('https://demo.aggregate.finance/mcp')
  })

  it('the demo app passes the hosted checks without mail or a file bucket, but still needs the RLS role', () => {
    const env = { AUTH_SECRET: 'x'.repeat(40), AGFN_ROLE: 'demo', DATABASE_URL: 'postgres://u:p@ep-d.neon.tech/demo', BASE_URL: 'https://demo.aggregate.finance', AGFN_PG_RLS_ROLE: 'agfn_app', FLY_APP_NAME: 'aggregate-demo', FLY_IMAGE_REF: 'registry.fly.io/aggregate-demo:deployment-01' }
    const cfg = loadConfig(env)
    expect(cfg.publicDemo).toBe(true)
    expect(hostedConfigProblems(env, cfg)).toEqual([])
    expect(hostedConfigProblems({ ...env, AGFN_PG_RLS_ROLE: undefined }, cfg).join()).toMatch(/AGFN_PG_RLS_ROLE/)
    // Without AGFN_ROLE=demo (a machine missing its config) the full hosted checks apply.
    expect(hostedConfigProblems({ ...env, AGFN_ROLE: undefined }, loadConfig({ ...env, AGFN_ROLE: undefined })).length).toBeGreaterThan(1)
  })
})
