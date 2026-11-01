import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connector } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { boot, startReadyGate, type Booted } from './boot.ts'
import { MemoryFileStore } from '@agfn/files'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { createHealthWatch } from './health-watch.ts'

let fakeAccounts = 0
const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
const revoked: string[] = []

const fakeBank = (deps: ConnectorDeps): Connector & { webhook: unknown; disconnect: (conn: { id: string }) => Promise<void> } => ({
  describe: () => ({ key: 'fakebank', name: 'Fake Bank', group: 'banks', provides: ['balances', 'transactions'], freshness: 'instant', auth: 'api_key' }),
  connect: async (input) => {
    if (input.apiKey !== 'good') throw new Error('bad key')
    return { secret: { apiKey: input.apiKey }, config: { accountId: 'acct_1' } }
  },
  health: async () => ({ status: 'ok' }),
  disconnect: async (conn: { id: string }) => void revoked.push(conn.id),
  webhook: {
    verify: async (req: { headers: Record<string, string> }) => {
      if (req.headers['x-sig'] !== 'ok') throw new Error('bad sig')
    },
    interpret: (req: { body: string }) => {
      const b = JSON.parse(req.body) as { id: string; account: string; kind: string }
      return { match: { field: 'accountId', value: b.account }, action: b.kind as 'sync' | 'needs_reauth', dedupeKey: b.id }
    },
  },
  sync: async (conn) => {
    const e = { type: 'account.upsert' as const, externalId: 'a1', connectionId: conn.id, name: 'Operating', accountType: 'depository' as const, currency: 'USD', mask: '0001', institution: 'Fake', businessHint: 'business' as const }
    e.externalId = 'a1'
    await deps.raw.put(conn.id, 'account', 'a1', { id: 'a1' })
    return { events: [e], cursor: null, hasMore: false }
  },
})

const fakeOauth = (_deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'fakeoauth', name: 'Fake Pay', group: 'payments', provides: ['transactions'], freshness: 'instant', auth: 'oauth' }),
  begin: async (ctx) => ({ kind: 'oauth', url: `https://pay.example/authorize?state=${ctx.state}&redirect_uri=${encodeURIComponent(ctx.redirectUri)}` }),
  connect: async (input) => {
    if (input.code !== 'c0de' || !String(input.redirectUri).endsWith('/api/connectors/fakeoauth/callback')) throw new Error('bad code')
    // A new account each sign-in: the same account twice is refused as a duplicate (reconnect-same-row.test.ts).
    return { secret: { token: 'tok' }, config: { accountId: `pay_${++fakeAccounts}` } }
  },
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeBank, fakeOauth], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email = 'founder@example.com'): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
/** Gives the signed-in person a passkey and a fresh passkey check (connecting accounts requires both). */
async function withPasskey(email = 'founder@example.com'): Promise<void> {
  const db = booted.services.db
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
}
const json = (cookie: string, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

describe('deleting a workspace', () => {
  it('needs the owner and DELETE typed, revokes providers, and removes every row', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const start = (await (await app.request('/api/connectors/fakebank/start', json(cookie, { entityId: null }))).json()) as { state: string }
    const { connectionId } = (await (await app.request('/api/connectors/fakebank/finish', json(cookie, { state: start.state, apiKey: 'good' }))).json()) as { connectionId: string }
    const del = (confirm: string) => app.request('/api/workspace', { method: 'DELETE', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ confirm }) })
    expect((await del('nope')).status).toBe(422)
    const ok = await del('DELETE')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, connectionsRevoked: 1 })
    expect(revoked).toContain(connectionId)
    const db = booted.services.db
    expect(await db.selectFrom('workspaces').select('id').execute()).toEqual([])
    expect(await db.selectFrom('connections').select('id').execute()).toEqual([])
    expect(await db.selectFrom('entities').select('id').execute()).toEqual([])
    expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(409)
  })
})

describe('connecting accounts needs a fresh check that it’s you', () => {
  const age = () => booted.services.db.updateTable('reauth_events').set({ at: new Date(Date.now() - 11 * 60_000).toISOString() }).execute()
  const event = async (method: 'passkey' | 'magic_link' | 'email_link') => booted.services.db.insertInto('reauth_events').values({ id: `e-${method}-${Date.now()}`, person_id: (await booted.services.db.selectFrom('people').select('id').executeTakeFirstOrThrow()).id, method, at: new Date().toISOString() }).execute()

  it('no passkey: a fresh sign-in or the email link is the check (never a dead end)', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    const start = () => app.request('/api/connectors/fakebank/start', json(cookie, { entityId: null }))
    expect((await start()).status).toBe(200) // just signed in
    await age()
    const r = await start()
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'recheck', method: 'email', fallback: 'email' })
    await event('email_link') // "Use email instead", link opened
    expect((await start()).status).toBe(200)
  })

  it('with a passkey: only a fresh passkey check or the email link, not a plain sign-in', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    const start = () => app.request('/api/connectors/fakebank/start', json(cookie, { entityId: null }))
    await withPasskey()
    await age()
    await event('magic_link')
    const r = await start()
    expect(r.status).toBe(403)
    expect(await r.json()).toMatchObject({ error: 'recheck', method: 'passkey', fallback: 'email' })
    await event('passkey')
    expect((await start()).status).toBe(200)
    await age()
    await event('email_link')
    expect((await start()).status).toBe(200)
  })
})

describe('server', () => {
  it('health, discovery and the unbuilt web fallback', async () => {
    expect((await app.request('/healthz')).status).toBe(200)
    // The sign-in page asks without a session; Apple/Google only when configured (not in this test).
    expect(await (await app.request('/api/sign-in-methods')).json()).toEqual({ methods: ['passkey', 'magic_link'] })
    const meta = await app.request('/.well-known/oauth-authorization-server')
    expect(meta.status).toBe(200)
    expect(((await meta.json()) as { issuer: string }).issuer).toBe(BASE)
    expect((await app.request('/')).status).toBe(503)
    expect((await app.request('/mcp', { method: 'POST' })).status).toBe(503)
    const res = await app.request('/healthz')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('HTML pages and every /api answer, errors included, say no-cache, no-store (Intuit security review)', async () => {
    for (const path of ['/api/me', '/api/no-such-route', '/api/sign-in-methods']) {
      const r = await app.request(path)
      expect(r.headers.get('cache-control'), path).toMatch(/no-store/)
    }
    expect((await app.request('/api/me')).headers.get('cache-control')).toBe('no-cache, no-store')
    // Not an API path and not HTML, or a page its route marks public (no private data): left as the route set it.
    expect((await app.request('/healthz')).headers.get('cache-control') ?? '').not.toMatch(/no-store/)
    expect((await app.request('/privacy')).headers.get('cache-control')).toMatch(/^public/)
  })

  it('/healthz stays 200 when the pool is busy (no machine-wide 503s), and fails on a database error', async () => {
    const stuck = { selectFrom: () => ({ select: () => ({ limit: () => ({ execute: () => new Promise(() => {}) }) }) }) }
    const health = createHealthWatch()
    const busy = createApp({ ...booted.services, health, db: { ...booted.services.db, ...stuck } as unknown as typeof booted.services.db })
    const res = await busy.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, db: 'busy' })
    expect(health.metrics()).toContain('agfn_healthz_busy_total 1')
    const broken = { selectFrom: () => ({ select: () => ({ limit: () => ({ execute: () => Promise.reject(new Error('connection refused')) }) }) }) }
    const down = createApp({ ...booted.services, db: { ...booted.services.db, ...broken } as unknown as typeof booted.services.db })
    expect((await down.request('/healthz')).status).toBe(500)
  })

  it('/healthz is 503 while the ready gate warms, 200 after', async () => {
    const readiness = { ready: false }
    const gated = createApp({ ...booted.services, readiness })
    const res = await gated.request('/healthz')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, warming: true })
    readiness.ready = true
    expect((await gated.request('/healthz')).status).toBe(200)
    // The real gate: closed while the ledger's prewarm runs, open once it settles.
    let finish!: (n: number) => void
    const ledger = { ...booted.services.ledger, prewarm: () => new Promise<number>((r) => (finish = r)) }
    const svc = { ...booted.services, ledger, config: { ...booted.services.config, readyGate: true } }
    startReadyGate({ ...booted, services: svc })
    expect(svc.readiness?.ready).toBe(false)
    finish(3)
    await vi.waitFor(() => expect(svc.readiness?.ready).toBe(true))
  })

  it('requires sign-in, then onboards a first company', async () => {
    expect((await app.request('/api/me')).status).toBe(401)
    const cookie = await signIn()
    const me = (await (await app.request('/api/me', { headers: { cookie } })).json()) as { needsOnboarding: boolean; email: string; mcpUrl: string }
    expect(me).toMatchObject({ needsOnboarding: true, email: 'founder@example.com', mcpUrl: `${BASE}/mcp` })
    expect((await app.request('/api/workspace', { headers: { cookie } })).status).toBe(409)
    const created = await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    expect(created.status).toBe(201)
    const ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { entities: Array<{ name: string; hidden: boolean }>; suggested: Array<{ key: string }> }
    expect(ws.entities.map((e) => e.name)).toEqual(['Personal', 'Acme'])
    // Personal is private, but its own owner sees their numbers.
    expect(ws.entities[0]!.hidden).toBe(false)
    expect(ws.suggested.map((s) => s.key).sort()).toEqual(['fakebank', 'fakeoauth'])
    const added = await app.request('/api/entities', json(cookie, { name: 'Bluebird' }))
    expect(added.status).toBe(201)
  })

  it('connects an api-key source, syncs accounts, and assigns them to a company', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const start = (await (await app.request('/api/connectors/fakebank/start', json(cookie, { entityId: null }))).json()) as { kind: string; state: string }
    expect(start.kind).toBe('api_key')
    const bad = await app.request('/api/connectors/fakebank/finish', json(cookie, { state: 'wrong', apiKey: 'good' }))
    expect(bad.status).toBe(400)
    const fin = await app.request('/api/connectors/fakebank/finish', json(cookie, { state: start.state, apiKey: 'good' }))
    expect(fin.status).toBe(200)
    const { accounts, connectionId } = (await fin.json()) as { connectionId: string; accounts: Array<{ id: string; name: string }> }
    expect(accounts.map((a) => a.name)).toEqual(['Operating'])
    // The state makes one connection: finishing again (a double submit) answers with the same one, no second connection.
    const twice = await app.request('/api/connectors/fakebank/finish', json(cookie, { state: start.state, apiKey: 'good' }))
    expect(((await twice.json()) as { connectionId: string }).connectionId).toBe(connectionId)
    expect(await booted.handle.db.selectFrom('connections').select('id').where('connector_key', '=', 'fakebank').execute()).toHaveLength(1)

    const ws = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as { entities: Array<{ id: string; name: string }>; connections: Array<{ id: string; entityNames: string[]; accountCount: number }> }
    const acme = ws.entities.find((e) => e.name === 'Acme')!
    // Until it has a company, the account is waiting: flagged on the row, listed in the connection drawer.
    expect(ws.connections.find((c) => c.id === connectionId)).toMatchObject({ needsCompany: 1 })
    const waiting = (await (await app.request(`/api/connections/${connectionId}`, { headers: { cookie } })).json()) as { unassigned: Array<{ name: string }> }
    expect(waiting.unassigned.map((a) => a.name)).toEqual(['Operating'])
    expect((await app.request('/api/accounts/assign', json(cookie, { assignments: [{ accountId: accounts[0]!.id, entityId: acme.id }] }))).status).toBe(200)
    const after = (await (await app.request('/api/workspace', { headers: { cookie } })).json()) as typeof ws
    expect(after.connections.find((c) => c.id === connectionId)).toMatchObject({ entityNames: ['Acme'], accountCount: 1 })

    // The connection drawer: summary, its accounts, what it reads.
    const detail = (await (await app.request(`/api/connections/${connectionId}`, { headers: { cookie } })).json()) as { name: string; accounts: Array<{ name: string; kind: string }>; unassigned: unknown[]; provides: string[] }
    expect(detail.accounts.map((a) => a.name)).toEqual(['Operating'])
    expect(detail.unassigned).toEqual([])
    expect(after.connections.find((c) => c.id === connectionId)).not.toHaveProperty('needsCompany')
    expect(detail.provides.length).toBeGreaterThan(0)
    expect((await app.request('/api/connections/nope', { headers: { cookie } })).status).toBe(404)

    // Secrets never leave the server.
    const raw = JSON.stringify(after)
    expect(raw).not.toContain('good')
  })

  it('blocks cross-site writes and keeps workspaces apart', async () => {
    const a = await signIn('a@x.com')
    await app.request('/api/workspaces', json(a, { companyName: 'A Co' }))
    const cross = await app.request('/api/entities', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: a }, body: '{"name":"x"}' })
    expect(cross.status).toBe(403)
    const b = await signIn('b@x.com')
    await app.request('/api/workspaces', json(b, { companyName: 'B Co' }))
    const wsA = (await (await app.request('/api/workspace', { headers: { cookie: a } })).json()) as { me: { workspaceId: string } }
    // B asking for A's workspace by header falls back to B's own.
    const wsB = (await (await app.request('/api/workspace', { headers: { cookie: b, 'x-agfn-workspace': wsA.me.workspaceId } })).json()) as { me: { workspaceId: string }; entities: Array<{ name: string }> }
    expect(wsB.me.workspaceId).not.toBe(wsA.me.workspaceId)
    expect(wsB.entities.map((e) => e.name)).toEqual(['Personal', 'B Co'])
  })

  it('verifies, dedupes and applies provider webhooks', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const start = (await (await app.request('/api/connectors/fakebank/start', json(cookie, {}))).json()) as { state: string }
    await app.request('/api/connectors/fakebank/finish', json(cookie, { state: start.state, apiKey: 'good' }))
    const hook = (sig: string, body: object) => app.request('/api/webhooks/fakebank', { method: 'POST', headers: { 'x-sig': sig, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await hook('bad', { id: 'e1', account: 'acct_1', kind: 'needs_reauth' })).status).toBe(401)
    expect((await hook('ok', { id: 'e1', account: 'acct_1', kind: 'needs_reauth' })).status).toBe(200)
    const conn = await booted.handle.db.selectFrom('connections').select('status').executeTakeFirstOrThrow()
    expect(conn.status).toBe('needs_reauth')
    await booted.handle.db.updateTable('connections').set({ status: 'active' }).execute()
    // Same delivery again (provider retry) does nothing.
    expect((await hook('ok', { id: 'e1', account: 'acct_1', kind: 'needs_reauth' })).status).toBe(200)
    expect((await booted.handle.db.selectFrom('connections').select('status').executeTakeFirstOrThrow()).status).toBe('active')
    // A sync webhook queues one job for the connection.
    await hook('ok', { id: 'e2', account: 'acct_1', kind: 'sync' })
    expect(await booted.handle.db.selectFrom('jobs').select('kind').where('kind', '=', 'connection.sync').execute()).toHaveLength(1)
  })

  it('completes an OAuth connector through the callback and redirects to the connection', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const start = (await (await app.request('/api/connectors/fakeoauth/start', json(cookie, {}))).json()) as { kind: string; url: string; state: string }
    expect(start.kind).toBe('oauth')
    expect(start.url).toContain(encodeURIComponent(`${BASE}/api/connectors/fakeoauth/callback`))
    const bad = await app.request(`/api/connectors/fakeoauth/callback?code=nope&state=${start.state}`, { headers: { cookie } })
    expect(bad.headers.get('location')).toContain('connect_error=')
    const start2 = (await (await app.request('/api/connectors/fakeoauth/start', json(cookie, {}))).json()) as { state: string }
    const ok = await app.request(`/api/connectors/fakeoauth/callback?code=c0de&state=${start2.state}`, { headers: { cookie } })
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toMatch(/^\/#\/\?d=connection:/)
    const denied = await app.request('/api/connectors/fakeoauth/callback?error=access_denied&error_description=Cancelled', { headers: { cookie } })
    expect(denied.headers.get('location')).toBe('/#/?connect_error=Cancelled&connector=fakeoauth')
  })

  it('comes back to where the connect started (onboarding), and ignores routes that aren\'t plain app paths', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const start = async (returnTo: string) => ((await (await app.request('/api/connectors/fakeoauth/start', json(cookie, { returnTo }))).json()) as { state: string }).state
    const ok = await app.request(`/api/connectors/fakeoauth/callback?code=c0de&state=${await start('/welcome/3')}`, { headers: { cookie } })
    expect(ok.headers.get('location')).toMatch(/^\/#\/welcome\/3\?d=connection:/)
    const cancelled = await app.request(`/api/connectors/fakeoauth/callback?error=access_denied&error_description=Cancelled&state=${await start('/welcome/3')}`, { headers: { cookie } })
    expect(cancelled.headers.get('location')).toBe('/#/welcome/3?connect_error=Cancelled&connector=fakeoauth')
    for (const bad of ['//evil.example', 'https://evil.example', '/a?b=c', '/x y']) {
      const r = await app.request(`/api/connectors/fakeoauth/callback?code=c0de&state=${await start(bad)}`, { headers: { cookie } })
      expect(r.headers.get('location')).toMatch(/^\/#\/\?d=connection:/)
    }
  })

  it('a repeated callback (provider redirecting twice, a refresh) lands on the same connection, not "expired"', async () => {
    const cookie = await signIn()
    await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))
    await withPasskey()
    const { state } = (await (await app.request('/api/connectors/fakeoauth/start', json(cookie, { returnTo: '/welcome/2' }))).json()) as { state: string }
    const first = await app.request(`/api/connectors/fakeoauth/callback?code=c0de&state=${state}`, { headers: { cookie } })
    const again = await app.request(`/api/connectors/fakeoauth/callback?code=c0de&state=${state}`, { headers: { cookie } })
    expect(first.headers.get('location')).toMatch(/^\/#\/welcome\/2\?d=connection:/)
    expect(again.headers.get('location')).toBe(first.headers.get('location'))
    const conns = await booted.handle.db.selectFrom('connections').select('id').where('connector_key', '=', 'fakeoauth').execute()
    expect(conns).toHaveLength(1)
  })

  it('uploads documents: dedupes, rejects bad types, serves as attachment, respects permissions', async () => {
    const cookie = await signIn()
    const ws = (await (await app.request('/api/workspaces', json(cookie, { companyName: 'Acme' }))).json()) as { companyId: string; personalId: string }
    const up = (name: string, bytes: Uint8Array, entityId = ws.companyId) => {
      const fd = new FormData()
      fd.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name))
      fd.set('entityId', entityId)
      return app.request('/api/documents', { method: 'POST', headers: { origin: BASE, cookie }, body: fd })
    }
    const pdf = new TextEncoder().encode('%PDF-1.7 plumber bill')
    const r1 = await up('bill.pdf', pdf)
    expect(r1.status).toBe(201)
    const d1 = (await r1.json()) as { documentId: string; state: string }
    expect(d1.state).toBe('unread')
    const r2 = await up('bill-again.pdf', pdf)
    expect(r2.status).toBe(200)
    expect(((await r2.json()) as { documentId: string }).documentId).toBe(d1.documentId)
    expect((await up('x.html', new TextEncoder().encode('<script>alert(1)</script>'))).status).toBe(422)
    const dl = await app.request(`/api/documents/${d1.documentId}/file`, { headers: { cookie } })
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(new TextDecoder().decode(new Uint8Array(await dl.arrayBuffer()))).toContain('plumber')
    const other = await signIn('intruder@x.com')
    await app.request('/api/workspaces', json(other, { companyName: 'Other' }))
    expect((await app.request(`/api/documents/${d1.documentId}/file`, { headers: { cookie: other } })).status).toBe(404)
  })
})

describe('sign-in email limits', () => {
  it('limits magic links per address even without a trusted IP header', async () => {
    const send = () => app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-forwarded-for': `10.0.0.${Math.floor(Math.random() * 200)}` }, body: JSON.stringify({ email: 'victim@example.com', callbackURL: '/' }) })
    const codes: number[] = []
    for (let i = 0; i < 7; i++) codes.push((await send()).status)
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true)
    expect(codes.slice(5)).toEqual([429, 429])
    expect(outbox).toHaveLength(5)
  })

  it('limits magic links per client IP, at AGFN_SIGNIN_IP_LIMIT when set', async () => {
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), AGFN_SIGNIN_IP_LIMIT: '500' }).signInIpLimit).toBe(500)
    expect(loadConfig({ AUTH_SECRET: 'x'.repeat(40), AGFN_SIGNIN_IP_LIMIT: '0' }).signInIpLimit).toBeUndefined()
    const limited = createApp({ ...booted.services, config: { ...booted.services.config, clientIpHeader: 'fly-client-ip', signInIpLimit: 3 } })
    const send = (n: number) => limited.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'fly-client-ip': '203.0.113.7' }, body: JSON.stringify({ email: `person${n}@example.com`, callbackURL: '/' }) })
    const codes: number[] = []
    const res: Response[] = []
    for (let i = 0; i < 4; i++) res.push(await send(i))
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 429])
    expect(((await res[3]!.json()) as { message: string }).message).toMatch(/^Too many sign-ins from this network\. Try again in/)
  })

  it('lets 20 people behind one shared IP sign in within a minute (Better Auth allowed 5), then says so plainly', async () => {
    // Better Auth only counts per IP when it knows the client IP, so boot with the proxy header like hosted does.
    // Our own per-IP limit is raised here so Better Auth's per-minute limit is the one reached.
    await booted.shutdown()
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false, clientIpHeader: 'fly-client-ip', signInIpLimit: 100 }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeBank, fakeOauth], fileStore: new MemoryFileStore() })
    const shared = createApp(booted.services)
    const send = (n: number) => shared.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'fly-client-ip': '198.51.100.9' }, body: JSON.stringify({ email: `hn${n}@example.com`, callbackURL: '/' }) })
    const codes: number[] = []
    for (let i = 0; i < 20; i++) codes.push((await send(i)).status)
    expect(codes.every((c) => c === 200)).toBe(true)
    expect(outbox).toHaveLength(20)
    const over = await send(20)
    expect(over.status).toBe(429)
    expect(((await over.json()) as { message: string }).message).toMatch(/^Too many sign-ins from this network\. Try again in/)
    expect(outbox).toHaveLength(20)
  })
})

describe('OpenAI apps domain check', () => {
  it('is a 404 until the token is set, then serves it as plain text, uncached', async () => {
    expect((await app.request('/.well-known/openai-apps-challenge')).status).toBe(404)
    const cfg = loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent', AGFN_OPENAI_APPS_CHALLENGE: '  tok-abc123\n' })
    expect(cfg.openaiAppsChallenge).toBe('tok-abc123')
    const withToken = createApp({ ...booted.services, config: { ...booted.services.config, openaiAppsChallenge: cfg.openaiAppsChallenge } })
    const res = await withToken.request('/.well-known/openai-apps-challenge')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe('tok-abc123')
  })
})

describe('Client ID Metadata Documents (AGFN_OAUTH_CIMD)', () => {
  it('are off by default and advertised once turned on; registration stays available either way', async () => {
    const meta = async (a: { request: (p: string) => Response | Promise<Response> }) => (await (await a.request('/.well-known/oauth-authorization-server')).json()) as Record<string, unknown>
    const off = await meta(app)
    expect(off.client_id_metadata_document_supported).toBeUndefined()
    expect(off.registration_endpoint).toBeTruthy()
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }
    expect(loadConfig(env).oauthCimd).toBeUndefined()
    const config = { ...loadConfig({ ...env, AGFN_OAUTH_CIMD: '1' }), runWorker: false }
    expect(config.oauthCimd).toBe(true)
    const on = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined } })
    try {
      const m = await meta(createApp(on.services))
      expect(m.client_id_metadata_document_supported).toBe(true)
      expect(m.registration_endpoint).toBeTruthy()
    } finally {
      await on.shutdown()
    }
  })
})

describe('MCP prompt packs (AGFN_MCP_PROMPTS)', () => {
  it('are off unless turned on', () => {
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }
    expect(loadConfig(env).mcpPrompts).toBeUndefined()
    expect(loadConfig({ ...env, AGFN_MCP_PROMPTS: '1' }).mcpPrompts).toBe(true)
    expect(booted.services.mcp?.service.offersPromptPacks ?? false).toBe(false)
  })
})

describe('Glama ownership check', () => {
  it('is a 404 until a claim token is set, then serves the claim JSON, uncached', async () => {
    expect((await app.request('/.well-known/glama.json')).status).toBe(404)
    const one = 'glama_claim_' + 'a'.repeat(32)
    const two = 'glama_claim_' + 'B-_9'.repeat(8)
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }
    expect(loadConfig({ ...env, AGFN_GLAMA_CLAIM: 'not-a-token' }).glamaClaim).toBeUndefined()
    expect(loadConfig({ ...env, AGFN_GLAMA_CLAIM: ` ${one} , junk,${two}` }).glamaClaim).toEqual([one, two])
    const serve = (glamaClaim: string[]) => createApp({ ...booted.services, config: { ...booted.services.config, glamaClaim } }).request('/.well-known/glama.json')
    const res = await serve([one])
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ $schema: 'https://glama.ai/mcp/schemas/connector.json', claim: one })
    expect(await (await serve([one, two])).json()).toMatchObject({ claim: [one, two] })
  })
})

describe('who may attach a connection to a company', () => {
  it('owners and admins (manage) connect to any company but never to someone else’s Personal space; others need add', async () => {
    const owner = await signIn('founder@example.com')
    await app.request('/api/workspaces', json(owner, { companyName: 'AGFN' }))
    const db = booted.services.db
    const ws = (await db.selectFrom('workspaces').select('id').executeTakeFirstOrThrow()).id
    const company = (await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'company').executeTakeFirstOrThrow()).id
    const ownersPersonal = (await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).where('kind', '=', 'personal').executeTakeFirstOrThrow()).id
    const member = async (email: string, role: 'admin' | 'finance') => {
      const cookie = await signIn(email)
      const p = await db.selectFrom('people').select('id').where('email', '=', email).executeTakeFirstOrThrow()
      await db.insertInto('memberships').values({ id: `m-${p.id}`, workspace_id: ws, person_id: p.id, role, grid_json: null, expires_at: null, invited_by: null, created_at: new Date().toISOString(), revoked_at: null }).execute()
      return cookie
    }
    const admin = await member('admin@example.com', 'admin')
    const start = (cookie: string, entityId: string) => app.request('/api/connectors/fakebank/start', json(cookie, { entityId }))

    const ok = await start(admin, company)
    expect(ok.status).toBe(200)
    const { state } = (await ok.json()) as { state: string }
    expect((await app.request('/api/connectors/fakebank/finish', json(admin, { state, apiKey: 'good' }))).status).toBe(200)
    expect((await start(admin, ownersPersonal)).status).toBe(403)
    const finance = await member('finance@example.com', 'finance')
    expect((await start(finance, company)).status).toBe(403)
  })
})
