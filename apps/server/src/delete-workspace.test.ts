import type { Kysely } from 'kysely'
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
  // Every table with a workspace_id, foreign key or not, so a new table can't keep rows after a delete.
  const db = h.db as unknown as Kysely<any>
  for (const t of (await db.introspection.getTables()).filter((x) => x.columns.some((c) => c.name === 'workspace_id'))) {
    expect(await db.selectFrom(t.name).select('workspace_id').where('workspace_id', '=', a.workspaceId).execute(), t.name).toEqual([])
  }
  expect(await h.db.selectFrom('people').select('id').execute()).toHaveLength(1)
  await h.close()
}

describe('deleteWorkspace', () => {
  it('removes one workspace and leaves the others (SQLite)', async () => run(connect<CoreTables>('sqlite::memory:')))
  it('removes one workspace and leaves the others (Postgres)', async () => run(await connectPglite<CoreTables>()), 60_000)
})

it('a background write that lands after its table was cleared does not stop the delete', async () => {
  const h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
  const pid = newId()
  await h.db.insertInto('people').values({ id: pid, auth_user_id: null, name: 'F', email: 'f@x.com', created_at: nowIso() }).execute()
  const a = await createWorkspace(h.db, { personId: pid, workspaceName: 'A', firstCompanyName: 'Acme' })
  const sync = new SyncEngine({ db: h.db, keys, registry: new ConnectorRegistry(), ledger: {} as never, queue: new JobQueue(h.db) })
  // A warm writes its row just before the first try at the workspace row.
  let raced = false
  const racing = new Proxy(h.db, {
    get(t, k) {
      if (k !== 'deleteFrom') { const v = Reflect.get(t, k); return typeof v === 'function' ? v.bind(t) : v }
      return (table: 'workspaces') => {
        const q = t.deleteFrom(table)
        if (table !== 'workspaces' || raced) return q
        raced = true
        return { where: (...w: Parameters<typeof q.where>) => ({ execute: async () => {
          await (t as never as Kysely<any>).insertInto('ledger_derived').values({ workspace_id: a.workspaceId, key_hash: 'k', cache_key: 'c', version: 1, value_json: '{}', created_at: nowIso() }).execute()
          return q.where(...w).execute()
        } }) }
      }
    },
  })
  await deleteWorkspace({ db: racing, files: new MemoryFileStore(), sync }, a.workspaceId)
  expect(raced).toBe(true)
  expect(await h.db.selectFrom('workspaces').select('id').execute()).toEqual([])
})
