import type { Kysely } from 'kysely'
import { forgetAttribution } from './creator-links.ts'
import { withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import type { SyncEngine } from '@agfn/sync'
import { isDemoWorkspace } from '@agfn/demo'
import { deleteWorkspace } from './delete-workspace.ts'

/**
 * A person leaves Aggregate entirely (data-retention policy §7). Refused while they are the only owner of a workspace
 * other people still belong to. A workspace they are the only member of is deleted first, the same way as
 * DELETE /api/workspace (provider access revoked, files, rows), so a failure there leaves the account as it was.
 * Then, everywhere else:
 *  - AI access they created is revoked (grants, agent keys, OAuth tokens and consent);
 *  - their Personal spaces' own bank connections are disconnected (provider access revoked, secrets wiped) and
 *    Personal documents deleted. Personal ledger rows stay, visible to nobody, because company entries can point at
 *    them (an owner paying a company bill). That trade-off is written down in the policy;
 *  - memberships are removed, and sign-in records (sessions, passkeys, linked Google/Apple, the login itself) deleted;
 *  - the person row is kept but emptied (name and email replaced) so history and the activity log still resolve.
 * Safe to run again if it stops halfway.
 */
export class SoleOwnerError extends Error {
  readonly workspaces: string[]
  constructor(workspaces: string[]) {
    super('Make someone else an owner or delete the workspace first.')
    this.workspaces = workspaces
  }
}

export interface DeleteAccountDeps {
  db: Kysely<CoreTables>
  files: FileStore
  sync: SyncEngine
  /** Revokes one grant the way the app does (keys, OAuth tokens, consent). Optional when MCP isn't installed. */
  revokeGrant?: (workspaceId: string, personId: string, grantId: string) => Promise<void>
  log?: (m: string, f?: Record<string, unknown>) => void
}

/**
 * Every workspace the person has rows in (memberships, AI grants, Personal spaces): the one cross-workspace step,
 * under a narrow named bypass (docs/security/rls.md). Everything else runs inside each workspace.
 */
async function workspacesWithRowsOf(db: Kysely<CoreTables>, personId: string): Promise<string[]> {
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  return withBypass('account:workspaces', async () => {
    const ids = new Set<string>()
    for (const r of await db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).execute()) ids.add(r.workspace_id)
    for (const r of (await anyDb.selectFrom('grants').select('workspace_id').where('person_id', '=', personId).execute().catch(() => [])) as Array<{ workspace_id: string }>) ids.add(r.workspace_id)
    for (const r of await db.selectFrom('entities').select('workspace_id').where('owner_person_id', '=', personId).execute()) ids.add(r.workspace_id)
    return [...ids]
  })
}

/**
 * The workspaces this person owns alone, split by who else is in them: `shared` (other members, no other owner) block
 * leaving; `solo` (nobody else) are deleted with the account. Demo workspaces are in neither: they always go with the
 * account (orphans.ts).
 */
export async function ownedAlone(db: Kysely<CoreTables>, personId: string): Promise<{ shared: string[]; solo: string[] }> {
  const owned = await withBypass('account:owned', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('role', '=', 'owner').where('revoked_at', 'is', null).execute())
  const shared: string[] = []
  const solo: string[] = []
  for (const { workspace_id } of owned) {
    const kind = await withWorkspace(workspace_id, async () => {
      if (await isDemoWorkspace(db, workspace_id)) return null
      // Pending invitees (never signed in) don't count: nobody would be stranded.
      const others = await db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select('memberships.role as role').where('memberships.workspace_id', '=', workspace_id).where('memberships.revoked_at', 'is', null).where('memberships.person_id', '!=', personId).where('people.auth_user_id', 'is not', null).execute()
      if (others.some((o) => o.role === 'owner')) return null
      return others.length ? 'shared' : 'solo'
    })
    if (kind === 'shared') shared.push(workspace_id)
    else if (kind === 'solo') solo.push(workspace_id)
  }
  return { shared, solo }
}

export async function soleOwnerWorkspaces(db: Kysely<CoreTables>, personId: string): Promise<string[]> {
  return (await ownedAlone(db, personId)).shared
}

export async function deleteAccount(deps: DeleteAccountDeps, personId: string): Promise<{ workspaces: number; workspacesDeleted: number; grantsRevoked: number; connectionsRevoked: number; documents: number }> {
  const { db, files, sync } = deps
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const { shared, solo } = await ownedAlone(db, personId)
  if (shared.length) throw new SoleOwnerError(shared)

  const person = await db.selectFrom('people').select(['id', 'auth_user_id']).where('id', '=', personId).executeTakeFirst()
  if (!person) return { workspaces: 0, workspacesDeleted: 0, grantsRevoked: 0, connectionsRevoked: 0, documents: 0 }
  const memberOf = await withBypass('account:memberships', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).execute())

  // 0. Workspaces only they belong to go first, whole (provider access revoked inside).
  for (const ws of solo) await withWorkspace(ws, () => deleteWorkspace(deps, ws))

  let grantsRevoked = 0
  let connectionsRevoked = 0
  let documents = 0
  for (const ws of await workspacesWithRowsOf(db, personId)) {
    await withWorkspace(ws, async () => {
      // 1. AI access.
      const grants = (await anyDb.selectFrom('grants').select(['id', 'workspace_id']).where('person_id', '=', personId).where('revoked_at', 'is', null).execute().catch(() => [])) as Array<{ id: string; workspace_id: string }>
      for (const g of grants) {
        if (deps.revokeGrant) await deps.revokeGrant(g.workspace_id, personId, g.id)
        else await anyDb.updateTable('grants').set({ revoked_at: new Date().toISOString(), revoked_by: personId }).where('id', '=', g.id).execute()
        grantsRevoked++
      }
      await anyDb.updateTable('agent_keys').set({ revoked_at: new Date().toISOString() }).where('created_by', '=', personId).where('revoked_at', 'is', null).execute().catch(() => undefined)

      // 2. Personal spaces: their own connections and documents.
      const personal = (await db.selectFrom('entities').select('id').where('owner_person_id', '=', personId).where('kind', '=', 'personal').execute()).map((e) => e.id)
      if (personal.length) {
        const conns = await db.selectFrom('connections').select('id').where('entity_id', 'in', personal).where('status', '!=', 'disconnected').execute()
        for (const c of conns) if ((await sync.disconnect(c.id)).revoked) connectionsRevoked++
        const docs = await db.selectFrom('documents').select(['id', 'storage_key']).where('entity_id', 'in', personal).execute()
        for (const d of docs) {
          await files.delete(d.storage_key).catch((err: unknown) => deps.log?.('file delete failed', { error: err instanceof Error ? err.message : 'unknown' }))
          await db.deleteFrom('documents').where('id', '=', d.id).execute()
          documents++
        }
      }

      // 3. The membership itself.
      await db.deleteFrom('memberships').where('person_id', '=', personId).execute()
    })
  }

  // 4. Person-level records (no workspace, so no row-level security): re-check history, then sign-in records.
  await anyDb.deleteFrom('reauth_events').where('person_id', '=', personId).execute().catch(() => undefined)
  // The person row stays (anonymized), so its creator-link attribution is removed here rather than by cascade.
  await forgetAttribution(anyDb, personId).catch(() => undefined)
  if (person.auth_user_id) {
    const uid = person.auth_user_id
    for (const t of ['auth_session', 'auth_account', 'passkey', 'oauthAccessToken', 'oauthRefreshToken', 'oauthConsent']) {
      await anyDb.deleteFrom(t).where('userId', '=', uid).execute().catch(() => undefined)
    }
    await anyDb.deleteFrom('auth_user').where('id', '=', uid).execute()
  }

  // 5. Keep the row (history points at it) but nothing that identifies them.
  await db.updateTable('people').set({ name: 'Former member', email: `deleted-${personId}@invalid`, auth_user_id: null }).where('id', '=', personId).execute()
  return { workspaces: memberOf.length, workspacesDeleted: solo.length, grantsRevoked, connectionsRevoked, documents }
}
