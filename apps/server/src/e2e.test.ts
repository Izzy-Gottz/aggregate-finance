import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor, mcpFor } from './modules.ts'

// Full path a real AI client takes: discovery → register → sign in → choose access → token → call /mcp.
const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({
    config,
    keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }),
    mailer: { send: async (m) => void outbox.push(m.text) },
    ledger: (h) => ledgerFor(h.db),
    mcp: (s) => mcpFor(s),
  })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

function jar() {
  const m = new Map<string, string>()
  return {
    take(res: Response) {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';')
        const i = pair!.indexOf('=')
        const k = pair!.slice(0, i)
        const v = pair!.slice(i + 1)
        if (v) m.set(k, v)
        else m.delete(k)
      }
    },
    get: () => [...m].map(([k, v]) => `${k}=${v}`).join('; '),
  }
}

describe('end to end: connect Claude', () => {
  it('discovery, registration, consent with the control sentence, token, and an MCP call', async () => {
    // 1. Unauthenticated MCP call points the client at the protected-resource metadata.
    const unauth = await app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) })
    expect(unauth.status).toBe(401)
    expect(unauth.headers.get('www-authenticate') ?? '').toContain('resource_metadata')
    const prm = (await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()) as { resource: string; authorization_servers: string[] }
    expect(prm.resource).toBe(`${BASE}/mcp`)
    expect(prm.authorization_servers).toContain(BASE)

    // 2. Register (DCR).
    const reg = await app.request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read records:write' }) })
    const client = (await reg.json()) as { client_id: string }

    // 3. Person signs in and creates a company.
    const cookies = jar()
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'f@x.com', callbackURL: '/' }) })
    cookies.take(await app.request(outbox[0]!.match(/https?:\/\/\S+/)![0].replace(BASE, ''), { headers: { origin: BASE } }))
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: cookies.get() }, body: JSON.stringify(body) })
    const ws = (await (await post('/api/workspaces', { companyName: 'Acme' })).json()) as { companyId: string }

    // 4. Authorize → our control-sentence page.
    const verifier = randomBytes(32).toString('base64url')
    const q = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', scope: 'openid offline_access finance:read records:write', state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: `${BASE}/mcp` })
    const authz = await app.request(`/api/auth/oauth2/authorize?${q}`, { headers: { cookie: cookies.get() } })
    const loc = authz.headers.get('location') ?? ''
    expect(loc).toContain('/#/connect-ai/consent')

    // 5. The page sends the chosen access; the server creates the grant (S7) and binds it.
    const consent = await post('/api/ai/consent', { clientId: client.client_id, clientName: 'Claude', shape: { entityIds: [ws.companyId], dataTypes: ['balances', 'transactions'], write: false, reviewMode: 'instant', expiresAt: null } })
    expect(consent.status).toBe(200)
    const { grantId } = (await consent.json()) as { grantId: string }
    const cont = await post('/api/auth/oauth2/continue', { postLogin: true, oauth_query: loc.slice(loc.indexOf('?') + 1) })
    let next = ((await cont.json()) as { url?: string }).url ?? ''
    if (next.includes('/#/connect-ai/consent')) {
      next = ((await (await post('/api/auth/oauth2/consent', { accept: true, oauth_query: next.slice(next.indexOf('?') + 1) })).json()) as { url?: string }).url ?? ''
    }
    const code = new URL(next).searchParams.get('code')!

    // 6. Token.
    const tok = await app.request('/api/auth/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) })
    const { access_token } = (await tok.json()) as { access_token: string }
    expect(access_token).toBeTruthy()
    // Revocation (RFC 7009): a token the server doesn't know answers 200; a JWT access token says it can't be revoked
    // on its own (it ends with its grant), never a false 200.
    const revoke = (token: string) => app.request('/api/auth/oauth2/revoke', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token, client_id: client.client_id }) })
    expect((await revoke('not-a-token')).status).toBe(200)
    const jwt = await revoke(access_token)
    expect(jwt.status).toBe(400)
    expect(((await jwt.json()) as { error: string }).error).toBe('unsupported_token_type')

    // 7. MCP: list tools as Claude. The list is the same for every connection; a read-only grant's writes are refused.
    const call = (body: unknown) => app.request('/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${access_token}`, 'mcp-protocol-version': '2025-06-18' }, body: JSON.stringify(body) })
    const init = await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: '1' } } })
    expect(init.status).toBe(200)
    const list = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const text = await list.text()
    expect(text).toContain('whoami')
    expect(text).toContain('add_entry')
    // A narrow grant (one company, balances and transactions, read-only) still lists all 40 tools and 3 prompts.
    const listed = JSON.parse(text.startsWith('{') ? text : text.split('\n').filter((l) => l.startsWith('data:')).at(-1)!.slice(5)) as { result: { tools: unknown[] } }
    expect(listed.result.tools).toHaveLength(40)
    const pr = await (await call({ jsonrpc: '2.0', id: 8, method: 'prompts/list', params: {} })).text()
    expect((JSON.parse(pr.startsWith('{') ? pr : pr.split('\n').filter((l) => l.startsWith('data:')).at(-1)!.slice(5)) as { result: { prompts: unknown[] } }).result.prompts).toHaveLength(3)
    const denied = await (await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'add_entry', arguments: { company: 'Acme', kind: 'cash_income', amount: { amount: '10.00', currency: 'USD' }, date: '2026-10-01', paid_by: 'Acme', reason: 'test', idempotency_key: 'readonly-check-1' } } })).text()
    expect(denied).toMatch(/read-only/)

    // 8. Revoking the grant stops the token immediately.
    await booted.services.mcp!.control.revokeGrant({ workspaceId: (await booted.services.permissions.workspacesFor((await booted.handle.db.selectFrom('people').select('id').executeTakeFirstOrThrow()).id))[0]!.id, personId: (await booted.handle.db.selectFrom('people').select('id').executeTakeFirstOrThrow()).id }, grantId)
    const after = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
    expect(after.status).toBe(401)
  })
})

describe('connecting an AI with a stale sign-in says how to confirm (method)', () => {
  const shape = (companyId: string) => ({ entityIds: [companyId], dataTypes: ['balances'], write: false, reviewMode: 'instant', expiresAt: null })
  async function stale(email: string) {
    const cookies = jar()
    await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
    cookies.take(await app.request(outbox.at(-1)!.match(/https?:\/\/\S+/)![0].replace(BASE, ''), { headers: { origin: BASE } }))
    const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie: cookies.get() }, body: JSON.stringify(body) })
    const patch = (path: string, body: unknown) => app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: BASE, cookie: cookies.get() }, body: JSON.stringify(body) })
    const ws = (await (await post('/api/workspaces', { companyName: 'Acme' })).json()) as { companyId: string }
    // Older than the first connection's 60 minutes too (FIRST_GRANT_WINDOW_MS).
    await booted.services.db.updateTable('reauth_events').set({ at: new Date(Date.now() - 61 * 60_000).toISOString() }).execute()
    const person = await booted.services.db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
    return { post, patch, ws, person }
  }

  it("a first AI connection within 60 minutes of signing in needs no re-check; the next one keeps the 10-minute rule", async () => {
    const { post, ws } = await stale('first@x.com')
    // Signed up 30 minutes ago, detoured through the bank and Claude's settings, then connects.
    await booted.services.db.updateTable('reauth_events').set({ at: new Date(Date.now() - 30 * 60_000).toISOString() }).execute()
    expect((await post('/api/ai/consent', { clientId: 'c1', clientName: 'Claude', shape: shape(ws.companyId) })).status).toBe(200)
    const second = await post('/api/ai/consent', { clientId: 'c9', clientName: 'ChatGPT', shape: shape(ws.companyId) })
    expect(second.status).toBe(403)
    expect(await second.json()).toMatchObject({ error: 'recheck', method: 'email' })
  })

  it('no passkey: method email (no passkey prompt that can never succeed); the email re-check then lets it through', async () => {
    const { post, ws, person } = await stale('nopk@x.com')
    const r = await post('/api/ai/consent', { clientId: 'c1', clientName: 'Claude', shape: shape(ws.companyId) })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'recheck', method: 'email', fallback: 'email' })
    await booted.services.db.insertInto('reauth_events').values({ id: 'e1', person_id: person.id, method: 'email_link', at: new Date().toISOString() }).execute()
    expect((await post('/api/ai/consent', { clientId: 'c1', clientName: 'Claude', shape: shape(ws.companyId) })).status).toBe(200)
  })

  it('widening an AI connection (a mounted route) answers the same way', async () => {
    const { post, patch, ws, person } = await stale('widen@x.com')
    await booted.services.db.insertInto('reauth_events').values({ id: 'e2', person_id: person.id, method: 'email_link', at: new Date().toISOString() }).execute()
    const { grantId } = (await (await post('/api/ai/consent', { clientId: 'c2', clientName: 'Claude', shape: shape(ws.companyId) })).json()) as { grantId: string }
    await booted.services.db.updateTable('reauth_events').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute()
    const r = await patch(`/api/ai/${grantId}`, { shape: { ...shape(ws.companyId), dataTypes: ['balances', 'transactions'], write: true } })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'recheck', method: 'email', fallback: 'email' })
  })

  it('with a passkey: method passkey, email as the fallback', async () => {
    const { post, ws, person } = await stale('pk@x.com')
    const anyDb = booted.services.db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    await anyDb.insertInto('passkey').values({ id: 'pk1', name: 'Mac', publicKey: 'x', userId: person.auth_user_id, credentialID: 'cred1', counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
    const r = await post('/api/ai/consent', { clientId: 'c1', clientName: 'Claude', shape: shape(ws.companyId) })
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'recheck', method: 'passkey', fallback: 'email' })
  })
})
