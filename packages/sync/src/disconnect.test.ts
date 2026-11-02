import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, Ledger } from '@agfn/contracts'
import { connect, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine, createConnection } from './index.ts'

const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
const ledger = {} as Ledger
let h: DbHandle<CoreTables>
let ws: string
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  ws = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
})
afterEach(() => h.close())

function engine(disconnect?: (ref: ConnectionRef) => Promise<void>, logs: string[] = []) {
  const registry = new ConnectorRegistry()
  const factory = (): Connector =>
    ({
      describe: () => ({ key: 'fake', name: 'Fake', group: 'banks', provides: [], freshness: 'instant', auth: 'api_key' }),
      connect: async () => ({ secret: {}, config: {} }),
      health: async () => ({ status: 'ok' }),
      sync: async () => ({ events: [], nextCursor: null, hasMore: false }),
      ...(disconnect ? { disconnect } : {}),
    }) as unknown as Connector
  registry.register(factory as never, { raw: { put: async () => 'x' } })
  return new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db), log: (m) => void logs.push(m) })
}

describe('SyncEngine.disconnect', () => {
  it('tells a connector with an accountKey whether that account is live elsewhere, in any workspace', async () => {
    const other = newId()
    await h.db.insertInto('workspaces').values({ id: other, name: 'Other', base_currency: 'USD', created_at: nowIso() }).execute()
    const seen: ConnectionRef[] = []
    const registry = new ConnectorRegistry()
    registry.register(
      (() =>
        ({
          describe: () => ({ key: 'fake', name: 'Fake', group: 'banks', provides: [], freshness: 'instant', auth: 'api_key' }),
          accountKey: (c: Record<string, unknown>) => c.shop,
          disconnect: async (ref: ConnectionRef) => void seen.push(ref),
        }) as unknown as Connector) as never,
      { raw: { put: async () => 'x' } },
    )
    const sync = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const add = (workspaceId: string, shop: string) => createConnection(h.db, keys, { workspaceId, connectorKey: 'fake', displayName: shop, secret: { accessToken: 'tok' }, config: { shop }, createdBy: null })
    const a = await add(ws, 'one')
    const b = await add(other, 'one')
    const c = await add(ws, 'two')
    await sync.disconnect(a)
    await sync.disconnect(b)
    await sync.disconnect(c)
    expect(seen.map((r) => r.config.liveElsewhere)).toEqual([true, false, false])
  })

  it('revokes at the provider with the unsealed secret, then forgets it', async () => {
    const id = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Bank', secret: { accessToken: 'tok' }, config: { a: 1 }, createdBy: null })
    const seen: ConnectionRef[] = []
    expect(await engine(async (ref) => void seen.push(ref)).disconnect(id)).toEqual({ revoked: true })
    expect(seen[0]).toMatchObject({ id, secret: { accessToken: 'tok' }, config: { a: 1 } })
    const row = await h.db.selectFrom('connections').select(['status', 'secret_enc']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'disconnected', secret_enc: null })
  })

  it('still disconnects locally when the provider call fails or is not supported', async () => {
    const logs: string[] = []
    const a = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'A', secret: { t: 1 }, config: {}, createdBy: null })
    expect(await engine(async () => Promise.reject(new Error('plaid down')), logs).disconnect(a)).toEqual({ revoked: false, warning: expect.stringContaining('remove Aggregate if it’s still listed') })
    expect(logs).toContain('provider disconnect failed')
    const b = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'B', secret: { t: 1 }, config: {}, createdBy: null })
    // Nothing to call at the provider: never silent, or the access stays live there and nobody knows.
    expect(await engine().disconnect(b)).toEqual({ revoked: false, warning: expect.stringContaining('In B, remove Aggregate or delete the key') })
    const rows = await h.db.selectFrom('connections').select('status').execute()
    expect(rows.every((r) => r.status === 'disconnected')).toBe(true)
  })
})

describe('a disconnect while a sync is running', () => {
  it('stops before the next page: nothing from it posts, no error or sign-in alert, the connection stays disconnected', async () => {
    const posted: string[] = []
    const ledger = { post: async (_ws: string, e: { externalId: string }) => (posted.push(e.externalId), { journalEntryId: null, status: 'posted' }) } as unknown as Ledger
    let eng: SyncEngine
    let id = ''
    const registry = new ConnectorRegistry()
    const factory = (): Connector =>
      ({
        describe: () => ({ key: 'fake', name: 'Fake', group: 'banks', provides: [], freshness: 'instant', auth: 'api_key' }),
        connect: async () => ({ secret: {}, config: {} }),
        health: async () => ({ status: 'ok' }),
        sync: async (_ref: ConnectionRef, cursor: string | null) => {
          const ev = (x: string) => ({ type: 'txn.upsert', externalId: x, connectionId: id, accountExternalId: 'a', date: '2026-10-01', amount: { minor: -100, currency: 'USD' }, status: 'posted' })
          if (cursor === null) return { events: [ev('p1')], cursor: 'page2', hasMore: true }
          // The person removes the connection while the provider is still answering.
          await eng.disconnect(id)
          return { events: [ev('p2')], cursor: 'done', hasMore: false }
        },
      }) as unknown as Connector
    registry.register(factory as never, { raw: { put: async () => 'x' } })
    eng = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    id = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Bank', secret: { t: 1 }, config: {}, createdBy: null })
    const out = await eng.sync(id)
    expect(out).toMatchObject({ status: 'ok', message: 'disconnected' })
    expect(posted).toEqual(['p1'])
    const row = await h.db.selectFrom('connections').select(['status', 'last_error', 'cursor']).where('id', '=', id).executeTakeFirstOrThrow()
    expect(row).toEqual({ status: 'disconnected', last_error: null, cursor: 'page2' })
  })
})

