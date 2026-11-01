import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { connectPglite, migrateToLatest, type CoreTables } from '@agfn/db'
import { percentile, INSTANCE, UsageMeter } from './usage.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('usage metering', () => {
  it('counts Plaid Items and products, connections, documents, syncs, MCP calls and emails, and rolls up daily', async () => {
    const cookie = await signIn('founder@example.com')
    await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))
    const db = booted.handle.db
    const ws = (await db.selectFrom('workspaces').select('id').executeTakeFirstOrThrow()).id
    const at = new Date().toISOString()
    const conn = (id: string, key: string, status: 'active' | 'disconnected', config = '{}') =>
      db.insertInto('connections').values({ id, workspace_id: ws, connector_key: key, entity_id: null, display_name: key, status, secret_enc: null, config_json: config, cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: at }).execute()
    await conn('c1', 'plaid', 'active', JSON.stringify({ itemId: 'i1', products: ['liabilities'] }))
    await conn('c2', 'plaid', 'active', JSON.stringify({ itemId: 'i2', products: ['liabilities', 'investments'] }))
    await conn('c3', 'plaid', 'disconnected')
    await conn('c4', 'stripe', 'active')
    await db.insertInto('documents').values({ id: 'd1', workspace_id: ws, entity_id: null, storage_key: 'k1', sha256: 'a'.repeat(64), mime_type: 'application/pdf', size_bytes: 1500, original_name: 'a.pdf', arrived_via: 'upload', status: 'unread', extracted_json: null, record_type: null, record_id: null, created_by: null, created_at: at }).execute()
    for (const ms of [100, 200, 300, 400, 5000]) await booted.services.usage.sample(ws, 'sync_ms', ms)
    await booted.services.usage.sample(ws, 'sync_failed')

    const r = await app.request('/api/usage', { headers: { cookie } })
    expect(r.status).toBe(200)
    const { today } = (await r.json()) as { today: Record<string, unknown> }
    expect(today).toMatchObject({
      plaidItems: { active: 2, products: { transactions: 2, liabilities: 2, investments: 1 } },
      connections: { plaid: { active: 2, total: 3 }, stripe: { active: 1, total: 1 } },
      documents: { count: 1, bytes: 1500 },
      syncJobs: { count: 5, p50Ms: 300, p95Ms: 5000, failed: 1 },
    })
    expect((today.db as { estimatedBytes: number | null }).estimatedBytes).not.toBeNull()

    // Sign-in emails were counted instance-wide.
    expect((await booted.services.usage.instance()).emailsSent).toBeGreaterThanOrEqual(1)

    // The daily job writes one row per workspace plus the instance row, and history reads it back.
    const today0 = new Date().toISOString().slice(0, 10)
    expect(await booted.services.usage.rollup(today0)).toBe(2)
    expect(await booted.services.usage.rollup(today0)).toBe(2)
    const hist = await booted.services.usage.history(ws, 2)
    expect(hist).toHaveLength(1)
    expect(hist[0]).toMatchObject({ day: today0, plaidItems: { active: 2 } })
    expect(await booted.services.usage.history(INSTANCE, 2)).toEqual([expect.objectContaining({ workspaces: 1 })])
  })

  it('is for owners and admins only', async () => {
    const cookie = await signIn('founder@example.com')
    await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))
    await app.request('/api/people', req(cookie, 'POST', { email: 'emp@example.com', role: 'employee', entityIds: 'all' }))
    const emp = await signIn('emp@example.com')
    expect((await app.request('/api/usage', { headers: { cookie: emp } })).status).toBe(403)
  })

  it('works on Postgres too', async () => {
    const h = await connectPglite<CoreTables>()
    try {
      await migrateToLatest(h.db)
      const at = new Date().toISOString()
      await h.db.insertInto('workspaces').values({ id: 'w1', name: 'Acme', base_currency: 'USD', created_at: at }).execute()
      const m = new UsageMeter(h.db, h.kind)
      await m.sample('w1', 'sync_ms', 120)
      await m.sample(null, 'email')
      const snap = await m.snapshot('w1')
      expect(snap).toMatchObject({ transactionsStored: 0, documents: { count: 0, bytes: 0 }, syncJobs: { count: 1, p50Ms: 120 } })
      expect((await m.instance()).dbBytes).toBeGreaterThan(0)
      expect(await m.rollup(at.slice(0, 10))).toBe(2)
    } finally {
      await h.close()
    }
  }, 30_000)

  it('percentiles by nearest rank', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
  })
})
