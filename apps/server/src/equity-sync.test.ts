// The cap table's connection holds records only (connector 'equity', no credentials): the hourly sync.all must never
// turn it into an error or a "not syncing" line in data health (it did: "connector equity is not installed").
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { financeFor } from './finance.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
const outbox: string[] = []

beforeAll(async () => {
  const modules = await loadInstalledModules({})
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, ledger: modules.ledger, mcp: modules.mcp, fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
}, 60_000)
afterAll(() => booted?.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

describe('cap table connection and sync.all', () => {
  it('a SAFE (cash in) makes a records-only connection that sync.all keeps active, error-free and out of data health', async () => {
    const s = booted.services
    const cookie = await signIn('founder@example.com')
    const h = { 'content-type': 'application/json', origin: BASE, cookie }
    expect((await app.request('/api/workspaces', { method: 'POST', headers: h, body: JSON.stringify({ companyName: 'Acme' }) })).status).toBe(201)
    const ent = await s.db.selectFrom('entities').select(['id', 'workspace_id']).where('name', '=', 'Acme').executeTakeFirstOrThrow()
    const ws = ent.workspace_id
    const r = await app.request(`/api/entities/${ent.id}/equity/events`, { method: 'POST', headers: { ...h, 'x-agfn-workspace': ws }, body: JSON.stringify({ kind: 'safe', date: '2025-03-15', stakeholder: 'Kite', amount: { minor: 25_000_00, currency: 'USD' }, valuationCap: { minor: 8_000_000_00, currency: 'USD' }, idempotencyKey: 'stake-one' }) })
    expect(r.status, await r.clone().text()).toBeLessThan(300)
    const conn = await s.db.selectFrom('connections').selectAll().where('workspace_id', '=', ws).where('connector_key', '=', 'equity').executeTakeFirstOrThrow()
    expect(conn.secret_enc).toBeNull()

    const health = () => financeFor(s).reader.metric('data_health', { workspaceId: ws, entityIds: [ent.id] })
    const before = await health()

    // As live had it: an old run left the error, and the last success is days old.
    await s.db.updateTable('connections').set({ status: 'error', last_error: 'connector equity is not installed', last_success_at: '2026-01-01T00:00:00.000Z' }).where('id', '=', conn.id).execute()
    await s.db.deleteFrom('jobs').where('workspace_id', '=', ws).execute()
    await s.sync.requestAll()

    const after = await s.db.selectFrom('connections').selectAll().where('id', '=', conn.id).executeTakeFirstOrThrow()
    expect(after).toMatchObject({ status: 'active', last_error: null })
    expect(Date.now() - Date.parse(after.last_success_at!)).toBeLessThan(60_000)
    // No job queued for it, and running a sync by hand is a no-op, not an error.
    expect(await s.db.selectFrom('jobs').select('id').where('workspace_id', '=', ws).execute()).toHaveLength(0)
    expect(await s.sync.sync(conn.id)).toMatchObject({ status: 'ok' })
    const now = await health()
    expect(now.value).toBe(before.value)
    expect(now.health?.staleSources ?? 0).toBe(before.health?.staleSources ?? 0)
  }, 60_000)
})
