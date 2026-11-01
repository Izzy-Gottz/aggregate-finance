// Workspaces nobody belongs to any more (data-retention policy: deleting your account deletes your data). A workspace
// is deleted, through the same path as DELETE /api/workspace, once its last member leaves or deletes their account; a
// demo workspace always goes when its person leaves the demo. Member-less workspaces are never synced, and a daily job
// (plus one pass at boot) removes any left from before this existed.

import type { Kysely } from 'kysely'
import { withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import type { SyncEngine } from '@agfn/sync'
import { deleteWorkspace } from './delete-workspace.ts'

export interface OrphanDeps {
  db: Kysely<CoreTables>
  files: FileStore
  sync: SyncEngine
  log?: (m: string, f?: Record<string, unknown>) => void
}

/** True when at least one person still belongs to the workspace (a membership that isn't revoked). */
export async function hasMembers(db: Kysely<CoreTables>, workspaceId: string): Promise<boolean> {
  const m = await withBypass('orphans:members', () => db.selectFrom('memberships').select('person_id').where('workspace_id', '=', workspaceId).where('revoked_at', 'is', null).executeTakeFirst())
  return Boolean(m)
}

/** Every workspace with no remaining member. */
export async function memberlessWorkspaces(db: Kysely<CoreTables>): Promise<string[]> {
  const rows = await withBypass('orphans:list', () =>
    db
      .selectFrom('workspaces')
      .select('id')
      .where(({ not, exists, selectFrom }) => not(exists(selectFrom('memberships').select('person_id').whereRef('memberships.workspace_id', '=', 'workspaces.id').where('memberships.revoked_at', 'is', null))))
      .execute(),
  )
  return rows.map((r) => r.id)
}

/** Delete these workspaces if nobody belongs to them any more; returns how many went. */
export async function deleteIfMemberless(deps: OrphanDeps, workspaceIds: Iterable<string>): Promise<number> {
  let n = 0
  for (const ws of new Set(workspaceIds)) {
    const there = await withBypass('orphans:exists', () => deps.db.selectFrom('workspaces').select('id').where('id', '=', ws).executeTakeFirst())
    if (!there || (await hasMembers(deps.db, ws))) continue
    await withWorkspace(ws, () => deleteWorkspace(deps, ws))
    n++
  }
  return n
}

/**
 * Deleting a big workspace (a demo's year of books) takes seconds: the request that emptied it answers at once and this
 * job deletes it, through deleteIfMemberless (the same path, and a no-op if someone belongs again). Leased and run by the
 * newest release like every job; the daily pass catches any that never ran. No workspace_id on the job itself, so the
 * delete never removes its own job row.
 */
export const WORKSPACE_DELETE_JOB = 'workspace.delete'
export async function queueIfMemberless(deps: { db: Kysely<CoreTables>; queue: { enqueue: (kind: string, payload: unknown, opts?: { uniqueKey?: string; maxAttempts?: number }) => Promise<unknown> } }, workspaceIds: Iterable<string>): Promise<number> {
  let n = 0
  for (const ws of new Set(workspaceIds)) {
    if (await hasMembers(deps.db, ws)) continue
    await withBypass('orphans:queue', () => deps.queue.enqueue(WORKSPACE_DELETE_JOB, { workspaceId: ws }, { uniqueKey: ws, maxAttempts: 5 }))
    n++
  }
  return n
}

/** The workspaces a person currently belongs to (read before they leave, to check afterwards). */
export async function workspacesOf(db: Kysely<CoreTables>, personId: string): Promise<string[]> {
  const rows = await withBypass('orphans:mine', () => db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('revoked_at', 'is', null).execute())
  return rows.map((r) => r.workspace_id)
}

/** The daily (and boot) pass: delete every member-less workspace. One that fails doesn't stop the rest; counts only. */
export async function deleteMemberlessWorkspaces(deps: OrphanDeps): Promise<number> {
  let n = 0
  let failed = 0
  let firstError = ''
  for (const ws of await memberlessWorkspaces(deps.db)) {
    try {
      n += await deleteIfMemberless(deps, [ws])
    } catch (err) {
      failed++
      firstError ||= err instanceof Error ? err.message : String(err)
    }
  }
  if (n) deps.log?.('retention: workspaces with no members deleted', { count: n })
  if (failed) deps.log?.('retention: workspaces with no members not deleted (retried tomorrow)', { count: failed, error: firstError.slice(0, 600) })
  return n
}
