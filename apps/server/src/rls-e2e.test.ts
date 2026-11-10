// Row-level security prototype end to end: the real server on PGlite with AGFN_PG_RLS=1 (docs/security/rls.md).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { connectPglite, currentRlsContext, ensureAppRole, exclusivePool, migrateToLatest, rlsPool, tablesMissingRls, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { Kysely } from 'kysely'
import { boot, scoped, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mintReviewerLink } from './reviewer.ts'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso } from '@agfn/db'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
const outbox: Array<{ to: string; text: string }> = []

beforeAll(async () => {
  process.env.AGFN_PG_RLS = '1'
  process.env.AGFN_PEOPLE_RLS = '1' // exercise the people policy end to end (it ships gated behind this flag)
  const db = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
  await withBypass('test', async () => {
    await migrateToLatest(db.db)
    await ensureAppRole(db.db as Kysely<any>)
  })
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: BASE, AGFN_FRIEND_INVITES: '1', WEB_DIST: '/nonexistent', INBOUND_EMAIL_DOMAIN: 'in.example.com', INBOUND_WEBHOOK_SECRET: 'hook-secret', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
  booted = await boot({ config, db, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  app = createApp(booted.services)
}, 120_000)
afterAll(async () => {
  delete process.env.AGFN_PG_RLS
  delete process.env.AGFN_PEOPLE_RLS
  await booted?.shutdown()
})

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('row-level security prototype, end to end', () => {
  it('two workspaces work normally and never see each other’s protected rows', async () => {
    const a = await signIn('a@example.com')
    const b = await signIn('b@example.com')
    const wa = await app.request('/api/workspaces', req(a, 'POST', { companyName: 'Acme' }))
    expect(wa.status, await wa.clone().text()).toBeLessThan(300)
    expect((await app.request('/api/workspaces', req(b, 'POST', { companyName: 'Beta' }))).status).toBeLessThan(300)
    // Writes that land in protected tables (activity_log via invites) work inside the request's workspace.
    expect((await app.request('/api/people', req(a, 'POST', { email: 'c@example.com', role: 'employee', entityIds: 'all' }))).status).toBe(201)
    expect((await app.request('/api/usage', { headers: { cookie: a } })).status).toBe(200)
    const db = booted.handle.db
    const all = await withBypass('test', () => db.selectFrom('activity_log' as never).select(['workspace_id' as never]).execute()) as Array<{ workspace_id: string }>
    const wsA = all.find((r) => r)!.workspace_id
    const seenByA = await withWorkspace(wsA, () => db.selectFrom('activity_log' as never).select(['workspace_id' as never]).execute()) as Array<{ workspace_id: string }>
    expect(seenByA.length).toBeGreaterThan(0)
    expect(seenByA.every((r) => r.workspace_id === wsA)).toBe(true)
    expect(await db.selectFrom('activity_log' as never).selectAll().execute()).toEqual([])
    // Boot left no workspace table uncovered.
    expect(await withBypass('test', () => tablesMissingRls(db as never))).toEqual([])
  }, 120_000)

  it('cross-workspace lookups work through their named scopes: invite email and welcome, email-in', async () => {
    const owner = await signIn('owner@example.com')
    const ws = (await (await app.request('/api/workspaces', req(owner, 'POST', { companyName: 'Gamma' }))).json()) as { workspaceId: string; companyId: string }
    // The invite email names the inviter (auth:invite lookup happens before any workspace is known).
    await app.request('/api/people', req(owner, 'POST', { email: 'dana@example.com', role: 'employee', entityIds: 'all' }))
    const mail = outbox.filter((m) => m.to === 'dana@example.com').at(-1)!
    expect(mail.text.split('\n')[0]).toBe('owner invited you to Gamma')
    const inviteId = decodeURIComponent(mail.text.match(/https?:\/\/\S+/)![0]).match(/invite=([A-Za-z0-9_-]+)/)![1]!
    const dana = await signIn('dana@example.com')
    const welcome = await app.request(`/api/invites/${inviteId}`, { headers: { cookie: dana } })
    expect(welcome.status).toBe(200)
    expect(await welcome.json()).toMatchObject({ workspaceId: ws.workspaceId, workspaceName: 'Gamma' })

    // Email-in: the address is found under inbound:address, the document lands inside the workspace.
    const info = (await (await app.request('/api/workspace', { headers: { cookie: owner } })).json()) as { inbound: Array<{ entityId: string; address: string }> }
    const address = info.inbound.find((i) => i.entityId === ws.companyId)!.address
    await app.request(`/api/inbound/${ws.companyId}`, req(owner, 'PUT', { allowedSenders: ['@vendor.com'] }))
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF').toString('base64')
    const r = await app.request(`/api/inbound/email/${address.split('@')[0]}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agfn-inbound-secret': 'hook-secret' }, body: JSON.stringify({ from: 'billing@vendor.com', to: [address], subject: 'Bill', attachments: [{ filename: 'bill.pdf', contentType: 'application/pdf', content: pdf }], auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' } }) })
    expect(await r.json()).toMatchObject({ accepted: 1 })
    const docs = await withWorkspace(ws.workspaceId, () => booted.handle.db.selectFrom('documents').select('original_name').execute())
    expect(docs.map((d) => d.original_name)).toEqual(['bill.pdf'])
  }, 120_000)

  it('a reviewer access link works under row-level security, inside its demo workspace only', async () => {
    const db = booted.handle.db
    const buildDemo = async (personId: string) => {
      const workspaceId = newId()
      return withWorkspace(workspaceId, async () => {
        await createWorkspace(db, { workspaceId, personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
        await db.insertInto('settings').values({ workspace_id: workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
        return workspaceId
      })
    }
    const link = await withBypass('cli:reviewer-link', () => mintReviewerLink({ db, buildDemo }, { label: 'rls', baseUrl: BASE }))
    const r = await app.request(link.url.replace(BASE, ''))
    expect(r.status).toBe(302)
    const verify = await app.request(r.headers.get('location')!.replace(BASE, ''), { headers: { origin: BASE } })
    const cookie = verify.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const me = await app.request('/api/me', { headers: { cookie } })
    expect(me.status, await me.clone().text()).toBe(200)
    expect(((await me.json()) as { workspaceId: string; reviewerDemo?: boolean })).toMatchObject({ workspaceId: link.workspaceId, reviewerDemo: true })
    expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(200)
    expect((await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Real' }))).status).toBe(403)
  }, 120_000)

  it('phase 2: sign-in and re-check codes work with no bypass (person-level tables, as the app role)', async () => {
    const email = 'codes@example.com'
    const asked = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const jar = asked.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const code = outbox.filter((m) => m.to === email).at(-1)!.text.match(/\n(\d{3} \d{3})\n/)![1]!
    const ok = await app.request('/api/signin/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: jar }, body: JSON.stringify({ code }) })
    expect(ok.status, await ok.clone().text()).toBe(200)
    const cookie = ok.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c): c is string => Boolean(c) && !c!.endsWith('=')).join('; ')
    expect((await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Codes Co' }))).status).toBeLessThan(300)
    expect((await app.request('/api/recheck/email', req(cookie, 'POST', {}))).status).toBe(200)
    const recheck = outbox.filter((m) => m.to === email).at(-1)!.text.match(/\n(\d{3} \d{3})\n/)![1]!
    expect((await app.request('/api/recheck/code', req(cookie, 'POST', { code: recheck }))).status).toBe(200)
    // Logged in the workspace (the one narrow lookup, then a write inside it).
    const ws = ((await (await app.request('/api/me', { headers: { cookie } })).json()) as { workspaceId: string }).workspaceId
    const logged = await withWorkspace(ws, () => (booted.handle.db as unknown as Kysely<any>).selectFrom('activity_log').select('action').where('action', '=', 'recheck.email_link').execute())
    expect(logged).toHaveLength(1)
  }, 120_000)

  it('phase 2: deleting an account works inside each workspace; nobody else’s rows are touched', async () => {
    const leaver = await signIn('leaver@example.com')
    const owner = await signIn('stays@example.com')
    expect((await app.request('/api/workspaces', req(owner, 'POST', { companyName: 'Stays Co' }))).status).toBeLessThan(300)
    // Before the demo: a demo can't send invites.
    expect((await app.request('/api/friend-invite', req(leaver, 'POST', { email: 'pal@example.com' }))).status).toBe(200)
    // The leaver has their own demo (deleted with the account) and also belongs to the owner's workspace (as finance).
    expect((await app.request('/api/demo', req(leaver, 'POST'))).status).toBeLessThan(300)
    const db = booted.handle.db
    const staysWs = ((await (await app.request('/api/me', { headers: { cookie: owner } })).json()) as { workspaceId: string }).workspaceId
    const leaverId = (await withBypass('test', () => db.selectFrom('people').select('id').where('email', '=', 'leaver@example.com').executeTakeFirstOrThrow())).id
    await withWorkspace(staysWs, () => db.insertInto('memberships').values({ id: newId(), workspace_id: staysWs, person_id: leaverId, role: 'finance', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute())
    // Invite records are closed to the app role, so these go from the owner side (a silent denial would leave the hashes).
    const friends = db as never as Kysely<any>
    const friendRows = async () => withBypass('test', async () => [
      ...(await friends.selectFrom('friend_invites').select('inviter_id as who').execute()),
      ...(await friends.selectFrom('friend_codes').select('person_id as who').execute()),
    ].filter((r) => r.who === leaverId))
    expect(await friendRows()).toHaveLength(2)
    const stop = /\/invites\/stop\?h=([a-f0-9]{64})&s=([a-f0-9]{64})/.exec(outbox.at(-1)!.text)!
    expect((await app.request('/invites/stop', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ h: stop[1]!, s: stop[2]!, action: 'stop' }) })).status).toBe(200)
    expect(await withBypass('test', () => friends.selectFrom('friend_invite_optouts').select('email_hash').execute())).toEqual([{ email_hash: stop[1] }])
    const del = await app.request('/api/me', req(leaver, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, workspaces: 2, workspacesDeleted: 1 })
    expect(await friendRows()).toEqual([])
    const left = await withBypass('test', () => db.selectFrom('memberships').select(['workspace_id', 'person_id']).where('workspace_id', '=', staysWs).execute())
    expect(left.map((m) => m.person_id)).not.toContain(leaverId)
    expect(left).toHaveLength(1) // the owner stays
  }, 120_000)

  it('phase 2: a sync job runs inside its workspace; jobs that span workspaces get a named bypass', async () => {
    const seen: unknown[] = []
    const h = scoped({ 'connection.sync': async () => void seen.push(currentRlsContext()), 'sync.all': async () => void seen.push(currentRlsContext()) })
    await h['connection.sync']!({ id: 'j1', kind: 'connection.sync', workspace_id: 'w-1', payload: {} } as never, new AbortController().signal)
    await h['sync.all']!({ id: 'j2', kind: 'sync.all', workspace_id: null, payload: {} } as never, new AbortController().signal)
    expect(seen).toEqual([{ workspaceId: 'w-1' }, { bypass: 'worker:sync.all' }])
    await expect(async () => h['connection.sync']!({ id: 'j3', kind: 'connection.sync', workspace_id: null, payload: {} } as never, new AbortController().signal)).rejects.toThrow(/without a workspace/)
  })
})


describe('a second server with missing config (the staging incident)', () => {
  it('refuses to start and leaves row-level security on for the running one', async () => {
    const db = booted.handle
    const bare = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:p@ep-x.us-east-2.aws.neon.tech/aggregate', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    await expect(boot({ config: bare, db, env: {}, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })).rejects.toThrow(/Refusing to start/)
    const local = { ...bare, databaseUrl: 'postgres://u:p@localhost/agfn' }
    await expect(boot({ config: local, db, env: {}, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })).rejects.toThrow(/AGFN_PG_RLS is not set/)
    expect(await withBypass('test', () => tablesMissingRls(db.db as Kysely<any>))).toEqual([])
  })
})
