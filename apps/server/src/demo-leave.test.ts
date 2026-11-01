// Leaving the demo answers at once; the demo's books are deleted by a queued job (orphans.ts WORKSPACE_DELETE_JOB),
// and the person never sees the half-deleted demo: their membership is revoked before the answer.
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createDemoConnector } from '@agfn/connector-demo'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { WORKSPACE_DELETE_JOB } from './orphans.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start(runWorker: boolean) {
  const outbox: string[] = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [(d) => createDemoConnector(d)], fileStore: new MemoryFileStore() })
  const app = createApp(booted.services)
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'leaver@example.com', callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  return { app, cookie, db: booted.handle.db }
}
const rowsIn = async (db: Booted['handle']['db'], ws: string) => {
  const out: Record<string, number> = {}
  for (const t of ['workspaces', 'entities', 'connections', 'accounts', 'documents', 'settings', 'memberships'] as const) {
    const col = t === 'workspaces' ? 'id' : 'workspace_id'
    out[t] = (await (db as never as { selectFrom: (t: string) => { select: (c: string) => { where: (a: string, b: string, c: string) => { execute: () => Promise<unknown[]> } } } }).selectFrom(t).select(col).where(col, '=', ws).execute()).length
  }
  return out
}

describe('leaving the demo', () => {
  it('answers without deleting inline: the demo is out of sight at once and its delete is queued', async () => {
    const { app, cookie, db } = await start(false)
    const own = ((await (await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Mine' }) })).json()) as { workspaceId: string }).workspaceId
    const demo = ((await (await app.request('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })).json()) as { workspaceId: string }).workspaceId

    const res = await app.request('/api/demo', { method: 'DELETE', headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })
    expect(res.status).toBe(200)
    // Not deleted inline (the job does it), but already invisible to them: not in their workspaces, not reachable.
    expect((await rowsIn(db, demo)).workspaces).toBe(1)
    const me = (await (await app.request('/api/me', { headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })).json()) as { workspaceId: string; workspaces: Array<{ id: string }> }
    expect(me.workspaceId).toBe(own)
    expect(me.workspaces.map((w) => w.id)).toEqual([own])
    const jobs = await db.selectFrom('jobs').select(['kind', 'payload_json', 'workspace_id', 'status']).where('kind', '=', WORKSPACE_DELETE_JOB).execute()
    expect(jobs).toEqual([{ kind: WORKSPACE_DELETE_JOB, payload_json: JSON.stringify({ workspaceId: demo }), workspace_id: null, status: 'queued' }])
    // Their own company was never queued.
    expect((await rowsIn(db, own)).workspaces).toBe(1)
  })

  it('the job deletes every row of the demo and leaves their company alone', async () => {
    const { app, cookie, db } = await start(true)
    const own = ((await (await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Mine' }) })).json()) as { workspaceId: string }).workspaceId
    const demo = ((await (await app.request('/api/demo', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: '{}' })).json()) as { workspaceId: string }).workspaceId
    expect((await rowsIn(db, demo)).entities).toBeGreaterThan(0)
    expect((await app.request('/api/demo', { method: 'DELETE', headers: { origin: BASE, cookie, 'x-agfn-workspace': demo } })).status).toBe(200)
    const deadline = Date.now() + 15_000
    while ((await rowsIn(db, demo)).workspaces && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
    expect(await rowsIn(db, demo)).toEqual({ workspaces: 0, entities: 0, connections: 0, accounts: 0, documents: 0, settings: 0, memberships: 0 })
    expect((await rowsIn(db, own)).workspaces).toBe(1)
    const done = await db.selectFrom('jobs').select('status').where('kind', '=', WORKSPACE_DELETE_JOB).execute()
    expect(done.map((j) => j.status)).toEqual(['done'])
  }, 30_000)
})
