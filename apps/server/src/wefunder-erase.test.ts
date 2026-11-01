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
let connected: Record<string, unknown>[] = []

// Wefunder-shaped: an OAuth redirect.
const fakeWefunder = (): Connector => ({
  describe: () => ({ key: 'wefunder', name: 'Wefunder', group: 'equity', provides: ['equity'], freshness: 'hours', auth: 'oauth' }),
  begin: async () => {
    begins++
    return { kind: 'oauth' as const, url: 'https://oauth.wefunder-sandbox.com/oauth/authorize?x=1' }
  },
  connect: async (input: Record<string, unknown>) => (connected.push(input), { secret: {}, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  begins = 0
  connected = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeWefunder as never], fileStore: new MemoryFileStore() })
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
async function addWefunder(ws: string, status: 'active' | 'needs_reauth' | 'disconnected' = 'active'): Promise<string> {
  const id = newId()
  await booted.services.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'wefunder', entity_id: null, display_name: 'Wefunder', status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
  return id
}

describe('wefunder: data is deleted on disconnect (Wefunder\'s terms)', () => {
  it('even when the person chose to keep history, and the response says so', async () => {
    const a = await workspace('a@example.com')
    const id = await addWefunder(a.ws)
    const db = booted.services.db
    await db.insertInto('raw_records').values({ id: newId(), workspace_id: a.ws, connection_id: id, kind: 'wefunder.position', external_id: 'ofr_1', payload_json: '{}', sha256: 'h', received_at: new Date().toISOString() }).execute()
    const res = await app.request(`/api/connections/${id}/disconnect`, post(a.cookie, { deleteData: false }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect(await db.selectFrom('raw_records').select('id').where('connection_id', '=', id).execute()).toEqual([])
    expect((await db.selectFrom('connections').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('disconnected')
  })
})

describe('wefunder: the callback gives the connector its connect state (PKCE verifier)', () => {
  it('as connectState, alongside the code', async () => {
    const a = await workspace('a@example.com')
    const start = (await (await app.request('/api/connectors/wefunder/start', post(a.cookie))).json()) as { state?: string; url: string }
    const state = start.state ?? new URL(start.url).searchParams.get('state')!
    // The callback reads the person's session; recheck/passkey rules may answer first, but connect must see the state.
    await app.request(`/api/connectors/wefunder/callback?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie: a.cookie, origin: BASE } })
    expect(connected.at(-1)).toMatchObject({ code: 'c1', connectState: state })
    expect(connected.at(-1)).not.toHaveProperty('state')
  })
})

describe('wefunder: revoked on wefunder.com → removed here with its data (Wefunder\'s terms)', () => {
  const revoked = Object.assign(new Error('revoked'), { kind: 'auth', code: 'revoked' })
  const failed = async (ws: string, id: string, err: unknown) => {
    for (const hook of booted.services.syncDeps.afterFailure ?? []) await hook(ws, id, err)
  }

  it('a sync that fails as revoked disconnects the connection and deletes its data, with a note in the log', async () => {
    const a = await workspace('a@example.com')
    const id = await addWefunder(a.ws)
    const db = booted.services.db
    await db.insertInto('raw_records').values({ id: newId(), workspace_id: a.ws, connection_id: id, kind: 'wefunder.position', external_id: 'ofr_1', payload_json: '{}', sha256: 'h', received_at: new Date().toISOString() }).execute()
    await failed(a.ws, id, revoked)
    const conn = await db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(conn).toMatchObject({ status: 'disconnected', secret_enc: null })
    expect(await db.selectFrom('raw_records').select('id').where('connection_id', '=', id).execute()).toEqual([])
    const notes = await (db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>).selectFrom('activity_log').select('detail').where('target_id', '=', id).execute()
    expect(notes.map((n) => n.detail)).toContainEqual(expect.stringMatching(/revoked at the provider/))
  })

  it('any other failure (a lost sign-in, an outage) keeps the connection and its data', async () => {
    const a = await workspace('a@example.com')
    const id = await addWefunder(a.ws)
    await failed(a.ws, id, Object.assign(new Error('expired'), { kind: 'auth', code: 'invalid_grant' }))
    await failed(a.ws, id, Object.assign(new Error('down'), { kind: 'transient' }))
    expect((await booted.services.db.selectFrom('connections').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status).toBe('active')
  })
})

describe('quickbooks: Intuit\'s terms (8.2(f)) want its data deleted on disconnect, so it erases like Wefunder', () => {
  it('is on the erase list (a disconnect here deletes), and a revoke in QuickBooks removes the connection and its data', async () => {
    const { ERASE_ON_DISCONNECT } = await import('./retire.ts')
    expect(ERASE_ON_DISCONNECT.has('quickbooks')).toBe(true)
    const a = await workspace('a@example.com')
    const db = booted.services.db
    const id = newId()
    await db.insertInto('connections').values({ id, workspace_id: a.ws, connector_key: 'quickbooks', entity_id: null, display_name: 'QuickBooks · Acme', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
    await db.insertInto('raw_records').values({ id: newId(), workspace_id: a.ws, connection_id: id, kind: 'quickbooks.invoice', external_id: '1', payload_json: '{}', sha256: 'h', received_at: new Date().toISOString() }).execute()
    for (const hook of booted.services.syncDeps.afterFailure ?? []) await hook(a.ws, id, Object.assign(new Error('revoked'), { kind: 'auth', code: 'revoked' }))
    expect(await db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', id).executeTakeFirstOrThrow()).toMatchObject({ status: 'disconnected', secret_enc: null })
    expect(await db.selectFrom('raw_records').select('id').where('connection_id', '=', id).execute()).toEqual([])
  })
})

