// "Don't see your app? Request it +": the fixed list, one row per workspace and app, never in a demo, gone with the
// workspace, and each workspace sees only its own asks under real row-level security (PGlite as agfn_app, the
// connect-gate-rls.test.ts harness).
import { readFileSync } from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, syncRlsPolicies, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { demoAllows } from './public-demo-web.ts'
import { REQUESTABLE, requestConnection, requestCounts, requestList } from './connection-requests.ts'
/* eslint-disable @typescript-eslint/no-explicit-any */

describe('the list', () => {
  it('has Hospitable, and exactly the Self-host and In development names in docs/connectors.md', () => {
    expect(REQUESTABLE.map((a) => a.name)).toContain('Hospitable')
    const doc = readFileSync(new URL('../../../docs/connectors.md', import.meta.url), 'utf8')
    // Table rows whose last cell is "Self-host" or "In development"; a cell can name several ("PayPal, Lemon Squeezy").
    const names = doc
      .split('\n')
      .map((l) => l.split('|').map((c) => c.trim()))
      .filter((cells) => cells.length >= 5 && /^(Self-host|In development)$/.test(cells[cells.length - 2]!))
      .flatMap((cells) => cells[1]!.split(',').map((n) => n.replace(/\s*\(.*\)$/, '').trim()))
      // Not an app: a feature of Aggregate's own.
      .filter((n) => n !== 'Receipts by email')
      // Left off on purpose: Etsy banned our API app on 2026-11-07, so we don't invite requests for it.
      .filter((n) => n !== 'Etsy')
    const ours = REQUESTABLE.filter((a) => a.key !== 'hospitable').map((a) => a.name)
    // "Lightspeed Retail (X-Series)" and "Justworks (direct)" lose their brackets above.
    expect([...ours].sort()).toEqual([...names].sort())
    expect(new Set(REQUESTABLE.map((a) => a.key)).size).toBe(REQUESTABLE.length)
  })
})

describe('under real row-level security (agfn_app)', () => {
  let pg: Awaited<ReturnType<typeof connectPglite<CoreTables>>>
  const wsA = newId()
  const wsB = newId()
  beforeAll(async () => {
    process.env.AGFN_PG_RLS = '1'
    pg = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    await withBypass('test-setup', async () => {
      await migrateToLatest(pg.db)
      await ensureAppRole(pg.db as Kysely<any>)
      await syncRlsPolicies(pg.db as Kysely<any>, true)
      for (const id of [wsA, wsB]) await pg.db.insertInto('workspaces').values({ id, name: id, base_currency: 'USD', time_zone: 'UTC', created_at: nowIso() }).execute()
    })
  }, 120_000)
  afterAll(async () => {
    delete process.env.AGFN_PG_RLS
    await pg?.close()
  })

  it('asking twice is one row; another workspace sees none of it and can’t write it; the totals count workspaces; it goes with the workspace', async () => {
    expect(await withWorkspace(wsA, () => requestConnection(pg.db, wsA, 'hospitable'))).toBe(true)
    expect(await withWorkspace(wsA, () => requestConnection(pg.db, wsA, 'hospitable'))).toBe(false)
    await withWorkspace(wsA, () => requestConnection(pg.db, wsA, 'harvest'))
    await withWorkspace(wsB, () => requestConnection(pg.db, wsB, 'hospitable'))

    const listA = await withWorkspace(wsA, () => requestList(pg.db, wsA))
    expect(listA.filter((a) => a.requested).map((a) => a.key).sort()).toEqual(['harvest', 'hospitable'])
    // B asking for A's rows by name still gets only its own.
    const listBasA = await withWorkspace(wsB, () => requestList(pg.db, wsA))
    expect(listBasA.filter((a) => a.requested)).toEqual([])
    const seenFromB = await withWorkspace(wsB, () => (pg.db as Kysely<any>).selectFrom('connection_requests').selectAll().execute())
    expect(seenFromB.map((r) => r.workspace_id)).toEqual([wsB])
    // Writing into another workspace is refused by the policy.
    await expect(withWorkspace(wsB, () => requestConnection(pg.db, wsA, 'rippling'))).rejects.toThrow()
    // Outside any workspace (no bypass), nothing at all.
    expect(await (pg.db as Kysely<any>).selectFrom('connection_requests').selectAll().execute().catch(() => [])).toEqual([])

    // The operator totals: across workspaces, under a named bypass.
    expect(await withBypass('test:counts', () => requestCounts(pg.db))).toEqual([
      { key: 'hospitable', name: 'Hospitable', workspaces: 2 },
      { key: 'harvest', name: 'Harvest', workspaces: 1 },
    ])

    // Deleting the workspace takes its rows (cascade), and only its rows.
    await withBypass('test:delete', () => pg.db.deleteFrom('workspaces').where('id', '=', wsA).execute())
    const left = await withBypass('test:left', () => (pg.db as Kysely<any>).selectFrom('connection_requests').select(['workspace_id', 'app_key']).execute())
    expect(left).toEqual([{ workspace_id: wsB, app_key: 'hospitable' }])
  })
})

describe('/api/connection-requests', () => {
  const BASE = 'http://localhost:8787'
  let booted: Booted
  let app: ReturnType<typeof createApp>
  let outbox: string[]
  beforeEach(async () => {
    outbox = []
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) } })
    app = createApp(booted.services)
  })
  afterEach(() => booted.shutdown())

  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
    const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  const post = (cookie: string, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
  const get = (cookie: string) => ({ headers: { origin: BASE, cookie } })
  const list = async (cookie: string) => ((await (await app.request('/api/connection-requests', get(cookie))).json()) as { apps: Array<{ key: string; name: string; requested: boolean }> }).apps
  const rows = () => (booted.services.db as unknown as Kysely<any>).selectFrom('connection_requests').selectAll().execute()

  it('needs a session', async () => {
    expect((await app.request('/api/connection-requests', { headers: { origin: BASE } })).status).toBe(401)
    expect((await app.request('/api/connection-requests', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: '{"app":"hospitable"}' })).status).toBe(401)
  })

  it('lists Hospitable, records one row per app however often it’s asked, and stores nothing about the person', async () => {
    const cookie = await signIn('owner@acme.example')
    expect((await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))).status).toBe(201)
    const before = await list(cookie)
    expect(before.find((a) => a.key === 'hospitable')).toEqual({ key: 'hospitable', name: 'Hospitable', requested: false })
    // Names the drawer already offers here aren't on it (this server offers WooCommerce, self-hosted style).
    const offered = new Set(((await (await app.request('/api/connectors', get(cookie))).json()) as Array<{ key: string }>).map((c) => c.key))
    expect(before.some((a) => offered.has(a.key))).toBe(false)

    for (let i = 0; i < 3; i++) expect((await app.request('/api/connection-requests', post(cookie, { app: 'hospitable' }))).status).toBe(200)
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0]!).sort()).toEqual(['app_key', 'created_at', 'workspace_id'])
    expect((await list(cookie)).find((a) => a.key === 'hospitable')?.requested).toBe(true)

    // Only names on the list: no free text.
    expect((await app.request('/api/connection-requests', post(cookie, { app: 'my secret bank' }))).status).toBe(400)
    expect((await app.request('/api/connection-requests', post(cookie, {}))).status).toBe(400)
    expect(await rows()).toHaveLength(1)
  })

  it('is refused in a demo workspace and on the public demo', async () => {
    const cookie = await signIn('try@example.com')
    expect((await app.request('/api/demo', post(cookie, {}))).status).toBe(201)
    expect((await app.request('/api/connection-requests', get(cookie))).status).toBe(403)
    expect((await app.request('/api/connection-requests', post(cookie, { app: 'hospitable' }))).status).toBe(403)
    expect(await rows()).toHaveLength(0)
    // The no-sign-up web demo's door lets neither through.
    expect(demoAllows('GET', '/api/connection-requests')).toBe(false)
    expect(demoAllows('POST', '/api/connection-requests')).toBe(false)
  })

  it('goes with the workspace when it’s deleted (SQLite)', async () => {
    const cookie = await signIn('owner2@acme.example')
    const ws = ((await (await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))).json()) as { workspaceId: string }).workspaceId
    await app.request('/api/connection-requests', post(cookie, { app: 'harvest' }))
    expect(await rows()).toHaveLength(1)
    const db = booted.services.db as unknown as Kysely<any>
    // Only the parent row, so the cascade is what removes it (deleteWorkspace also sweeps every workspace_id table).
    await db.deleteFrom('memberships').where('workspace_id', '=', ws).execute()
    await db.deleteFrom('settings').where('workspace_id', '=', ws).execute()
    await db.deleteFrom('entities').where('workspace_id', '=', ws).execute()
    await db.deleteFrom('workspaces').where('id', '=', ws).execute()
    expect(await rows()).toHaveLength(0)
  })
})
