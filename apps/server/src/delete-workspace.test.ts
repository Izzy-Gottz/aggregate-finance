import { describe, expect, it } from 'vitest'
import { connect, connectPglite, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { createWorkspace } from '@agfn/auth'
import { MemoryFileStore } from '@agfn/files'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine, createConnection } from '@agfn/sync'
import { deleteWorkspace } from './delete-workspace.ts'

async function run(h: DbHandle<CoreTables>) {
  await migrateToLatest(h.db)
  const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
  const pid = newId()
  await h.db.insertInto('people').values({ id: pid, auth_user_id: null, name: 'F', email: 'f@x.com', created_at: nowIso() }).execute()
  const a = await createWorkspace(h.db, { personId: pid, workspaceName: 'A', firstCompanyName: 'Acme' })
  const b = await createWorkspace(h.db, { personId: pid, workspaceName: 'B', firstCompanyName: 'Other' })
  await createConnection(h.db, keys, { workspaceId: a.workspaceId, connectorKey: 'manual', displayName: 'Cash', secret: null, config: {}, createdBy: pid })
  const files = new MemoryFileStore()
  await files.put(`${a.workspaceId}/x.pdf`, new Uint8Array([1]))
  const sync = new SyncEngine({ db: h.db, keys, registry: new ConnectorRegistry(), ledger: {} as never, queue: new JobQueue(h.db) })
  const r = await deleteWorkspace({ db: h.db, files, sync }, a.workspaceId)
  expect(r.rows).toBeGreaterThan(3)
  const left = await h.db.selectFrom('workspaces').select('id').execute()
  expect(left.map((w) => w.id)).toEqual([b.workspaceId])
  expect(await h.db.selectFrom('entities').select('id').where('workspace_id', '=', a.workspaceId).execute()).toEqual([])
  expect(await h.db.selectFrom('people').select('id').execute()).toHaveLength(1)
  await h.close()
}

describe('deleteWorkspace', () => {
  it('removes one workspace and leaves the others (SQLite)', async () => run(connect<CoreTables>('sqlite::memory:')))
  it('removes one workspace and leaves the others (Postgres)', async () => run(await connectPglite<CoreTables>()), 60_000)
})
