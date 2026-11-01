import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connector, ConnectorDescription, Ledger, NormalizedEvent, PostResult, SyncResult } from '@agfn/contracts'
import { connect, connectPglite, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { generateMasterKey, loadKeyRing, unseal } from '@agfn/security'
import { ConnectorError, plainError, type ConnectorDeps } from '@agfn/connector-sdk'
import { ConnectorRegistry, SyncEngine, createConnection, SECRET_PURPOSE } from './index.ts'
import { spreadOffset } from './engine.ts'

const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
let h: DbHandle<CoreTables>
let ws: string
const posted: NormalizedEvent[] = []
const ledger: Ledger = {
  post: async (_w, e): Promise<PostResult> => {
    posted.push(e)
    return { journalEntryId: e.type === 'txn.upsert' ? newId() : null, status: e.type === 'txn.upsert' ? 'posted' : 'recorded' }
  },
  link: async () => ({ linkId: 'l', status: 'proposed' }),
  suggestLinks: async () => [],
  metric: async () => {
    throw new Error('unused')
  },
}

const desc: ConnectorDescription = { key: 'fake', name: 'Fake Bank', group: 'banks', provides: ['balances', 'transactions'], freshness: 'instant', auth: 'api_key' }
type Script = (cursor: string | null, secret: unknown) => SyncResult
function fakeFactory(script: Script) {
  return (deps: ConnectorDeps): Connector => ({
    describe: () => desc,
    connect: async () => ({ secret: {}, config: {} }),
    health: async () => ({ status: 'ok' }),
    sync: async (conn, cursor) => {
      const r = script(cursor, conn.secret)
      for (const e of r.events) e.rawRef = await deps.raw.put(conn.id, e.type, e.externalId, { e })
      return r
    },
  })
}

function engineWith(script: Script) {
  const registry = new ConnectorRegistry()
  registry.register(fakeFactory(script), { raw: { put: async () => 'x' } })
  return new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
}

beforeEach(async () => {
  posted.length = 0
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  ws = newId()
  await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
})
afterEach(() => h.close())

describe('SyncEngine', () => {
  it('pages through, upserts accounts, posts events, stores raw, checkpoints cursor and rotated secret', async () => {
    const connId = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Fake', secret: { token: 't1' }, config: {}, createdBy: null })
    const engine = engineWith((cursor) => {
      if (cursor === null) {
        return {
          cursor: 'c1',
          hasMore: true,
          events: [{ type: 'account.upsert', externalId: 'a1', connectionId: connId, name: 'Checking', accountType: 'depository', currency: 'USD', mask: '1234', institution: 'Chase' }],
        }
      }
      return {
        cursor: 'c2',
        hasMore: false,
        updatedSecret: { token: 't2' },
        events: [{ type: 'txn.upsert', externalId: 't1', connectionId: connId, accountExternalId: 'a1', date: '2026-10-01', amount: { minor: -4200, currency: 'USD' }, status: 'posted' }],
      }
    })
    const out = await engine.sync(connId)
    expect(out).toMatchObject({ status: 'ok', events: 2, posted: 1 })
    expect(posted.map((e) => e.type)).toEqual(['account.upsert', 'txn.upsert'])
    const accounts = await h.db.selectFrom('accounts').selectAll().execute()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]).toMatchObject({ name: 'Checking', entity_id: null, mask: '1234' })
    expect(await h.db.selectFrom('raw_records').select('id').execute()).toHaveLength(2)
    const conn = await h.db.selectFrom('connections').selectAll().where('id', '=', connId).executeTakeFirstOrThrow()
    expect(conn.cursor).toBe('c2')
    expect(conn.status).toBe('active')
    expect(unseal(keys, conn.secret_enc!, { workspaceId: ws, recordId: connId, purpose: SECRET_PURPOSE })).toEqual({ token: 't2' })

    // A second run is idempotent for accounts and raw records.
    await engine.sync(connId)
    expect(await h.db.selectFrom('accounts').select('id').execute()).toHaveLength(1)
  })

  it('a rotated token shared by sibling connections reaches all of them; siblings sync one at a time', async () => {
    const make = (name: string, config: Record<string, unknown>) => createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: name, secret: { token: 't1' }, config, createdBy: null })
    const a = await make('Org A', { sharedSecretKey: 'grant-1' })
    const b = await make('Org B', { sharedSecretKey: 'grant-1' })
    const other = await make('Other grant', { sharedSecretKey: 'grant-2' })
    const solo = await make('Solo', {})
    let running = 0
    let overlapped = false
    const engine = engineWith((_cursor, secret) => {
      const t = (secret as { token: string }).token
      return { cursor: null, hasMore: false, events: [], updatedSecret: { token: `${t}+` } }
    })
    // Wrap sync so we can see whether two siblings ever ran at once.
    const inner = (engine as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne.bind(engine)
    ;(engine as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne = async (id) => {
      running++
      if (running > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 5))
      try {
        return await inner(id)
      } finally {
        running--
      }
    }
    await Promise.all([engine.sync(a), engine.sync(b)])
    expect(overlapped).toBe(false)
    const secretOf = async (id: string) => {
      const r = await h.db.selectFrom('connections').select(['secret_enc', 'workspace_id']).where('id', '=', id).executeTakeFirstOrThrow()
      return unseal(keys, r.secret_enc!, { workspaceId: r.workspace_id, recordId: id, purpose: SECRET_PURPOSE })
    }
    // A rotated t1 → t1+, shared to B; then B (reading t1+) rotated to t1++, shared back to A.
    expect(await secretOf(a)).toEqual({ token: 't1++' })
    expect(await secretOf(b)).toEqual({ token: 't1++' })
    expect(await secretOf(other)).toEqual({ token: 't1' })
    expect(await secretOf(solo)).toEqual({ token: 't1' })
  })

  it('one connection synced twice at once (a request while the worker runs it) runs one sync after the other, each with the latest secret', async () => {
    const solo = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Solo', secret: { token: 't1' }, config: {}, createdBy: null })
    const seen: string[] = []
    let running = 0
    let overlapped = false
    const engine = engineWith((_cursor, secret) => {
      const t = (secret as { token: string }).token
      seen.push(t)
      return { cursor: null, hasMore: false, events: [], updatedSecret: { token: `${t}+` } }
    })
    const inner = (engine as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne.bind(engine)
    ;(engine as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne = async (id) => {
      running++
      if (running > 1) overlapped = true
      await new Promise((r) => setTimeout(r, 5))
      try {
        return await inner(id)
      } finally {
        running--
      }
    }
    await Promise.all([engine.sync(solo), engine.sync(solo)])
    expect(overlapped).toBe(false)
    // The second run read the token the first one rotated, not the one it would have read at the same moment.
    expect(seen).toEqual(['t1', 't1+'])
  })

  it("disconnect: a token the connector refreshed reaches the siblings; a provider refusal comes back as the connector's warning", async () => {
    const registry = new ConnectorRegistry()
    registry.register(
      (deps) => ({
        ...fakeFactory(() => ({ cursor: null, hasMore: false, events: [] }))(deps),
        disconnect: async (ref) => {
          await deps.saveSecret?.(ref.id, { token: 'rotated' })
          throw new ConnectorError('permanent', 'Xero refused to revoke access (HTTP 400). Remove "Aggregate" in Xero under Settings → Connected apps.', { provider: 'fake', forUser: true })
        },
      }),
      { raw: { put: async () => 'x' } },
    )
    const engine = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const make = () => createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'X', secret: { token: 't' }, config: { sharedSecretKey: 'g' }, createdBy: null })
    const a = await make()
    const b = await make()
    const out = await engine.disconnect(a)
    expect(out).toEqual({ revoked: false, warning: expect.stringMatching(/Connected apps/) })
    const r = await h.db.selectFrom('connections').select(['secret_enc', 'status']).where('id', '=', b).executeTakeFirstOrThrow()
    expect(r.status).not.toBe('disconnected')
    expect(unseal(keys, r.secret_enc!, { workspaceId: ws, recordId: b, purpose: SECRET_PURPOSE })).toEqual({ token: 'rotated' })
    expect((await h.db.selectFrom('connections').select('secret_enc').where('id', '=', a).executeTakeFirstOrThrow()).secret_enc).toBeNull()
  })

  it('offers what the grant reaches but the workspace lacks; adding one makes exactly one connection on the shared token', async () => {
    const registry = new ConnectorRegistry()
    registry.register(
      (deps) => ({
        ...fakeFactory(() => ({ cursor: null, hasMore: false, events: [] }))(deps),
        listShared: async () => ['t-a', 't-demo'].map((t) => ({ id: t, name: t === 't-demo' ? 'Demo Company (US)' : 'A', match: { field: 'tenantId', value: t } })),
        connectShared: async (ref, id) => ({ secret: ref.secret, config: { tenantId: id, displayName: `Fake · ${id}`, sharedSecretKey: 'fake:grant-1' } }),
      }),
      { raw: { put: async () => 'x' } },
    )
    const engine = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const a = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'A', secret: { token: 't' }, config: { tenantId: 't-a' }, createdBy: null })
    // A disconnected connection to Demo doesn't count: it's offered again.
    const old = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Old', secret: null, config: { tenantId: 't-demo' }, createdBy: null })
    await h.db.updateTable('connections').set({ status: 'disconnected' }).where('id', '=', old).execute()
    expect((await engine.sharedOffers(a)).map((o) => o.id)).toEqual(['t-demo'])
    const added = await engine.addShared(a, 't-demo', { createdBy: null })
    expect(added.displayName).toBe('Fake · t-demo')
    // Now nothing is left to offer, and both live connections carry the grant's key (a rotation reaches both).
    expect(await engine.sharedOffers(a)).toEqual([])
    const live = await h.db.selectFrom('connections').select(['id', 'config_json']).where('workspace_id', '=', ws).where('status', '!=', 'disconnected').execute()
    expect(live.map((r) => (JSON.parse(r.config_json) as { sharedSecretKey?: string }).sharedSecretKey)).toEqual(['fake:grant-1', 'fake:grant-1'])
    expect(unseal(keys, (await h.db.selectFrom('connections').select('secret_enc').where('id', '=', added.connectionId).executeTakeFirstOrThrow()).secret_enc!, { workspaceId: ws, recordId: added.connectionId, purpose: SECRET_PURPOSE })).toEqual({ token: 't' })
    await expect(engine.addShared(a, 't-demo', { createdBy: null })).rejects.toThrow(/not offered/)
  })

  it('disconnect tells the connector whether this was the last connection on a shared token', async () => {
    const seen: Array<unknown> = []
    const registry = new ConnectorRegistry()
    registry.register((deps) => ({ ...fakeFactory(() => ({ cursor: null, hasMore: false, events: [] }))(deps), disconnect: async (ref) => void seen.push(ref.config.lastOfGrant) }), { raw: { put: async () => 'x' } })
    const engine = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const make = (config: Record<string, unknown>) => createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'X', secret: { token: 't' }, config, createdBy: null })
    const a = await make({ sharedSecretKey: 'g' })
    const b = await make({ sharedSecretKey: 'g' })
    const solo = await make({})
    await engine.disconnect(a)
    await engine.disconnect(b)
    await engine.disconnect(solo)
    expect(seen).toEqual([false, true, undefined])
  })

  it("passes the workspace's time zone to the connector (its \"today\" for month periods); unset is America/New_York", async () => {
    const seen: Array<string | undefined> = []
    const registry = new ConnectorRegistry()
    registry.register((deps) => ({ ...fakeFactory(() => ({ cursor: null, hasMore: false, events: [] }))(deps), sync: async (conn) => (seen.push(conn.timeZone), { cursor: null, hasMore: false, events: [] }) }), { raw: { put: async () => 'x' } })
    const engine = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db) })
    const connId = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Fake', secret: {}, config: {}, createdBy: null })
    await engine.sync(connId)
    await h.db.updateTable('workspaces').set({ time_zone: 'Australia/Sydney' }).where('id', '=', ws).execute()
    await engine.sync(connId)
    expect(seen).toEqual(['America/New_York', 'Australia/Sydney'])
  })

  it('schedules a follow-up sync when the provider is still preparing data', async () => {
    const connId = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Fake', secret: {}, config: {}, createdBy: null })
    const before = Date.now()
    await engineWith(() => ({ cursor: 'c', hasMore: false, events: [], syncAgainInMs: 30_000 })).sync(connId)
    const jobs = await h.db.selectFrom('jobs').select(['kind', 'run_at']).execute()
    expect(jobs).toHaveLength(1)
    const at = Date.parse(jobs[0]!.run_at)
    expect(at).toBeGreaterThanOrEqual(before + 30_000)
    expect(at).toBeLessThan(before + 60_000)
  })

  it('marks needs_reauth on auth errors without throwing; rethrows transient errors for retry', async () => {
    const connId = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Fake', secret: {}, config: {}, createdBy: null })
    const authFail = engineWith(() => {
      throw new ConnectorError('auth', 'ITEM_LOGIN_REQUIRED', { provider: 'fake' })
    })
    expect(await authFail.sync(connId)).toMatchObject({ status: 'needs_reauth' })
    expect((await h.db.selectFrom('connections').select('status').executeTakeFirstOrThrow()).status).toBe('needs_reauth')

    await h.db.updateTable('connections').set({ status: 'active' }).execute()
    const transient = engineWith(() => {
      throw new ConnectorError('transient', 'timeout', { provider: 'fake' })
    })
    await expect(transient.sync(connId)).rejects.toThrow('timeout')
    expect((await h.db.selectFrom('connections').select(['status', 'last_error']).executeTakeFirstOrThrow())).toMatchObject({ status: 'error', last_error: 'Fake isn’t responding right now. Aggregate will try again shortly.' })
  })

  it('flags the same real account from a second source as a duplicate', async () => {
    const c1 = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'A', secret: null, config: {}, createdBy: null })
    const c2 = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'B', secret: null, config: {}, createdBy: null })
    const mk = (conn: string): Script => () => ({ cursor: null, hasMore: false, events: [{ type: 'account.upsert', externalId: 'x-' + conn, connectionId: conn, name: 'Ops', accountType: 'depository', currency: 'USD', mask: '9999', institution: 'Mercury' }] })
    await engineWith(mk(c1)).sync(c1)
    await engineWith(mk(c2)).sync(c2)
    const rows = await h.db.selectFrom('accounts').selectAll().orderBy('created_at').execute()
    expect(rows[1]!.duplicate_of).toBe(rows[0]!.id)
    expect(rows[1]!.include_in_cash).toBe(0)
  })

  it('counts only bank-type accounts as cash', async () => {
    const c = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'A', secret: null, config: {}, createdBy: null })
    const types = ['depository', 'credit_card', 'loan', 'investment', 'processor_balance'] as const
    await engineWith(() => ({ cursor: null, hasMore: false, events: types.map((t) => ({ type: 'account.upsert' as const, externalId: t, connectionId: c, name: t, accountType: t, currency: 'USD' })) })).sync(c)
    const rows = await h.db.selectFrom('accounts').select(['external_id', 'include_in_cash']).execute()
    expect(Object.fromEntries(rows.map((r) => [r.external_id, r.include_in_cash]))).toEqual({ depository: 1, credit_card: 0, loan: 0, investment: 0, processor_balance: 1 })
  })

  it('an account re-typed out of a cash type leaves cash; a later opt-in survives the next sync', async () => {
    const c = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'A', secret: null, config: {}, createdBy: null })
    let type: 'depository' | 'investment' = 'depository'
    const engine = engineWith(() => ({ cursor: null, hasMore: false, events: [{ type: 'account.upsert' as const, externalId: 'cd', connectionId: c, name: 'CD', accountType: type, currency: 'USD' }] }))
    const cash = async () => (await h.db.selectFrom('accounts').select('include_in_cash').where('connection_id', '=', c).executeTakeFirstOrThrow()).include_in_cash
    await engine.sync(c)
    expect(await cash()).toBe(1)
    type = 'investment'
    await engine.sync(c)
    expect(await cash()).toBe(0)
    await h.db.updateTable('accounts').set({ include_in_cash: 1 }).where('connection_id', '=', c).execute()
    await engine.sync(c)
    expect(await cash()).toBe(1)
  })

  it('rejects events claiming another connection', async () => {
    const connId = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Fake', secret: null, config: {}, createdBy: null })
    const bad = engineWith(() => ({ cursor: null, hasMore: false, events: [{ type: 'account.upsert', externalId: 'a', connectionId: 'someone-else', name: 'X', accountType: 'depository', currency: 'USD' }] }))
    await expect(bad.sync(connId)).rejects.toThrow(/another connection/)
  })

  it('accounts start in the company of a single-company connection; bank logins wait; reassignment survives re-sync', async () => {
    const acme = newId()
    const other = newId()
    for (const id of [acme, other]) await h.db.insertInto('entities').values({ id, workspace_id: ws, kind: 'company', name: id, base_currency: 'USD', created_at: nowIso() } as never).execute()
    const acct = (connectionId: string): SyncResult => ({ cursor: null, hasMore: false, events: [{ type: 'account.upsert', externalId: 'a1', connectionId, name: 'Account', accountType: 'depository', currency: 'USD' }] })
    let current = ''
    const engine = engineWith(() => acct(current))
    const entityOf = async (connectionId: string) => (await h.db.selectFrom('accounts').select('entity_id').where('connection_id', '=', connectionId).executeTakeFirstOrThrow()).entity_id

    current = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Stripe', secret: {}, config: {}, createdBy: null, entityId: acme })
    await engine.sync(current)
    expect(await entityOf(current)).toBe(acme)
    // The person moves the account to another company; the next sync keeps that choice.
    await h.db.updateTable('accounts').set({ entity_id: other }).where('connection_id', '=', current).execute()
    await engine.sync(current)
    expect(await entityOf(current)).toBe(other)

    current = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Bank login', secret: {}, config: {}, createdBy: null })
    await engine.sync(current)
    expect(await entityOf(current)).toBeNull()
  })

  it('a personal account (IRA, HSA, mortgage) on a company bank login waits for "which company?"; on Personal it stays', async () => {
    const acme = newId()
    const me = newId()
    await h.db.insertInto('entities').values({ id: acme, workspace_id: ws, kind: 'company', name: 'Acme', base_currency: 'USD', created_at: nowIso() } as never).execute()
    await h.db.insertInto('entities').values({ id: me, workspace_id: ws, kind: 'personal', name: 'Personal', base_currency: 'USD', created_at: nowIso() } as never).execute()
    let current = ''
    const engine = engineWith(() => ({ cursor: null, hasMore: false, events: [
      { type: 'account.upsert', externalId: 'chk', connectionId: current, name: 'Checking', accountType: 'depository', currency: 'USD', businessHint: 'unknown' },
      { type: 'account.upsert', externalId: 'ira', connectionId: current, name: 'IRA', accountType: 'investment', currency: 'USD', businessHint: 'personal' },
    ] }))
    const entities = async () => Object.fromEntries((await h.db.selectFrom('accounts').select(['external_id', 'entity_id']).where('connection_id', '=', current).execute()).map((r) => [r.external_id, r.entity_id]))
    current = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Bank', secret: {}, config: {}, createdBy: null, entityId: acme })
    await engine.sync(current)
    expect(await entities()).toEqual({ chk: acme, ira: null })
    current = await createConnection(h.db, keys, { workspaceId: ws, connectorKey: 'fake', displayName: 'Bank 2', secret: {}, config: {}, createdBy: null, entityId: me })
    await engine.sync(current)
    expect(await entities()).toEqual({ chk: me, ira: me })
  })
})

describe('failure messages people can act on', () => {
  const err = (kind: ConnectorError['kind'], message: string, extra: { status?: number; code?: string; forUser?: boolean } = {}) => new ConnectorError(kind, message, { provider: 'x', ...extra })
  it("never shows a provider's own text; a connector's hand-written sentence stays", () => {
    for (const raw of ['message=AuthenticationFailed; errorCode=003200; statusCode=401: Token revoked', 'invalid_grant', 'HTTP 401', 'Unauthorized']) {
      expect(plainError(err('auth', raw, { status: 401 }), 'QuickBooks')).toEqual({ status: 'needs_reauth', message: 'QuickBooks access was removed or has expired. Reconnect to keep syncing.' })
    }
    expect(plainError(err('auth', 'Mercury rejected the sign-in; reconnect Mercury', { forUser: true }), 'Mercury').message).toMatch(/^Mercury rejected/)
    expect(plainError(err('auth', 'INSUFFICIENT_SCOPES', { status: 403 }), 'Square')).toEqual({ status: 'needs_reauth', message: 'Square isn’t allowing Aggregate to read this any more. Reconnect Square and allow read access.' })
    expect(plainError(err('rate_limited', 'Too Many Requests', { status: 429 }), 'Brex').message).toBe('Brex is limiting how fast Aggregate can read right now. It will try again shortly.')
    expect(plainError(err('transient', '<html>502 Bad Gateway</html>', { status: 502 }), 'Wise').message).toBe('Wise isn’t responding right now. Aggregate will try again shortly.')
    expect(plainError(err('permanent', 'ValidationFault: 6000', { status: 400 }), 'QuickBooks').message).toBe('Aggregate couldn’t read QuickBooks just now. Sync now to try again; if this keeps happening, reconnect QuickBooks.')
    expect(plainError(new Error('boom'), 'Xero').status).toBe('error')
  })
  it('on connect, our own check of what was pasted is shown; the provider\'s answer is not', () => {
    expect(plainError(err('invalid_input', 'the Mercury token must not contain spaces'), 'Mercury', 'connect').message).toBe('Mercury didn’t accept that: the Mercury token must not contain spaces')
    expect(plainError(err('auth', '{"errors":{"message":"invalid token"}}', { status: 401 }), 'Mercury', 'connect').message).toBe('Mercury didn’t accept that. Check it’s copied in full and still active, then try again.')
    expect(plainError(err('invalid_input', 'No such API key: sk_test_…', { status: 400 }), 'Stripe', 'connect').message).toBe('Stripe didn’t accept that. Try again.')
  })
})

describe('records-only connections', () => {
  it('a connection with no connector and no credentials is up to date; with credentials it is still an error', async () => {
    const engine = engineWith(() => ({ cursor: null, hasMore: false, events: [] }))
    const held = newId()
    const real = newId()
    for (const [id, secret] of [[held, null], [real, 'sealed']] as const)
      await h.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: 'equity', entity_id: null, display_name: 'Cap table', status: 'error', secret_enc: secret, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: 'connector equity is not installed', created_by: null, created_at: nowIso() } as never).execute()
    expect(await engine.sync(held)).toMatchObject({ status: 'ok', message: 'nothing to sync' })
    expect(await h.db.selectFrom('connections').select(['status', 'last_error']).where('id', '=', held).executeTakeFirstOrThrow()).toEqual({ status: 'active', last_error: null })
    expect(await engine.sync(real)).toMatchObject({ status: 'error' })
  })
})

describe('sync all', () => {
  it('spreads start times at a fixed offset per connection and re-syncs demo connections only once a day', async () => {
    const engine = engineWith(() => ({ cursor: null, hasMore: false, events: [] }))
    const person = newId()
    await h.db.insertInto('people').values({ id: person, auth_user_id: null, name: 'P', email: 'p@example.com', created_at: nowIso() }).execute()
    await h.db.insertInto('memberships').values({ id: newId(), workspace_id: ws, person_id: person, role: 'owner', grid_json: null, expires_at: null, invited_by: null, created_at: nowIso(), revoked_at: null }).execute()
    const add = async (key: string, lastSuccess: string | null) => {
      const id = newId()
      await h.db.insertInto('connections').values({ id, workspace_id: ws, connector_key: key, entity_id: null, display_name: key, status: 'active', secret_enc: 'sealed', config_json: '{}', cursor: null, last_sync_at: lastSuccess, last_success_at: lastSuccess, last_error: null, created_by: null, created_at: nowIso() } as never).execute()
      return id
    }
    const bank = await add('fake', nowIso())
    const freshDemo = await add('demo', nowIso())
    const staleDemo = await add('demo', new Date(Date.now() - 25 * 3600_000).toISOString())
    const before = Date.now()
    expect(await engine.requestAll({ spreadMs: 48 * 60_000, demoEveryMs: 23 * 3600_000 })).toBe(2)
    const jobs = await h.db.selectFrom('jobs').select(['unique_key', 'run_at']).execute()
    expect(jobs.map((j) => j.unique_key).sort()).toEqual([bank, staleDemo].sort())
    expect(jobs.map((j) => j.unique_key)).not.toContain(freshDemo)
    for (const j of jobs) {
      const at = Date.parse(j.run_at) - before
      expect(at).toBeGreaterThanOrEqual(-1000)
      expect(at).toBeLessThan(48 * 60_000 + 1000)
    }
    expect(spreadOffset(bank, 48 * 60_000)).toBe(spreadOffset(bank, 48 * 60_000))
  })
})

describe('two machines (Postgres)', () => {
  it('one connection synced on two machines at once runs one after the other, each with the latest secret', async () => {
    const pg = await connectPglite<CoreTables>()
    try {
      const w = newId()
      await pg.db.insertInto('workspaces').values({ id: w, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
      const solo = await createConnection(pg.db, keys, { workspaceId: w, connectorKey: 'fake', displayName: 'Solo', secret: { token: 't1' }, config: {}, createdBy: null })
      const seen: string[] = []
      let running = 0
      let overlapped = false
      // Two engines on one database: two machines, each with its own in-process queue.
      const machine = () => {
        const registry = new ConnectorRegistry()
        registry.register(
          fakeFactory((_c, secret) => {
            const t = (secret as { token: string }).token
            seen.push(t)
            return { cursor: null, hasMore: false, events: [], updatedSecret: { token: `${t}+` } }
          }),
          { raw: { put: async () => 'x' } },
        )
        const e = new SyncEngine({ db: pg.db, keys, registry, ledger, queue: new JobQueue(pg.db) })
        const inner = (e as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne.bind(e)
        ;(e as unknown as { syncOne: (id: string) => Promise<unknown> }).syncOne = async (id) => {
          running++
          if (running > 1) overlapped = true
          await new Promise((r) => setTimeout(r, 50))
          try {
            return await inner(id)
          } finally {
            running--
          }
        }
        return e
      }
      const [a, b] = [machine(), machine()]
      await Promise.all([a.sync(solo), b.sync(solo)])
      expect(overlapped).toBe(false)
      expect(seen).toEqual(['t1', 't1+'])
      // Released: nothing left behind.
      expect(await pg.db.selectFrom('settings').select('key').where('key', 'like', 'sync_lease:%').execute()).toEqual([])
    } finally {
      await pg.close()
    }
  }, 30_000)
})

