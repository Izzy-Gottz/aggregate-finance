import type { Kysely } from 'kysely'
import type { CoreTables } from '@agfn/db'
import type { FileStore } from '@agfn/files'
import type { SyncEngine } from '@agfn/sync'

/**
 * Other members whose Personal connections (still connected) go when the workspace is deleted: shown to the owner
 * before they confirm (counts only, Personal stays private) and emailed before it runs (their own connection names).
 */
export async function personalAffected(db: Kysely<CoreTables>, workspaceId: string, exceptPersonId: string): Promise<Array<{ personId: string; name: string; email: string; connections: string[] }>> {
  const rows = await db
    .selectFrom('connections')
    .innerJoin('entities', 'entities.id', 'connections.entity_id')
    .innerJoin('people', 'people.id', 'entities.owner_person_id')
    .innerJoin('memberships', (j) => j.onRef('memberships.person_id', '=', 'people.id').onRef('memberships.workspace_id', '=', 'connections.workspace_id'))
    .select(['people.id as personId', 'people.name as name', 'people.email as email', 'connections.display_name as connection'])
    .where('connections.workspace_id', '=', workspaceId)
    .where('entities.kind', '=', 'personal')
    .where('connections.status', '!=', 'disconnected')
    .where('memberships.revoked_at', 'is', null)
    .where('people.id', '!=', exceptPersonId)
    .orderBy('people.name')
    .execute()
  const by = new Map<string, { personId: string; name: string; email: string; connections: string[] }>()
  for (const r of rows) {
    const p = by.get(r.personId) ?? { personId: r.personId, name: r.name, email: r.email, connections: [] }
    if (!p.connections.includes(r.connection)) p.connections.push(r.connection)
    by.set(r.personId, p)
  }
  return [...by.values()]
}

/**
 * Delete a whole workspace (MASTER §9, Plaid questionnaire "can users delete their data?"): revoke every provider
 * connection, delete stored files, then delete every row that belongs to the workspace. Sign-in accounts stay, so
 * people in other workspaces keep working. Safe to run again if it stops halfway.
 */
export async function deleteWorkspace(deps: { db: Kysely<CoreTables>; files: FileStore; sync: SyncEngine; log?: (m: string, f?: Record<string, unknown>) => void }, workspaceId: string): Promise<{ connectionsRevoked: number; notRevoked: string[]; files: number; rows: number }> {
  const { db, files, sync } = deps
  const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>

  // 1. Provider access first, so nothing stays live (or billed) at Plaid and others.
  let connectionsRevoked = 0
  const conns = await db.selectFrom('connections').select('id').where('workspace_id', '=', workspaceId).where('secret_enc', 'is not', null).execute()
  // What's still live at a provider, and what the person must do there: nobody else can tell them.
  const notRevoked: string[] = []
  for (const c of conns) {
    const out = await sync.disconnect(c.id)
    if (out.revoked) connectionsRevoked++
    else if (out.warning) notRevoked.push(out.warning)
  }

  // Nothing new is queued for it from here on, by this server or another one still running an older release.
  await db.updateTable('connections').set({ status: 'disconnected' }).where('workspace_id', '=', workspaceId).execute()

  // 2. Files (documents and exports).
  let fileCount = 0
  const docs = await db.selectFrom('documents').select('storage_key').where('workspace_id', '=', workspaceId).execute()
  const exportsRows = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', workspaceId).where('key', 'like', 'export:%').execute()
  const keys = [...docs.map((d) => d.storage_key), ...exportsRows.map((r) => (JSON.parse(r.value_json) as { key: string }).key)]
  for (const k of new Set(keys)) {
    await files.delete(k).catch((err: unknown) => deps.log?.('file delete failed', { error: err instanceof Error ? err.message : 'unknown' }))
    fileCount++
  }

  // 3. Rows. Tables reference each other, so delete in rounds until a whole round goes through with nothing failing.
  // Every round tries every table again, not just the ones that failed: a sync still finishing elsewhere can add
  // children (journal lines) to a table that was already cleared, and those must go before their parents can.
  const grantIds = (await anyDb.selectFrom('grants').select('id').where('workspace_id', '=', workspaceId).execute().catch(() => [])) as Array<{ id: string }>
  if (grantIds.length) await anyDb.deleteFrom('oauth_pending_grants').where('grant_id', 'in', grantIds.map((g) => g.id)).execute().catch(() => undefined)
  const tables = (await db.introspection.getTables()).filter((t) => t.name !== 'workspaces' && t.columns.some((c) => c.name === 'workspace_id')).map((t) => t.name)
  let rows = 0
  let failed: string[] = []
  const why = new Map<string, string>()
  for (let round = 0; round < 12; round++) {
    failed = []
    why.clear()
    for (const t of tables) {
      try {
        const r = await anyDb.deleteFrom(t).where('workspace_id', '=', workspaceId).executeTakeFirst()
        rows += Number(r.numDeletedRows ?? 0)
      } catch (err) {
        failed.push(t)
        why.set(t, err instanceof Error ? err.message.slice(0, 200) : String(err))
      }
    }
    // The workspace itself goes in the round too: a background write (a warm's ledger_derived row) can land after its
    // table was cleared, and then this fails on that row until the next round takes it.
    if (!failed.length) {
      try {
        await db.deleteFrom('workspaces').where('id', '=', workspaceId).execute()
        break
      } catch (err) {
        failed.push('workspaces')
        why.set('workspaces', err instanceof Error ? err.message.slice(0, 200) : String(err))
      }
    }
    if (round > 2) await new Promise((r) => setTimeout(r, 250 * round)) // give a writer elsewhere time to finish
  }
  if (failed.length) throw new Error(`could not delete rows from: ${failed.map((t) => `${t} (${why.get(t)})`).join('; ')}`)
  return { connectionsRevoked, notRevoked, files: fileCount, rows: rows + 1 }
}
