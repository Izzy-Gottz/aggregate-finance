import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { createDemoConnector } from '@agfn/connector-demo'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { createDemoWorkspace } from '@agfn/demo'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

const fakeBank = (_deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'fakebank', name: 'Fake Bank', group: 'banks', provides: ['balances'], freshness: 'instant', auth: 'api_key' }),
  connect: async () => ({ secret: { k: 1 }, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeBank, (d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
const get = (cookie: string) => ({ headers: { origin: BASE, cookie } })
/** A stored document in a workspace: the simplest row of "their own data". */
const documentRow = async (workspaceId: string) => ({ id: `doc_${workspaceId}`, workspace_id: workspaceId, entity_id: null, storage_key: 'k', sha256: 'x'.repeat(64), mime_type: 'application/pdf', size_bytes: 1, original_name: 'bill.pdf', arrived_via: 'upload' as const, status: 'unread' as const, extracted_json: null, record_type: null, record_id: null, created_by: null, created_at: new Date().toISOString() })

describe('demo workspace API', () => {
  it('opens a demo workspace, marks it demo, refuses real connectors there, and can be left', async () => {
    const cookie = await signIn('try@example.com')
    const res = await app.request('/api/demo', post(cookie))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { workspaceId: string; entities: Array<{ name: string }> }
    expect(body.entities.map((e) => e.name)).toEqual(['Northwind Labs', 'Bluebird Studio', 'Harbor Coffee', 'Personal'])

    const me = (await (await app.request('/api/me', get(cookie))).json()) as { demo: boolean; workspaceId: string }
    // Still filling (syncs are queued): the UI shows "Filling the demo…" until demoReady.
    expect(me).toMatchObject({ demo: true, demoReady: false, workspaceId: body.workspaceId })
    const ws = (await (await app.request('/api/workspace', get(cookie))).json()) as { me: { demo: boolean }; suggested: unknown[]; connections: unknown[] }
    expect(ws.me.demo).toBe(true)
    // Queued first imports show as "syncing" until they finish.
    const demoConns = (ws.connections as Array<{ connectorKey: string; status: string }>).filter((x) => x.connectorKey === 'demo')
    expect(demoConns.map((x) => x.status)).toEqual(['syncing', 'syncing', 'syncing', 'syncing'])
    expect(ws.suggested).toEqual([])
    // Syncs are queued, not run inside the request.
    // One unread receipt, so the documents screen and the AI's document tools have something to show.
    const docs = await booted.handle.db.selectFrom('documents').select(['original_name', 'status']).where('workspace_id', '=', body.workspaceId).execute()
    expect(docs).toEqual([{ original_name: 'receipt-abc-printing.pdf', status: 'unread' }])
    const jobs = await booted.handle.db.selectFrom('jobs').select('kind').where('workspace_id', '=', body.workspaceId).execute()
    // One company at a time: the next starts when the previous catches up (boot.ts).
    expect(jobs).toHaveLength(1)

    const start = await app.request('/api/connectors/fakebank/start', post(cookie))
    expect(start.status).toBe(409)
    expect(((await start.json()) as { message?: string; error?: string }).error).toBe('demo')

    expect((await app.request('/api/demo', post(cookie))).status).toBe(200)
    expect((await app.request('/api/demo', { method: 'DELETE', headers: { origin: BASE, cookie } })).status).toBe(200)
    const after = (await (await app.request('/api/me', get(cookie))).json()) as { needsOnboarding: boolean; demo: boolean }
    expect(after).toMatchObject({ needsOnboarding: true, demo: false })
  })

  it('a company named but still empty can look at the demo first: its own workspace, theirs untouched; leaving goes back', async () => {
    const cookie = await signIn('named@example.com')
    const own = ((await (await app.request('/api/workspaces', post(cookie, { companyName: 'Real Co' }))).json()) as { workspaceId: string }).workspaceId
    const res = await app.request('/api/demo', post(cookie))
    expect(res.status).toBe(201)
    const demo = ((await res.json()) as { workspaceId: string }).workspaceId
    expect(demo).not.toBe(own)
    // Their company stays as it was, with no demo data in it; they now belong to both.
    expect(await booted.handle.db.selectFrom('connections').select('id').where('workspace_id', '=', own).execute()).toEqual([])
    const me = (await (await app.request('/api/me', { headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })).json()) as { demo: boolean; workspaces: Array<{ id: string }> }
    expect(me.demo).toBe(true)
    expect(me.workspaces.map((w) => w.id).sort()).toEqual([own, demo].sort())
    // Leaving: the demo goes; the next request lands in their own company (even naming the demo, now not theirs).
    expect((await app.request('/api/demo', { method: 'DELETE', headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })).status).toBe(200)
    const back = (await (await app.request('/api/me', { headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })).json()) as { workspaceId: string; demo: boolean; needsOnboarding: boolean }
    expect(back).toMatchObject({ workspaceId: own, demo: false, needsOnboarding: false })
  })

  it('a real workspace never gets demo data, and once it holds data the demo isn’t offered', async () => {
    const cookie = await signIn('real@example.com')
    const own = ((await (await app.request('/api/workspaces', post(cookie, { companyName: 'Real Co' }))).json()) as { workspaceId: string }).workspaceId
    expect((await app.request('/api/connectors/demo/start', post(cookie))).status).toBe(409)
    // Their own data (a document is enough): the demo is for before that.
    await booted.handle.db.insertInto('documents').values(await documentRow(own)).execute()
    const refused = await app.request('/api/demo', post(cookie))
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: 'has_data', message: 'The demo is for before you add your own data. Your books are already here.' })
    const list = (await (await app.request('/api/connectors', get(cookie))).json()) as Array<{ key: string }>
    expect(list.map((d) => d.key)).not.toContain('demo')
  })
})

describe('demo AI', () => {
  it('shows Claude already connected, with one write, once the demo books are filled', async () => {
    await booted.shutdown()
    const modules = await loadInstalledModules({})
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, ledger: modules.ledger, mcp: modules.mcp, connectors: [(d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
    app = createApp(booted.services)
    const s = booted.services
    await signIn('ai@example.com')
    const person = await s.db.selectFrom('people').select('id').where('email', '=', 'ai@example.com').executeTakeFirstOrThrow()
    const demo = await createDemoWorkspace({ db: s.db, keys: s.keys }, { personId: person.id, historyDays: 10 })
    const actor = { workspaceId: demo.workspaceId, personId: person.id }

    // Synced by hand here; each one queues the next (one company at a time), which the worker would run. Clear those so
    // the "ready" check doesn't wait on them.
    const ran = async (id: string) => {
      await s.sync.sync(id)
      await s.db.deleteFrom('jobs').where('workspace_id', '=', demo.workspaceId).execute()
    }
    for (const id of demo.connections.slice(0, 3)) await ran(id)
    expect(await s.mcp!.control.listGrants(actor)).toHaveLength(0)
    await ran(demo.connections[3]!)
    const grants = await s.mcp!.control.listGrants(actor)
    expect(grants).toHaveLength(1)
    expect(grants[0]!.grant).toMatchObject({ clientName: 'Claude (demo)' })
    // The write went through (a failed seed clears its claim so the next sync retries).
    expect(await s.db.selectFrom('settings').select('key').where('workspace_id', '=', demo.workspaceId).where('key', '=', 'demo_ai_seeded').executeTakeFirst()).toBeDefined()
    // A re-sync never seeds twice.
    await s.sync.sync(demo.connections[3]!)
    expect(await s.mcp!.control.listGrants(actor)).toHaveLength(1)
  })
})
