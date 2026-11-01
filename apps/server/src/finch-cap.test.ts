import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector } from '@agfn/contracts'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { newId } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]
let begins: number
let connects = 0

// Finch-shaped: a redirect to Finch Connect.
const fakeFinch = (): Connector => ({
  describe: () => ({ key: 'finch', name: 'Payroll via Finch', group: 'payroll', provides: ['payroll'], freshness: 'hours', auth: 'oauth' }),
  begin: async () => {
    begins++
    return { kind: 'oauth' as const, url: 'https://connect.tryfinch.com/authorize?x=1' }
  },
  connect: async () => {
    connects++
    return { secret: {}, config: {} }
  },
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  begins = 0
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeFinch as never], fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const db = booted.services.db
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

async function workspace(email: string): Promise<{ cookie: string; ws: string }> {
  const cookie = await signIn(email)
  const r = (await (await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))).json()) as { workspaceId?: string; id?: string }
  return { cookie, ws: (r.workspaceId ?? r.id)! }
}
async function addFinch(ws: string, status: 'active' | 'needs_reauth' | 'disconnected' = 'active'): Promise<string> {
  const id = newId()
  await booted.services.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'finch', entity_id: null, display_name: 'Gusto', status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
  return id
}

describe('finch connection caps', () => {
  const base = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }
  it('reads the settings; hosted defaults to 1 per workspace and 15 in all; self-hosted has no cap', () => {
    expect(loadConfig({ ...base, AGFN_FINCH_MAX_CONNECTIONS_PER_WORKSPACE: '3', AGFN_FINCH_MAX_CONNECTIONS: '40' })).toMatchObject({ finchMaxPerWorkspace: 3, finchMaxConnections: 40 })
    const self = loadConfig(base)
    expect(self.finchMaxPerWorkspace).toBeUndefined()
    expect(self.finchMaxConnections).toBeUndefined()
    const hosted = loadConfig({ ...base, AGFN_HOSTED: '1', AGFN_FINCH_MAX_CONNECTIONS: 'lots' })
    expect(hosted.finchMaxPerWorkspace).toBe(1)
    expect(hosted.finchMaxConnections).toBe(15)
  })

  it('one payroll connection per workspace, said plainly; reconnecting one that needs it is let through', async () => {
    booted.services.config.finchMaxPerWorkspace = 1
    const a = await workspace('a@example.com')
    expect((await app.request('/api/connectors/finch/start', post(a.cookie))).status).toBe(200)
    const id = await addFinch(a.ws)
    const before = begins
    const full = await app.request('/api/connectors/finch/start', post(a.cookie))
    expect(full.status).toBe(409)
    const body = (await full.json()) as { error: string; limit: number; message: string }
    expect(body).toMatchObject({ error: 'finch_limit', limit: 1 })
    expect(body.message).toMatch(/Payroll is already connected/)
    expect(begins).toBe(before) // never sent to Finch

    await booted.services.db.updateTable('connections').set({ status: 'needs_reauth' }).where('id', '=', id).execute()
    expect((await app.request('/api/connectors/finch/start', post(a.cookie))).status).toBe(200)
  })

  it('counts every workspace toward the overall limit; a workspace that already has Finch may still reconnect', async () => {
    booted.services.config.finchMaxConnections = 2
    const a = await workspace('a@example.com')
    const b = await workspace('b@example.com')
    await addFinch(a.ws)
    await addFinch(b.ws, 'needs_reauth')
    await addFinch(b.ws, 'disconnected')
    const c = await workspace('c@example.com')
    expect((await app.request('/api/connectors/finch/start', post(c.cookie))).status).toBe(200) // 1 counted of 2
    await addFinch(c.ws)

    const d = await workspace('d@example.com')
    const full = await app.request('/api/connectors/finch/start', post(d.cookie))
    expect(full.status).toBe(409)
    const body = (await full.json()) as { error: string; limit: number; message: string }
    expect(body).toMatchObject({ error: 'finch_limit', limit: 2 })
    expect(body.message).toMatch(/New payroll connections are full right now/)
    expect(body.message).toMatch(/support@aggregate\.finance/)

    expect((await app.request('/api/connectors/finch/start', post(b.cookie))).status).toBe(200) // reconnecting its own

    booted.services.config.finchMaxConnections = undefined
    expect((await app.request('/api/connectors/finch/start', post(d.cookie))).status).toBe(200)
  })

  it('the overall limit is checked again at the finish, before Finch is asked: two started under it, one fits', async () => {
    booted.services.config.finchMaxConnections = 1
    booted.services.config.finchMaxPerWorkspace = undefined
    const a = await workspace('a@example.com')
    const b = await workspace('b@example.com')
    const start = async (cookie: string) => (await (await app.request('/api/connectors/finch/start', post(cookie))).json()) as { state?: string; url: string }
    const sa = await start(a.cookie)
    const sb = await start(b.cookie) // both started while there was room
    const finish = (cookie: string, st: { state?: string; url: string }) =>
      app.request(`/api/connectors/finch/callback?code=c1&state=${encodeURIComponent(st.state ?? new URL(st.url).searchParams.get('state')!)}`, { headers: { cookie, origin: BASE } })
    connects = 0
    const [ra, rb] = await Promise.all([finish(a.cookie, sa), finish(b.cookie, sb)])
    const n = await booted.services.db.selectFrom('connections').select('id').where('connector_key', '=', 'finch').execute()
    expect(n).toHaveLength(1)
    expect(connects).toBe(1) // the second never reached Finch (nothing billed)
    const where = [ra, rb].map((r) => decodeURIComponent(r.headers.get('location') ?? ''))
    expect(where.filter((l) => l.includes('New payroll connections are full right now'))).toHaveLength(1)
  })
})

