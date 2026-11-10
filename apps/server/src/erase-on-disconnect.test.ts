// Providers whose terms require their data deleted on disconnect (ERASE_ON_DISCONNECT: Wefunder): disconnecting
// deletes what the connection brought (ledger records and everything posted from them, raw payloads), not only
// retires it. A connection from any other provider keeps the choice it always had.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, NormalizedEvent } from '@agfn/contracts'
import type { ConnectorDeps } from '@agfn/connector-sdk'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { withBypass } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ERASE_ON_DISCONNECT } from './retire.ts'
import { ledgerFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

// Wefunder-shaped (investment events), plus an account with one row so the account rule is exercised: Wefunder itself
// sends no accounts.
const fakeProvider = (key: string) => (deps: ConnectorDeps): Connector => ({
  describe: () => ({ key, name: key, group: 'investments', provides: ['investments'], freshness: 'daily', auth: 'oauth' }) as never,
  connect: async () => ({ secret: {}, config: {} }),
  health: async () => ({ status: 'ok' }),
  sync: async (conn: ConnectionRef) => {
    const ev = (externalId: string, kind: 'invest' | 'mark', date: string, minor: number) => ({ type: 'investment.event', externalId, connectionId: conn.id, kind, positionId: 'tide', issuer: 'Tidewell Health', securityType: 'safe', date, amount: { minor, currency: 'USD' } })
    const events = []
    const acct = { type: 'account.upsert', externalId: 'wf-cash', connectionId: conn.id, name: 'Wefunder cash', accountType: 'depository', currency: 'USD' }
    const row = { type: 'txn.upsert', externalId: 'wf-t1', connectionId: conn.id, accountExternalId: 'wf-cash', date: '2026-03-01', amount: { minor: 5_000, currency: 'USD' }, description: 'Refund', status: 'posted' }
    for (const e of [acct, row, ev('inv-1', 'invest', '2026-03-02', 250_000), ev('mark-1', 'mark', '2026-09-30', 400_000)]) events.push({ ...e, rawRef: await deps.raw.put(conn.id, 'position', e.externalId, e) })
    return { events: events as NormalizedEvent[], cursor: null, hasMore: false }
  },
})

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, connectors: [fakeProvider('wefunder') as never, fakeProvider('freshbooks') as never, fakeProvider('bigcommerce') as never], fileStore: new MemoryFileStore(), ledger: (h) => ledgerFor(h.db) })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const post = (cookie: string, body: unknown = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify(body) })

async function setup(key = 'wefunder'): Promise<{ cookie: string; ws: string; personal: string; id: string }> {
  const cookie = await signIn('investor@example.test')
  await app.request('/api/workspaces', post(cookie, { companyName: 'Acme' }))
  const db = booted.services.db
  const { ws, personal } = await withBypass('t', async () => {
    const p = await db.selectFrom('people').select('id').where('email', '=', 'investor@example.test').executeTakeFirstOrThrow()
    const m = await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', p.id).executeTakeFirstOrThrow()
    const e = await db.selectFrom('entities').select('id').where('workspace_id', '=', m.workspace_id).where('kind', '=', 'personal').executeTakeFirstOrThrow()
    return { ws: m.workspace_id, personal: e.id }
  })
  const id = 'conn_wf'
  await withBypass('t', () => db.insertInto('connections').values({ id, workspace_id: ws, connector_key: key, entity_id: personal, display_name: 'Wefunder', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute())
  await withBypass('t', () => booted.services.sync.sync(id))
  return { cookie, ws, personal, id }
}
const anyDb = () => booted.services.db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
const accountOf = (id: string) => withBypass('t', () => anyDb().selectFrom('accounts').select(['id', 'closed_at']).where('connection_id', '=', id).execute())

describe('erase on disconnect', () => {
  it('FreshBooks is erased like QuickBooks: records, entries and raw payloads all go', async () => {
    expect(ERASE_ON_DISCONNECT.has('quickbooks')).toBe(true)
    expect(ERASE_ON_DISCONNECT.has('freshbooks')).toBe(true)
    const { cookie, ws, personal, id } = await setup('freshbooks')
    const rows = (t: string) => withBypass('t', () => anyDb().selectFrom(t).select('id').where('connection_id', '=', id).execute())
    expect((await rows('ledger_records')).length).toBe(4)
    const res = await app.request(`/api/connections/${id}/disconnect`, post(cookie, {}))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect(await rows('ledger_records')).toEqual([])
    expect(await rows('raw_records')).toEqual([])
    expect(await withBypass('t', () => anyDb().selectFrom('journal_entries').select('id').where('workspace_id', '=', ws).where('entity_id', '=', personal).execute())).toEqual([])
  })

  it('Etsy is erased on disconnect too (API Terms: service provider, kept no longer than needed, stop on termination)', () => {
    expect(ERASE_ON_DISCONNECT.has('etsy')).toBe(true)
  })

  it('Amazon is erased on disconnect too (Data Protection Policy s.1.7)', () => {
    expect(ERASE_ON_DISCONNECT.has('amazon')).toBe(true)
  })

  it('BigCommerce is erased on disconnect (API Terms s.2.1): records, entries and raw payloads all go', async () => {
    expect(ERASE_ON_DISCONNECT.has('bigcommerce')).toBe(true)
    const { cookie, ws, personal, id } = await setup('bigcommerce')
    const rows = (t: string) => withBypass('t', () => anyDb().selectFrom(t).select('id').where('connection_id', '=', id).execute())
    expect((await rows('ledger_records')).length).toBe(4)
    expect((await rows('raw_records')).length).toBe(4)
    const res = await app.request(`/api/connections/${id}/disconnect`, post(cookie, {}))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect(await rows('ledger_records')).toEqual([])
    expect(await rows('raw_records')).toEqual([])
    expect(await withBypass('t', () => anyDb().selectFrom('journal_entries').select('id').where('workspace_id', '=', ws).where('entity_id', '=', personal).execute())).toEqual([])
  })

  it('deletes a Wefunder connection\'s records, entries, raw payloads and (nothing else pointing at it) its account', async () => {
    expect(ERASE_ON_DISCONNECT.has('wefunder')).toBe(true)
    const { cookie, ws, personal, id } = await setup()
    const rows = (t: string) => withBypass('t', () => anyDb().selectFrom(t).select('id').where('connection_id', '=', id).execute())
    expect((await rows('ledger_records')).length).toBe(4)
    expect((await rows('raw_records')).length).toBe(4)
    const [acct] = await accountOf(id)
    expect(acct).toBeTruthy()

    const res = await app.request(`/api/connections/${id}/disconnect`, post(cookie, {}))
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect(await rows('ledger_records')).toEqual([])
    expect(await rows('raw_records')).toEqual([])
    const entries = await withBypass('t', () => anyDb().selectFrom('journal_entries').select('id').where('workspace_id', '=', ws).where('entity_id', '=', personal).execute())
    expect(entries).toEqual([])
    // The account and its own ledger account are gone.
    expect(await accountOf(id)).toEqual([])
    expect(await withBypass('t', () => anyDb().selectFrom('ledger_accounts').select('id').where('role', 'like', `%:${acct!.id as string}`).execute())).toEqual([])
  })

  it('keeps the account, closed, when another source still points at it (an account marked as its copy)', async () => {
    const { cookie, ws, personal, id } = await setup()
    const [acct] = await accountOf(id)
    // A statement upload of the same bank account, marked as a copy of this one.
    await withBypass('t', async () => {
      await anyDb().insertInto('connections').values({ id: 'conn_up', workspace_id: ws, connector_key: 'files', entity_id: personal, display_name: 'Statements', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: new Date().toISOString() }).execute()
      await anyDb().insertInto('accounts').values({ id: 'acct_copy', workspace_id: ws, entity_id: personal, connection_id: 'conn_up', external_id: 'stmt-1', name: 'Wefunder cash (statement)', account_type: 'depository', currency: 'USD', mask: null, institution: null, include_in_cash: 1, duplicate_of: acct!.id, created_at: new Date().toISOString(), closed_at: null, business_hint: null }).execute()
    })
    const res = await app.request(`/api/connections/${id}/disconnect`, post(cookie, {}))
    expect(res.status, await res.clone().text()).toBe(200)
    const kept = await accountOf(id)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.closed_at).not.toBeNull()
    expect(await withBypass('t', () => anyDb().selectFrom('ledger_records').select('id').where('connection_id', '=', id).execute())).toEqual([])
  })
})
