// Glue for apps/server: build a PeopleDirectory from @agfn/auth's permissions and re-check helpers.
// Structural types only, so packages/mcp doesn't depend on Better Auth.

import type { Kysely } from 'kysely'
import type { Can, EntityId, EntityKind, PersonId, WorkspaceId } from '@agfn/contracts'
import { ownerOf, type CoreTables } from '@agfn/db'
import type { PeopleDirectory } from './ports.ts'

export interface AuthPermissions {
  can: Can
  /** A checker for one request (S0 permissions.forCall). */
  forCall?(): Can
  entitiesFor(workspaceId: WorkspaceId, personId: PersonId): Promise<Array<{ id: EntityId; name: string; kind: EntityKind }>>
  canManageWorkspace(workspaceId: WorkspaceId, personId: PersonId): Promise<boolean>
}

export interface AuthReauth {
  requireRecentPasskey(personId: PersonId, withinMs: number, purpose?: 'create_grant' | 'first_grant'): Promise<boolean>
  requireRecentAuth(personId: PersonId, withinMs: number): Promise<boolean>
}

/**
 * People with a passkey must re-check with it; people without one yet (new sign-ups) may use any fresh sign-in,
 * and the UI nudges them to add a passkey. `passkeysPossible: false` (a server on plain http that isn't localhost,
 * where browsers refuse passkeys): any fresh sign-in counts for everyone, as for connecting accounts.
 */
/**
 * `noRecheck`: no "confirm it's you" step at all (the challenge app: made-up books, GitHub sign-in, no email to send a
 * link with). Never set where real accounts live.
 */
export function peopleFromAuth(deps: { db: Kysely<CoreTables>; permissions: AuthPermissions; reauth: AuthReauth; passkeyTable?: string; passkeysPossible?: boolean; noRecheck?: boolean }): PeopleDirectory {
  const { db, permissions, reauth } = deps
  const passkeyTable = deps.passkeyTable ?? 'passkey'
  const anyDb = db as unknown as Kysely<Record<string, { id: string; userId: string }>>
  return {
    can: permissions.can,
    ...(permissions.forCall ? { forCall: permissions.forCall } : {}),
    entitiesFor: permissions.entitiesFor,
    canManageWorkspace: permissions.canManageWorkspace,
    async displayName(personId) {
      const r = await db.selectFrom('people').select('name').where('id', '=', personId).executeTakeFirst()
      return r?.name || 'someone'
    },
    async requireRecentPasskey(personId, withinMs, purpose) {
      if (deps.noRecheck) return true
      const person = await db.selectFrom('people').select(['auth_user_id', 'email']).where('id', '=', personId).executeTakeFirst()
      // Reviewer demo accounts (apps/server reviewer.ts): creating an AI connection needs no re-check (the session came
      // from the access code, the account only ever holds made-up demo books, and its connections end nightly), so a
      // directory reviewer is never sent to "sign in again". Any other re-check refuses them, so a route someone forgets
      // to block still can't fall through.
      if (person?.email?.toLowerCase().endsWith('@reviewers.aggregate.invalid')) return purpose === 'create_grant' || purpose === 'first_grant'
      // An account's first AI connection: the sign-up or sign-in itself is the check (FIRST_GRANT_WINDOW_MS).
      if (purpose === 'first_grant' || deps.passkeysPossible === false) return reauth.requireRecentAuth(personId, withinMs)
      let hasPasskey = false
      if (person?.auth_user_id) {
        const pk = await ownerOf(anyDb).selectFrom(passkeyTable).select('id').where('userId', '=', person.auth_user_id).limit(1).executeTakeFirst()
        hasPasskey = Boolean(pk)
      }
      return hasPasskey ? reauth.requireRecentPasskey(personId, withinMs) : reauth.requireRecentAuth(personId, withinMs)
    },
  }
}
