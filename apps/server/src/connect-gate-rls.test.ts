// 43's staging blocker: the connect_source confirm page (/connect/<token>) runs OUTSIDE the /api/* session, so it has
// no ambient workspace. canManageWorkspace reads the RLS-scoped `memberships` table, so without a workspace the app
// role (agfn_app, NOBYPASSRLS) sees zero rows and every rightful owner is refused with 403. mayApproveConnect fixes
// that by setting the link's workspace for the check. These cases run the real RLS policies on PGlite as agfn_app, the
// same harness people-rls.test.ts and rls-e2e.test.ts use (PGlite is Postgres; there's no separate live-PG test rig).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, syncRlsPolicies, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely'
import { createPermissions } from '@agfn/auth'
import { mayApproveConnect } from './connect-source.ts'

let db: Awaited<ReturnType<typeof connectPglite<CoreTables>>>
let permissions: ReturnType<typeof createPermissions>
const wsA = newId()
const wsB = newId()
const ownerA = newId() // owner of wsA
const memberA = newId() // finance (non-manage) member of wsA
const ownerB = newId() // owner of wsB — a different tenant

beforeAll(async () => {
  process.env.AGFN_PG_RLS = '1'
  db = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
  permissions = createPermissions(db.db)
  await withBypass('test-setup', async () => {
    await migrateToLatest(db.db)
    await ensureAppRole(db.db as Kysely<any>)
    await syncRlsPolicies(db.db as Kysely<any>, true)
    const h = db.db
    for (const id of [wsA, wsB]) await h.insertInto('workspaces').values({ id, name: id, base_currency: 'USD', time_zone: 'UTC', created_at: nowIso() }).execute()
    const person = (id: string) => h.insertInto('people').values({ id, auth_user_id: `u-${id}`, name: id, email: `${id}@example.com`, created_at: nowIso() }).execute()
    const member = (ws: string, personId: string, role: 'owner' | 'finance') => h.insertInto('memberships').values({ id: newId(), workspace_id: ws, person_id: personId, role, grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute()
    await person(ownerA)
    await person(memberA)
    await person(ownerB)
    await member(wsA, ownerA, 'owner')
    await member(wsA, memberA, 'finance')
    await member(wsB, ownerB, 'owner')
  })
}, 120_000)

afterAll(async () => {
  delete process.env.AGFN_PG_RLS
  await db?.close()
})

const link = { workspaceId: wsA }

describe('mayApproveConnect under real RLS (agfn_app)', () => {
  it('the rightful owner is allowed', async () => {
    expect(await mayApproveConnect(permissions, link, ownerA)).toBe(true)
  })

  it('a non-owner member of the same workspace is refused', async () => {
    expect(await mayApproveConnect(permissions, link, memberA)).toBe(false)
  })

  it('an owner of another workspace (different tenant) is refused', async () => {
    expect(await mayApproveConnect(permissions, link, ownerB)).toBe(false)
  })

  it('without the workspace wrap the owner would be refused — proving RLS hides the membership (the bug)', async () => {
    // This is what the old code did: call canManageWorkspace with no ambient workspace. RLS → 0 rows → false.
    expect(await permissions.canManageWorkspace(wsA, ownerA)).toBe(false)
    // And with the wrap it is visible again.
    expect(await withWorkspace(wsA, () => permissions.canManageWorkspace(wsA, ownerA))).toBe(true)
  })
})
