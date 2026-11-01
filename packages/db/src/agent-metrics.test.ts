import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { connectPglite } from './pglite.ts'
import { migrateToLatest, newId, type CoreTables } from './index.ts'

// Migrations 0900-0906: the funnel views count only real people (no .invalid/.test/.example/.localhost, none listed in
// metrics_excluded_people) and real workspaces; YC grants and AI calls
// (demo workspaces and the challenge's archived activity included) are counted as they are.
describe('agent_metrics views', () => {
  it('counts sign-ups, activation, AI connections and activity, skipping system accounts and demo workspaces', async () => {
    const h = await connectPglite<CoreTables>()
    try {
      expect((await migrateToLatest(h.db)).error).toBeUndefined()
      const db = h.db as any
      const today = new Date().toISOString().slice(0, 10)
      const at = `${today}T12:00:00.000Z`
      const ws = newId(), demoWs = newId()
      await db.insertInto('workspaces').values([{ id: ws, name: 'Real', base_currency: 'USD', created_at: at }, { id: demoWs, name: 'Demo', base_currency: 'USD', created_at: at }]).execute()
      await db.insertInto('settings').values({ workspace_id: demoWs, key: 'demo', value_json: 'true', updated_at: at }).execute()
      const person = (id: string, email: string, auth: string | null) => ({ id, auth_user_id: auth, name: 'x', email, created_at: at })
      const [a, b, c, bot, invited, tester, team] = [newId(), newId(), newId(), newId(), newId(), newId(), newId()]
      await db.insertInto('people').values([
        person(a, 'a@example.com', 'u-a'), person(b, 'b@example.com', 'u-b'), person(c, 'c@example.com', 'u-c'),
        person(bot, 'reviewer-1@reviewers.aggregate.invalid', 'u-bot'), person(invited, 'i@example.com', null),
        person(newId(), 'p1@demo-pool.aggregate.invalid', null), // a pooled demo's reserved person (never counts)
        person(tester, 'qa@Staging.TEST', 'u-t'), // a signed-in test account on a reserved test domain (never counts)
        person(team, 'founder@example.org', 'u-team'), // the team's own account, listed below (never counts)
      ]).execute()
      const conn = (by: string, w: string) => ({ id: newId(), workspace_id: w, connector_key: 'plaid', display_name: 'Bank', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: by, created_at: at })
      await db.insertInto('connections').values([conn(a, ws), conn(b, demoWs), conn(bot, ws), conn(tester, ws), conn(team, ws)]).execute()
      const grant = (p: string, client: string, w: string) => ({ id: newId(), workspace_id: w, person_id: p, kind: 'oauth', client_id: client, client_name: client, entity_ids_json: '[]', data_types_json: '[]', can_write: 0, review_mode: 'none', daily_write_cap: null, expires_at: null, created_at: at, updated_at: at, revoked_at: null, revoked_by: null, last_used_at: null })
      const g = grant(a, 'claude', ws)
      await db.insertInto('grants').values([g, grant(c, 'public-demo', ws), grant(b, 'claude', demoWs), grant(tester, 'claude', ws), grant(team, 'claude', ws)]).execute()
      const log = (seq: number, kind: string, p: string | null, gid: string | null, w: string) => ({ id: newId(), workspace_id: w, seq, at, actor_kind: kind, person_id: p, grant_id: gid, actor_label: 'x', action: 'read', target_type: null, target_id: null, entity_ids_json: null, args_json: null, status: 'ok', rows_returned: 0, detail: null, ip: null, user_agent: null, prev_hash: '0', hash: `h${seq}` })
      const live = log(1, 'agent', null, g.id, ws), archivedOnly = log(5, 'agent', null, null, demoWs)
      await db.insertInto('activity_log').values([live, log(2, 'person', c, null, ws), log(3, 'person', b, null, demoWs), log(4, 'system', null, null, ws), log(12, 'person', tester, null, ws), log(13, 'person', team, null, ws)]).execute()
      // The challenge's reset copies rows before deleting a workspace: a copy of a row still live counts once.
      // The demo's own seeded AI never counts: live under a 'demo' client grant, or (after a challenge reset deleted the
      // workspace and its grant) only in the copies, found by its demo-seed write.
      const demoGrant = grant(b, 'demo', demoWs)
      await db.insertInto('grants').values(demoGrant).execute()
      await db.insertInto('activity_log').values(log(7, 'agent', null, demoGrant.id, demoWs)).execute()
      const seedRead = { ...log(8, 'agent', null, 'gone-grant', demoWs), action: 'get_metric' }
      const seedWrite = { ...log(9, 'agent', null, 'gone-grant', demoWs), action: 'add_entry', args_json: JSON.stringify({ idempotency_key: 'demo-seed-gone-grant', reason: 'Demo data' }) }
      // Only real people's AI counts: a tester's copy and a copy that names no owner (made before 0903) don't.
      const testerCall = { ...log(10, 'agent', null, 'tester-grant', demoWs), grant_person_id: bot }, ownerless = log(11, 'agent', null, 'old-grant', demoWs)
      await db.insertInto('challenge_activity').values([live, { ...archivedOnly, grant_person_id: a }, log(6, 'person', b, null, demoWs), seedRead, seedWrite, testerCall, ownerless].map((r) => ({ id: newId(), ws: r.workspace_id, at, row_json: JSON.stringify(r) }))).execute()
      await sql`insert into metrics_excluded_people (person_id, reason, created_at) values (${team}, 'team', ${at})`.execute(h.db)
      const ycGrant = (revoked: string | null, kind = 'yc') => ({ id: newId(), workspace_id: ws, kind, months: 12, until: null, reason: 'YC Deal', granted_by: 'ops', created_at: at, revoked_at: revoked })
      await db.insertInto('workspace_grants').values([ycGrant(null), ycGrant(at), ycGrant(null, 'manual')]).execute()

      const totals = Object.fromEntries((await sql<{ metric: string; value: string }>`select metric, value from agent_metrics.totals`.execute(h.db)).rows.map((r) => [r.metric, Number(r.value)]))
      expect(totals).toEqual({ signups: 3, activated: 1, ai_connected: 1, weekly_active: 2, paid: 0, yc_grants: 1, agent_calls: 2 })
      const daily = (await sql<{ d: string; metric: string; v: number }>`select to_char(day, 'YYYY-MM-DD') as d, metric, value::float8 as v from agent_metrics.daily`.execute(h.db)).rows
      expect(Object.fromEntries(daily.map((r) => [r.metric, [r.d, r.v]]))).toEqual({ signups: [today, 3], activated: [today, 1], ai_connected: [today, 1], active_people: [today, 2], yc_grants: [today, 1], agent_calls: [today, 2] })
      const cols = (await sql<{ column_name: string }>`select column_name from information_schema.columns where table_schema = 'agent_metrics'`.execute(h.db)).rows.map((r) => r.column_name)
      expect(new Set(cols)).toEqual(new Set(['day', 'metric', 'value']))
    } finally {
      await h.close()
    }
  })
})
