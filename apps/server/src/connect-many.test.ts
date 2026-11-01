// One sign-in, several organisations (Xero's consent screen lets the person tick more than one): one connection each,
// named after its organisation, sharing the token (config.sharedSecretKey). The first gets the company the person
// started from; another goes to a company of the same name when there is one. One left unplaced can be moved later.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

const multi = (deps: ConnectorDeps): Connector => ({
  describe: () => ({ key: 'books', name: 'Books', group: 'accounting', provides: ['invoices'], freshness: 'updates every few hours', auth: 'api_key' }),
  connect: async () => ({
    secret: { tokens: 'shared' },
    config: { tenantId: 't1', tenantName: 'Demo Company', displayName: 'Books · Demo Company', sharedSecretKey: 'g1' },
    additional: [
      { secret: { tokens: 'shared' }, config: { tenantId: 't2', tenantName: 'Acme Ltd', displayName: 'Books · Acme Ltd', sharedSecretKey: 'g1' } },
      { secret: { tokens: 'shared' }, config: { tenantId: 't3', tenantName: 'Side Project', displayName: 'Books · Side Project', sharedSecretKey: 'g1' } },
    ],
  }),
  // Side Project has a bank account and an invoice of its own.
  sync: async (conn: ConnectionRef) => {
    if ((conn.config as { tenantId: string }).tenantId !== 't3') return { events: [], cursor: null, hasMore: false }
    const r = (id: string) => deps.raw.put(conn.id, 'x', id, {})
    const events = [
      { type: 'account.upsert', externalId: 'sp-bank', name: 'Side Project Checking', accountType: 'depository', currency: 'USD', rawRef: await r('a') },
      { type: 'invoice.upsert', externalId: 'inv-1', direction: 'receivable', number: 'SP-1', counterparty: 'Globex', issueDate: '2026-09-01', dueDate: '2026-10-01', total: { minor: 50_000, currency: 'USD' }, amountPaid: { minor: 0, currency: 'USD' }, status: 'open', rawRef: await r('i') },
    ].map((e) => ({ ...e, connectionId: conn.id })) as NormalizedEvent[]
    return { events, cursor: null, hasMore: false }
  },
  health: async () => ({ status: 'ok' }),
})

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [multi as never], ledger: (h) => ledgerFor(h.db), fileStore: new MemoryFileStore() })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

async function setup(email: string, connect = true, companyName: string | null = 'Demo Company'): Promise<{ cookie: string; ws: { workspaceId: string; companyId: string }; acme: { id?: string } }> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const cookie = (await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })).headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const db = booted.services.db
  const p = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', email).executeTakeFirstOrThrow()
  const anyDb = db as unknown as import('kysely').Kysely<Record<string, Record<string, unknown>>>
  await anyDb.insertInto('passkey').values({ id: `pk_${p.id}`, name: 'Mac', publicKey: 'x', userId: p.auth_user_id, credentialID: `cred_${p.id}`, counter: 0, deviceType: 'singleDevice', backedUp: 0, transports: 'internal', createdAt: new Date().toISOString() }).execute()
  await db.insertInto('reauth_events').values({ id: `re_${p.id}`, person_id: p.id, method: 'passkey', at: new Date().toISOString() }).execute()
  const ws = (await (await app.request('/api/workspaces', post(cookie, { companyName }))).json()) as { workspaceId: string; companyId: string }
  if (!connect) return { cookie, ws, acme: {} }
  const acme = (await (await app.request('/api/entities', post(cookie, { name: 'Acme Ltd', kind: 'company' }))).json()) as { id?: string }
  const start = (await (await app.request('/api/connectors/books/start', post(cookie, { entityId: ws.companyId }))).json()) as { state: string }
  const fin = await app.request('/api/connectors/books/finish', post(cookie, { state: start.state, apiKey: 'x' }))
  expect(fin.status).toBe(200)
  return { cookie, ws, acme }
}

describe('one sign-in, several organisations', () => {
  it('creates one connection per organisation, each named after it, in the right company', async () => {
    const { ws, acme } = await setup('multi@example.com')
    const rows = await booted.services.db.selectFrom('connections').select(['display_name', 'entity_id', 'config_json']).where('connector_key', '=', 'books').orderBy('display_name').execute()
    expect(rows.map((r) => [r.display_name, r.entity_id])).toEqual([
      ['Books · Acme Ltd', acme.id ?? null],
      ['Books · Demo Company', ws.companyId],
      ['Books · Side Project', null],
    ])
    expect(rows.every((r) => (JSON.parse(r.config_json) as { sharedSecretKey: string }).sharedSecretKey === 'g1')).toBe(true)
  })

  it('started without a company in a workspace with just one: every connection goes to it', async () => {
    // Signed up for personal use: the workspace's one entity is Personal (kind personal), which the picker doesn't list.
    const { cookie, ws } = await setup('only@example.com', false, null)
    const db = booted.services.db
    const only = await db.selectFrom('entities').select(['id', 'kind']).where('workspace_id', '=', ws.workspaceId).where('archived_at', 'is', null).execute()
    expect(only.map((e) => e.kind)).toEqual(['personal'])
    const start = (await (await app.request('/api/connectors/books/start', post(cookie, {}))).json()) as { state: string }
    expect((await app.request('/api/connectors/books/finish', post(cookie, { state: start.state, apiKey: 'x' }))).status).toBe(200)
    const rows = await db.selectFrom('connections').select('entity_id').where('workspace_id', '=', ws.workspaceId).where('connector_key', '=', 'books').execute()
    expect(rows.map((r) => r.entity_id)).toEqual([only[0]!.id, only[0]!.id, only[0]!.id])
  })

  it('an unplaced organisation moves to a company; its account and invoice follow without a provider call', async () => {
    const { cookie } = await setup('mover@example.com')
    const db = booted.services.db
    const anyDb = db as unknown as import('kysely').Kysely<{ ledger_records: { connection_id: string; event_type: string; entity_id: string | null; status: string } }>
    const side = await db.selectFrom('connections').select('id').where('display_name', '=', 'Books · Side Project').executeTakeFirstOrThrow()
    const held = () => anyDb.selectFrom('ledger_records').select(['entity_id', 'status']).where('connection_id', '=', side.id).where('event_type', '=', 'invoice.upsert').executeTakeFirstOrThrow()
    expect((await held()).status).toBe('unassigned')
    const sp = (await (await app.request('/api/entities', post(cookie, { name: 'Side Project LLC' }))).json()) as { id: string }

    expect((await app.request(`/api/connections/${side.id}/company`, post(cookie, { entityId: 'nope' }))).status).toBe(404)
    const moved = await app.request(`/api/connections/${side.id}/company`, post(cookie, { entityId: sp.id }))
    expect(await moved.json()).toEqual({ ok: true, moved: 1 })
    expect((await db.selectFrom('connections').select('entity_id').where('id', '=', side.id).executeTakeFirstOrThrow()).entity_id).toBe(sp.id)
    expect((await db.selectFrom('accounts').select('entity_id').where('connection_id', '=', side.id).executeTakeFirstOrThrow()).entity_id).toBe(sp.id)
    expect(await held()).toMatchObject({ entity_id: sp.id, status: 'posted' })

    // Someone else's workspace can't see it, let alone move it.
    const other = await setup('stranger@example.com', false)
    const mine = (await (await app.request('/api/entities', post(other.cookie, { name: 'Mine' }))).json()) as { id: string }
    expect((await app.request(`/api/connections/${side.id}/company`, post(other.cookie, { entityId: mine.id }))).status).toBe(404)
    expect((await app.request(`/api/connections/${side.id}/company`, post(other.cookie, { entityId: sp.id }))).status).toBe(404)
  })
})
