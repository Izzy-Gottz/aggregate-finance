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

// FreshBooks-shaped: a redirect to FreshBooks' consent screen.
const fakeFreshbooks = (): Connector => ({
  describe: () => ({ key: 'freshbooks', name: 'FreshBooks', group: 'accounting', provides: ['invoices'], freshness: 'hours', auth: 'oauth' }),
  begin: async () => {
    begins++
    return { kind: 'oauth' as const, url: 'https://auth.freshbooks.com/oauth/authorize?x=1' }
  },
  connect: async () => ({ secret: {}, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  begins = 0
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeFreshbooks as never], fileStore: new MemoryFileStore() })
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
async function addFreshbooks(ws: string, status: 'active' | 'needs_reauth' | 'disconnected' = 'active'): Promise<string> {
  const id = newId()
  await booted.services.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'freshbooks', entity_id: null, display_name: 'FreshBooks', status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
  return id
}

describe('freshbooks connection cap', () => {
  const base = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }
  it('reads the setting; hosted defaults to 450; self-hosted has no cap', () => {
    expect(loadConfig({ ...base, AGFN_FRESHBOOKS_MAX_CONNECTIONS: '40' }).freshbooksMaxConnections).toBe(40)
    expect(loadConfig(base).freshbooksMaxConnections).toBeUndefined()
    expect(loadConfig({ ...base, AGFN_HOSTED: '1', AGFN_FRESHBOOKS_MAX_CONNECTIONS: 'lots' }).freshbooksMaxConnections).toBe(450)
  })

  it('counts every workspace, says so plainly before FreshBooks, and lets a workspace that has it reconnect', async () => {
    booted.services.config.freshbooksMaxConnections = 2
    const a = await workspace('a@example.com')
    const b = await workspace('b@example.com')
    await addFreshbooks(a.ws)
    await addFreshbooks(b.ws, 'needs_reauth')
    const c = await workspace('c@example.com')
    await addFreshbooks(c.ws, 'disconnected')
    const before = begins
    const full = await app.request('/api/connectors/freshbooks/start', post(c.cookie))
    expect(full.status).toBe(409)
    const body = (await full.json()) as { error: string; limit: number; message: string }
    expect(body).toMatchObject({ error: 'freshbooks_limit', limit: 2 })
    expect(body.message).toMatch(/New FreshBooks connections are full right now/)
    expect(begins).toBe(before) // never sent to FreshBooks

    expect((await app.request('/api/connectors/freshbooks/start', post(b.cookie))).status).toBe(200)
  })

  it('no cap set: nothing is refused', async () => {
    const a = await workspace('a@example.com')
    expect((await app.request('/api/connectors/freshbooks/start', post(a.cookie))).status).toBe(200)
  })
})
