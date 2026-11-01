import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import type { SyncEngine } from '@agfn/sync'

/**
 * One person leaves one workspace (removed by an owner or admin, or leaving themselves; a pending invite is cancelled the
 * same way). Within this workspace only, the same steps as deleting the account (delete-account.ts):
 *  - AI access they created here is revoked (grants with their keys, OAuth tokens and consent; loose agent keys);
 *  - their Personal space's bank connections here are disconnected and its documents deleted (nobody else may see
 *    them, so nobody could ever use them). Personal ledger rows stay, visible to nobody, as with a deleted account;
 *  - the membership is revoked, and any invite links for their email stop working.
 * Sessions stay: every request looks memberships up again (app.ts), so the workspace is gone from them at once, and
 * any other workspaces they're in keep working. Runs inside the workspace (row-level security); safe to run again.
 */
export class LastOwnerError extends Error {
  constructor(self: boolean) {
    super(self ? 'You’re the only owner. Make someone else an owner first, or delete the workspace.' : 'A workspace needs at least one owner. Make someone else an owner first.')
  }
}

export interface RemoveMemberDeps {
  db: Kysely<CoreTables>
  files: FileStore
  sync: SyncEngine
  /** Revokes one grant the way the app does (keys, OAuth tokens, consent). Optional when MCP isn't installed. */
  revokeGrant?: (workspaceId: string, personId: string, grantId: string) => Promise<void>
  log?: (m: string, f?: Record<string, unknown>) => void
}

/** True when this person is the workspace's only current owner. */
export async function isLastOwner(db: Kysely<CoreTables>, workspaceId: string, personId: string): Promise<boolean> {
  const owners = await db.selectFrom('memberships').select('person_id').where('workspace_id', '=', workspaceId).where('role', '=', 'owner').where('revoked_at', 'is', null).execute()
  return owners.length > 0 && owners.every((o) => o.person_id === personId)
}

export async function removeMember(deps: RemoveMemberDeps, workspaceId: string, personId: string, opts: { self: boolean }): Promise<{ grantsRevoked: number; connectionsRevoked: number; documents: number }> {
  const { db, files, sync } = deps
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
  const memberships = await db.selectFrom('memberships').select(['id', 'role']).where('workspace_id', '=', workspaceId).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
  if (!memberships.length) return { grantsRevoked: 0, connectionsRevoked: 0, documents: 0 }
  if (memberships.some((m) => m.role === 'owner') && (await isLastOwner(db, workspaceId, personId))) throw new LastOwnerError(opts.self)
  const now = new Date().toISOString()

  // 1. AI access, while the membership still stands (revoking checks the grant is theirs).
  let grantsRevoked = 0
  const grants = (await anyDb.selectFrom('grants').select('id').where('workspace_id', '=', workspaceId).where('person_id', '=', personId).where('revoked_at', 'is', null).execute().catch(() => [])) as Array<{ id: string }>
  for (const g of grants) {
    if (deps.revokeGrant) await deps.revokeGrant(workspaceId, personId, g.id)
    else await anyDb.updateTable('grants').set({ revoked_at: now, revoked_by: personId }).where('id', '=', g.id).execute()
    grantsRevoked++
  }
  await anyDb.updateTable('agent_keys').set({ revoked_at: now }).where('workspace_id', '=', workspaceId).where('created_by', '=', personId).where('revoked_at', 'is', null).execute().catch(() => undefined)

  // 2. Their Personal space here.
  let connectionsRevoked = 0
  let documents = 0
  const personal = (await db.selectFrom('entities').select('id').where('workspace_id', '=', workspaceId).where('owner_person_id', '=', personId).where('kind', '=', 'personal').execute()).map((e) => e.id)
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

  // 3. The membership, and invite links for their address (the welcome screen and its link stop answering).
  await db.updateTable('memberships').set({ revoked_at: now }).where('workspace_id', '=', workspaceId).where('person_id', '=', personId).where('revoked_at', 'is', null).execute()
  const person = await db.selectFrom('people').select('email').where('id', '=', personId).executeTakeFirst()
  if (person) {
    const invites = await db.selectFrom('settings').select(['key', 'value_json']).where('workspace_id', '=', workspaceId).where('key', 'like', 'invite:%').execute()
    const theirs = invites.filter((r) => {
      try {
        return String((JSON.parse(r.value_json) as { email?: unknown }).email ?? '').toLowerCase() === person.email.toLowerCase()
      } catch {
        return false
      }
    })
    if (theirs.length) await db.deleteFrom('settings').where('workspace_id', '=', workspaceId).where('key', 'in', theirs.map((r) => r.key)).execute()
  }
  return { grantsRevoked, connectionsRevoked, documents }
}
