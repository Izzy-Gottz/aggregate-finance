import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, Ledger, SyncResult } from '@agfn/contracts'
import { connect, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine, createConnection } from './index.ts'

const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
const ledger = { post: async () => ({ journalEntryId: null, status: 'recorded' }) } as unknown as Ledger
let h: DbHandle<CoreTables>
let ws: string
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  ws = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
})
afterEach(() => h.close())

/** A connector whose sync records the cursor it was given; `pages` controls how many runs a full pass takes. */
function engine(version: number | undefined, seen: Array<string | null>, pages = 1) {
  const registry = new ConnectorRegistry()
  const factory = (): Connector =>
    ({
      describe: () => ({ key: 'fake', name: 'Fake', group: 'banks', provides: [], freshness: 'updates hourly', auth: 'api_key', ...(version ? { dataVersion: version } : {}) }),
      connect: async () => ({ secret: {}, config: {} }),
      health: async () => ({ status: 'ok' }),
      sync: async (_c: unknown, cursor: string | null): Promise<SyncResult> => {
        seen.push(cursor)
        const n = cursor ? Number(cursor.split(':')[1]) : 0
        return { events: [], cursor: `c:${n + 1}`, hasMore: n + 1 < pages } as SyncResult
      },
    }) as unknown as Connector
  registry.register(factory as never, { raw: { put: async () => 'x' } })
  return new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db), maxPagesPerRun: 1 } as never)
}

describe('connector dataVersion', () => {
  it('re-imports once from the start after an upgrade, then resumes incrementally', async () => {
    const id = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'F', secret: null, config: {}, createdBy: null })
    const seen: Array<string | null> = []
    await engine(undefined, seen).sync(id)
    await engine(undefined, seen).sync(id)
    expect(seen).toEqual([null, 'c:1'])
    await engine(2, seen).sync(id) // upgraded: starts over
    await engine(2, seen).sync(id) // already done: incremental
    expect(seen.slice(2)).toEqual([null, 'c:1'])
    await engine(3, seen).sync(id) // next upgrade: starts over again
    expect(seen.at(-1)).toBeNull()
  })
})
