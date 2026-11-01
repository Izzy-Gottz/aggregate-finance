import { describe, expect, it } from 'vitest'
import { connect, migrateToLatest, nowIso, type CoreTables } from '@agfn/db'
import { INACTIVITY_KEY, purgeRawPayloads, revokeUnboundOauthGrants, sendInactivityNotices } from './retention.ts'

describe('raw payload purge', () => {
  it('deletes raw payloads 30 days after disconnect, and nothing else', async () => {
    const h = connect<CoreTables>('sqlite::memory:')
    const db = h.db
    try {
      await migrateToLatest(db)
      await db.insertInto('workspaces').values({ id: 'w', name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
      const conn = (id: string, status: 'active' | 'disconnected', disconnected_at: string | null) =>
        db.insertInto('connections').values({ id, workspace_id: 'w', connector_key: 'plaid', entity_id: null, display_name: id, status, secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, disconnected_at, created_by: null, created_at: nowIso() }).execute()
      const raw = (id: string, connection_id: string) => db.insertInto('raw_records').values({ id, workspace_id: 'w', connection_id, kind: 'txn', external_id: id, payload_json: '{}', sha256: id, received_at: nowIso() }).execute()
      const now = new Date('2026-11-20T00:00:00Z')
      await conn('old', 'disconnected', '2026-10-01T00:00:00Z') // 50 days ago
      await conn('recent', 'disconnected', '2026-11-10T00:00:00Z') // 10 days ago
      await conn('legacy', 'disconnected', null) // disconnected before the column existed
      await conn('live', 'active', null)
      for (const c of ['old', 'recent', 'legacy', 'live']) {
        await raw(`${c}-1`, c)
        await raw(`${c}-2`, c)
      }
      expect(await purgeRawPayloads(db, now)).toEqual({ stamped: 1, connections: 1, rows: 2 })
      const left = (await db.selectFrom('raw_records').select('connection_id').execute()).map((r) => r.connection_id)
      expect(left.sort()).toEqual(['legacy', 'legacy', 'live', 'live', 'recent', 'recent'])
      // The legacy connection's 30 days run from the first purge.
      expect(await purgeRawPayloads(db, new Date('2026-12-21T00:00:00Z'))).toEqual({ stamped: 0, connections: 2, rows: 4 })
      expect((await db.selectFrom('raw_records').select('connection_id').execute()).map((r) => r.connection_id)).toEqual(['live', 'live'])
    } finally {
      await h.close()
    }
  })
})

describe('never-connected AI grants', () => {
  it('revokes OAuth grants that were never bound to a consent or used, and nothing else', async () => {
    const h = connect<CoreTables>('sqlite::memory:')
    const db = h.db
    const anyDb = db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    try {
      await migrateToLatest(db)
      await db.insertInto('workspaces').values({ id: 'w', name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
      await db.insertInto('people').values({ id: 'p', auth_user_id: null, name: 'P', email: 'p@x', created_at: nowIso() }).execute()
      const grant = (id: string, kind: string, created: string, used: string | null = null) =>
        anyDb.insertInto('grants').values({ id, workspace_id: 'w', person_id: 'p', kind, client_id: 'c1', client_name: 'X', entity_ids_json: '"all"', data_types_json: '[]', can_write: 0, review_mode: 'instant', daily_write_cap: 10, expires_at: null, created_at: created, updated_at: created, revoked_at: null, revoked_by: null, last_used_at: used }).execute()
      const old = '2026-10-10T00:00:00.000Z'
      await grant('orphan', 'oauth', old)
      await grant('bound', 'oauth', old)
      await grant('used', 'oauth', old, '2026-10-10T00:05:00.000Z')
      await grant('fresh', 'oauth', '2026-10-10T01:50:00.000Z')
      await grant('key', 'key', old)
      // Better Auth's consent table records the bound one.
      await (db as never as import('kysely').Kysely<any>).schema.createTable('oauthConsent').ifNotExists().addColumn('id', 'text').addColumn('referenceId', 'text').execute()
      await anyDb.insertInto('oauthConsent').values({ id: 'c', referenceId: 'bound' }).execute()
      expect(await revokeUnboundOauthGrants(db, { now: new Date('2026-10-10T02:00:00.000Z') })).toBe(1)
      const rows = (await anyDb.selectFrom('grants').select(['id', 'revoked_by']).orderBy('id').execute()) as Array<{ id: string; revoked_by: string | null }>
      expect(rows.filter((r) => r.revoked_by).map((r) => r.id)).toEqual(['orphan'])
      // Restarting the same client revokes even a fresh unfinished attempt.
      expect(await revokeUnboundOauthGrants(db, { now: new Date('2026-10-10T02:00:00.000Z'), olderThanMs: 0, personId: 'p', clientId: 'c1' })).toBe(1)
    } finally {
      await h.close()
    }
  })
})

describe('90-day inactivity notice', () => {
  it('emails owners once after 90 quiet days, again only after 90 more, and never for a used workspace', async () => {
    const h = connect<CoreTables>('sqlite::memory:')
    const db = h.db
    const anyDb = db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const sent: Array<{ to: string; text: string }> = []
    const mailer = { send: async (m: { to: string; subject: string; text: string }) => void sent.push(m) }
    const run = (now: string) => sendInactivityNotices({ db, mailer, baseUrl: 'https://app.example/', now: new Date(now) })
    try {
      await migrateToLatest(db)
      const t0 = '2026-01-01T00:00:00.000Z'
      for (const w of ['quiet', 'busy', 'young']) await db.insertInto('workspaces').values({ id: w, name: w, base_currency: 'USD', created_at: w === 'young' ? '2026-03-15T00:00:00.000Z' : t0 }).execute()
      const person = async (id: string, email: string, ws: string, role: 'owner' | 'finance') => {
        await db.insertInto('people').values({ id, auth_user_id: null, name: id, email, created_at: t0 }).onConflict((oc) => oc.doNothing()).execute()
        await db.insertInto('memberships').values({ id: `${id}-${ws}`, workspace_id: ws, person_id: id, role, grid_json: null, expires_at: null, invited_by: null, created_at: t0, revoked_at: null }).execute()
      }
      await person('o1', 'o1@x.com', 'quiet', 'owner')
      await person('o2', 'o2@x.com', 'quiet', 'owner')
      await person('f', 'f@x.com', 'quiet', 'finance')
      await person('o3', 'o3@x.com', 'busy', 'owner')
      await person('o4', 'o4@x.com', 'young', 'owner')
      // An AI used "busy" recently.
      await anyDb.insertInto('grants').values({ id: 'g', workspace_id: 'busy', person_id: 'o3', kind: 'key', client_id: 'k', client_name: 'X', entity_ids_json: '"all"', data_types_json: '[]', can_write: 0, review_mode: 'instant', daily_write_cap: 10, expires_at: null, created_at: t0, updated_at: t0, revoked_at: null, revoked_by: null, last_used_at: '2026-04-01T00:00:00.000Z' }).execute()

      expect(await run('2026-04-15T00:00:00.000Z')).toEqual({ checked: 2, notified: 1 })
      expect(sent.map((m) => m.to).sort()).toEqual(['o1@x.com', 'o2@x.com']) // owners only
      expect(sent[0]!.text).toContain('hasn’t been used in 90 days')
      expect(sent[0]!.text).toContain('Bank connections are still syncing.')
      expect(sent[0]!.text).toContain('https://app.example/#/preferences')
      const stored = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', 'quiet').where('key', '=', INACTIVITY_KEY).executeTakeFirst()
      expect(JSON.parse(stored!.value_json)).toMatchObject({ sentAt: '2026-04-15T00:00:00.000Z' })

      // Daily runs don't repeat it; 90 days later it goes again.
      expect((await run('2026-04-16T00:00:00.000Z')).notified).toBe(0)
      // "busy" was last used by its AI on 04-01 and "young" was made on 03-15, so both reach 90 days by July;
      // "quiet" waits 90 days after its first notice.
      sent.length = 0
      expect((await run('2026-07-13T00:00:00.000Z')).notified).toBe(2)
      expect(sent.map((m) => m.to).sort()).toEqual(['o3@x.com', 'o4@x.com'])
      sent.length = 0
      expect((await run('2026-07-15T00:00:00.000Z')).notified).toBe(1)
      expect(sent.map((m) => m.to).sort()).toEqual(['o1@x.com', 'o2@x.com'])
      // A person acting in the app resets the clock.
      await anyDb.insertInto('activity_log').values({ id: 'a1', workspace_id: 'quiet', seq: 1, at: '2026-10-01T00:00:00.000Z', actor_kind: 'person', person_id: 'o1', grant_id: null, actor_label: 'o1', action: 'write.add_entry', target_type: null, target_id: null, entity_ids_json: null, args_json: null, status: 'ok', rows_returned: null, detail: null, ip: null, user_agent: null, prev_hash: '', hash: 'h' } as never).execute()
      sent.length = 0
      expect((await run('2026-10-20T00:00:00.000Z')).notified).toBe(2)
      expect(sent.map((m) => m.to).sort()).toEqual(['o3@x.com', 'o4@x.com'])
    } finally {
      await h.close()
    }
  })
})
