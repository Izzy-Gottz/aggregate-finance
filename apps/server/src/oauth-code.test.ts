// The ChatGPT/Claude directory reviewer's exact path, signed out: the AI opens authorization → Better Auth sends the
// browser to the app's login page (/#/sign-in?<signed query>) → the reviewer types the access code there → the page
// continues the authorization (what apps/web does after an in-place sign-in) → consent → code → token.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { mintReviewerLink, serverDemoBuilder } from './reviewer.ts'

const BASE = 'http://localhost:8787'
const CALLBACK = 'https://chatgpt.com/connector_platform_oauth_redirect'
let booted: Booted | undefined
afterEach(async () => {
  vi.useRealTimers()
  await booted?.shutdown()
  booted = undefined
})

describe('reviewer access code in the OAuth window', () => {
  it('signed out → #/sign-in → access code → continue → consent → token', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const app = createApp(booted.services)
    const link = await mintReviewerLink({ db: booted.handle.db, buildDemo: serverDemoBuilder(booted.services) }, { label: 'OpenAI review', baseUrl: BASE })

    // The sign-in page offers the code only while reviewer links are on.
    expect(((await (await app.request('/api/sign-in-methods')).json()) as { reviewerCode?: boolean }).reviewerCode).toBe(true)

    // The AI client registers and starts authorization with no session: the app's login page, with the signed query.
    const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read' }) })).json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    const login = (await app.request(`/api/auth/oauth2/authorize?${q}`)).headers.get('location') ?? ''
    expect(login).toContain('/#/sign-in?')
    const oauthQuery = login.slice(login.indexOf('?') + 1)

    // The reviewer types the test account's email and password (the access code), as given in the review form.
    const signed = await app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: link.email, code: link.url.split('/').pop() }) })
    expect(signed.status, await signed.clone().text()).toBe(200)
    const cookie = signed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

    // What the sign-in page does next (apps/web continueOAuthLogin): carry on to the consent page.
    const next = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: oauthQuery })).json()) as { url?: string; redirectURI?: string })
    const consentUrl = next.url ?? next.redirectURI ?? ''
    expect(consentUrl).toContain('/#/connect-ai/consent')

    // Even if the reviewer takes longer than the usual 10-minute re-check window before choosing Allow, consent works.
    const reviewerId = (await booted.handle.db.selectFrom('people').select('id').where('email', '=', link.email).executeTakeFirstOrThrow()).id
    await booted.handle.db.deleteFrom('reauth_events').where('person_id', '=', reviewerId).execute()
    // The consent page: the reviewer approves; the AI gets its code and a token.
    const consentQuery = consentUrl.slice(consentUrl.indexOf('?') + 1)
    expect((await post('/api/ai/consent', { clientId: client.client_id, clientName: 'ChatGPT', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'reports'], write: false, reviewMode: 'instant', expiresAt: null } })).status).toBe(200)
    let done = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: consentQuery })).json()) as { url?: string }).url ?? ''
    if (done.includes('/#/connect-ai/consent')) done = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: done.slice(done.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    const code = new URL(done).searchParams.get('code')!
    expect(code).toBeTruthy()
    const tok = (await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token?: string }
    expect(tok.access_token).toBeTruthy()
  })
})

// Meta Muse's client names no resource (RFC 8707) at authorize or token. The server defaults the audience to /mcp, so the
// token is one /mcp accepts instead of an opaque token it can't verify (Muse's listing step failed on 2026-11-01).
describe('a client that names no resource', () => {
  it('gets a token /mcp accepts', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const app = createApp(booted.services)
    const link = await mintReviewerLink({ db: booted.handle.db, buildDemo: serverDemoBuilder(booted.services) }, { label: 'Muse review', baseUrl: BASE })
    const MUSE = 'https://platform.muse.ai/oauth/credential-test/callback'
    const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Meta Muse', redirect_uris: [MUSE], token_endpoint_auth_method: 'client_secret_basic', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read' }) })).json()) as { client_id: string; client_secret: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: MUSE, scope: 'openid offline_access finance:read', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })
    const login = (await app.request(`/api/auth/oauth2/authorize?${q}`)).headers.get('location') ?? ''
    expect(new URLSearchParams(login.slice(login.indexOf('?') + 1)).get('resource')).toBe(`${BASE}/mcp`)
    const signed = await app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: link.email, code: link.url.split('/').pop() }) })
    const cookie = signed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
    const next = (await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: login.slice(login.indexOf('?') + 1) })).json()) as { url?: string }
    const consentQuery = (next.url ?? '').slice((next.url ?? '').indexOf('?') + 1)
    expect((await post('/api/ai/consent', { clientId: client.client_id, clientName: 'Meta Muse', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null } })).status).toBe(200)
    let done = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: consentQuery })).json()) as { url?: string }).url ?? ''
    if (done.includes('/#/connect-ai/consent')) done = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: done.slice(done.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    const code = new URL(done).searchParams.get('code')!
    // The token request names no resource either, with the secret in the Authorization header as Muse sends it.
    const basic = 'Basic ' + Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64')
    const tok = (await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: MUSE, code_verifier: verifier }) })).json()) as { access_token?: string }
    expect(tok.access_token?.split('.')).toHaveLength(3)
    const mcp = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'muse', version: '1' } } }) })
    expect(mcp.status, await mcp.clone().text()).toBe(200)
  })
})

// The signed authorization query carried from sign-in to Allow lasts 30 minutes (codeExpiresIn in @agfn/auth). Before
// 2026-10-27 it lasted Better Auth's default 10, and anyone (a directory reviewer included) who took longer got
// "invalid_signature" on Allow.
describe('time from sign-in to Allow', () => {
  async function signedInAtConsent() {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_REVIEWER_LINKS: '1' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const app = createApp(booted.services)
    const link = await mintReviewerLink({ db: booted.handle.db, buildDemo: serverDemoBuilder(booted.services) }, { label: 'OpenAI review', baseUrl: BASE })
    const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read' }) })).json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    const login = (await app.request(`/api/auth/oauth2/authorize?${q}`)).headers.get('location') ?? ''
    const signed = await app.request('/api/review-access/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: link.email, code: link.url.split('/').pop() }) })
    expect(signed.status).toBe(200)
    const cookie = signed.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
    const next = (await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: login.slice(login.indexOf('?') + 1) })).json()) as { url?: string; redirectURI?: string }
    const consentUrl = next.url ?? next.redirectURI ?? ''
    expect(consentUrl).toContain('/#/connect-ai/consent')
    const consentQuery = consentUrl.slice(consentUrl.indexOf('?') + 1)
    // Allow on the consent page: the grant, then the continue the page makes. Returns the continue's status and the code.
    const allow = async (oauthQuery = consentQuery) => {
      expect((await post('/api/ai/consent', { clientId: client.client_id, clientName: 'ChatGPT', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'reports'], write: false, reviewMode: 'instant', expiresAt: null } })).status).toBe(200)
      const r = await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: oauthQuery })
      let done = ((await r.clone().json()) as { url?: string }).url ?? ''
      if (r.ok && done.includes('/#/connect-ai/consent')) done = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: done.slice(done.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
      return { status: r.status, body: await r.text(), code: done.startsWith(CALLBACK) ? new URL(done).searchParams.get('code') : null }
    }
    const token = async (code: string) => ((await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token?: string }).access_token
    return { consentQuery, allow, token }
  }
  const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)

  for (const minutes of [11, 25]) {
    it(`Allow ${minutes} minutes after sign-in still connects`, async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
      const flow = await signedInAtConsent()
      later(minutes)
      const r = await flow.allow()
      expect(r.status, r.body).toBe(200)
      expect(r.code).toBeTruthy()
      expect(await flow.token(r.code!)).toBeTruthy()
    })
  }

  it('after 31 minutes the query has expired: Allow is refused and no code is issued', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    const flow = await signedInAtConsent()
    later(31)
    const r = await flow.allow()
    expect(r.status).toBe(400)
    expect(r.body).toContain('invalid_signature')
    expect(r.code).toBeNull()
  })

  it('a tampered query is refused, however soon', async () => {
    const flow = await signedInAtConsent()
    const forged = new URLSearchParams(flow.consentQuery)
    forged.set('scope', 'openid offline_access finance:read records:write')
    const r = await flow.allow(forged.toString())
    expect(r.status).toBe(400)
    expect(r.body).toContain('invalid_signature')
    expect(r.code).toBeNull()
    const longer = new URLSearchParams(flow.consentQuery)
    longer.set('exp', String(Number(longer.get('exp')) + 24 * 3600))
    expect((await flow.allow(longer.toString())).status).toBe(400)
  })
})

// The most common first run: someone adds Aggregate in Claude or ChatGPT before having an account. The web app keeps the
// consent URL through the company-name step (apps/web lib/pending-consent.ts) and resumes it; the server side must
// accept that same signed query after the workspace exists.
describe('a brand-new account in the OAuth window', () => {
  it('signed out → #/sign-in → new email → code → workspace → consent → token', async () => {
    const outbox: Array<{ to: string; text: string }> = []
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, ...(await loadInstalledModules({})) })
    const app = createApp(booted.services)
    const jarOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(';')[0]!).filter((c) => !c.endsWith('=')).join('; ')

    const client = (await (await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read' }) })).json()) as { client_id: string }
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, scope: 'openid offline_access finance:read', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    const login = (await app.request(`/api/auth/oauth2/authorize?${q}`)).headers.get('location') ?? ''
    expect(login).toContain('/#/sign-in?')
    const oauthQuery = login.slice(login.indexOf('?') + 1)

    // A new email: the sign-in email's code, typed in the OAuth window, creates the account and signs in.
    const email = 'first-run@acme.example'
    const asked = await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    expect(asked.status).toBe(200)
    const code = outbox.filter((m) => m.to === email).at(-1)!.text.match(/\n(\d{3} \d{3})\n/)![1]!
    const signed = await app.request('/api/signin/code', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: jarOf(asked) }, body: JSON.stringify({ code }) })
    expect(signed.status, await signed.clone().text()).toBe(200)
    const cookie = jarOf(signed)
    const get = (path: string) => app.request(path, { headers: { cookie } })
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })
    expect(((await (await get('/api/me')).json()) as { needsOnboarding?: boolean }).needsOnboarding).toBe(true)

    // The page continues the authorization: the consent page, which the web app keeps while setup asks for the company.
    const next = (await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: oauthQuery })).json()) as { url?: string; redirectURI?: string }
    const consentUrl = next.url ?? next.redirectURI ?? ''
    expect(consentUrl).toContain('/#/connect-ai/consent')

    // The minimum setup: the company name.
    expect((await post('/api/workspaces', { companyName: 'Acme Inc' })).status).toBe(201)
    expect(((await (await get('/api/me')).json()) as { needsOnboarding?: boolean }).needsOnboarding).toBe(false)

    // Back on the kept consent page: approve; the same signed query still yields the code, then the token.
    expect((await post('/api/ai/consent', { clientId: client.client_id, clientName: 'Claude', shape: { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'reports'], write: false, reviewMode: 'instant', expiresAt: null } })).status).toBe(200)
    const consentQuery = consentUrl.slice(consentUrl.indexOf('?') + 1)
    let done = ((await (await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: consentQuery })).json()) as { url?: string }).url ?? ''
    if (done.includes('/#/connect-ai/consent')) done = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: done.slice(done.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    const authCode = new URL(done).searchParams.get('code')!
    expect(authCode).toBeTruthy()
    const tok = (await (await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: authCode, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })).json()) as { access_token?: string }
    expect(tok.access_token).toBeTruthy()
    // The token reads the new workspace.
    const who = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) })
    expect(who.status).toBe(200)
    expect(await who.text()).toMatch(/Acme Inc/)
  })
})
