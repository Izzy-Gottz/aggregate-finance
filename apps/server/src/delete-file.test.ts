import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
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
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, fileStore: new MemoryFileStore(), ledger: (h) => ledgerFor(h.db) })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, ws: string, method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json', origin: BASE, cookie, 'x-agfn-workspace': ws },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const csv = 'Date,Description,Amount\n2026-10-09,Coffee,-4.50\n'

async function setup() {
  const cookie = await signIn('owner@example.test')
  const ws = (await (await app.request('/api/workspaces', req(cookie, '', 'POST', { companyName: 'Acme' }))).json()) as { workspaceId: string; companyId: string }
  const w = ws.workspaceId
  const upload = async (name: string, body: string, entityId = ws.companyId) => {
    const fd = new FormData()
    fd.set('file', new File([body], name))
    fd.set('entityId', entityId)
    const r = await app.request('/api/documents', { method: 'POST', headers: { origin: BASE, cookie, 'x-agfn-workspace': w }, body: fd })
    expect(r.status, await r.clone().text()).toBeLessThan(300)
    return (await r.json()) as { documentId: string; state: string }
  }
  const del = (id: string, as = cookie) => app.request(`/api/documents/${id}`, req(as, w, 'DELETE'))
  const docRow = (id: string) => withBypass('t', () => booted.services.db.selectFrom('documents').select(['id', 'storage_key']).where('id', '=', id).executeTakeFirst())
  // A statement waiting for "which account?" (as email-in leaves one): no connection yet, its bytes stored.
  const waiting = async (name: string, entityId = ws.companyId) => {
    const id = newId()
    await booted.services.files.put(`${w}/${id}`, new TextEncoder().encode(csv))
    await withBypass('t', () => booted.services.db.insertInto('documents').values({ id, workspace_id: w, entity_id: entityId, storage_key: `${w}/${id}`, sha256: id, mime_type: 'text/csv', size_bytes: csv.length, original_name: name, arrived_via: 'email', status: 'unread', extracted_json: JSON.stringify({ status: 'needs_account' }), record_type: null, record_id: null, created_by: null, created_at: nowIso() }).execute())
    return id
  }
  return { cookie, ws, upload, waiting, del, docRow }
}

describe('deleting one uploaded file', () => {
  it('a statement waiting for “which account?” goes, bytes and row, and a pending review that cites it is rejected', async () => {
    const { ws, waiting, del, docRow } = await setup()
    const out = { documentId: await waiting('oct.csv') }
    const row = (await docRow(out.documentId))!
    expect(await booted.services.files.get(row.storage_key)).not.toBeNull()
    const anyDb = booted.services.db as unknown as Kysely<Record<string, Record<string, unknown>>>
    const wr = newId()
    await withBypass('t', () =>
      anyDb.insertInto('write_requests').values({ id: wr, workspace_id: ws.workspaceId, actor_kind: 'agent', person_id: null, grant_id: null, origin: 'agent', op: 'create', entity_id: ws.companyId, idem_scope: 's', idempotency_key: 'k', payload_hash: 'h', payload_json: '{}', reason: null, file_sha256: null, source_document_id: out.documentId, status: 'pending_review', hold_reason: null, record_id: null, record_type: null, result_json: null, error: null, undo_until: null, created_at: nowIso(), decided_at: null, decided_by: null, reverted_at: null, reverted_by: null }).execute(),
    )
    const res = await del(out.documentId)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await res.json()).toEqual({ ok: true, name: 'oct.csv' })
    expect(await docRow(out.documentId)).toBeUndefined()
    expect(await booted.services.files.get(row.storage_key)).toBeNull()
    expect(await withBypass('t', () => anyDb.selectFrom('write_requests').select(['status', 'error']).where('id', '=', wr).executeTakeFirst())).toEqual({ status: 'rejected', error: 'Its file was deleted.' })
    expect((await del(out.documentId)).status).toBe(404)
  })

  it('an imported statement is refused (its connection’s “Delete its data” removes it)', async () => {
    const { upload, del, docRow } = await setup()
    const out = await upload('oct.csv', csv)
    const res = await del(out.documentId)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { message: string }).message).toBe('This statement was imported. Remove it with its connection’s “Delete its data”.')
    expect(await docRow(out.documentId)).toBeDefined()
  })

  it('owner or admin only; another workspace’s file is not found', async () => {
    const { cookie, ws, waiting, del } = await setup()
    const out = { documentId: await waiting('oct.csv') }
    await app.request('/api/people', req(cookie, ws.workspaceId, 'POST', { email: 'acct@example.test', role: 'accountant', entityIds: 'all' }))
    const acct = await signIn('acct@example.test')
    const r = await del(out.documentId, acct)
    expect(r.status).toBe(403)
    expect(((await r.json()) as { message: string }).message).toBe('Only an owner or admin can delete files.')
    const other = await signIn('other@example.test')
    const theirs = (await (await app.request('/api/workspaces', req(other, '', 'POST', { companyName: 'Other' }))).json()) as { workspaceId: string }
    expect((await app.request(`/api/documents/${out.documentId}`, req(other, theirs.workspaceId, 'DELETE'))).status).toBe(404)
  })

  it('once its only file is deleted, the company can be deleted', async () => {
    const { cookie, ws, waiting, del } = await setup()
    const co = ((await (await app.request('/api/entities', req(cookie, ws.workspaceId, 'POST', { name: 'Receipts Co' }))).json()) as { id: string }).id
    const id = await waiting('receipt.csv', co)
    expect((await app.request(`/api/entities/${co}`, req(cookie, ws.workspaceId, 'DELETE'))).status).toBe(409)
    expect((await del(id)).status).toBe(200)
    expect((await app.request(`/api/entities/${co}`, req(cookie, ws.workspaceId, 'DELETE'))).status).toBe(200)
  })
})
