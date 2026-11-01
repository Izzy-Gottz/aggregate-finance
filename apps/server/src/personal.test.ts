import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, type CoreTables, type DbHandle } from '@agfn/db'
import { personalHidden } from './personal.ts'

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('who sees Personal', () => {
  it('its owner sees it; other members, even owners of the workspace, see "private"; companies are never hidden', async () => {
    h = connect<CoreTables>('sqlite::memory:')
    await migrateToLatest(h.db)
    const db = h.db
    const ws = newId()
    const [alex, sam, old] = [newId(), newId(), newId()]
    await db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', time_zone: null, created_at: nowIso() }).execute()
    for (const [pid, role] of [[alex, 'owner'], [sam, 'owner']] as const) {
      await db.insertInto('people').values({ id: pid, auth_user_id: null, name: pid, email: `${pid}@example.com`, created_at: nowIso() }).execute()
      await db.insertInto('memberships').values({ id: newId(), workspace_id: ws, person_id: pid, role, grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null } as never).execute()
    }
    const ent = (id: string, kind: string, owner: string | null) =>
      db.insertInto('entities').values({ id, workspace_id: ws, kind, name: id, base_currency: 'USD', owner_person_id: owner, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso(), archived_at: null } as never).execute()
    await ent('mine', 'personal', alex)
    await ent('legacy', 'personal', null)
    await ent('co', 'company', null)
    expect(await personalHidden(db, ws, { id: 'mine', kind: 'personal' }, alex)).toBe(false)
    expect(await personalHidden(db, ws, { id: 'mine', kind: 'personal' }, sam)).toBe(true)
    // A Personal saved before owners were recorded: the workspace's owners see it, nobody else.
    expect(await personalHidden(db, ws, { id: 'legacy', kind: 'personal' }, sam)).toBe(false)
    expect(await personalHidden(db, ws, { id: 'legacy', kind: 'personal' }, old)).toBe(true)
    expect(await personalHidden(db, ws, { id: 'co', kind: 'company' }, old)).toBe(false)
  })
})
