// Red-team: a reviewer access link can't reach or create anything outside its demo workspace.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { createWorkspace } from '@agfn/auth'
import { newId, nowIso } from '@agfn/db'
import { createConnection } from '@agfn/sync'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpFor } from './modules.ts'
import { peopleFromAuth } from '@agfn/mcp'
import { mintReviewerLink, reseedReviewerDemos, reviewerBlocked, revokeReviewerLink } from './reviewer.ts'

const BASE = 'http://localhost:8787'
let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
})

async function start(reviewerLinks: boolean) {
  const outbox: Array<{ to: string; text: string }> = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', ...(reviewerLinks ? { AGFN_REVIEWER_LINKS: '1' } : {}) }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, mcp: (svc) => mcpFor(svc) })
  const app = createApp(booted.services)
  const db = booted.handle.db
  // A light demo workspace (the real one is filled by @agfn/demo; tested there).
  const buildDemo = async (personId: string) => {
    const ids = await createWorkspace(db, { personId, workspaceName: 'Demo', firstCompanyName: 'Northwind' })
    await db.insertInto('settings').values({ workspace_id: ids.workspaceId, key: 'demo', value_json: 'true', updated_at: nowIso() }).execute()
    return ids.workspaceId
  }
  const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  async function open(url: string): Promise<{ status: number; cookie: string }> {
    const r = await app.request(url.replace(BASE, ''))
    if (r.status !== 302) return { status: r.status, cookie: '' }
    const verify = await app.request(r.headers.get('location')!.replace(BASE, ''), { headers: { origin: BASE } })
    return { status: 302, cookie: verify.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }
  }
  async function signIn(email: string): Promise<string> {
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
    const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
    return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  }
  return { app, db, outbox, buildDemo, req, open, signIn }
}

describe('reviewer access links', () => {
  it('are off by default: the route is a 404 even for a valid token', async () => {
    const t = await start(false)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'test', baseUrl: BASE })
    expect((await t.app.request(link.url.replace(BASE, ''))).status).toBe(404)
  })

  it('sign a reviewer into the demo with no email sent, and refuse everything outside it', async () => {
    const t = await start(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'Anthropic directory review', baseUrl: BASE })
    expect(link.url).toMatch(/^http:\/\/localhost:8787\/review-access\/[A-Za-z0-9_-]{43}$/)
    const row = await t.db.selectFrom('reviewer_links').selectAll().executeTakeFirstOrThrow()
    expect(link.url).not.toContain(row.token_hash) // only the hash is stored

    const { status, cookie } = await t.open(link.url)
    expect(status).toBe(302)
    expect(t.outbox).toEqual([]) // nothing was emailed
    const me = (await (await t.app.request('/api/me', { headers: { cookie } })).json()) as { workspaceId: string; reviewerDemo?: boolean; demo: boolean }
    expect(me).toMatchObject({ workspaceId: link.workspaceId, reviewerDemo: true, demo: true })

    // Nothing that creates, joins, deletes, invites or connects.
    for (const [method, path, body] of [
      ['POST', '/api/workspaces', { companyName: 'Real Co' }],
      ['DELETE', '/api/me', { confirm: 'DELETE' }],
      ['DELETE', '/api/workspace', { confirm: 'DELETE' }],
      ['DELETE', '/api/demo', undefined],
      ['POST', '/api/people', { email: 'friend@example.com', role: 'owner' }],
      ['POST', '/api/connectors/plaid/start', {}],
      ['PUT', `/api/inbound/${link.workspaceId}`, { extra: ['@evil.com'] }],
      ['GET', '/api/auth/passkey/generate-register-options', undefined],
      ['POST', '/api/auth/change-email', { newEmail: 'me@example.com' }],
    ] as const) {
      expect((await t.app.request(path, t.req(cookie, method, body))).status, `${method} ${path}`).toBe(403)
    }
    // A workspace header can't point it elsewhere: it stays in the demo.
    const other = await t.signIn('owner@example.com')
    await t.app.request('/api/workspaces', t.req(other, 'POST', { companyName: 'Real Co' }))
    const realWs = (await (await t.app.request('/api/me', { headers: { cookie: other } })).json()) as { workspaceId: string }
    const forced = (await (await t.app.request('/api/me', { headers: { cookie, 'x-agfn-workspace': realWs.workspaceId } })).json()) as { workspaceId: string }
    expect(forced.workspaceId).toBe(link.workspaceId)
    // Nobody can invite a reviewer address into a real workspace.
    const inv = await t.app.request('/api/people', t.req(other, 'POST', { email: link.email, role: 'finance' }))
    expect([400, 403]).toContain(inv.status)

    // An AI connection made by the reviewer (fresh sign-in counts as the re-check) belongs to the demo workspace.
    const key = await t.app.request('/api/ai/keys', t.req(cookie, 'POST', { name: 'Reviewer AI', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', dailyWriteCap: 50, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } }))
    expect(key.status).toBeLessThan(300)
    const grants = (await t.db.selectFrom('grants' as never).select(['workspace_id' as never]).execute()) as Array<{ workspace_id: string }>
    expect(grants.every((g) => g.workspace_id === link.workspaceId)).toBe(true)
    // It can't add a passkey of its own (which would satisfy later re-checks): refused above.
    const people = peopleFromAuth({ db: t.db, permissions: booted!.services.permissions, reauth: booted!.services.reauth })
    const reviewerId = (await t.db.selectFrom('people').select('id').where('email', '=', link.email).executeTakeFirstOrThrow()).id
    expect(await people.requireRecentPasskey(reviewerId, 600_000, 'create_grant')).toBe(true) // AI connections only
    // However long ago the access code was used: a reviewer is never sent to "sign in again" to connect (OpenAI's review
    // was refused for "additional setup or verification").
    expect(await people.requireRecentPasskey(reviewerId, 1, 'create_grant')).toBe(true)
    expect(await people.requireRecentPasskey(reviewerId, 1, 'first_grant')).toBe(true)
    expect(await people.requireRecentPasskey(reviewerId, 600_000)).toBe(false) // every other re-check, even inside the window
    // A re-check-gated action that isn't route-blocked (widening an AI connection) is still refused inside the window.
    const grantId = ((await key.clone().json()) as { grantId?: string; grant?: { id: string } }).grantId ?? ((await key.clone().json()) as { grant: { id: string } }).grant?.id
    const widen = await t.app.request(`/api/ai/${grantId}`, t.req(cookie, 'PATCH', { shape: { entityIds: 'all', dataTypes: ['balances', 'transactions'], write: true, reviewMode: 'instant', dailyWriteCap: 50, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } }))
    expect(widen.status).toBe(403)
    // No passkey prompt and no email (the reviewer has neither): a fresh sign-in with the code, for connecting only.
    expect(await widen.json()).toMatchObject({ error: 'recheck', method: 'signin' })
  })

  it('can’t use the email re-check to connect anything (no passkey, fresh sign-in, even a planted email_link)', async () => {
    const t = await start(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'review', baseUrl: BASE })
    const { cookie } = await t.open(link.url)
    // Asking for the link: refused, nothing sent.
    expect((await t.app.request('/api/recheck/email', t.req(cookie, 'POST', {}))).status).toBe(403)
    expect(t.outbox).toEqual([])
    // Even if a re-check event existed (it can't be made through the app), connecting stays refused everywhere.
    const reviewerId = (await t.db.selectFrom('people').select('id').where('email', '=', link.email).executeTakeFirstOrThrow()).id
    await t.db.insertInto('reauth_events').values({ id: newId(), person_id: reviewerId, method: 'email_link', at: nowIso() }).execute()
    for (const key of ['plaid', 'quickbooks', 'stripe', 'fakebank']) expect((await t.app.request(`/api/connectors/${key}/start`, t.req(cookie, 'POST', { entityId: null }))).status, key).toBe(403)
    // Adding an account from an existing connection (not route-blocked) is refused by the check itself.
    const entityId = (await t.db.selectFrom('entities').select('id').where('workspace_id', '=', link.workspaceId).executeTakeFirstOrThrow()).id
    const connId = await createConnection(t.db, booted!.services.keys, { workspaceId: link.workspaceId, connectorKey: 'demo', displayName: 'x', secret: { demo: true }, config: { profile: 'northwind' }, createdBy: reviewerId, entityId })
    const shared = await t.app.request(`/api/connections/${connId}/shared`, t.req(cookie, 'POST', { id: 'x' }))
    expect(shared.status).toBe(403)
    expect((await t.db.selectFrom('connections').select('id').where('workspace_id', '=', link.workspaceId).execute()).length).toBe(1)
  })

  it('the access code typed on the sign-in page signs the reviewer in, with the same checks as the link', async () => {
    const off = await start(false)
    expect((await off.app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ code: 'x' }) })).status).toBe(404)
    await booted!.shutdown()
    booted = undefined
    const t = await start(true)
    const methods = (await (await t.app.request('/api/sign-in-methods')).json()) as { reviewerCode?: boolean }
    expect(methods.reviewerCode).toBe(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'OpenAI review', baseUrl: BASE })
    const code = link.url.split('/').pop()!
    const post = (c: string) => t.app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ code: c }) })
    expect((await post('not-a-real-code')).status).toBe(400)
    for (const typed of [code, `  ${link.url}  `]) {
      const ok = await post(typed)
      expect(ok.status, await ok.clone().text()).toBe(200)
      const cookie = ok.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
      const me = (await (await t.app.request('/api/me', { headers: { cookie } })).json()) as { reviewerDemo?: boolean; workspaceId: string }
      expect(me).toMatchObject({ reviewerDemo: true, workspaceId: link.workspaceId })
    }
    expect(t.outbox).toEqual([]) // nothing emailed
    // As email + password (the password is the code): the email must be this code's account, in any case.
    const login = (email: string, c: string) => t.app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ code: c, email }) })
    const viaPassword = await login(`  ${link.email.toUpperCase()} `, code)
    expect(viaPassword.status, await viaPassword.clone().text()).toBe(200)
    expect(viaPassword.headers.getSetCookie().some((x) => x.includes('session_token'))).toBe(true)
    expect((await login('someone@example.com', code)).status).toBe(400)
    const other = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'Claude review', baseUrl: BASE })
    expect((await login(other.email, code)).status).toBe(400) // another reviewer's email with this code
    expect((await login(link.email, 'not-a-real-code')).status).toBe(400)
    expect(t.outbox).toEqual([])
    await revokeReviewerLink(t.db, link.id)
    expect((await post(code)).status).toBe(400)
    expect((await login(link.email, code)).status).toBe(400)
  })

  it('inside an AI’s OAuth window, the access code carries on to consent and a token (the reviewer’s path)', async () => {
    const t = await start(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'OpenAI review', baseUrl: BASE })
    const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const client = (await (await t.app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read records:write' }) })).json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read records:write', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    // Signed out: the authorize request lands on the sign-in page, carrying its signed query.
    const signInAt = (await t.app.request(`/api/auth/oauth2/authorize?${q}`)).headers.get('location') ?? ''
    expect(signInAt).toContain('/#/sign-in?')
    const oauthQuery = signInAt.slice(signInAt.indexOf('?') + 1)
    // The access code typed on that page signs in (the browser keeps the cookie), then the page continues the authorization.
    const ok = await t.app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ code: link.url.split('/').pop() }) })
    expect(ok.status).toBe(200)
    const cookie = ok.headers.getSetCookie().map((x) => x.split(';')[0]).join('; ')
    const cont = await t.app.request('/api/auth/oauth2/continue', t.req(cookie, 'POST', { postLogin: true, oauth_query: oauthQuery }))
    expect(cont.status, await cont.clone().text()).toBe(200)
    const consentAt = ((await cont.json()) as { url?: string }).url ?? ''
    expect(consentAt).toContain('/#/connect-ai/consent?')
    // Consent (the reviewer steps: all companies, read and write), then the code and the token.
    expect((await t.app.request('/api/ai/consent', t.req(cookie, 'POST', { clientId: client.client_id, clientName: 'ChatGPT', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'documents', 'reports'], write: true, reviewMode: 'instant', expiresAt: null } }))).status).toBe(200)
    let next = ((await (await t.app.request('/api/auth/oauth2/continue', t.req(cookie, 'POST', { postLogin: true, oauth_query: consentAt.slice(consentAt.indexOf('?') + 1) }))).json()) as { url?: string }).url ?? ''
    if (next.includes('/#/connect-ai/consent')) next = ((await (await t.app.request('/api/auth/oauth2/consent', t.req(cookie, 'POST', { accept: true, oauth_query: next.slice(next.indexOf('?') + 1) }))).json()) as { url?: string }).url ?? ''
    const code = new URL(next).searchParams.get('code')!
    const tok = (await (await t.app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token?: string }
    expect(tok.access_token).toBeTruthy()
  })

  it('stop working the moment the account isn’t demo-only, and when expired or revoked', async () => {
    const t = await start(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'OpenAI review', baseUrl: BASE })
    const { cookie } = await t.open(link.url)
    const reviewerId = (await t.db.selectFrom('people').select('id').where('email', '=', link.email).executeTakeFirstOrThrow()).id

    // Gains a second membership (by mistake): every request and the link itself are refused.
    const ownerId = newId()
    await t.db.insertInto('people').values({ id: ownerId, auth_user_id: null, name: 'Owner', email: 'owner2@example.com', created_at: nowIso() }).execute()
    const realId = (await createWorkspace(t.db, { personId: ownerId, workspaceName: 'Real', firstCompanyName: 'Real Co' })).workspaceId
    await t.db.insertInto('memberships').values({ id: newId(), workspace_id: realId, person_id: reviewerId, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute()
    expect((await t.app.request('/api/me', { headers: { cookie } })).status).toBe(403)
    expect((await t.open(link.url)).status).toBe(404)
    await t.db.deleteFrom('memberships').where('workspace_id', '=', realId).where('person_id', '=', reviewerId).execute()
    expect((await t.app.request('/api/me', { headers: { cookie } })).status).toBe(200)

    // The demo flag removed: refused.
    await t.db.updateTable('settings').set({ value_json: 'false' }).where('workspace_id', '=', link.workspaceId).where('key', '=', 'demo').execute()
    expect((await t.app.request('/api/me', { headers: { cookie } })).status).toBe(403)
    await t.db.updateTable('settings').set({ value_json: 'true' }).where('workspace_id', '=', link.workspaceId).where('key', '=', 'demo').execute()

    // Wrong, expired and revoked tokens.
    expect((await t.open(`${BASE}/review-access/${'A'.repeat(43)}`)).status).toBe(404)
    await t.db.updateTable('reviewer_links').set({ expires_at: '2000-01-01T00:00:00.000Z' }).execute()
    expect((await t.open(link.url)).status).toBe(404)
    await t.db.updateTable('reviewer_links').set({ expires_at: '2999-01-01T00:00:00.000Z' }).execute()
    expect(await revokeReviewerLink(t.db, link.id)).toBe(true)
    expect((await t.open(link.url)).status).toBe(404)
    expect((await t.app.request('/api/me', { headers: { cookie } })).status).toBe(401) // its sessions ended
  })

  it('get fresh demo books every night; yesterday’s AI connections are revoked', async () => {
    const t = await start(true)
    const link = await mintReviewerLink({ db: t.db, buildDemo: t.buildDemo }, { label: 'nightly', baseUrl: BASE })
    const { cookie } = await t.open(link.url)
    await t.app.request('/api/ai/keys', t.req(cookie, 'POST', { name: 'Reviewer AI', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', dailyWriteCap: 50, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() } }))
    expect(await reseedReviewerDemos({ db: t.db, buildDemo: t.buildDemo })).toBe(1)
    const me = (await (await t.app.request('/api/me', { headers: { cookie } })).json()) as { workspaceId: string }
    expect(me.workspaceId).not.toBe(link.workspaceId)
    const old = (await t.db.selectFrom('grants' as never).select(['revoked_at' as never]).where('workspace_id' as never, '=', link.workspaceId as never).execute()) as Array<{ revoked_at: string | null }>
    expect(old.length).toBeGreaterThan(0)
    expect(old.every((g) => g.revoked_at)).toBe(true)
  })

  it('block list', () => {
    expect(reviewerBlocked('GET', '/api/workspace')).toBe(false)
    expect(reviewerBlocked('POST', '/api/workspace/leave')).toBe(true)
    expect(reviewerBlocked('POST', '/api/ai/keys')).toBe(false)
    expect(reviewerBlocked('POST', '/api/connectors/plaid/finish')).toBe(true)
    expect(reviewerBlocked('GET', '/api/auth/passkey/generate-register-options')).toBe(true)
    expect(reviewerBlocked('POST', '/api/auth/oauth2/consent')).toBe(false)
  })
})
