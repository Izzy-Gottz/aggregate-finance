// The hand-over runs inside a workspace, as the app role, and the no-signup demo depends on it: a right the role lacks
// would burn every pooled demo.
import { describe, expect, it } from 'vitest'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, withBypass, type CoreTables } from '@agfn/db'
import { DEMO_POOL, DEMO_POOL_READY, markPooled, newPoolPerson, takePoolDemo } from './pool.ts'

describe('a pooled demo under row-level security', () => {
  it('hands over as the app role: the reserved person goes, the new owner is in', async () => {
    const h = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    const db = h.db
    try {
      const at = nowIso()
      const { reserved, person } = await withBypass('test', async () => {
        await migrateToLatest(db)
        await ensureAppRole(db as never)
        await db.insertInto('workspaces').values({ id: 'w1', name: 'Demo', base_currency: 'USD', created_at: at }).execute()
        const reserved = await newPoolPerson(db)
        const person = newId()
        await db.insertInto('people').values({ id: person, auth_user_id: null, name: 'New', email: 'new@example.test', created_at: at } as never).execute()
        await db.insertInto('memberships').values({ id: newId(), workspace_id: 'w1', person_id: reserved, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: at, revoked_at: null } as never).execute()
        await markPooled(db, 'w1')
        await db.insertInto('settings').values({ workspace_id: 'w1', key: DEMO_POOL_READY, value_json: 'true', updated_at: at }).execute()
        return { reserved, person }
      })
      expect(await withBypass('demo:take', () => takePoolDemo(db, person))).toBe('w1')
      await withBypass('test', async () => {
        expect(await db.selectFrom('people').select('id').where('id', '=', reserved).execute()).toEqual([])
        expect((await db.selectFrom('memberships').select('person_id').where('workspace_id', '=', 'w1').execute()).map((m) => m.person_id)).toEqual([person])
        expect(await db.selectFrom('settings').select('key').where('workspace_id', '=', 'w1').where('key', 'in', [DEMO_POOL, DEMO_POOL_READY]).execute()).toEqual([])
      })
    } finally {
      await h.close()
    }
  }, 60_000)
})
