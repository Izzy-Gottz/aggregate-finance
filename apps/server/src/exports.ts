// Export files are a full copy of a workspace's books. A link lives an hour; the file must not outlive it.
import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'

/** Delete export files (and their link records) whose link has expired. Optionally for one workspace only. */
export async function pruneExpiredExports(db: Kysely<CoreTables>, files: FileStore, opts: { workspaceId?: string; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now()
  let q = db.selectFrom('settings').select(['workspace_id', 'key', 'value_json']).where('key', 'like', 'export:%')
  if (opts.workspaceId) q = q.where('workspace_id', '=', opts.workspaceId)
  let n = 0
  for (const r of await q.execute()) {
    const meta = JSON.parse(r.value_json) as { key?: string; expiresAt?: string }
    if (meta.expiresAt && Date.parse(meta.expiresAt) > now) continue
    if (meta.key) await files.delete(meta.key)
    await db.deleteFrom('settings').where('workspace_id', '=', r.workspace_id).where('key', '=', r.key).execute()
    n++
  }
  return n
}
