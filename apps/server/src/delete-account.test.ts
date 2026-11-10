import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { mcpFor } from './modules.ts'

const BASE = 'http://localhost:8787'
let booted: Booted
let app: ReturnType<typeof createApp>
let outbox: Array<{ to: string; text: string }>

beforeEach(async () => {
  outbox = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) }, mcp: (svc) => mcpFor(svc) })
  app = createApp(booted.services)
})
afterEach(() => booted.shutdown())

async function signIn(email: string): Promise<string> {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email, callbackURL: '/' }) })
  const link = outbox.filter((m) => m.to === email).at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}
const req = (cookie: string, method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json', origin: BASE, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

describe('DELETE /api/me', () => {
  it('deletes a workspace only they belong to along with the account', async () => {
    const solo = await signIn('solo@example.com')
    const made = (await (await app.request('/api/workspaces', req(solo, 'POST', { companyName: 'Solo Co' }))).json()) as { workspaceId?: string; id?: string }
    const db = booted.handle.db
    const me = await db.selectFrom('people').select('id').where('email', '=', 'solo@example.com').executeTakeFirstOrThrow()
    const ws = (await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', me.id).executeTakeFirstOrThrow()).workspace_id
    expect(made).toBeTruthy()

    const del = await app.request('/api/me', req(solo, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, workspaces: 1, workspacesDeleted: 1 })
    expect(await db.selectFrom('workspaces').select('id').where('id', '=', ws).execute()).toEqual([])
    expect(await db.selectFrom('entities').select('id').where('workspace_id', '=', ws).execute()).toEqual([])
    expect((await app.request('/api/me', { headers: { cookie: solo } })).status).toBe(401)
  })

  it('refuses the only owner while others belong, then removes access, sign-in and identity once someone else owns it', async () => {
    const founder = await signIn('founder@example.com')
    await app.request('/api/workspaces', req(founder, 'POST', { companyName: 'Acme' }))
    const db = booted.handle.db
    const me = await db.selectFrom('people').select(['id', 'auth_user_id']).where('email', '=', 'founder@example.com').executeTakeFirstOrThrow()
    const ws = (await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', me.id).executeTakeFirstOrThrow()).workspace_id

    // Someone else belongs (not an owner): leaving would strand them.
    expect((await app.request('/api/people', req(founder, 'POST', { email: 'bea@example.com', role: 'finance', entityIds: 'all' }))).status).toBeLessThan(300)
    await signIn('bea@example.com')
    expect((await app.request('/api/me', req(founder, 'DELETE', {}))).status).toBe(422)
    const sole = await app.request('/api/me', req(founder, 'DELETE', { confirm: 'DELETE' }))
    expect(sole.status).toBe(409)
    expect(await sole.json()).toMatchObject({ error: 'sole_owner', message: 'Make someone else an owner or delete the workspace first.', workspaces: [ws] })

    // Another owner, and some AI access the founder created.
    await app.request('/api/people', req(founder, 'POST', { email: 'avi@example.com', role: 'owner', entityIds: 'all' }))
    const avi = await signIn('avi@example.com')
    const key = await app.request('/api/ai/keys', req(founder, 'POST', { name: 'n8n', shape: { entityIds: 'all', dataTypes: ['balances'], write: false, reviewMode: 'instant', dailyWriteCap: 10, expiresAt: '2026-12-01T00:00:00.000Z' } }))
    expect(key.status).toBeLessThan(300)

    // Invites the founder sent, their code, and being invited by the other owner.
    const friendDb = db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const at = new Date().toISOString()
    const otherId = (await db.selectFrom('people').select('id').where('email', '=', 'avi@example.com').executeTakeFirstOrThrow()).id
    await friendDb.insertInto('friend_codes').values({ person_id: me.id, code: 'aaaaaaaaaaaaaaaa', created_at: at }).execute()
    await friendDb.insertInto('friend_invites').values({ id: 'fi', inviter_id: me.id, email_hash: 'h', created_at: at }).execute()
    await friendDb.insertInto('friend_signups').values({ person_id: me.id, inviter_id: otherId, created_at: at }).execute()
    await friendDb.insertInto('friend_signups').values({ person_id: otherId, inviter_id: me.id, created_at: at }).execute()

    const del = await app.request('/api/me', req(founder, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, workspaces: 1, workspacesDeleted: 0, grantsRevoked: 1 })
    for (const t of ['friend_codes', 'friend_invites', 'friend_signups']) expect(await friendDb.selectFrom(t).selectAll().execute(), t).toEqual([])
    expect(await db.selectFrom('workspaces').select('id').where('id', '=', ws).execute()).toHaveLength(1)

    // Signed out everywhere; nothing that identifies them is left; their AI access is dead.
    expect((await app.request('/api/me', { headers: { cookie: founder } })).status).toBe(401)
    expect(await db.selectFrom('memberships').select('id').where('person_id', '=', me.id).execute()).toEqual([])
    expect(await db.selectFrom('people').select(['name', 'email', 'auth_user_id']).where('id', '=', me.id).executeTakeFirst()).toEqual({ name: 'Former member', email: `deleted-${me.id}@invalid`, auth_user_id: null })
    const anyDb = db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    expect(await anyDb.selectFrom('auth_user').select('id').where('id', '=', me.auth_user_id!).execute()).toEqual([])
    expect(await anyDb.selectFrom('auth_session').select('id').where('userId', '=', me.auth_user_id!).execute()).toEqual([])
    expect((await anyDb.selectFrom('grants').select('revoked_at').where('person_id', '=', me.id).execute()).every((g) => g.revoked_at)).toBe(true)
    expect((await anyDb.selectFrom('agent_keys').select('revoked_at').where('created_by', '=', me.id).execute()).every((k) => k.revoked_at)).toBe(true)

    // The workspace carries on for the other owner; the same email can start fresh.
    expect((await app.request('/api/workspace', { headers: { cookie: avi } })).status).toBe(200)
    const again = await signIn('founder@example.com')
    expect(((await (await app.request('/api/me', { headers: { cookie: again } })).json()) as { workspaces?: unknown[] }).workspaces ?? []).toEqual([])
  })
})

describe('DELETE /api/me with pending invites', () => {
  it('a pending invitee (never signed in) doesn’t block the only owner; the workspace goes with the account', async () => {
    const founder = await signIn('founder@example.com')
    await app.request('/api/workspaces', req(founder, 'POST', { companyName: 'Acme' }))
    expect((await app.request('/api/people', req(founder, 'POST', { email: 'never@example.com', role: 'finance', entityIds: 'all' }))).status).toBe(201)
    const del = await app.request('/api/me', req(founder, 'DELETE', { confirm: 'DELETE' }))
    expect(del.status, await del.clone().text()).toBe(200)
    expect(await del.json()).toMatchObject({ ok: true, workspacesDeleted: 1 })
  })
})

describe('deleteAccount and transactions', () => {
  it('never calls the bank provider or the file store while a database transaction is open (Postgres)', async () => {
    const { connectPglite, migrateToLatest, nowIso } = await import('@agfn/db')
    const { deleteAccount } = await import('./delete-account.ts')
    const h = await connectPglite<import('@agfn/db').CoreTables>()
    const db = h.db
    try {
      await migrateToLatest(db)
      const t = nowIso()
      await db.insertInto('workspaces').values({ id: 'w', name: 'W', base_currency: 'USD', created_at: t }).execute()
      for (const id of ['leaver', 'other']) {
        await db.insertInto('people').values({ id, auth_user_id: id === 'other' ? 'u-other' : null, name: id, email: `${id}@x.com`, created_at: t }).execute()
        await db.insertInto('memberships').values({ id: `m-${id}`, workspace_id: 'w', person_id: id, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: t, revoked_at: null }).execute()
      }
      await db.insertInto('entities').values({ id: 'pers', workspace_id: 'w', kind: 'personal', name: 'Personal', base_currency: 'USD', owner_person_id: 'leaver', parent_entity_id: null, fiscal_year_start_month: 1, created_at: t, archived_at: null }).execute()
      await db.insertInto('connections').values({ id: 'c1', workspace_id: 'w', connector_key: 'plaid', entity_id: 'pers', display_name: 'Chase', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, disconnected_at: null, created_by: 'leaver', created_at: t }).execute()
      await db.insertInto('documents').values({ id: 'd1', workspace_id: 'w', entity_id: 'pers', storage_key: 'k1', sha256: 'x', mime_type: 'application/pdf', size_bytes: 1, original_name: 'a.pdf', arrived_via: 'upload', status: 'unread', extracted_json: null, record_type: null, record_id: null, created_by: 'leaver', created_at: t }).execute()

      // A transaction-local setting survives into the next statement only inside an open transaction (outside, each
      // statement is its own transaction). PGlite's single shared session means an open transaction anywhere shows here.
      const { sql } = await import('kysely')
      const inTransaction = async () => {
        await sql`select set_config('agfn.tx_probe', 'open', true)`.execute(db)
        const { rows } = await sql<{ v: string | null }>`select current_setting('agfn.tx_probe', true) as v`.execute(db)
        return rows[0]!.v === 'open'
      }
      // The detector itself: true inside a transaction, false outside.
      expect(await db.transaction().execute(async () => inTransaction())).toBe(true)
      expect(await inTransaction()).toBe(false)
      const seen: string[] = []
      const sync = {
        disconnect: async (id: string) => {
          seen.push(`disconnect:${id}:${await inTransaction()}`)
          await new Promise((r) => setTimeout(r, 20)) // a slow provider call
          await db.updateTable('connections').set({ status: 'disconnected' }).where('id', '=', id).execute()
          return { revoked: true }
        },
      }
      const files = { delete: async (key: string) => void seen.push(`file:${key}:${await inTransaction()}`) }
      const r = await deleteAccount({ db, files: files as never, sync: sync as never }, 'leaver')
      expect(r).toMatchObject({ connectionsRevoked: 1, documents: 1 })
      expect(seen).toEqual(['disconnect:c1:false', 'file:k1:false'])
    } finally {
      await h.close()
    }
  })
})

describe('anonymizeOrphanedDeletedPeople (backfill)', () => {
  it('tombstones orphaned real-email rows, leaves invitees/system/active/tombstoned alone, idempotent', async () => {
    const { connectPglite, migrateToLatest, nowIso } = await import('@agfn/db')
    const { anonymizeOrphanedDeletedPeople, deletedTombstone } = await import('./delete-account.ts')
    const h = await connectPglite<import('@agfn/db').CoreTables>()
    const db = h.db
    try {
      await migrateToLatest(db)
      const t = nowIso()
      await db.insertInto('workspaces').values({ id: 'w', name: 'W', base_currency: 'USD', created_at: t }).execute()
      const person = (id: string, auth: string | null, email: string) => db.insertInto('people').values({ id, auth_user_id: auth, name: id, email, created_at: t }).execute()
      // Fixed: a former account whose email was never cleared — two shapes. (a) no sign-in at all (auth_user_id null);
      await person('orphan', null, 'real-person@gmail.com')
      // (b) the real-leak shape: auth_user already deleted but the login reference and email left behind (dangling).
      await person('dangling', 'u-gone', 'leaked@gmail.com')
      // Left alone: a pending invitee (real email, live membership); a system row (*.invalid); an active signed-in person
      // (auth_user_id points at a REAL auth_user); two already-tombstoned rows (@invalid and .invalid); a company owner.
      await person('invitee', null, 'invitee@company.com')
      await db.insertInto('memberships').values({ id: 'm-invitee', workspace_id: 'w', person_id: 'invitee', role: 'finance', grid_json: null, expires_at: null, invited_by: null, created_at: t, revoked_at: null }).execute()
      await person('system', null, 'reviewer-abc@reviewers.aggregate.invalid')
      await person('active', 'u-active', 'active@company.com')
      await db.insertInto('memberships').values({ id: 'm-active', workspace_id: 'w', person_id: 'active', role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: t, revoked_at: null }).execute()
      await person('already-at', null, 'deleted-already-at@invalid')
      await person('already-dot', null, 'deleted-already-dot@deleted.invalid')
      await person('owner-orphan', null, 'still-owns@gmail.com')
      await db.insertInto('entities').values({ id: 'e1', workspace_id: 'w', kind: 'company', name: 'Co', base_currency: 'USD', owner_person_id: 'owner-orphan', parent_entity_id: null, fiscal_year_start_month: 1, created_at: t, archived_at: null }).execute()

      const dry = await anonymizeOrphanedDeletedPeople(db)
      expect(dry.found).toBe(2)
      expect(dry.anonymized).toBe(0)
      expect(dry.samples.map((s) => s.id).sort()).toEqual(['dangling', 'orphan'])
      // Nothing changed on a dry run.
      expect((await db.selectFrom('people').select('email').where('id', '=', 'orphan').executeTakeFirstOrThrow()).email).toBe('real-person@gmail.com')

      const applied = await anonymizeOrphanedDeletedPeople(db, { apply: true })
      expect(applied).toMatchObject({ found: 2, anonymized: 2 })
      for (const id of ['orphan', 'dangling']) {
        expect((await db.selectFrom('people').select(['name', 'email', 'auth_user_id']).where('id', '=', id).executeTakeFirstOrThrow())).toEqual({ name: 'Former member', email: deletedTombstone(id), auth_user_id: null })
      }
      // Untouched rows keep their emails.
      for (const [id, email] of [['invitee', 'invitee@company.com'], ['system', 'reviewer-abc@reviewers.aggregate.invalid'], ['active', 'active@company.com'], ['already-at', 'deleted-already-at@invalid'], ['already-dot', 'deleted-already-dot@deleted.invalid'], ['owner-orphan', 'still-owns@gmail.com']] as const) {
        expect((await db.selectFrom('people').select('email').where('id', '=', id).executeTakeFirstOrThrow()).email).toBe(email)
      }
      // Idempotent: a second run finds nothing.
      expect((await anonymizeOrphanedDeletedPeople(db, { apply: true })).found).toBe(0)
    } finally {
      await h.close()
    }
  })
})

describe('deleteAccount under people RLS (agfn_app)', () => {
  it('anonymizes the person row even when AGFN_PEOPLE_RLS hides it — solo owner and invited member both tombstoned', async () => {
    const { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, syncRlsPolicies, withBypass } = await import('@agfn/db')
    const { deleteAccount, deletedTombstone } = await import('./delete-account.ts')
    /* eslint-disable @typescript-eslint/no-explicit-any */
    process.env.AGFN_PEOPLE_RLS = '1'
    process.env.AGFN_PG_RLS = '1'
    const h = await connectPglite<import('@agfn/db').CoreTables>({ wrapPool: (p: any) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    const db = h.db
    const soloWs = newId(), sharedWs = newId(), solo = newId(), mainOwner = newId(), invited = newId()
    try {
      await withBypass('setup', async () => {
        await migrateToLatest(db)
        await ensureAppRole(db as any)
        await syncRlsPolicies(db as any, true, { people: true })
        const t = nowIso()
        for (const id of [soloWs, sharedWs]) await db.insertInto('workspaces').values({ id, name: id, base_currency: 'USD', time_zone: 'UTC', created_at: t }).execute()
        const person = (id: string) => db.insertInto('people').values({ id, auth_user_id: null, name: `Real ${id}`, email: `${id}@gmail.com`, created_at: t }).execute()
        const member = (ws: string, pid: string, role: 'owner' | 'finance') => db.insertInto('memberships').values({ id: newId(), workspace_id: ws, person_id: pid, role, grid_json: null, expires_at: null, invited_by: null, created_at: t, revoked_at: null }).execute()
        await person(solo); await person(mainOwner); await person(invited)
        await member(soloWs, solo, 'owner')
        await member(sharedWs, mainOwner, 'owner')
        await member(sharedWs, invited, 'finance')
      })
      const deps = { db, files: { delete: async () => {} } as any, sync: { disconnect: async () => ({ revoked: true }) } as any }
      const tombstoned = (id: string) => withBypass('check', () => db.selectFrom('people').select(['name', 'email', 'auth_user_id']).where('id', '=', id).executeTakeFirstOrThrow())

      // Invited member: not a sole owner, so just loses membership and is anonymized.
      await deleteAccount(deps, invited)
      expect(await tombstoned(invited)).toEqual({ name: 'Former member', email: deletedTombstone(invited), auth_user_id: null })

      // Solo owner: their workspace is deleted first, then they are anonymized.
      await deleteAccount(deps, solo)
      expect(await tombstoned(solo)).toEqual({ name: 'Former member', email: deletedTombstone(solo), auth_user_id: null })
    } finally {
      delete process.env.AGFN_PEOPLE_RLS
      delete process.env.AGFN_PG_RLS
      await h.close()
    }
  }, 120_000)
})
