import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { MemoryFileStore } from '@agfn/files'
import { newId, nowIso, withBypass } from '@agfn/db'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { ledgerFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: string[]

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push(m.text) }, fileStore: new MemoryFileStore(), ledger: (h) => ledgerFor(h.db) })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.at(-1)!.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, ws: string, method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', origin: BASE, cookie, 'x-agfn-workspace': ws },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

async function setup() {
  const cookie = await signIn('owner@example.test')
  const ws = (await (await app.request('/api/workspaces', req(cookie, '', 'POST', { companyName: 'Acme' }))).json()) as { workspaceId: string; companyId: string; personalId?: string }
  const add = async (name: string) => ((await (await app.request('/api/entities', req(cookie, ws.workspaceId, 'POST', { name }))).json()) as { id: string }).id
  const detail = async (id: string) => (await (await app.request(`/api/entities/${id}`, req(cookie, ws.workspaceId, 'GET'))).json()) as { deletable?: boolean; deleteBlocked?: string | null }
  const del = (id: string) => app.request(`/api/entities/${id}`, req(cookie, ws.workspaceId, 'DELETE'))
  const listed = async () => ((await (await app.request('/api/workspace', req(cookie, ws.workspaceId, 'GET'))).json()) as { entities: Array<{ id: string; name: string }> }).entities.map((e) => e.name)
  return { cookie, ws, add, detail, del, listed }
}

describe('deleting an empty company', () => {
  it('an empty company is deletable, goes, and leaves the lists', async () => {
    const { add, detail, del, listed } = await setup()
    const id = await add('Test Co')
    expect((await detail(id)).deletable).toBe(true)
    const res = await del(id)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'Test Co' })
    expect(await listed()).not.toContain('Test Co')
    // Asked again: it's gone.
    expect((await del(id)).status).toBe(404)
  })

  it('one with a live connection is refused with the reason; once disconnected and erased it can go', async () => {
    const { ws, add, detail, del } = await setup()
    const id = await add('Has Stripe')
    const conn = newId()
    await withBypass('t', () =>
      booted.services.db.insertInto('connections').values({ id: conn, workspace_id: ws.workspaceId, connector_key: 'stripe', entity_id: id, display_name: 'Stripe', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute(),
    )
    expect((await detail(id)).deletable).toBe(false)
    const res = await del(id)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'live_connection', message: 'Has Stripe can’t be deleted: Disconnect Stripe first.', connections: [{ id: conn, name: 'Stripe' }] })
    expect((await detail(id)).deleteBlocked).toBe('Disconnect Stripe first.')
    await withBypass('t', () => booted.services.db.updateTable('connections').set({ status: 'disconnected' }).where('id', '=', conn).execute())
    expect((await del(id)).status).toBe(200)
  })

  it('one with an account (data kept after a disconnect) stays', async () => {
    const { ws, add, del } = await setup()
    const id = await add('Kept History')
    // Disconnected with its history kept: the connection no longer counts, its account does.
    const conn = newId()
    await withBypass('t', () =>
      booted.services.db.insertInto('connections').values({ id: conn, workspace_id: ws.workspaceId, connector_key: 'stripe', entity_id: id, display_name: 'Stripe', status: 'disconnected', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute(),
    )
    await withBypass('t', () =>
      booted.services.db.insertInto('accounts').values({ id: newId(), workspace_id: ws.workspaceId, entity_id: id, connection_id: conn, external_id: 'x', name: 'Checking', account_type: 'depository', currency: 'USD', mask: null, institution: null, business_hint: null, include_in_cash: 1, duplicate_of: null, created_at: nowIso(), closed_at: null }).execute(),
    )
    const res = await del(id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'has_data', message: 'Kept History can’t be deleted: Its books still count data from Stripe. Remove it with “Delete its data”, then delete the company.' })
  })

  it('one whose connection was removed with its data can go, though records and accounts remain', async () => {
    const { ws, add, detail, del } = await setup()
    const id = await add('Was Used')
    const conn = newId()
    const db = booted.services.db
    await withBypass('t', async () => {
      await db.insertInto('connections').values({ id: conn, workspace_id: ws.workspaceId, connector_key: 'stripe', entity_id: id, display_name: 'Stripe', status: 'disconnected', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
      // What "Delete its data" leaves: a closed account and an excluded record.
      await db.insertInto('accounts').values({ id: newId(), workspace_id: ws.workspaceId, entity_id: id, connection_id: conn, external_id: 'x', name: 'Checking', account_type: 'depository', currency: 'USD', mask: null, institution: null, business_hint: null, include_in_cash: 0, duplicate_of: null, created_at: nowIso(), closed_at: nowIso() }).execute()
      const anyDb = db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
      await anyDb.insertInto('ledger_records').values({ id: newId(), workspace_id: ws.workspaceId, connection_id: conn, event_type: 'charge', external_id: 'ch_1', content_hash: 'h', event_json: '{}', origin: 'sync', created_by: null, source_account_id: null, entity_id: id, status: 'excluded', date: '2026-10-01', amount_minor: 100, currency: 'USD', posting_hash: null, provenance_json: null, created_at: nowIso(), updated_at: nowIso() }).execute()
    })
    expect((await detail(id)).deleteBlocked).toBeNull()
    expect((await del(id)).status).toBe(200)
  })

  it('one with an uploaded statement can go once that upload is disconnected with “Delete its data”, and the file goes too', async () => {
    const { cookie, ws, add, detail, del } = await setup()
    const id = await add('Csv Co')
    const fd = new FormData()
    fd.set('file', new File(['Date,Description,Amount\n2026-10-09,Coffee,-4.50\n'], 'oct.csv'))
    fd.set('entityId', id)
    const up = await app.request('/api/documents', { method: 'POST', headers: { origin: BASE, cookie, 'x-agfn-workspace': ws.workspaceId }, body: fd })
    expect(up.status, await up.clone().text()).toBe(201)
    const db = booted.services.db
    const doc = await withBypass('t', () => db.selectFrom('documents').select(['id', 'storage_key', 'record_id']).where('entity_id', '=', id).executeTakeFirstOrThrow())
    expect(doc.record_id).toBeTruthy()
    expect((await del(id)).status).toBe(409)
    const off = await app.request(`/api/connections/${doc.record_id}/disconnect`, req(cookie, ws.workspaceId, 'POST', { deleteData: true }))
    expect(await off.json()).toMatchObject({ ok: true, dataDeleted: true })
    expect((await detail(id)).deleteBlocked).toBeNull()
    expect(await withBypass('t', () => db.selectFrom('documents').select('id').where('id', '=', doc.id).execute())).toEqual([])
    expect(await booted.services.files.get(doc.storage_key)).toBeNull()
    expect((await del(id)).status).toBe(200)
  })

  it('a statement file of a disconnected upload no longer blocks, even if it stayed; any other file does', async () => {
    const { ws, add, detail } = await setup()
    const id = await add('Old Files')
    const conn = newId()
    const db = booted.services.db
    const file = (docId: string, recordId: string | null) => ({ id: docId, workspace_id: ws.workspaceId, entity_id: id, storage_key: docId, sha256: docId, mime_type: 'text/csv', size_bytes: 1, original_name: 'a.csv', arrived_via: 'upload' as const, status: 'unread' as const, extracted_json: null, record_type: recordId ? 'connection' : null, record_id: recordId, created_by: null, created_at: nowIso() })
    await withBypass('t', async () => {
      await db.insertInto('connections').values({ id: conn, workspace_id: ws.workspaceId, connector_key: 'files', entity_id: id, display_name: 'Uploaded statements', status: 'disconnected', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
      await db.insertInto('documents').values(file('d-stmt', conn)).execute()
    })
    expect((await detail(id)).deleteBlocked).toBeNull()
    await withBypass('t', () => db.insertInto('documents').values(file('d-receipt', null)).execute())
    expect((await detail(id)).deleteBlocked).toBe('It has files. Delete them first.')
  })

  it('admins can’t delete a company (owners only), and don’t see deleteBlocked', async () => {
    const { cookie, ws, add } = await setup()
    const id = await add('Owner Only')
    await app.request('/api/people', req(cookie, ws.workspaceId, 'POST', { email: 'adm@example.test', role: 'admin', entityIds: 'all' }))
    const adm = await signIn('adm@example.test')
    const res = await app.request(`/api/entities/${id}`, req(adm, ws.workspaceId, 'DELETE'))
    expect(res.status).toBe(403)
    expect(((await res.json()) as { message: string }).message).toBe('Only an owner can delete a company.')
    const d = (await (await app.request(`/api/entities/${id}`, req(adm, ws.workspaceId, 'GET'))).json()) as Record<string, unknown>
    expect(d.deletable).toBe(false)
    expect('deleteBlocked' in d).toBe(false)
  })

  it('Personal can’t be deleted; the last company can, leaving Personal', async () => {
    const { ws, detail, del, listed } = await setup()
    const personal = (await listed()).length
    const pid = await withBypass('t', async () => (await booted.services.db.selectFrom('entities').select('id').where('workspace_id', '=', ws.workspaceId).where('kind', '=', 'personal').executeTakeFirstOrThrow()).id)
    expect((await detail(pid)).deletable).toBe(false)
    expect((await del(pid)).status).toBe(409)
    expect((await del(ws.companyId)).status).toBe(200)
    expect((await listed()).length).toBe(personal - 1)
    expect(await listed()).not.toContain('Acme')
  })
})
