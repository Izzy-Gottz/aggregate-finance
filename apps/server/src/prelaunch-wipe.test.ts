// The launch-day wipe keeps reviewer accounts and the keep-list with their workspaces, and deletes everything else.
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, withBypass, type CoreTables } from '@agfn/db'
import { MemoryFileStore } from '@agfn/files'
import type { Kysely } from 'kysely'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules, mcpFor } from './modules.ts'
import { mintReviewerLink, revokeReviewerLink, serverDemoBuilder } from './reviewer.ts'
import { applyWipe, planWipe, rowsOnly } from './prelaunch-wipe.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

describe('prelaunch wipe', () => {
  it('keeps reviewers and the keep-list, deletes the rest, and a second plan finds nothing left', async () => {
    const outbox: Array<{ to: string; text: string }> = []
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, mcp: (svc) => mcpFor(svc) })
    const app = createApp(booted.services)
    const db = booted.handle.db
    const buildDemo = async (personId: string) => {
      const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
      await db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
      return ids.workspaceId
    }
    async function signUp(email: string, company: string): Promise<void> {
      await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
      const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
      const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
      const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
      expect((await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: company }) })).status).toBeLessThan(300)
    }

    const live = await mintReviewerLink({ db, buildDemo }, { label: 'Claude directory review', baseUrl: BASE })
    const old = await mintReviewerLink({ db, buildDemo }, { label: 'old review', baseUrl: BASE })
    await revokeReviewerLink(db, old.id)
    await signUp('owner@example.com', 'Kept Co')
    await signUp('tester@example.com', 'Test Co')
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'pending@example.com', callbackURL: '/' }) })

    await expect(planWipe(db, { keepEmails: ['nobody@example.com'] })).rejects.toThrow(/not found/)
    // A champions list: whoever never signed up is reported, not an error, and everyone on it who did is kept.
    const champs = await planWipe(db, { keepEmails: ['nobody@example.com', 'owner@example.com'], allowMissing: true })
    expect(champs.notFound).toEqual(['nobody@example.com'])
    expect(champs.keepPeople.map((p) => p.email)).toContain('owner@example.com')
    const plan = await planWipe(db, { keepEmails: ['Owner@example.com'] })
    expect(plan.keepPeople.map((p) => p.email).sort()).toEqual([live.email, 'owner@example.com'].sort())
    expect(plan.keepWorkspaces.map((w) => w.id)).toContain(live.workspaceId)
    expect(plan.deleteWorkspaces.map((w) => w.id)).toContain(old.workspaceId)
    expect(plan.deletePeople.map((p) => p.email).sort()).toEqual([old.email, 'tester@example.com'].sort())
    expect(plan.deadReviewerLinks).toBe(1)
    expect(plan.pendingMagicLinks).toBeGreaterThan(0)

    const result = await applyWipe({ db, files: booted.services.files, sync: booted.services.sync }, plan)
    expect(result.failures).toEqual([])
    expect(result.workspacesDeleted).toBe(plan.deleteWorkspaces.length)

    const workspaces = (await db.selectFrom('workspaces').select('id').execute()).map((w) => w.id).sort()
    expect(workspaces).toEqual(plan.keepWorkspaces.map((w) => w.id).sort())
    expect((await db.selectFrom('people').select('email').execute()).map((p) => p.email)).not.toContain('tester@example.com')
    expect(await db.selectFrom('reviewer_links').select('id').execute()).toEqual([{ id: live.id }])
    // The live reviewer link still signs in.
    expect((await app.request(live.url.replace(BASE, ''))).status).toBe(302)

    const after = await planWipe(db, { keepEmails: ['owner@example.com'] })
    expect([after.deleteWorkspaces.length, after.deletePeople.length, after.deleteAuthUsers]).toEqual([0, 0, 0])
  })
})

describe('prelaunch wipe on Postgres with row-level security (hosted)', () => {
  // Demos filled ahead of time for "Look around" (packages/demo pool.ts) aren't anyone's: kept, not counted or wiped.
  it('keeps the demo pool and its workspaces', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined } })
    const db = booted.handle.db
    const { newPoolPerson, markPooled } = await import('@agfn/demo')
    const pooled = await newPoolPerson(db)
    const ids = await createWorkspace(db, { personId: pooled, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
    await markPooled(db, ids.workspaceId)
    const plan = await planWipe(db)
    expect(plan.keepPeople).toEqual([expect.objectContaining({ id: pooled, why: 'the demo pool' })])
    expect(plan.keepWorkspaces.map((w) => w.id)).toEqual([ids.workspaceId])
    expect(plan.deletePeople).toEqual([])
  })

  // The Glass Ledger (launch step 5a) is made after the wipe, but a wipe run after it (or an early create) must keep it.
  it('keeps the Glass Ledger and its workspace', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined } })
    const db = booted.handle.db
    const { GLASS_EMAIL } = await import('./glass-ledger.ts')
    const glass = newId()
    await withBypass('t', () => db.insertInto('people').values({ id: glass, auth_user_id: null, name: 'Glass Ledger', email: GLASS_EMAIL, created_at: nowIso() }).execute())
    const ids = await withBypass('t', () => createWorkspace(db, { personId: glass, workspaceName: 'Glass Ledger', firstCompanyName: 'Aggregate' }))
    const plan = await planWipe(db)
    expect(plan.keepPeople).toEqual([expect.objectContaining({ id: glass, why: 'the Glass Ledger' })])
    expect(plan.keepWorkspaces.map((w) => w.id)).toEqual([ids.workspaceId])
    expect(plan.deletePeople).toEqual([])
    expect(plan.deleteWorkspaces).toEqual([])
  })

  // Shopify's reviewer signs up with their own email (unknown to us): a workspace with a live Shopify install keeps its
  // owners and admins, and so the workspace; a disconnected one and a plain member don't count.
  it('keeps whoever owns or runs a workspace with a live install of a provider still in review (Shopify, Deel)', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined } })
    const db = booted.handle.db
    const person = async (email: string) => {
      const id = newId()
      await withBypass('t', () => db.insertInto('people').values({ id, auth_user_id: null, name: email, email, created_at: nowIso() }).execute())
      return id
    }
    const shop = async (ws: string, status: 'active' | 'disconnected') =>
      withBypass('t', () => db.insertInto('connections').values({ id: newId(), workspace_id: ws, connector_key: 'shopify', entity_id: null, display_name: 'Shopify', status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute())
    const reviewer = await person('app-review@shopify-reviewer.example.com')
    const viewer = await person('viewer@example.com')
    const gone = await person('uninstalled@example.com')
    const live = await withBypass('t', () => createWorkspace(db, { personId: reviewer, workspaceName: 'Review store', firstCompanyName: 'Store' }))
    await withBypass('t', () => db.insertInto('memberships').values({ id: newId(), workspace_id: live.workspaceId, person_id: viewer, role: 'employee', grid_json: null, expires_at: null, invited_by: reviewer, created_at: nowIso(), revoked_at: null }).execute())
    await shop(live.workspaceId, 'active')
    const old = await withBypass('t', () => createWorkspace(db, { personId: gone, workspaceName: 'Old store', firstCompanyName: 'Old' }))
    await shop(old.workspaceId, 'disconnected')
    // Deel's reviewer (App Store review: open signup on live) the same way, labeled by provider; a Stripe-only one isn't.
    const deelOwner = await person('deel-review@example.com')
    const deelWs = await withBypass('t', () => createWorkspace(db, { personId: deelOwner, workspaceName: 'Deel review', firstCompanyName: 'Co' }))
    await withBypass('t', () => db.insertInto('connections').values({ id: newId(), workspace_id: deelWs.workspaceId, connector_key: 'deel', entity_id: null, display_name: 'Deel', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute())
    const stripeOwner = await person('stripe-only@example.com')
    const stripeWs = await withBypass('t', () => createWorkspace(db, { personId: stripeOwner, workspaceName: 'Stripe only', firstCompanyName: 'Co' }))
    await withBypass('t', () => db.insertInto('connections').values({ id: newId(), workspace_id: stripeWs.workspaceId, connector_key: 'stripe', entity_id: null, display_name: 'Stripe', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute())
    const plan = await planWipe(db)
    expect(plan.keepPeople.map((p) => [p.id, p.why]).sort()).toEqual([[reviewer, 'a Shopify install'], [deelOwner, 'a Deel install']].sort())
    expect(plan.keepWorkspaces.map((w) => w.id).sort()).toEqual([live.workspaceId, deelWs.workspaceId].sort())
    expect(plan.deletePeople.map((p) => p.id).sort()).toEqual([viewer, gone, stripeOwner].sort())
    expect(plan.deleteWorkspaces.map((w) => w.id).sort()).toEqual([old.workspaceId, stripeWs.workspaceId].sort())
  })

  it('deletes a filled workspace and keeps the reviewer demo, as the non-bypass app role', async () => {
    process.env.AGFN_PG_RLS = '1'
    try {
      const handle = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
      await withBypass('test', async () => {
        await migrateToLatest(handle.db)
        await ensureAppRole(handle.db as Kysely<any>)
      })
      const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
      booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), db: handle, fileStore: new MemoryFileStore(), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
      const db = booted.handle.db
      const buildDemo = serverDemoBuilder(booted.services)
      const live = await withBypass('test', () => mintReviewerLink({ db, buildDemo }, { label: 'Claude directory review', baseUrl: BASE }))
      const personId = newId()
      await withBypass('test', () => db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'T', email: 'tester@example.com', created_at: nowIso() }).execute())
      const testWs = await withBypass('test', () => buildDemo(personId))

      const plan = await planWipe(db)
      expect(plan.keepWorkspaces.map((w) => w.id)).toEqual([live.workspaceId])
      expect(plan.deleteWorkspaces.map((w) => w.id)).toEqual([testWs])
      const result = await applyWipe({ db, files: booted.services.files, sync: booted.services.sync }, plan)
      expect(result.failures).toEqual([])
      expect((await withBypass('test', () => db.selectFrom('workspaces').select('id').execute())).map((w) => w.id)).toEqual([live.workspaceId])
      const after = await planWipe(db)
      expect([after.deleteWorkspaces.length, after.deletePeople.length]).toEqual([0, 0])
    } finally {
      delete process.env.AGFN_PG_RLS
    }
  }, 180_000)
})

describe('prelaunch wipe on a branch copy (rowsOnly)', () => {
  it('never contacts a provider or deletes a stored file, and passes everything else through', async () => {
    const calls: string[] = []
    const files = { delete: async (k: string) => void calls.push(`files.delete ${k}`), put: async () => void calls.push('files.put') }
    const sync = { disconnect: async (id: string) => (calls.push(`sync.disconnect ${id}`), { revoked: true }), other: () => 'kept' }
    const deps = rowsOnly({ db: 'db', files, sync } as unknown as Parameters<typeof rowsOnly>[0])
    await deps.files.delete('doc-1')
    expect(await deps.sync.disconnect('conn-1')).toEqual({ revoked: false })
    expect(calls).toEqual([])
    expect((deps.sync as unknown as typeof sync).other()).toBe('kept')
    await (deps.files as unknown as typeof files).put()
    expect(calls).toEqual(['files.put'])
    expect((deps as unknown as { db: string }).db).toBe('db')
  })
})
