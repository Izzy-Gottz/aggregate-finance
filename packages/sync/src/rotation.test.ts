// Rotating refresh tokens (Brex, Mercury, Stripe Apps, Shopify): the new token is kept the moment the connector has
// it, before any page is fetched, so a page that fails afterwards (or a crash) can't leave a spent token stored.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectionRef, Ledger, SyncResult } from '@agfn/contracts'
import { ConnectorError, type ConnectorDeps } from '@agfn/connector-sdk'
import { connect, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { generateMasterKey, loadKeyRing, unseal } from '@agfn/security'
import { ConnectorRegistry, SyncEngine, createConnection } from './index.ts'
import { SECRET_PURPOSE } from './engine.ts'

const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
const ledger = { post: async () => ({ journalEntryId: null, status: 'posted' }) } as unknown as Ledger
let h: DbHandle<CoreTables>
let ws: string
beforeEach(async () => {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  ws = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
})
afterEach(() => h.close())

/** A provider whose refresh tokens are single use: refreshing with a spent one is "sign in again". */
function provider() {
  const valid = new Set(['refresh-1'])
  let n = 1
  const seen: string[] = []
  let failPages = 0
  const factory = (deps: ConnectorDeps): Connector =>
    ({
      describe: () => ({ key: 'rotating', name: 'Rotating', group: 'banks', provides: [], freshness: 'instant', auth: 'oauth' }),
      connect: async () => ({ secret: {}, config: {} }),
      health: async () => ({ status: 'ok' }),
      async sync(conn: ConnectionRef): Promise<SyncResult> {
        const s = conn.secret as { refresh: string }
        seen.push(s.refresh)
        if (!valid.delete(s.refresh)) throw new ConnectorError('auth', 'refresh token already used', { provider: 'rotating' })
        const next = { refresh: `refresh-${++n}` }
        valid.add(next.refresh)
        await deps.saveSecret?.(conn.id, next)
        if (failPages > 0) {
          failPages--
          throw new ConnectorError('rate_limited', 'slow down', { provider: 'rotating', status: 429 })
        }
        return { events: [], cursor: null, hasMore: false, updatedSecret: next }
      },
    }) as unknown as Connector
  return { factory, seen, failNext: (k: number) => void (failPages = k) }
}

function engineWith(factory: (d: ConnectorDeps) => Connector) {
  const registry = new ConnectorRegistry()
  registry.register(factory as never, { raw: { put: async () => 'x' } })
  return new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
}
const secretOf = async (id: string) => {
  const row = await h.db.selectFrom('connections').select(['secret_enc', 'status']).where('id', '=', id).executeTakeFirstOrThrow()
  return { status: row.status, secret: unseal(keys, row.secret_enc!, { workspaceId: ws, recordId: id, purpose: SECRET_PURPOSE }) as { refresh: string } }
}

describe('rotating refresh tokens', () => {
  it('refreshed, then the page is rate-limited out: the new token is already kept, and the next sync uses it', async () => {
    const p = provider()
    const eng = engineWith(p.factory)
    const id = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'rotating', displayName: 'Bank', secret: { refresh: 'refresh-1' }, config: {}, createdBy: null })
    p.failNext(1)
    await eng.sync(id).catch(() => undefined)
    expect((await secretOf(id)).secret).toEqual({ refresh: 'refresh-2' })
    const out = await eng.sync(id)
    expect(out.status).toBe('ok')
    expect(p.seen).toEqual(['refresh-1', 'refresh-2'])
    const after = await secretOf(id)
    expect([after.status, after.secret]).toEqual(['active', { refresh: 'refresh-3' }])
  })

  it('connections sharing one sign-in all get the rotated token, even when the page fails', async () => {
    const p = provider()
    const eng = engineWith(p.factory)
    const cfg = { sharedSecretKey: 'grant-1' }
    const a = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'rotating', displayName: 'Org A', secret: { refresh: 'refresh-1' }, config: cfg, createdBy: null })
    const b = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'rotating', displayName: 'Org B', secret: { refresh: 'refresh-1' }, config: cfg, createdBy: null })
    p.failNext(1)
    await eng.sync(a).catch(() => undefined)
    expect((await secretOf(b)).secret).toEqual({ refresh: 'refresh-2' })
    expect((await eng.sync(b)).status).toBe('ok')
    expect((await secretOf(a)).secret).toEqual({ refresh: 'refresh-3' })
  })

  it('a connector may only keep its own connection’s secret', async () => {
    const registry = new ConnectorRegistry()
    const other = newId()
    registry.register(
      ((deps: ConnectorDeps) =>
        ({
          describe: () => ({ key: 'sneaky', name: 'S', group: 'banks', provides: [], freshness: 'instant', auth: 'oauth' }),
          connect: async () => ({ secret: {}, config: {} }),
          health: async () => ({ status: 'ok' }),
          sync: async () => {
            await deps.saveSecret?.(other, { stolen: true })
            return { events: [], cursor: null, hasMore: false }
          },
        }) as unknown as Connector) as never,
      { raw: { put: async () => 'x' } },
    )
    const eng = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const id = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'sneaky', displayName: 'S', secret: { mine: 1 }, config: {}, createdBy: null })
    await expect(eng.sync(id)).rejects.toThrow(/another connection/)
  })
})
