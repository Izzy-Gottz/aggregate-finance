// `people` has no workspace_id, so it carries a membership policy (rls.ts): under row-level security a person row is
// visible only to bypass work (the owner) or to a request whose current workspace the person is a member of. The point
// is that the app role with NO workspace context — what a SQL injection reaches — reads no names or emails. These tests
// run the real policy on PGlite with AGFN_PG_RLS=1 (as rls-e2e does).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, syncRlsPolicies, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely'

let db: Awaited<ReturnType<typeof connectPglite<CoreTables>>>
const wsA = newId()
const wsB = newId()
const alice = newId() // member of wsA
const bob = newId() // member of wsB
const carol = newId() // member of nothing (a revoked membership in wsA)

const read = (ids: string[]) => db.db.selectFrom('people').select('id').where('id', 'in', ids).execute().then((rs) => rs.map((r) => r.id).sort())

beforeAll(async () => {
  process.env.AGFN_PG_RLS = '1'
  db = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
  await withBypass('test-setup', async () => {
    await migrateToLatest(db.db)
    await ensureAppRole(db.db as Kysely<any>)
    await syncRlsPolicies(db.db as Kysely<any>, true, { people: true }) // applies the agfn_people policy (and the workspace ones)
    const h = db.db
    for (const id of [wsA, wsB]) await h.insertInto('workspaces').values({ id, name: id, base_currency: 'USD', time_zone: 'UTC', created_at: nowIso() }).execute()
    const person = (id: string, email: string) => h.insertInto('people').values({ id, auth_user_id: null, name: email.split('@')[0]!, email, created_at: nowIso() }).execute()
    await person(alice, 'alice@example.com')
    await person(bob, 'bob@example.com')
    await person(carol, 'carol@example.com')
    const member = (id: string, ws: string, personId: string, revokedAt: string | null) => h.insertInto('memberships').values({ id, workspace_id: ws, person_id: personId, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: revokedAt }).execute()
    await member(newId(), wsA, alice, null)
    await member(newId(), wsB, bob, null)
    await member(newId(), wsA, carol, nowIso()) // carol's wsA membership is revoked
  })
}, 120_000)

afterAll(async () => {
  delete process.env.AGFN_PG_RLS
  await db?.close()
})

describe('people under RLS (membership policy)', () => {
  it('no workspace context (what injection reaches): reads no people at all', async () => {
    expect(await read([alice, bob, carol])).toEqual([])
  })

  it('a workspace sees its own members, and nobody else', async () => {
    expect(await withWorkspace(wsA, () => read([alice, bob, carol]))).toEqual([alice].sort())
    expect(await withWorkspace(wsB, () => read([alice, bob, carol]))).toEqual([bob].sort())
  })

  it('a revoked membership does not reveal the person', async () => {
    // carol's only wsA membership is revoked, so wsA cannot see her; no workspace shows her at all.
    expect(await withWorkspace(wsA, () => read([carol]))).toEqual([])
  })

  it('bypass (the owner) sees everyone', async () => {
    expect(await withBypass('t', () => read([alice, bob, carol]))).toEqual([alice, bob, carol].sort())
  })

  it('creating a person for a workspace you are not yet a member of is refused without bypass, allowed under it', async () => {
    const stranger = newId()
    // A workspace-scoped insert of a not-yet-member fails the WITH CHECK (this is why invites create the person under
    // bypass).
    await expect(withWorkspace(wsA, () => db.db.insertInto('people').values({ id: stranger, auth_user_id: null, name: 'x', email: 'x@example.com', created_at: nowIso() }).execute())).rejects.toThrow(/row-level security/i)
    // Under bypass it works (sign-in and invites run there).
    await withBypass('t', () => db.db.insertInto('people').values({ id: stranger, auth_user_id: null, name: 'x', email: 'x@example.com', created_at: nowIso() }).execute())
    expect(await withBypass('t', () => read([stranger]))).toEqual([stranger])
  })
})
