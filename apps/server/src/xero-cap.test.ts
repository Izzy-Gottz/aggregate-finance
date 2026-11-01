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
/** The organisations the next sign-in ticks, in Xero's order; and what was removed at Xero ([tenantId, lastOfGrant]). */
let ticked: string[]
let removed: Array<[string, boolean]>
/** When set, each connect waits here until this many sign-ins have reached Xero (so finishes really overlap). */
let barrier: { n: number; arrived: number; open: () => void; ready: Promise<void> } | null = null

const org = (t: string) => ({ secret: { tokens: 'shared' }, config: { tenantId: t, tenantName: `Org ${t}`, displayName: `Xero · Org ${t}`, ...(ticked.length > 1 ? { sharedSecretKey: 'xero:grant' } : {}) } })
// Xero-shaped: an OAuth redirect to Xero's consent screen; one sign-in can tick several organisations.
const fakeXero = (): Connector => ({
  describe: () => ({ key: 'xero', name: 'Xero', group: 'accounting', provides: ['invoices'], freshness: 'hours', auth: 'oauth' }),
  begin: async () => {
    begins++
    return { kind: 'oauth' as const, url: 'https://login.xero.com/identity/connect/authorize?x=1' }
  },
  // A code like "t3.t4" ticks those (concurrent sign-ins); otherwise `ticked`.
  connect: async (input) => {
    if (barrier && ++barrier.arrived >= barrier.n) barrier.open()
    await barrier?.ready
    const [first, ...rest] = (String(input.code).includes('t') ? String(input.code).split('.') : ticked).map(org)
    return { ...first!, ...(rest.length ? { additional: rest } : {}) }
  },
  disconnect: async (conn) => void removed.push([String(conn.config.tenantId), conn.config.lastOfGrant === true]),
  health: async () => ({ status: 'ok' }),
  sync: async () => ({ events: [], cursor: null, hasMore: false }),
})

beforeEach(async () => {
  outbox = []
  begins = 0
  ticked = []
  removed = []
  barrier = null
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeXero as never], fileStore: new MemoryFileStore() })
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
async function addXeroOrg(ws: string, tenantId: string, status: 'active' | 'disconnected' = 'active'): Promise<string> {
  const id = newId()
  await booted.services.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'xero', entity_id: null, display_name: `Xero · ${tenantId}`, status, secret_enc: null, config_json: JSON.stringify({ tenantId }), cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
  return id
}

describe('xero connection cap (AGFN_XERO_MAX_CONNECTIONS)', () => {
  it('reads the setting; unset or junk means no check', () => {
    const base = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE }
    expect(loadConfig({ ...base, AGFN_XERO_MAX_CONNECTIONS: '5' }).xeroMaxConnections).toBe(5)
    expect(loadConfig(base).xeroMaxConnections).toBeUndefined()
    expect(loadConfig({ ...base, AGFN_XERO_MAX_CONNECTIONS: '0' }).xeroMaxConnections).toBeUndefined()
    expect(loadConfig({ ...base, AGFN_XERO_MAX_CONNECTIONS: 'lots' }).xeroMaxConnections).toBeUndefined()
  })

  it('counts organisations across workspaces and says so plainly before sending anyone to Xero', async () => {
    booted.services.config.xeroMaxConnections = 2
    const a = await workspace('a@example.com')
    const b = await workspace('b@example.com')
    await addXeroOrg(a.ws, 't1')
    await addXeroOrg(a.ws, 't1') // the same organisation twice counts once
    expect((await app.request('/api/connectors/xero/start', post(b.cookie))).status).toBe(200)
    await addXeroOrg(b.ws, 't2')
    await addXeroOrg(b.ws, 't3', 'disconnected') // disconnected ones don't count

    const c = await workspace('c@example.com')
    const before = begins
    const full = await app.request('/api/connectors/xero/start', post(c.cookie))
    expect(full.status).toBe(409)
    const body = (await full.json()) as { error: string; limit: number; message: string }
    expect(body.error).toBe('xero_limit')
    expect(body.limit).toBe(2)
    expect(body.message).toMatch(/New Xero connections are full right now/)
    expect(body.message).toMatch(/support@aggregate\.finance/)
    expect(begins).toBe(before) // never sent to Xero

    // A workspace that already has Xero may reconnect (re-authorising a known organisation adds nothing at Xero).
    expect((await app.request('/api/connectors/xero/start', post(a.cookie))).status).toBe(200)

    // Other connectors are unaffected, and with no setting there's no check.
    booted.services.config.xeroMaxConnections = undefined
    expect((await app.request('/api/connectors/xero/start', post(c.cookie))).status).toBe(200)
  })

  async function callback(cookie: string): Promise<string> {
    const start = (await (await app.request('/api/connectors/xero/start', post(cookie))).json()) as { state?: string; url: string }
    const state = start.state ?? new URL(start.url).searchParams.get('state')!
    const res = await app.request(`/api/connectors/xero/callback?code=c1&state=${encodeURIComponent(state)}`, { headers: { cookie, origin: BASE } })
    return decodeURIComponent(res.headers.get('location') ?? '')
  }
  const tenantsOf = async (ws: string) =>
    (await booted.services.db.selectFrom('connections').select('config_json').where('workspace_id', '=', ws).where('connector_key', '=', 'xero').execute()).map((r) => JSON.parse(r.config_json).tenantId as string).sort()

  it('at the callback, keeps what fits in Xero\'s order, removes the rest at Xero, and says so', async () => {
    booted.services.config.xeroMaxConnections = 3
    const a = await workspace('a@example.com')
    await addXeroOrg(a.ws, 't1')
    const b = await workspace('b@example.com')
    // Room for 2: t1 is already connected (costs nothing), t2 and t3 fit, t4 and t5 don't.
    ticked = ['t2', 't1', 't3', 't4', 't5']
    const to = await callback(b.cookie)
    expect(await tenantsOf(b.ws)).toEqual(['t1', 't2', 't3'])
    // Removed at Xero; the shared token stays (organisations from the same sign-in were kept).
    expect(removed).toEqual([['t4', false], ['t5', false]])
    expect(to).toMatch(/d=connection:/)
    expect(to).toContain('Xero is full for now, so we kept 3 of your 5 companies (Org t2, Org t1, Org t3)')
    expect(to).toContain('Org t4, Org t5')
  })

  it('a workspace that already has Xero can\'t pass the cap with a new organisation; nothing kept means the token is revoked', async () => {
    booted.services.config.xeroMaxConnections = 1
    const a = await workspace('a@example.com')
    await addXeroOrg(a.ws, 't1')
    ticked = ['t9']
    const to = await callback(a.cookie) // past the start check (it already has Xero), stopped here
    expect(await tenantsOf(a.ws)).toEqual(['t1'])
    expect(removed).toEqual([['t9', true]])
    expect(to).toMatch(/connect_error=New Xero connections are full right now/)
  })

  it('with room, every organisation ticked is kept and nothing is removed', async () => {
    booted.services.config.xeroMaxConnections = 5
    const a = await workspace('a@example.com')
    ticked = ['t1', 't2']
    const to = await callback(a.cookie)
    expect(await tenantsOf(a.ws)).toEqual(['t1', 't2'])
    expect(removed).toEqual([])
    expect(to).not.toContain('connect_error')
  })

  it('two sign-ins finishing at once share the room instead of both filling it', async () => {
    booted.services.config.xeroMaxConnections = 2
    const a = await workspace('a@example.com')
    const b = await workspace('b@example.com')
    ticked = ['x', 'y'] // two per sign-in, so each org() carries the shared-token key
    const startA = (await (await app.request('/api/connectors/xero/start', post(a.cookie))).json()) as { state?: string; url: string }
    const startB = (await (await app.request('/api/connectors/xero/start', post(b.cookie))).json()) as { state?: string; url: string }
    const cb = (cookie: string, s: { state?: string; url: string }, code: string) =>
      app.request(`/api/connectors/xero/callback?code=${code}&state=${encodeURIComponent(s.state ?? new URL(s.url).searchParams.get('state')!)}`, { headers: { cookie, origin: BASE } })
    let open!: () => void
    barrier = { n: 2, arrived: 0, open: () => open(), ready: new Promise<void>((r) => (open = r)) }
    await Promise.all([cb(a.cookie, startA, 't1.t2'), cb(b.cookie, startB, 't3.t4')])
    // Only two fit across both: whichever finished first kept its two; the other's were removed at Xero.
    const kept = [...(await tenantsOf(a.ws)), ...(await tenantsOf(b.ws))].sort()
    expect(kept).toHaveLength(2)
    expect(removed.map(([t]) => t).sort()).toEqual(['t1', 't2', 't3', 't4'].filter((t) => !kept.includes(t)))
  })
})

// Two machines on one Postgres (live's blue-green minute): set AGFN_TEST_PG_URL to a throwaway server to run it.
const pgUrl = process.env.AGFN_TEST_PG_URL
describe.runIf(!!pgUrl)('xero cap across two machines (Postgres advisory lock)', () => {
  it('two finishes on two servers share the room', async () => {
    const pg = await import('pg')
    const name = `xero_cap_${Date.now()}`
    const admin = new pg.default.Client({ connectionString: pgUrl })
    await admin.connect()
    await admin.query(`create database ${name}`)
    const url = pgUrl!.replace(/\/[^/]*$/, `/${name}`)
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const machine = async () => {
      const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: url, BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false, xeroMaxConnections: 2 }
      const b = await boot({ config, keys, mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeXero as never], fileStore: new MemoryFileStore() })
      return { b, app: createApp(b.services) }
    }
    const first = { booted, app }
    const m1 = await machine()
    const m2 = await machine()
    try {
      const on = (m: typeof m1) => ((booted = m.b), (app = m.app))
      on(m1)
      const a = await workspace('a@example.test')
      on(m2)
      const b = await workspace('b@example.test')
      ticked = ['x', 'y']
      const startOn = async (m: typeof m1, cookie: string) => (await (await m.app.request('/api/connectors/xero/start', post(cookie))).json()) as { state?: string; url: string }
      const sa = await startOn(m1, a.cookie)
      const sb = await startOn(m2, b.cookie)
      const cb = (m: typeof m1, cookie: string, st: { state?: string; url: string }, code: string) =>
        m.app.request(`/api/connectors/xero/callback?code=${code}&state=${encodeURIComponent(st.state ?? new URL(st.url).searchParams.get('state')!)}`, { headers: { cookie, origin: BASE } })
      let open!: () => void
      barrier = { n: 2, arrived: 0, open: () => open(), ready: new Promise<void>((r) => (open = r)) }
      await Promise.all([cb(m1, a.cookie, sa, 't1.t2'), cb(m2, b.cookie, sb, 't3.t4')])
      const rows = await m1.b.services.db.selectFrom('connections').select('config_json').where('connector_key', '=', 'xero').execute()
      expect(rows).toHaveLength(2)
      expect(removed).toHaveLength(2)
    } finally {
      await m1.b.shutdown()
      await m2.b.shutdown()
      booted = first.booted
      app = first.app
      await admin.query(`drop database ${name} with (force)`)
      await admin.end()
    }
  }, 120_000)
})

