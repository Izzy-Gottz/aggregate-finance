import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { createWorkspace } from '@agfn/auth'
import { createNotifier, isoWeek } from './notify.ts'

let h: DbHandle<CoreTables>
let ws: string
let sent: Array<{ to: string; subject: string; text: string }>
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  sent = []
  const pid = newId()
  await h.db.insertInto('people').values({ id: pid, auth_user_id: null, name: 'F', email: 'f@x.com', created_at: nowIso() }).execute()
  ws = (await createWorkspace(h.db, { personId: pid, workspaceName: 'W', firstCompanyName: 'Acme', timeZone: 'UTC' })).workspaceId
})
afterEach(() => h.close())

describe('notifications', () => {
  it('computes ISO weeks', () => {
    expect(isoWeek(new Date('2026-10-12T09:00:00Z'))).toBe('2026-W42')
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53')
  })

  it('sends the Monday note once per week, only on Monday mornings', async () => {
    let t = new Date('2026-10-12T07:00:00Z')
    const n = createNotifier({ db: h.db, mailer: { send: async (m) => void sent.push(m) }, baseUrl: 'https://app.aggregate.finance', now: () => t, digest: async () => ({ subject: 'Monday note', lines: ['Cash: $412,880 across 3 companies'] }) })
    expect(await n.weekly()).toBe(0)
    t = new Date('2026-10-12T09:00:00Z')
    expect(await n.weekly()).toBe(1)
    expect(await n.weekly()).toBe(0)
    expect(sent[0]).toMatchObject({ to: 'f@x.com', subject: 'Monday note' })
    expect(sent[0]!.text).toContain('Turn the Monday note off')
    t = new Date('2026-10-13T09:00:00Z')
    expect(await n.weekly()).toBe(0)
  })

  it("Monday 08:00 is in the workspace's own time zone (New York when unset)", async () => {
    await h.db.updateTable('workspaces').set({ time_zone: null }).where('id', '=', ws).execute()
    let t = new Date('2026-10-12T11:30:00Z') // 07:30 in New York
    const n = createNotifier({ db: h.db, mailer: { send: async (m) => void sent.push(m) }, baseUrl: 'https://x', now: () => t, digest: async () => ({ subject: 'Monday note', lines: ['Cash: $1'] }) })
    expect(await n.weekly()).toBe(0)
    t = new Date('2026-10-12T12:30:00Z') // 08:30 in New York
    expect(await n.weekly()).toBe(1)
    await h.db.updateTable('workspaces').set({ time_zone: 'Asia/Tokyo' }).where('id', '=', ws).execute()
    await h.db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', 'notify:digest_week').execute()
    t = new Date('2026-10-11T23:30:00Z') // Monday 08:30 in Tokyo, still Sunday in UTC
    expect(await n.weekly()).toBe(1)
  })

  it('alerts once when a connection needs sign-in, again only after it recovers and breaks', async () => {
    const id = newId()
    await h.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'plaid', entity_id: null, display_name: 'Chase', status: 'needs_reauth', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
    const n = createNotifier({ db: h.db, mailer: { send: async (m) => void sent.push(m) }, baseUrl: 'https://x' })
    expect(await n.connectionAlerts()).toBe(1)
    expect(await n.connectionAlerts()).toBe(0)
    await h.db.updateTable('connections').set({ status: 'active' }).execute()
    await n.connectionAlerts()
    await h.db.updateTable('connections').set({ status: 'needs_reauth' }).execute()
    expect(await n.connectionAlerts()).toBe(1)
    expect(sent[0]!.subject).toBe('Chase needs you to sign in again')
  })

  it('respects the per-person off switch', async () => {
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    await h.db.insertInto('settings').values({ workspace_id: ws, key: `prefs:${person.id}`, value_json: JSON.stringify({ mondayEmail: false }), updated_at: nowIso() }).execute()
    const n = createNotifier({ db: h.db, mailer: { send: async (m) => void sent.push(m) }, baseUrl: 'https://x', now: () => new Date('2026-10-12T09:00:00Z'), digest: async () => ({ subject: 's', lines: ['x'] }) })
    expect(await n.weekly()).toBe(0)
  })

  it('emails the person who connected an AI when it is refused, once per AI per day', async () => {
    const person = await h.db.selectFrom('people').select('id').executeTakeFirstOrThrow()
    const db = h.db as never as import('kysely').Kysely<Record<string, Record<string, unknown>>>
    const t = nowIso()
    await db.insertInto('grants').values({ id: 'g1', workspace_id: ws, person_id: person.id, kind: 'oauth', client_id: 'c', client_name: 'Claude', entity_ids_json: '[]', data_types_json: '[]', created_at: t, updated_at: t }).execute()
    let seq = 0
    const log = (status: string, action: string) =>
      db.insertInto('activity_log').values({ id: newId(), workspace_id: ws, seq: ++seq, at: t, actor_kind: 'agent', grant_id: 'g1', actor_label: 'Claude', action, status, prev_hash: '', hash: String(seq) }).execute()
    let day = '2026-10-12T09:00:00Z'
    const n = createNotifier({ db: h.db, mailer: { send: async (m) => void sent.push(m) }, baseUrl: 'https://x', now: () => new Date(day) })
    await log('denied', 'tool.list_payroll')
    expect(await n.blockedAsks()).toBe(0) // first run starts from now, no email about history
    await log('ok', 'tool.get_overview')
    await log('denied', 'tool.list_payroll')
    await log('denied', 'write.record_invoice')
    expect(await n.blockedAsks()).toBe(1)
    expect(sent[0]).toMatchObject({ to: 'f@x.com', subject: 'Claude asked for something it can’t see' })
    expect(sent[0]!.text).toContain('list payroll, record invoice')
    await log('denied', 'tool.list_payroll')
    expect(await n.blockedAsks()).toBe(0) // same day
    day = '2026-10-13T09:00:00Z'
    await log('denied', 'tool.list_payroll')
    expect(await n.blockedAsks()).toBe(1)
    await h.db.insertInto('settings').values({ workspace_id: ws, key: `prefs:${person.id}`, value_json: JSON.stringify({ blockedAsk: false }), updated_at: nowIso() }).execute()
    day = '2026-10-14T09:00:00Z'
    await log('denied', 'tool.list_payroll')
    expect(await n.blockedAsks()).toBe(0)
  })
})
