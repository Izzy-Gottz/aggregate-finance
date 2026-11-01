import { describe, expect, it } from 'vitest'
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import { peopleFromAuth, type AuthReauth } from './host.ts'

// A tiny stand-in for the two lookups requireRecentPasskey makes: the person, and whether they have a passkey.
function fakeDb(person: { auth_user_id: string; email: string }, hasPasskey: boolean): Kysely<CoreTables> {
  const q = (row: unknown) => {
    const chain = { select: () => chain, where: () => chain, limit: () => chain, executeTakeFirst: async () => row }
    return chain
  }
  return { selectFrom: (t: string) => q(t === 'people' ? person : hasPasskey ? { id: 'pk1' } : undefined) } as unknown as Kysely<CoreTables>
}
const perms = { can: (async () => true) as never, entitiesFor: async () => [], canManageWorkspace: async () => true }
// Recent sign-in yes, recent passkey no: which one gets asked decides the answer.
const reauth: AuthReauth = { requireRecentPasskey: async () => false, requireRecentAuth: async () => true }

describe('peopleFromAuth re-check', () => {
  it('noRecheck (the challenge app): no confirm step at all, even with a passkey and no fresh one', async () => {
    const p = peopleFromAuth({ db: fakeDb(owner, true), permissions: perms, reauth, noRecheck: true })
    expect(await p.requireRecentPasskey('p1' as never, 600_000)).toBe(true)
    expect(await p.requireRecentPasskey('p1' as never, 600_000, 'create_grant')).toBe(true)
  })
  const owner = { auth_user_id: 'u1', email: 'owner@example.com' }
  it('a passkey holder must use the passkey where passkeys work', async () => {
    const p = peopleFromAuth({ db: fakeDb(owner, true), permissions: perms, reauth })
    expect(await p.requireRecentPasskey('p1' as never, 600_000)).toBe(false)
  })
  it('on plain http (LAN), where no browser can use a passkey, a fresh sign-in counts even for a passkey holder', async () => {
    const p = peopleFromAuth({ db: fakeDb(owner, true), permissions: perms, reauth, passkeysPossible: false })
    expect(await p.requireRecentPasskey('p1' as never, 600_000)).toBe(true)
  })
  it('reviewer demo accounts stay refused there too, except for creating an AI connection', async () => {
    const p = peopleFromAuth({ db: fakeDb({ auth_user_id: 'u2', email: 'r1@reviewers.aggregate.invalid' }, false), permissions: perms, reauth, passkeysPossible: false })
    expect(await p.requireRecentPasskey('p2' as never, 600_000)).toBe(false)
    expect(await p.requireRecentPasskey('p2' as never, 600_000, 'create_grant')).toBe(true)
    expect(await p.requireRecentPasskey('p2' as never, 3_600_000, 'first_grant')).toBe(true)
  })
  it("an account's first AI connection: any recent sign-in counts, even for a passkey holder, within the window asked", async () => {
    const asked: number[] = []
    const r: AuthReauth = { requireRecentPasskey: async () => false, requireRecentAuth: async (_p, ms) => (asked.push(ms), true) }
    const p = peopleFromAuth({ db: fakeDb(owner, true), permissions: perms, reauth: r })
    expect(await p.requireRecentPasskey('p1' as never, 3_600_000, 'first_grant')).toBe(true)
    expect(asked).toEqual([3_600_000])
    // Not first: the passkey is required again.
    expect(await p.requireRecentPasskey('p1' as never, 600_000, 'create_grant')).toBe(false)
  })
})
