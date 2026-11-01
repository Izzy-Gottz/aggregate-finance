// The demo's connections sync at the same time in one workspace (as on the hosted server), with afterSync hooks
// that make several ledger writes in one transaction (like the demo's seeded AI write). It must finish, and the
// books must come out exactly as when the same connections sync one after another.
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, connectPglite, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine } from '@agfn/sync'
import { createDemoConnector } from '@agfn/connector-demo'
import { ledgerFor } from '@agfn/server/modules'
import { createDemoWorkspace } from './index.ts'

const NOW = new Date('2026-10-09T12:00:00Z')
const handles: Array<DbHandle<CoreTables>> = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.close()
})

async function importDemo(open: () => Promise<DbHandle<CoreTables>>, concurrent: boolean): Promise<Record<string, number>> {
  const h = await open()
  handles.push(h)
  await migrateToLatest(h.db)
  const keys = loadKeyRing({ AGFN_MASTER_KEY: randomBytes(32).toString('base64') })
  const registry = new ConnectorRegistry()
  const clock = { now: () => NOW.getTime(), sleep: async () => {} }
  registry.register((deps) => createDemoConnector({ ...deps, clock }), { raw: { put: async () => '' } })
  const ledger = ledgerFor(h.db)
  // A hook like the demo's seeded AI write: two ledger writes inside one transaction.
  const afterSync = [async (ws: string) => ledger.transaction(async () => {
    await ledger.redate(ws)
    await ledger.redate(ws)
  }).then(() => undefined)]
  const sync = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db), connectorDeps: { clock }, afterSync })
  const personId = newId()
  await h.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'D', email: 'd@example.com', created_at: nowIso() }).execute()
  const ws = await createDemoWorkspace({ db: h.db, keys, now: () => NOW }, { personId, historyDays: 60 })
  const untilDone = async (id: string) => {
    for (let i = 0; i < 50; i++) if ((await sync.sync(id)).status !== 'partial') return
  }
  if (concurrent) await Promise.all(ws.connections.map(untilDone))
  else for (const id of ws.connections) await untilDone(id)
  const out: Record<string, number> = {}
  const entities = await h.db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', ws.workspaceId).execute()
  for (const e of entities) {
    const cash = await ledger.metric('cash', { workspaceId: ws.workspaceId, entityIds: [e.id] })
    out[e.name] = (cash.value as { minor: number } | null)?.minor ?? 0
  }
  return out
}

const backends: Array<[string, () => Promise<DbHandle<CoreTables>>]> = [
  ['sqlite', async () => connect<CoreTables>('sqlite::memory:')],
  ['postgres (pglite)', async () => connectPglite<CoreTables>()],
]

describe.each(backends)('demo connections syncing at once (%s)', (_name, open) => {
  it('finishes, with the same books as one connection after another', async () => {
    const sequential = await importDemo(open, false)
    const together = await Promise.race([importDemo(open, true), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('deadlock: concurrent import did not finish')), 120_000))])
    expect(together).toEqual(sequential)
    expect(Object.values(sequential).some((v) => v !== 0)).toBe(true)
  }, 300_000)
})
