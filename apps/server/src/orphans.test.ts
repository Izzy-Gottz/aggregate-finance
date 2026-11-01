// Workspaces nobody belongs to are deleted, never synced (orphans.ts).
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso, withBypass } from '@agfn/db'
import { createConnection } from '@agfn/sync'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { deleteIfMemberless, deleteMemberlessWorkspaces, memberlessWorkspaces, WORKSPACE_DELETE_JOB } from './orphans.ts'
import { mintReviewerLink, reseedReviewerDemos, revokeReviewerLink } from './reviewer.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start() {
  const outbox: Array<{ to: string; text: string }> = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, ...(await loadInstalledModules({})) })
  const app = createApp(booted.services)
  const db = booted.handle.db
  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
    return (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const exists = async (ws: string) => Boolean(await db.selectFrom('workspaces').select('id').where('id', '=', ws).executeTakeFirst())
  const rowsIn = async (ws: string) => (await db.selectFrom('connections').select('id').where('workspace_id', '=', ws).execute()).length + (await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).execute()).length
  const deps = () => ({ db, files: booted!.services.files, sync: booted!.services.sync })
  return { app, db, signIn, req, exists, rowsIn, deps }
}

describe('workspaces with no members', () => {
  it('deleting an account deletes its demo workspace (and doesn’t refuse because of it)', async () => {
    const t = await start()
    const cookie = await t.signIn('demo@example.com')
    const demo = (await (await t.app.request('/api/demo', t.req(cookie, 'POST'))).json()) as { workspaceId: string }
    expect(await t.rowsIn(demo.workspaceId)).toBeGreaterThan(0)
    const del = await t.app.request('/api/me', t.req(cookie, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(((await del.json()) as { workspacesDeleted: number }).workspacesDeleted).toBe(1)
    expect(await t.exists(demo.workspaceId)).toBe(false)
    expect(await t.rowsIn(demo.workspaceId)).toBe(0)
  }, 60_000)

  it('leaving the demo queues its delete (the job runs it: demo-leave.test.ts); nobody belongs to it from then on', async () => {
    const t = await start()
    const cookie = await t.signIn('leaver@example.com')
    const demo = (await (await t.app.request('/api/demo', t.req(cookie, 'POST'))).json()) as { workspaceId: string }
    expect((await t.app.request('/api/demo', t.req(cookie, 'DELETE'))).status).toBe(200)
    expect(await memberlessWorkspaces(t.db)).toEqual([demo.workspaceId])
    const job = await t.db.selectFrom('jobs').select(['payload_json', 'status']).where('kind', '=', WORKSPACE_DELETE_JOB).executeTakeFirst()
    expect(job).toEqual({ payload_json: JSON.stringify({ workspaceId: demo.workspaceId }), status: 'queued' })
  }, 60_000)

  it('a workspace survives one of its two members leaving', async () => {
    const t = await start()
    const owner = await t.signIn('owner@example.com')
    await t.app.request('/api/workspaces', t.req(owner, 'POST', { companyName: 'Acme' }))
    const ws = (await (await t.app.request('/api/me', { headers: { cookie: owner } })).json()) as { workspaceId: string }
    const member = await t.signIn('member@example.com')
    const memberId = (await t.db.selectFrom('people').select('id').where('email', '=', 'member@example.com').executeTakeFirstOrThrow()).id
    await t.db.insertInto('memberships').values({ id: newId(), workspace_id: ws.workspaceId, person_id: memberId, role: 'finance', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute()
    expect((await t.app.request('/api/me', t.req(member, 'DELETE', { confirm: 'DELETE' }))).status).toBe(200)
    expect(await t.exists(ws.workspaceId)).toBe(true)
    expect(await memberlessWorkspaces(t.db)).toEqual([])
  }, 60_000)

  it('a member-less workspace is never synced, and the retention pass deletes it', async () => {
    const t = await start()
    const personId = newId()
    await t.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Gone', email: 'gone@example.com', created_at: nowIso() }).execute()
    const ids = await createWorkspace(t.db, { personId, workspaceName: 'Left behind', firstCompanyName: 'Orphan Co' })
    await createConnection(t.db, booted!.services.keys, { workspaceId: ids.workspaceId, connectorKey: 'demo', displayName: 'x', secret: { demo: true }, config: { profile: 'northwind' }, createdBy: personId, entityId: ids.companyId })
    expect(await withBypass('test', () => booted!.services.sync.requestAll())).toBeGreaterThan(0)
    await t.db.updateTable('memberships').set({ revoked_at: nowIso() }).where('workspace_id', '=', ids.workspaceId).execute()
    expect(await withBypass('test', () => booted!.services.sync.requestAll())).toBe(0)
    expect(await memberlessWorkspaces(t.db)).toEqual([ids.workspaceId])
    expect(await deleteMemberlessWorkspaces(t.deps())).toBe(1)
    expect(await t.exists(ids.workspaceId)).toBe(false)
    expect(await deleteIfMemberless(t.deps(), [ids.workspaceId])).toBe(0) // already gone: nothing to do
  }, 60_000)

  it('the reviewer reseed deletes yesterday’s demo, and an expired link’s demo goes too', async () => {
    const t = await start()
    const buildDemo = async (personId: string) => {
      const ids = await createWorkspace(t.db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
      await t.db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
      return ids.workspaceId
    }
    const cleanup = (ids: string[]) => deleteIfMemberless(t.deps(), ids)
    const a = await mintReviewerLink({ db: t.db, buildDemo }, { label: 'a', baseUrl: BASE })
    const b = await mintReviewerLink({ db: t.db, buildDemo }, { label: 'b', baseUrl: BASE })
    expect(await reseedReviewerDemos({ db: t.db, buildDemo, cleanup })).toBe(2)
    expect(await t.exists(a.workspaceId)).toBe(false)
    expect(await memberlessWorkspaces(t.db)).toEqual([])
    await revokeReviewerLink(t.db, b.id)
    await reseedReviewerDemos({ db: t.db, buildDemo, cleanup })
    const bPerson = (await t.db.selectFrom('people').select('id').where('email', '=', b.email).executeTakeFirstOrThrow()).id
    expect(await t.db.selectFrom('memberships').select('id').where('person_id', '=', bPerson).where('revoked_at', 'is', null).execute()).toEqual([])
    expect(await memberlessWorkspaces(t.db)).toEqual([])
  }, 60_000)
})
