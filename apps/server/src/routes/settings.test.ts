import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { withBypass } from '@agfn/db'
import { boot, type Booted } from '../boot.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { mcpFor } from '../modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, mcp: (svc) => mcpFor(svc) })
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

async function owner(): Promise<{ cookie: string; companyId: string }> {
  const cookie = await signIn('founder@example.com')
  const r = (await (await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Acme' }))).json()) as { companyId: string }
  return { cookie, companyId: r.companyId }
}

describe('preferences', () => {
  it('reads and updates personal and company settings', async () => {
    const { cookie, companyId } = await owner()
    const p = (await (await app.request('/api/preferences', { headers: { cookie } })).json()) as Record<string, unknown>
    expect(p).toMatchObject({
      signIn: { passkeys: [], apple: false, google: false, email: 'founder@example.com' },
      companies: [{ id: companyId, name: 'Acme', currency: 'USD', fiscalYearStartMonth: 1 }],
      aiReviewMode: false,
      notifications: { mondayEmail: true, blockedAsk: true },
      theme: 'light',
      people: [{ email: 'founder@example.com', role: 'owner', entityIds: 'all', pending: false }],
    })
    const upd = await app.request('/api/preferences', req(cookie, 'PATCH', { theme: 'dark', notifications: { mondayEmail: false }, companies: [{ id: companyId, name: 'Acme Inc', fiscalYearStartMonth: 4, currency: 'EUR' }], aiReviewMode: true }))
    expect(upd.status).toBe(200)
    expect(await upd.json()).toMatchObject({ theme: 'dark', notifications: { mondayEmail: false, blockedAsk: true }, companies: [{ name: 'Acme Inc', fiscalYearStartMonth: 4, currency: 'EUR' }], aiReviewMode: true })
    expect((await app.request('/api/preferences', req(cookie, 'PATCH', { theme: 'neon' }))).status).toBe(400)
    expect((await app.request('/api/preferences', req(cookie, 'PATCH', { companies: [{ id: 'nope', name: 'X' }] }))).status).toBe(400)
  })
})

describe('renaming the only company', () => {
  const db = () => booted.services.db
  const theWs = () => withBypass('t', () => db().selectFrom('workspaces').select(['id', 'name']).executeTakeFirstOrThrow())
  const rename = (cookie: string, id: string, name: string) => app.request('/api/preferences', req(cookie, 'PATCH', { companies: [{ id, name }] }))

  it('renames the workspace named after it', async () => {
    const { cookie, companyId } = await owner()
    expect((await theWs()).name).toBe('Acme')
    expect((await rename(cookie, companyId, 'Acme Holdings')).status).toBe(200)
    expect((await theWs()).name).toBe('Acme Holdings')
  })

  it('leaves a workspace named otherwise, or one with two companies, alone', async () => {
    const { cookie, companyId } = await owner()
    const ws = await theWs()
    await withBypass('t', () => db().updateTable('workspaces').set({ name: 'Family office' }).where('id', '=', ws.id).execute())
    expect((await rename(cookie, companyId, 'Acme 2')).status).toBe(200)
    expect((await theWs()).name).toBe('Family office')
    await withBypass('t', () => db().updateTable('workspaces').set({ name: 'Acme 2' }).where('id', '=', ws.id).execute())
    expect((await app.request('/api/entities', req(cookie, 'POST', { name: 'Second Co' }))).status).toBe(201)
    expect((await rename(cookie, companyId, 'Acme 3')).status).toBe(200)
    expect((await theWs()).name).toBe('Acme 2')
  })
})

describe('people', () => {
  it('invites by email, edits roles and grids, and keeps at least one owner', async () => {
    const { cookie, companyId } = await owner()
    const inv = await app.request('/api/people', req(cookie, 'POST', { email: 'Avi@Example.com', role: 'accountant', entityIds: [companyId] }))
    expect(inv.status).toBe(201)
    const row = (await inv.json()) as { id: string; email: string; role: string; entityIds: string[]; grid: Record<string, string>; pending: boolean }
    expect(row).toMatchObject({ email: 'avi@example.com', role: 'accountant', entityIds: [companyId], pending: true })
    expect(row.grid).toMatchObject({ transactions: 'view', payroll: 'view', personal: 'none' })
    expect(outbox.some((m) => m.to === 'avi@example.com' && /https?:\/\//.test(m.text))).toBe(true)
    const inviteMail = outbox.filter((m) => m.to === 'avi@example.com').at(-1)!
    expect(inviteMail.text.split('\n')[0]).toBe('founder invited you to Acme')
    // A link requested by anyone with a made-up invite id gets the plain sign-in text.
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'victim@example.com', callbackURL: '/?invite=AAAAAAAAAAAAAAAAAAAAAAAA' }) })
    expect(outbox.filter((m) => m.to === 'victim@example.com').at(-1)!.text).toMatch(/^Sign in to Aggregate\n/)
    expect((await app.request('/api/people', req(cookie, 'POST', { email: 'founder@example.com', role: 'finance', entityIds: 'all' }))).status).toBe(409)
    expect((await app.request('/api/people', req(cookie, 'POST', { email: 'x@example.com', role: 'god', entityIds: 'all' }))).status).toBe(400)
    expect((await app.request('/api/people', req(cookie, 'POST', { email: 'x@example.com', role: 'finance', entityIds: ['someone-elses'] }))).status).toBe(400)

    const edited = await app.request(`/api/people/${row.id}`, req(cookie, 'PATCH', { grid: { transactions: 'add', payroll: 'none' } }))
    expect(edited.status).toBe(200)
    expect(((await edited.json()) as { grid: Record<string, string> }).grid).toMatchObject({ transactions: 'add', payroll: 'none', invoices: 'view' })
    const promoted = await app.request(`/api/people/${row.id}`, req(cookie, 'PATCH', { role: 'finance' }))
    expect(((await promoted.json()) as { role: string; grid: Record<string, string> })).toMatchObject({ role: 'finance', grid: { payroll: 'add' } })

    // The only owner can't be demoted.
    const me = ((await (await app.request('/api/preferences', { headers: { cookie } })).json()) as { people: Array<{ id: string; email: string }> }).people.find((p) => p.email === 'founder@example.com')!
    const demote = await app.request(`/api/people/${me.id}`, req(cookie, 'PATCH', { role: 'admin' }))
    expect(demote.status).toBe(409)

    // The invitee signs in: not a manager, so they can't change people or export, and only see themselves.
    const avi = await signIn('avi@example.com')
    expect((await app.request(`/api/people/${me.id}`, req(avi, 'PATCH', { role: 'employee' }))).status).toBe(403)
    expect((await app.request('/api/export', req(avi, 'POST', {}))).status).toBe(403)
    const theirs = (await (await app.request('/api/preferences', { headers: { cookie: avi } })).json()) as { people: unknown[] }
    expect(theirs.people).toHaveLength(1)

    // The welcome screen reads the invite: only for the invited person.
    const inviteId = decodeURIComponent(inviteMail.text.match(/https?:\/\/\S+/)![0]).match(/invite=([A-Za-z0-9_-]+)/)![1]!
    const welcome = await app.request(`/api/invites/${inviteId}`, { headers: { cookie: avi } })
    expect(welcome.status).toBe(200)
    expect(await welcome.json()).toEqual({ workspaceId: expect.any(String), workspaceName: 'Acme', inviterName: 'founder' })
    expect((await app.request(`/api/invites/${inviteId}`, { headers: { cookie } })).status).toBe(404)
    expect((await app.request('/api/invites/AAAAAAAAAAAAAAAAAAAAAAAA', { headers: { cookie: avi } })).status).toBe(404)
  })
})

describe('export', () => {
  it('downloads the workspace as JSON for the person who asked, without secrets or others’ Personal', async () => {
    const { cookie } = await owner()
    const r = await app.request('/api/export', req(cookie, 'POST', {}))
    expect(r.status).toBe(200)
    const { url } = (await r.json()) as { url: string }
    expect(url).toMatch(/^\/api\/export\/[A-Za-z0-9_-]+$/)
    const dl = await app.request(url, { headers: { cookie } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment; filename="aggregate-export-\d{4}-\d{2}-\d{2}\.json"$/)
    const body = (await dl.json()) as { format: string; tables: Record<string, Array<Record<string, unknown>>> }
    expect(body.format).toBe('aggregate-export')
    expect(body.tables.entities!.map((e) => e.name).sort()).toEqual(['Acme', 'Personal'])
    expect(body.tables.connections ?? []).toEqual(expect.not.arrayContaining([expect.objectContaining({ secret_enc: expect.anything() })]))
    expect(JSON.stringify(body)).not.toMatch(/secret_enc|key_hash/)
    // Another signed-in person can't use the link.
    const other = await signIn('stranger@example.com')
    expect((await app.request(url, { headers: { cookie: other } })).status).toBe(409)
    expect((await app.request('/api/export/not-a-real-token-xxxxxxxxxx', { headers: { cookie } })).status).toBe(404)
  })
})

describe('joining another way', () => {
  const inviteIdFor = (email: string) => decodeURIComponent(outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]).match(/invite=([A-Za-z0-9_-]+)/)![1]!

  it('an invite opened under another sign-in (Hide My Email) can be accepted by that account, once', async () => {
    const { cookie } = await owner()
    await app.request('/api/people', req(cookie, 'POST', { email: 'dana@example.com', role: 'finance', entityIds: 'all' }))
    const inviteId = inviteIdFor('dana@example.com')
    const relay = await signIn('x7k2@privaterelay.appleid.com')
    const look = await app.request(`/api/invites/${inviteId}`, { headers: { cookie: relay } })
    expect(look.status).toBe(200)
    expect(await look.json()).toEqual({ workspaceId: expect.any(String), workspaceName: 'Acme', inviterName: 'founder', claim: true, invitedEmail: 'dana@example.com' })
    const acc = await app.request(`/api/invites/${inviteId}/accept`, req(relay, 'POST', {}))
    expect(acc.status).toBe(200)
    const me = (await (await app.request('/api/me', { headers: { cookie: relay } })).json()) as { workspaces: Array<{ name: string; role: string }> }
    expect(me.workspaces).toEqual([expect.objectContaining({ name: 'Acme', role: 'finance' })])
    const people = ((await (await app.request('/api/preferences', { headers: { cookie } })).json()) as { people: Array<{ email: string; pending: boolean }> }).people
    expect(people.map((p) => [p.email, p.pending])).toEqual([['founder@example.com', false], ['x7k2@privaterelay.appleid.com', false]])
    // Used up: nobody else can take it, and it no longer answers.
    const other = await signIn('other@example.com')
    expect((await app.request(`/api/invites/${inviteId}`, { headers: { cookie: other } })).status).toBe(404)
    expect((await app.request(`/api/invites/${inviteId}/accept`, req(other, 'POST', {}))).status).toBe(404)
  })

  it('a joined invitee’s link answers nobody else; an invitee who owns nothing can still start their own workspace', async () => {
    const { cookie } = await owner()
    await app.request('/api/people', req(cookie, 'POST', { email: 'eli@example.com', role: 'employee', entityIds: 'all' }))
    const inviteId = inviteIdFor('eli@example.com')
    const eli = await signIn('eli@example.com')
    const other = await signIn('other@example.com')
    expect((await app.request(`/api/invites/${inviteId}`, { headers: { cookie: other } })).status).toBe(404)
    expect((await app.request(`/api/invites/${inviteId}/accept`, req(other, 'POST', {}))).status).toBe(404)
    // Eli is only an employee in Acme: their own workspace is allowed; a second one isn't.
    const own = await app.request('/api/workspaces', req(eli, 'POST', { companyName: 'Eli Co' }))
    expect(own.status, await own.clone().text()).toBe(201)
    expect((await app.request('/api/workspaces', req(eli, 'POST', { companyName: 'Again' }))).status).toBe(409)
    expect((await app.request('/api/workspaces', req(cookie, 'POST', { companyName: 'Again' }))).status).toBe(409)
  })
})

describe('removing people', () => {
  const anyDb = () => booted.handle.db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  const personId = async (email: string) => (await booted.handle.db.selectFrom('people').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id

  it('re-sends a pending invite instead of refusing, then cancels it so its link stops working', async () => {
    const { cookie } = await owner()
    expect((await app.request('/api/people', req(cookie, 'POST', { email: 'avi@example.com', role: 'finance', entityIds: 'all' }))).status).toBe(201)
    const first = outbox.filter((m) => m.to === 'avi@example.com').length
    // Inviting the same pending person again re-sends; so does Re-send.
    expect((await app.request('/api/people', req(cookie, 'POST', { email: 'avi@example.com', role: 'finance', entityIds: 'all' }))).status).toBe(201)
    const avi = await personId('avi@example.com')
    const resend = await app.request(`/api/people/${avi}/resend`, req(cookie, 'POST', {}))
    expect(resend.status).toBe(200)
    expect(await resend.json()).toEqual({ ok: true, sentTo: 'avi@example.com' })
    expect(outbox.filter((m) => m.to === 'avi@example.com').length).toBe(first + 2)
    const inviteId = decodeURIComponent(outbox.filter((m) => m.to === 'avi@example.com').at(-1)!.text.match(/https?:\/\/\S+/)![0]).match(/invite=([A-Za-z0-9_-]+)/)![1]!

    // Cancel: the membership and every invite record for them go.
    const del = await app.request(`/api/people/${avi}`, req(cookie, 'DELETE'))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    const prefs = (await (await app.request('/api/preferences', { headers: { cookie } })).json()) as { people: Array<{ email: string }> }
    expect(prefs.people.map((p) => p.email)).toEqual(['founder@example.com'])
    expect(await booted.handle.db.selectFrom('settings').select('key').where('key', 'like', 'invite:%').execute()).toEqual([])
    const aviCookie = await signIn('avi@example.com')
    expect((await app.request(`/api/invites/${inviteId}`, { headers: { cookie: aviCookie } })).status).toBe(404)
    expect(((await (await app.request('/api/me', { headers: { cookie: aviCookie } })).json()) as { needsOnboarding: boolean }).needsOnboarding).toBe(true)
    // Re-send for someone who has joined is refused.
    expect((await app.request(`/api/people/${await personId('founder@example.com')}/resend`, req(cookie, 'POST', {}))).status).toBe(409)
  })

  it('a failed invite email says so and leaves them pending for Re-send', async () => {
    const { cookie } = await owner()
    const send = booted.services.mailer!.send
    booted.services.mailer!.send = async () => {
      throw new Error('smtp down')
    }
    const inv = await app.request('/api/people', req(cookie, 'POST', { email: 'bea@example.com', role: 'finance', entityIds: 'all' }))
    booted.services.mailer!.send = send
    expect(inv.status).toBe(502)
    expect(await inv.json()).toMatchObject({ error: 'email_failed' })
    expect((await app.request(`/api/people/${await personId('bea@example.com')}/resend`, req(cookie, 'POST', {}))).status).toBe(200)
    expect(outbox.some((m) => m.to === 'bea@example.com')).toBe(true)
  })

  it('removes a member with their AI access; owners only for owners; the last owner can’t leave', async () => {
    const { cookie } = await owner()
    const founder = await personId('founder@example.com')
    await app.request('/api/people', req(cookie, 'POST', { email: 'adm@example.com', role: 'admin', entityIds: 'all' }))
    await app.request('/api/people', req(cookie, 'POST', { email: 'emp@example.com', role: 'employee', entityIds: 'all' }))
    const adm = await signIn('adm@example.com')
    const emp = await signIn('emp@example.com')
    const admId = await personId('adm@example.com')
    const empId = await personId('emp@example.com')
    const key = await app.request('/api/ai/keys', req(adm, 'POST', { name: 'n8n', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', dailyWriteCap: 10, expiresAt: '2026-12-01T00:00:00.000Z' } }))
    expect(key.status, await key.clone().text()).toBeLessThan(300)

    // The founder is the only owner: no leaving, and nobody can remove them; an employee can't remove anyone.
    expect(((await (await app.request('/api/preferences', { headers: { cookie } })).json()) as { canLeave: boolean }).canLeave).toBe(false)
    const leave = await app.request('/api/workspace/leave', req(cookie, 'POST', {}))
    expect(leave.status).toBe(409)
    expect(await leave.json()).toMatchObject({ error: 'last_owner', message: 'You’re the only owner. Make someone else an owner first, or delete the workspace.' })
    expect((await app.request(`/api/people/${founder}`, req(adm, 'DELETE'))).status).toBe(403)
    expect((await app.request(`/api/people/${admId}`, req(emp, 'DELETE'))).status).toBe(403)

    // The owner removes the admin: membership, grant and key all end, and the workspace is gone from their session.
    expect((await app.request(`/api/people/${admId}`, req(cookie, 'DELETE'))).status).toBe(200)
    expect(await booted.handle.db.selectFrom('memberships').select('id').where('person_id', '=', admId).where('revoked_at', 'is', null).execute()).toEqual([])
    expect((await anyDb().selectFrom('grants').select('revoked_at').where('person_id', '=', admId).execute()).every((g) => g.revoked_at)).toBe(true)
    expect((await anyDb().selectFrom('agent_keys').select('revoked_at').where('created_by', '=', admId).execute()).map((k) => Boolean(k.revoked_at))).toEqual([true])
    expect((await app.request('/api/preferences', { headers: { cookie: adm } })).status).toBe(409)
    expect((await app.request(`/api/people/${admId}`, req(cookie, 'DELETE'))).status).toBe(404)

    // An employee leaves on their own.
    expect(((await (await app.request('/api/preferences', { headers: { cookie: emp } })).json()) as { canLeave: boolean }).canLeave).toBe(true)
    expect((await app.request('/api/workspace/leave', req(emp, 'POST', {}))).status).toBe(200)
    expect(((await (await app.request('/api/me', { headers: { cookie: emp } })).json()) as { needsOnboarding: boolean }).needsOnboarding).toBe(true)
    expect(empId).toBeTruthy()

    // With a second owner, the founder can leave.
    await app.request('/api/people', req(cookie, 'POST', { email: 'own2@example.com', role: 'owner', entityIds: 'all' }))
    await signIn('own2@example.com')
    expect((await app.request('/api/workspace/leave', req(cookie, 'POST', {}))).status).toBe(200)
  })
})

describe('deleting a workspace others keep Personal connections in', () => {
  it('the owner sees who is affected (counts only), and they are emailed before it goes', async () => {
    const { cookie } = await owner()
    const { newId, nowIso, withBypass } = await import('@agfn/db')
    await app.request('/api/people', req(cookie, 'POST', { email: 'fay@example.com', role: 'employee', entityIds: 'all' }))
    await signIn('fay@example.com')
    const db = booted.handle.db
    const fay = (await db.selectFrom('people').select('id').where('email', '=', 'fay@example.com').executeTakeFirstOrThrow()).id
    const ws = (await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', fay).executeTakeFirstOrThrow()).workspace_id
    await withBypass('t', async () => {
      const ent = (await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('owner_person_id', '=', fay).where('kind', '=', 'personal').executeTakeFirst())?.id ?? newId()
      if (!(await db.selectFrom('entities').select('id').where('id', '=', ent).executeTakeFirst())) await db.insertInto('entities').values({ id: ent, workspace_id: ws, kind: 'personal', name: 'Personal', base_currency: 'USD', owner_person_id: fay, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null }).execute()
      for (const [name, status] of [['Chase', 'active'], ['Old Amex', 'disconnected']] as const)
        await db.insertInto('connections').values({ id: newId(), workspace_id: ws, connector_key: 'plaid', entity_id: ent, display_name: name, status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: fay, created_at: nowIso() }).execute()
    })
    const pre = await app.request('/api/workspace/delete-preview', { headers: { cookie } })
    expect(pre.status).toBe(200)
    expect(await pre.json()).toEqual({ affected: [{ personId: fay, name: 'fay', email: 'fay@example.com', personalConnections: 1 }] })
    const sentBefore = outbox.filter((m) => m.to === 'fay@example.com').length
    const del = await app.request('/api/workspace', req(cookie, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    const notice = outbox.filter((m) => m.to === 'fay@example.com').slice(sentBefore)
    expect(notice).toHaveLength(1)
    expect(notice[0]!.text).toContain('founder is deleting the workspace Acme')
    expect(notice[0]!.text).toContain('(Chase)')
    expect(notice[0]!.text).not.toContain('Old Amex')
  })

  it('only an owner sees the preview', async () => {
    const { cookie } = await owner()
    await app.request('/api/people', req(cookie, 'POST', { email: 'adm@example.com', role: 'admin', entityIds: 'all' }))
    const adm = await signIn('adm@example.com')
    expect((await app.request('/api/workspace/delete-preview', { headers: { cookie: adm } })).status).toBe(403)
    expect(await (await app.request('/api/workspace/delete-preview', { headers: { cookie } })).json()).toEqual({ affected: [] })
  })
})
