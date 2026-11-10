import { notRevokedWarning } from './revoke-help.ts'
import { PostgresAdapter, type Kysely } from 'kysely'
import type { AccountUpsert, ConnectBegin, ConnectBeginContext, ConnectionId, ConnectionRef, Connector, Ledger, NormalizedEvent, PostResult, SharedOffer, WorkspaceId } from '@agfn/contracts'
import { newId, nowIso, perfEnabled, perfLine, withBypass, withPerf, type CoreTables, type JobQueue } from '@agfn/db'
import { seal, unseal, type KeyRing } from '@agfn/security'
import { dedupeEvents, healthFromError, isConnectorError, plainError, runSync, type ConnectorDeps } from '@agfn/connector-sdk'
import { DbRawSink } from './raw-sink.ts'
import type { ConnectorRegistry } from './registry.ts'

export const SYNC_JOB = 'connection.sync'
export const SECRET_PURPOSE = 'connection.secret'
/** Platform-managed connections with nothing to pull (e.g. S1's "Added by hand"). Never synced, never shown as broken. */
export const INTERNAL_CONNECTORS = new Set(['manual'])

/**
 * A connection with no connector to run and no credentials only holds records another module writes (the cap table,
 * packages/equity, uses connector_key 'equity'). There's nothing to sync, so it is never an error. One with
 * credentials whose connector isn't installed still is: that's a real source this server can't reach.
 */
export function holdsRecordsOnly(registry: Pick<ConnectorRegistry, 'has'>, row: { connector_key: string; secret_enc: string | null }): boolean {
  return !registry.has(row.connector_key) && !row.secret_enc
}

export interface SyncEngineDeps {
  db: Kysely<CoreTables>
  keys: KeyRing
  registry: ConnectorRegistry
  ledger: Ledger
  queue: JobQueue
  /** Extra deps for connectors (fetch, clock) — injectable for tests. */
  connectorDeps?: Omit<ConnectorDeps, 'raw'>
  log?: (msg: string, fields?: Record<string, unknown>) => void
  /**
   * Optional event router: return a PostResult to take over an event (e.g. S4/S5 books.ingest for invoices and payroll),
   * or null to send it to ledger.post. `entityId` is the connection's company (null when not chosen yet).
   */
  route?: (workspaceId: string, entityId: string | null, event: NormalizedEvent, page?: RoutePage) => Promise<PostResult | null>
  /**
   * After a sync page's events have all been routed (accounts upserted, documents taken): work a router put off to do
   * once per page (see RoutePage). Runs before the page's ledger batch is written.
   */
  pageDone?: (workspaceId: string, entityId: string | null, page: RoutePage) => Promise<void>
  /**
   * Live balance checks cost money (Plaid /accounts/balance/get, $0.10 a call), so they are capped: at most one per
   * connection per `cooldownMs` (default 15 minutes) and `dailyCap` per workspace per UTC day (default 20). `onCall`
   * meters each real call (usage). Only ever reached through refreshBalances, never from sync, webhooks or jobs.
   */
  liveBalance?: { cooldownMs?: number; dailyCap?: number; onCall?: (workspaceId: string, connectionId: string) => Promise<void> | void }
  /** Runs after a successful sync (e.g. payroll detection over new bank rows). Errors are logged, never fatal. */
  afterSync?: Array<(workspaceId: string, connectionId: string) => Promise<void>>
  /** Runs after a sync fails (error or needs_reauth; not a rate-limit reschedule), with the error. Errors are logged, never fatal. */
  afterFailure?: Array<(workspaceId: string, connectionId: string, error?: unknown) => Promise<void>>
  /**
   * Cap how many connections sync at once in this process (default: no cap). A sync runs CPU-light but holds a database
   * connection for its transactions; a burst (the hourly sync.all, a post-deploy resync of every connection) can put
   * more in flight than the pool can serve, so each one waits tens of seconds to check out — the whole burst crawls on
   * a small pool. The cap bounds how many race for the pool at once; the rest queue here, holding nothing while they
   * wait. Set it at or below the pool size. The per-connection and cross-machine serialization (grantLocks, leased) is
   * unchanged; a sync waits here only after its turn in those, and holds no slot while waiting for them.
   */
  maxConcurrentSyncs?: number
}

export type RefreshOutcome =
  | { status: 'ok'; snapshots: number; posted: number; at: string }
  /** Capped: nothing was called. `refreshedAt` = the last live check (null if never), `retryAt` = when one is allowed. */
  | { status: 'cached'; reason: 'cooldown' | 'daily_cap'; refreshedAt: string | null; retryAt: string }
  | { status: 'unsupported' }

/** A connection's fixed offset in [0, spreadMs): the same every run, so each one still syncs once per interval. */
export function spreadOffset(id: string, spreadMs: number): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return (h >>> 0) % Math.max(1, Math.floor(spreadMs))
}

/**
 * One sync page, as the router sees it: all of its events (so a router can read or write for the whole page at once,
 * not once per event) and a scratch space that lives for the page. The engine has already checked, at the page's
 * start, that the connection wasn't disconnected.
 */
export interface RoutePage {
  events: readonly NormalizedEvent[]
  cache: Map<string, unknown>
}

/** Thrown inside a page when the connection was disconnected after the sync started. */
class StoppedByDisconnect extends Error {}

export interface SyncOutcome {
  status: 'ok' | 'needs_reauth' | 'error' | 'partial'
  events: number
  posted: number
  message?: string
}

/**
 * Pulls one connection: decrypts its secret, runs the connector page by page, stores raw payloads, upserts
 * accounts (S0 owns the accounts table), hands every event to the ledger (idempotent per connection+externalId),
 * and checkpoints the cursor (plus any rotated secret) after each page so a crash resumes where it stopped.
 */
export class SyncEngine {
  private d: SyncEngineDeps
  constructor(deps: SyncEngineDeps) {
    this.d = deps
    this.#syncSlots = deps.maxConcurrentSyncs && deps.maxConcurrentSyncs > 0 ? deps.maxConcurrentSyncs : Infinity
  }

  // A plain counting semaphore over concurrent syncs (maxConcurrentSyncs; Infinity = no cap). A waiter holds no slot,
  // so a sync blocked on its grant lock or lease doesn't occupy one.
  #syncSlots: number
  #syncWaiters: Array<() => void> = []
  async #acquireSyncSlot(): Promise<void> {
    if (this.#syncSlots > 0) {
      this.#syncSlots--
      return
    }
    await new Promise<void>((resolve) => this.#syncWaiters.push(resolve))
  }
  #releaseSyncSlot(): void {
    const next = this.#syncWaiters.shift()
    if (next) next()
    else this.#syncSlots++
  }

  /** Queue a sync; at most one queued/running per connection. */
  async request(workspaceId: string, connectionId: string, runAt?: Date): Promise<void> {
    await this.d.queue.enqueue(SYNC_JOB, { workspaceId, connectionId }, { workspaceId, uniqueKey: connectionId, ...(runAt ? { runAt } : {}) })
  }

  /**
   * Queue every active connection (the recurring "sync all" job). `spreadMs` spreads the start times over that window,
   * each connection at a fixed offset (from its id), so the hourly run doesn't hit the database all at :00.
   * `demoEveryMs` re-syncs a demo connection only that often: its books gain one day per day, so hourly is waste.
   */
  async requestAll(opts: { spreadMs?: number; demoEveryMs?: number } = {}): Promise<number> {
    // Only workspaces someone still belongs to: a member-less one is waiting to be deleted, not synced.
    const rows = (
      await this.d.db
        .selectFrom('connections')
        .select(['id', 'workspace_id', 'connector_key', 'secret_enc', 'last_success_at'])
        .where('status', 'in', ['active', 'error'])
        .where(({ exists, selectFrom }) => exists(selectFrom('memberships').select('person_id').whereRef('memberships.workspace_id', '=', 'connections.workspace_id').where('memberships.revoked_at', 'is', null)))
        // The public demo is rebuilt from scratch every night (apps/server/src/public-demo.ts): nothing to refresh.
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('settings').select('key').whereRef('settings.workspace_id', '=', 'connections.workspace_id').where('settings.key', '=', 'public_demo'))))
        // A demo still in line for a fill slot (packages/demo fill-queue.ts) starts when admitted, not with the hourly round.
        .where(({ not, exists, selectFrom }) => not(exists(selectFrom('settings').select('key').whereRef('settings.workspace_id', '=', 'connections.workspace_id').where('settings.key', '=', 'demo_fill_waiting'))))
        .execute()
    ).filter((r) => !INTERNAL_CONNECTORS.has(r.connector_key))
    // Nothing to run for these (see holdsRecordsOnly): marked up to date in one go instead of a job each.
    const held = rows.filter((r) => holdsRecordsOnly(this.d.registry, r))
    if (held.length) await this.markHeldUpToDate(held.map((r) => r.id))
    const demoSince = opts.demoEveryMs ? Date.now() - opts.demoEveryMs : 0
    const queued = rows.filter((r) => !holdsRecordsOnly(this.d.registry, r)).filter((r) => !(demoSince && r.connector_key === 'demo' && r.last_success_at && Date.parse(r.last_success_at) > demoSince))
    const now = Date.now()
    for (const r of queued) await this.request(r.workspace_id, r.id, opts.spreadMs ? new Date(now + spreadOffset(r.id, opts.spreadMs)) : undefined)
    return queued.length
  }

  /**
   * A records-only connection has no live source to go stale against, so we keep it active and clear any error. For one
   * that has synced before, we keep its success time current (nothing to re-fetch). But a never-synced one has no data
   * yet, so we do NOT invent a last_success_at — stamping "synced now" made freshness claim data that isn't there. We
   * record that we looked (last_sync_at) and leave last_success_at null until it actually has something.
   */
  private async markHeldUpToDate(ids: string[]): Promise<void> {
    const now = nowIso()
    // Synced before: keep its success time current (nothing to re-fetch).
    await this.d.db.updateTable('connections').set({ status: 'active', last_error: null, last_sync_at: now, last_success_at: now }).where('id', 'in', ids).where('status', 'in', ['active', 'error']).where('last_success_at', 'is not', null).execute()
    // Never synced: record that we looked, but don't invent a success time it never had.
    await this.d.db.updateTable('connections').set({ status: 'active', last_error: null, last_sync_at: now }).where('id', 'in', ids).where('status', 'in', ['active', 'error']).where('last_success_at', 'is', null).execute()
  }

  /**
   * Stop a connection: revoke access at the provider when the connector supports it (e.g. Plaid /item/remove, so the
   * Item stops being live and billed), then forget the secret locally. A provider failure is logged, never blocking.
   */
  async disconnect(connectionId: string): Promise<{ revoked: boolean; warning?: string }> {
    const { db, keys, registry } = this.d
    const row = await db.selectFrom('connections').selectAll().where('id', '=', connectionId).executeTakeFirst()
    if (!row) return { revoked: false }
    let revoked = false
    let warning: string | undefined
    if (row.secret_enc && registry.has(row.connector_key) && !INTERNAL_CONNECTORS.has(row.connector_key)) {
      try {
        const secret = unseal(keys, row.secret_enc, { workspaceId: row.workspace_id, recordId: row.id, purpose: SECRET_PURPOSE })
        // A token refreshed while disconnecting reaches the siblings that still share it.
        const saveSecret = async (id: string, next: unknown) => {
          if (id !== row.id) throw new Error('connector saved a secret for another connection')
          await this.keepSecret(row, next)
        }
        const connector = registry.create(row.connector_key, { ...this.d.connectorDeps, raw: new DbRawSink(db, row.workspace_id), saveSecret }) as { accountKey?: (config: Record<string, unknown>) => string | undefined; disconnect?: (ref: ConnectionRef) => Promise<void | { notRevoked: string }> }
        if (connector.disconnect) {
          const config = JSON.parse(row.config_json) as Record<string, unknown>
          // Shared token: the connector removes only this one; it revokes the token only if no sibling still uses it.
          const grant = sharedSecretKeyOf(row.config_json)
          if (grant) config.lastOfGrant = (await siblingsOf(db, row, grant)).length === 0
          const account = connector.accountKey?.(config)
          if (account) config.liveElsewhere = await liveElsewhere(db, row, (c) => connector.accountKey?.(c) === account)
          const out = await connector.disconnect({ id: row.id, workspaceId: row.workspace_id, connectorKey: row.connector_key, secret, config })
          if (out?.notRevoked) warning = out.notRevoked.slice(0, 300)
          else revoked = true
        } else {
          // No way to end it from here: say so, or the access quietly stays live at the provider.
          warning = notRevokedWarning(row.connector_key, row.display_name)
        }
      } catch (err) {
        this.d.log?.('provider disconnect failed', { connectionId: row.id, connector: row.connector_key, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' })
        // A connector's own message says what to do at the provider; anything else stays in the log.
        warning = `In ${row.display_name}, remove Aggregate if it’s still listed.`
        if (isConnectorError(err)) {
          warning = err.forUser ? err.message.slice(0, 300) : `In ${row.display_name}, go to Settings → Remove Aggregate if it’s still listed.`
        }
      }
    }
    await db.updateTable('connections').set({ status: 'disconnected', secret_enc: null, disconnected_at: new Date().toISOString() }).where('id', '=', row.id).execute()
    return { revoked, ...(warning ? { warning } : {}) }
  }

  /**
   * Start re-authenticating an existing connection on the SAME provider login (Plaid Link update mode), never a new
   * one: a second Plaid Item for the same login is billed and counted twice. Throws ConnectorError as the provider does.
   */
  async beginReconnect(connectionId: string, ctx: Omit<ConnectBeginContext, 'connection'>): Promise<ConnectBegin> {
    const { ref, connector } = this.open(await this.row(connectionId))
    const begin = (connector as { begin?: (c: ConnectBeginContext) => Promise<ConnectBegin> }).begin
    if (!begin) throw new Error('this connection has no reconnect flow')
    return begin.call(connector, { ...ctx, connection: ref })
  }

  /**
   * Live balances, on explicit request only (people and the AI share this path and its caps; see `liveBalance`).
   * Over a cap nothing is called: the answer says when balances were last refreshed, and the cached ones stand.
   */
  async refreshBalances(connectionId: string, opts: { now?: () => number } = {}): Promise<RefreshOutcome> {
    const { db } = this.d
    const row = await this.row(connectionId)
    const { ref, connector } = this.open(row)
    if (!connector.refreshBalances) return { status: 'unsupported' }
    const now = opts.now?.() ?? Date.now()
    const cooldown = this.d.liveBalance?.cooldownMs ?? 15 * 60_000
    const cap = this.d.liveBalance?.dailyCap ?? 20
    const ws = row.workspace_id
    const lastKey = `balance_refresh:${row.id}`
    const dayKey = `balance_refresh_day:${new Date(now).toISOString().slice(0, 10)}`
    const read = async (key: string) => {
      const r = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', key).executeTakeFirst()
      return r ? Number(JSON.parse(r.value_json)) : 0
    }
    const write = (key: string, v: number) =>
      db
        .insertInto('settings')
        .values({ workspace_id: ws, key, value_json: JSON.stringify(v), updated_at: nowIso() })
        .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json: JSON.stringify(v), updated_at: nowIso() }))
        .execute()
    const lastAt = await read(lastKey)
    const last = lastAt ? new Date(lastAt).toISOString() : null
    if (lastAt && now - lastAt < cooldown) return { status: 'cached', reason: 'cooldown', refreshedAt: last, retryAt: new Date(lastAt + cooldown).toISOString() }
    const today = await read(dayKey)
    if (today >= cap) return { status: 'cached', reason: 'daily_cap', refreshedAt: last, retryAt: new Date(Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z') + 86_400_000).toISOString() }
    // Count before calling: a failed or slow call still costs.
    await write(lastKey, now)
    await write(dayKey, today + 1)
    await this.d.liveBalance?.onCall?.(ws, row.id)
    const events = await connector.refreshBalances(ref)
    let posted = 0
    for (const e of events) {
      if (e.connectionId !== row.id) throw new Error('connector emitted an event for another connection')
      const r = (await this.d.route?.(ws, row.entity_id ?? null, e)) ?? (await this.d.ledger.post(ws, e))
      if (r.status === 'posted') posted++
    }
    return { status: 'ok', snapshots: events.length, posted, at: new Date(now).toISOString() }
  }

  private async row(connectionId: string) {
    const row = await this.d.db.selectFrom('connections').selectAll().where('id', '=', connectionId).executeTakeFirst()
    if (!row || row.status === 'disconnected') throw new Error('connection not found')
    return row
  }

  private open(row: { id: string; workspace_id: string; connector_key: string; secret_enc: string | null; config_json: string }) {
    const { db, keys, registry } = this.d
    if (!registry.has(row.connector_key)) throw new Error(`connector ${row.connector_key} is not installed`)
    const secret = row.secret_enc ? unseal(keys, row.secret_enc, { workspaceId: row.workspace_id, recordId: row.id, purpose: SECRET_PURPOSE }) : null
    // A token refreshed outside a sync is kept too (and reaches siblings sharing it).
    const saveSecret = async (id: string, next: unknown) => {
      if (id !== row.id) throw new Error('connector saved a secret for another connection')
      await this.keepSecret(row, next)
    }
    const connector = registry.create(row.connector_key, { ...this.d.connectorDeps, raw: new DbRawSink(db, row.workspace_id), saveSecret })
    const ref: ConnectionRef = { id: row.id, workspaceId: row.workspace_id, connectorKey: row.connector_key, secret, config: JSON.parse(row.config_json) as Record<string, unknown> }
    return { ref, connector }
  }

  /** What this connection's grant can reach that the workspace doesn't have yet (Xero organisations shared before). */
  async sharedOffers(connectionId: string): Promise<SharedOffer[]> {
    const row = await this.row(connectionId)
    const { ref, connector } = this.open(row)
    const c = connector as Connector
    if (!c.listShared) return []
    const offers = await c.listShared(ref)
    const live = await this.d.db
      .selectFrom('connections')
      .select('config_json')
      .where('workspace_id', '=', row.workspace_id)
      .where('connector_key', '=', row.connector_key)
      .where('status', '!=', 'disconnected')
      .execute()
    const configs = live.map((r) => JSON.parse(r.config_json) as Record<string, unknown>)
    return offers.filter((o) => !configs.some((cfg) => cfg[o.match.field] === o.match.value))
  }

  /**
   * Add one of sharedOffers as its own connection on the same grant. Both then carry the grant's sharedSecretKey,
   * so a rotated token reaches both, and syncs of the two queue one after the other.
   */
  async addShared(connectionId: string, offerId: string, opts: { createdBy: string | null; entityId?: string | null }): Promise<{ connectionId: string; displayName: string }> {
    const row = await this.row(connectionId)
    const offer = (await this.sharedOffers(connectionId)).find((o) => o.id === offerId)
    if (!offer) throw new Error('not offered')
    const { ref, connector } = this.open(await this.row(connectionId))
    const c = connector as Connector
    const result = await c.connectShared!(ref, offerId)
    const key = typeof result.config.sharedSecretKey === 'string' ? result.config.sharedSecretKey : undefined
    if (key && sharedSecretKeyOf(row.config_json) !== key) {
      const cfg = { ...(JSON.parse(row.config_json) as Record<string, unknown>), sharedSecretKey: key }
      await this.d.db.updateTable('connections').set({ config_json: JSON.stringify(cfg) }).where('id', '=', row.id).execute()
    }
    const displayName = typeof result.config.displayName === 'string' && result.config.displayName.trim() ? result.config.displayName.trim().slice(0, 120) : offer.name
    const id = await createConnection(this.d.db, this.d.keys, { workspaceId: row.workspace_id, connectorKey: row.connector_key, displayName, secret: result.secret, config: result.config, createdBy: opts.createdBy, entityId: opts.entityId ?? null })
    return { connectionId: id, displayName }
  }

  /** A connection, and connections sharing one rotating token (config.sharedSecretKey), sync one at a time in this process. */
  private readonly grantLocks = new Map<string, Promise<unknown>>()

  /** Pull one connection. With AGFN_PERF_LOG=1, logs what the whole sync and each page cost in the database. */
  async sync(connectionId: string): Promise<SyncOutcome> {
    if (!perfEnabled()) return this.syncOnce(connectionId)
    const r = await withPerf(() => this.syncOnce(connectionId))
    console.info(`[agfn] perf sync ${connectionId}: ${perfLine(r, { status: r.value.status, events: r.value.events, pages: this.perfPages.get(connectionId) ?? 0 })}`)
    this.perfPages.delete(connectionId)
    return r.value
  }

  private perfPages = new Map<string, number>()

  private async perfPage(connectionId: string, events: number, fn: () => Promise<void>): Promise<void> {
    if (!perfEnabled()) return fn()
    const n = (this.perfPages.get(connectionId) ?? 0) + 1
    this.perfPages.set(connectionId, n)
    const r = await withPerf(fn)
    console.info(`[agfn] perf page ${n} of ${connectionId}: ${perfLine(r, { events })}`)
  }

  private async settle(ws: string, connectionId: string): Promise<void> {
    const settle = this.d.ledger.settle
    if (!settle) return
    const run = () => settle.call(this.d.ledger, ws as WorkspaceId, connectionId as ConnectionId)
    if (!perfEnabled()) return run()
    console.info(`[agfn] perf settle ${connectionId}: ${perfLine(await withPerf(run))}`)
  }

  /**
   * Seal and store a connection's new secret (and, with `cursor`, its checkpoint in the same write). A rotated token
   * shared with sibling connections reaches them in the same transaction, sealed for each row, so no crash can
   * leave one holding a dead token.
   */
  private async keepSecret(row: { id: string; workspace_id: string; connector_key: string; config_json: string }, secret: unknown, cursor?: string | null): Promise<void> {
    const { db, keys } = this.d
    const sealFor = (id: string) => seal(keys, secret, { workspaceId: row.workspace_id, recordId: id, purpose: SECRET_PURPOSE })
    const update: { secret_enc: string; cursor?: string | null } = { secret_enc: sealFor(row.id), ...(cursor !== undefined ? { cursor } : {}) }
    const grant = sharedSecretKeyOf(row.config_json)
    if (!grant) {
      await db.updateTable('connections').set(update).where('id', '=', row.id).where('status', '!=', 'disconnected').execute()
      return
    }
    await db.transaction().execute(async (tx) => {
      await tx.updateTable('connections').set(update).where('id', '=', row.id).where('status', '!=', 'disconnected').execute()
      for (const sib of await siblingsOf(tx, row, grant)) await tx.updateTable('connections').set({ secret_enc: sealFor(sib.id) }).where('id', '=', sib.id).execute()
    })
  }

  private async syncOnce(connectionId: string): Promise<SyncOutcome> {
    const peek = await this.d.db.selectFrom('connections').select(['workspace_id', 'config_json']).where('id', '=', connectionId).executeTakeFirst()
    const grant = peek ? sharedSecretKeyOf(peek.config_json) : undefined
    // Two syncs refreshing the same rotating token at once would invalidate each other: queue them, and each reads
    // its (possibly just-rotated) secret only once it holds the lock. That covers siblings sharing one grant, and one
    // connection synced twice at once (a sync from a request while the worker's job for it runs).
    const key = grant ? `${peek!.workspace_id}:${grant}` : `conn:${connectionId}`
    const prev = this.grantLocks.get(key) ?? Promise.resolve()
    // In this process first, then a lease row other machines see too (launch runs several; a deploy overlaps two).
    const run = prev.catch(() => undefined).then(async () => {
      if (!peek) return this.syncOne(connectionId)
      // Cap concurrent syncs here, after the grant lock, so a burst (sync.all, a post-deploy resync) can't put more in
      // flight than maxConcurrentSyncs at once. The slot is held only for the actual run, never while queued above.
      await this.#acquireSyncSlot()
      try {
        return await this.leased(peek.workspace_id, key, () => this.syncOne(connectionId))
      } finally {
        this.#releaseSyncSlot()
      }
    })
    this.grantLocks.set(key, run)
    try {
      return await run
    } finally {
      if (this.grantLocks.get(key) === run) this.grantLocks.delete(key)
    }
  }

  /**
   * One sync per token across machines: a `sync_lease:<key>` settings row, taken like a lock (insert if absent, then
   * read back the token), renewed while the sync runs, and released at the end. A machine that dies leaves it to expire
   * after SYNC_LEASE_MS. The waiter polls: a sync holds no pool connection while it waits or runs. Postgres only.
   */
  private async leased<T>(ws: string, key: string, fn: () => Promise<T>): Promise<T> {
    const { db } = this.d
    // SQLite is one process (self-host): the in-process queue is the whole story.
    if (!(db.getExecutor().adapter instanceof PostgresAdapter)) return fn()
    const name = `sync_lease:${key}`
    const token = JSON.stringify(`${process.pid}:${Math.random().toString(36).slice(2)}`)
    for (;;) {
      const now = Date.now()
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', name).where('updated_at', '<', new Date(now - SYNC_LEASE_MS).toISOString()).execute()
      await db.insertInto('settings').values({ workspace_id: ws, key: name, value_json: token, updated_at: new Date(now).toISOString() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing()).execute()
      const held = await db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', name).executeTakeFirst()
      if (held?.value_json === token) break
      await new Promise((r) => setTimeout(r, SYNC_LEASE_POLL_MS))
    }
    const renew = setInterval(() => {
      void db.updateTable('settings').set({ updated_at: new Date().toISOString() }).where('workspace_id', '=', ws).where('key', '=', name).where('value_json', '=', token).execute().catch(() => undefined)
    }, SYNC_LEASE_MS / 3)
    renew.unref?.()
    try {
      return await fn()
    } finally {
      clearInterval(renew)
      await db.deleteFrom('settings').where('workspace_id', '=', ws).where('key', '=', name).where('value_json', '=', token).execute().catch(() => undefined)
    }
  }

  private async syncOne(connectionId: string): Promise<SyncOutcome> {
    const { db, keys, registry, ledger } = this.d
    const row = await db.selectFrom('connections').selectAll().where('id', '=', connectionId).executeTakeFirst()
    if (!row) return { status: 'error', events: 0, posted: 0, message: 'connection not found' }
    if (row.status === 'paused' || row.status === 'disconnected') return { status: 'ok', events: 0, posted: 0, message: row.status }
    if (INTERNAL_CONNECTORS.has(row.connector_key)) return { status: 'ok', events: 0, posted: 0, message: 'internal' }
    if (holdsRecordsOnly(registry, row)) {
      await this.markHeldUpToDate([row.id])
      return { status: 'ok', events: 0, posted: 0, message: 'nothing to sync' }
    }
    if (!registry.has(row.connector_key)) return this.fail(row.id, 'error', `connector ${row.connector_key} is not installed`)

    const ctx = { workspaceId: row.workspace_id, recordId: row.id, purpose: SECRET_PURPOSE }
    const secret = row.secret_enc ? unseal(keys, row.secret_enc, ctx) : null
    const raw = new DbRawSink(db, row.workspace_id, { batch: true })
    // A rotated refresh token is kept the moment the connector has it (and reaches siblings sharing the grant).
    const saveSecret = async (id: string, next: unknown) => {
      if (id !== row.id) throw new Error('connector saved a secret for another connection')
      await this.keepSecret(row, next)
    }
    const connector = registry.create(row.connector_key, { ...this.d.connectorDeps, raw, saveSecret })
    const ref: ConnectionRef = {
      id: row.id,
      workspaceId: row.workspace_id,
      connectorKey: row.connector_key,
      secret,
      config: JSON.parse(row.config_json) as Record<string, unknown>,
    }
    const ws = await db.selectFrom('workspaces').select('time_zone').where('id', '=', row.workspace_id).executeTakeFirst()
    // Unset = America/New_York, the workspace default everywhere else (metrics, Settings, the Monday note).
    ref.timeZone = ws?.time_zone ?? 'America/New_York'

    let events = 0
    let posted = 0
    const warnings = new Set<string>()
    await db.updateTable('connections').set({ last_sync_at: nowIso() }).where('id', '=', row.id).execute()
    // A connector upgrade that changes what it fetches re-imports existing connections once, from the start.
    const dataVersion = connector.describe().dataVersion
    const versionKey = `sync:data_version:${row.id}`
    const seenVersion = dataVersion
      ? await db.selectFrom('settings').select('value_json').where('workspace_id', '=', row.workspace_id).where('key', '=', versionKey).executeTakeFirst()
      : undefined
    // Stored as {done, pending}: `pending` marks a re-import already started, so a pass split over several runs
    // (maxPages) continues from its cursor instead of restarting.
    const v = seenVersion ? (JSON.parse(seenVersion.value_json) as { done?: number; pending?: number }) : {}
    const reimport = dataVersion !== undefined && row.cursor !== null && (v.done ?? 0) < dataVersion && v.pending !== dataVersion
    const saveVersion = (value: { done?: number; pending?: number }) =>
      db
        .insertInto('settings')
        .values({ workspace_id: row.workspace_id, key: versionKey, value_json: JSON.stringify(value), updated_at: nowIso() })
        .onConflict((oc) => oc.columns(['workspace_id', 'key']).doUpdateSet({ value_json: JSON.stringify(value), updated_at: nowIso() }))
        .execute()
    if (reimport) {
      this.d.log?.('connector upgraded: re-importing from the start', { connectionId: row.id, connector: row.connector_key, level: 'info' })
      await saveVersion({ ...v, pending: dataVersion })
    }
    try {
      const result = await runSync(connector, ref, reimport ? null : row.cursor, {
        onPage: (page) => this.perfPage(row.id, page.events.length, async () => {
          // Disconnected while this sync was running: stop here, before keeping or posting anything from this page.
          const now = await db.selectFrom('connections').select('status').where('id', '=', row.id).executeTakeFirst()
          if (!now || now.status === 'disconnected') throw new StoppedByDisconnect()
          // What the provider sent is kept before anything is posted from it.
          await raw.flush()
          for (const w of (page as { warnings?: string[] }).warnings ?? []) warnings.add(w.slice(0, 300))
          // Events the router doesn't take go to the ledger a page at a time (one transaction, far fewer round trips),
          // flushed before any routed event so the ledger sees them in the order they came.
          let pending: NormalizedEvent[] = []
          const flush = async () => {
            if (pending.length === 0) return
            const batch = pending
            pending = []
            const results = ledger.postBatch ? await ledger.postBatch(row.workspace_id, batch, ledger.settle ? { settleLater: true } : undefined) : await mapSeq(batch, (e) => ledger.post(row.workspace_id, e))
            for (const r of results) if (r.status === 'posted') posted++
          }
          const deduped = dedupeEvents(page.events)
          const routePage: RoutePage = { events: deduped, cache: new Map() }
          for (const e of deduped) {
            events++
            if (e.connectionId !== row.id) throw new Error('connector emitted an event for another connection')
            if (e.type === 'account.upsert') await this.upsertAccount(row.workspace_id, e, row.entity_id ?? null)
            const routed = await this.d.route?.(row.workspace_id, row.entity_id ?? null, e, routePage)
            if (routed) {
              await flush()
              if (routed.status === 'posted') posted++
            } else pending.push(e)
          }
          await this.d.pageDone?.(row.workspace_id, row.entity_id ?? null, routePage)
          await flush()
          if (page.updatedSecret !== undefined) await this.keepSecret(row, page.updatedSecret, page.cursor)
          else await db.updateTable('connections').set({ cursor: page.cursor }).where('id', '=', row.id).where('status', '!=', 'disconnected').execute()
        }),
      })
      await raw.flush()
      // Matching and opening balances for everything the pages posted, once (before the hooks, which read links).
      await this.settle(row.workspace_id, row.id)
      await db
        .updateTable('connections')
        .set({
          status: 'active',
          last_success_at: nowIso(),
          last_error: null,
          warnings_json: warnings.size ? JSON.stringify([...warnings].slice(0, 20)) : null,
          // Kept from the last sync when this one's pages didn't say (a SimpleFIN pass that read no accounts).
          ...(result.freshness ? { freshness_json: JSON.stringify(result.freshness) } : {}),
        })
        .where('id', '=', row.id)
        // Disconnected or paused while this sync was in flight: that stands (a disconnected Item must not come back).
        .where('status', 'not in', ['disconnected', 'paused'])
        .execute()
      // Record the version only once a full pass finished, so an interrupted re-import resumes next time.
      if (dataVersion !== undefined && result.complete && (v.done ?? 0) < dataVersion) await saveVersion({ done: dataVersion })
      for (const [i, hook] of (this.d.afterSync ?? []).entries()) {
        const run = () => hook(row.workspace_id, row.id).catch((err: unknown) => this.d.log?.('afterSync hook failed', { connectionId: row.id, error: err instanceof Error ? err.message : String(err) }))
        if (!perfEnabled()) await run()
        else console.info(`[agfn] perf afterSync hook ${i} of ${row.id}: ${perfLine(await withPerf(run))}`)
      }
      // Large backfills stop at maxPages; continue soon instead of waiting for the next round.
      if (!result.complete) await this.request(row.workspace_id, row.id, new Date(Date.now() + 5_000))
      // The provider is still preparing data (Plaid history right after linking): look again soon, not in an hour.
      else if (result.syncAgainInMs) await this.request(row.workspace_id, row.id, new Date(Date.now() + result.syncAgainInMs))
      return { status: result.complete ? 'ok' : 'partial', events, posted }
    } catch (err) {
      // Removed mid-sync: a clean stop, not a failure (no error status, no "sign in again", nothing kept from the page).
      if (err instanceof StoppedByDisconnect) {
        this.d.log?.('sync stopped: connection disconnected', { connectionId: row.id, level: 'info' })
        return { status: 'ok', events, posted, message: 'disconnected' }
      }
      // Keep what the provider sent even when posting failed (that's what you debug from).
      await raw.flush().catch(() => undefined)
      // Pages that did post still get matched now; if this fails too, the mark stays for the next run.
      await this.settle(row.workspace_id, row.id).catch(() => undefined)
      // Provider asked us to back off longer than the HTTP client waits: reschedule, don't mark the connection broken.
      if (isConnectorError(err) && err.kind === 'rate_limited' && typeof (err as { retryAfterMs?: number }).retryAfterMs === 'number') {
        await this.request(row.workspace_id, row.id, new Date(Date.now() + (err as { retryAfterMs: number }).retryAfterMs))
        return { status: 'partial', events, posted, message: 'rate limited; rescheduled' }
      }
      const health = healthFromError(err)
      // The provider's request id (QuickBooks intuit_tid, Plaid request_id…) is what their support asks for.
      const requestId = isConnectorError(err) ? err.requestId : undefined
      // The provider's own words stay in the log (with its request id); the drawer gets a sentence a person can act on.
      const rawText = err instanceof Error ? String((err as { cause?: unknown }).cause ?? err.message).slice(0, 300) : undefined
      this.d.log?.('sync failed', { connectionId: row.id, connector: row.connector_key, status: health.status, ...(requestId ? { requestId } : {}), ...(rawText ? { detail: rawText } : {}) })
      const failed = async () => {
        for (const hook of this.d.afterFailure ?? []) {
          await hook(row.workspace_id, row.id, err).catch((e: unknown) => this.d.log?.('afterFailure hook failed', { connectionId: row.id, error: e instanceof Error ? e.message : String(e) }))
        }
      }
      // Named as the person knows it ("Chase", "Xero · Demo Company"), not by the service that reached it.
      const plain = plainError(err, row.display_name || connector.describe().name)
      if (health.status === 'needs_reauth') {
        const out = await this.fail(row.id, 'needs_reauth', plain.message, events, posted)
        await failed()
        return out
      }
      await this.fail(row.id, 'error', plain.message, events, posted)
      await failed()
      // Transient and rate-limit errors are retried by the job queue's backoff; permanent ones are not.
      if (isConnectorError(err) && err.retryable) throw err
      if (!isConnectorError(err)) throw err
      return { status: 'error', events, posted, message: plain.message }
    }
  }

  private async fail(id: string, status: 'needs_reauth' | 'error', message: string, events = 0, posted = 0): Promise<SyncOutcome> {
    await this.d.db.updateTable('connections').set({ status, last_error: message.slice(0, 500) }).where('id', '=', id).where('status', 'not in', ['disconnected', 'paused']).execute()
    return { status, events, posted, message }
  }

  /** New accounts of a single-company connection (Stripe, QuickBooks, payroll) start in that company; multi-company
   *  bank logins (entity null) wait for "which company?". */
  private async upsertAccount(workspaceId: string, e: AccountUpsert, connectionEntityId: string | null): Promise<void> {
    const { db } = this.d
    const existing = await db
      .selectFrom('accounts')
      .select(['id', 'account_type'])
      .where('connection_id', '=', e.connectionId)
      .where('external_id', '=', e.externalId)
      .executeTakeFirst()
    if (existing) {
      // Re-typed from a cash type to a non-cash one (a CD or HSA once read as a bank account): out of cash. Only on that
      // change, so a person's own later choice to count it stays.
      const leavesCash = CASH_TYPES.has(existing.account_type) && !CASH_TYPES.has(e.accountType)
      await db
        .updateTable('accounts')
        .set({ name: e.name, account_type: e.accountType, currency: e.currency, mask: e.mask ?? null, institution: e.institution ?? null, ...(leavesCash ? { include_in_cash: 0 } : {}) })
        .where('id', '=', existing.id)
        .execute()
      return
    }
    // Same real account already connected through another source: mark as duplicate so it counts once. The mask plus
    // the account type are the backbone of the match; the institution is a free-text label that drifts between sources
    // ("Mercury" vs "Mercury Bank, N.A."), so it decides between candidates but doesn't gate the match. Only a live
    // twin counts: a closed account, or one on a disconnected connection (a re-linked bank), isn't a source.
    // We auto-link only when the answer is unambiguous — an exact institution match, or a single candidate. Two or
    // more candidates with no exact institution match are left separate here; the possible-duplicate flag (3b) is
    // what surfaces those, since a wrong auto-merge would hide a real, distinct account.
    let duplicateOf: string | null = null
    if (e.mask) {
      const candidates = await db
        .selectFrom('accounts as a')
        .innerJoin('connections as c', 'c.id', 'a.connection_id')
        .select(['a.id', 'a.institution'])
        .where('a.workspace_id', '=', workspaceId)
        .where('a.mask', '=', e.mask)
        .where('a.account_type', '=', e.accountType)
        .where('a.duplicate_of', 'is', null)
        .where('a.closed_at', 'is', null)
        .where('c.status', '!=', 'disconnected')
        .execute()
      // Auto-link only when both sides carry an institution label and they agree. A wrong merge is the dangerous
      // direction — the duplicate_of account drops out of cash, silently hiding real money — so a missing label on
      // either side (a bare statement upload, a connector that omits it) is never enough on a four-digit mask alone.
      // A missed merge stays visible: the possible-duplicate flag (3b) surfaces it. Within that, an exact label match
      // links decisively; otherwise link a single candidate that survives dropping clearly-different banks, and leave
      // two or more survivors — ambiguous — for 3b.
      if (candidates.length > 0 && e.institution) {
        const exact = candidates.find((c) => c.institution === e.institution)
        if (exact) duplicateOf = exact.id
        else {
          const compatible = candidates.filter((c) => c.institution && institutionsCompatible(e.institution, c.institution))
          if (compatible.length === 1) duplicateOf = compatible[0]!.id
        }
      }
    }
    // A personal account (an IRA, an HSA, a mortgage) arriving on a company's connection isn't assumed to be the
    // company's: it waits for "which company?" (the connect screen suggests Personal).
    let entityId = connectionEntityId
    if (entityId && e.businessHint === 'personal') {
      const ent = await db.selectFrom('entities').select('kind').where('id', '=', entityId).executeTakeFirst()
      if (ent?.kind === 'company') entityId = null
    }
    await db
      .insertInto('accounts')
      .values({
        id: newId(),
        workspace_id: workspaceId,
        entity_id: entityId,
        connection_id: e.connectionId,
        external_id: e.externalId,
        name: e.name,
        account_type: e.accountType,
        currency: e.currency,
        mask: e.mask ?? null,
        institution: e.institution ?? null,
        business_hint: e.businessHint ?? null,
        // Cash = money you hold: bank accounts, cash on hand, processor balances. Cards, loans and investments are tracked, not cash.
        include_in_cash: !duplicateOf && CASH_TYPES.has(e.accountType) ? 1 : 0,
        duplicate_of: duplicateOf,
        created_at: nowIso(),
        closed_at: null,
      })
      .execute()
  }
}

/** Saves a new connection with its secret sealed to that row. */
export async function createConnection(
  db: Kysely<CoreTables>,
  keys: KeyRing,
  input: { workspaceId: string; connectorKey: string; displayName: string; secret: unknown; config: Record<string, unknown>; createdBy: string | null; entityId?: string | null },
): Promise<string> {
  const id = newId()
  const secretEnc = input.secret == null ? null : seal(keys, input.secret, { workspaceId: input.workspaceId, recordId: id, purpose: SECRET_PURPOSE })
  await db
    .insertInto('connections')
    .values({
      id,
      workspace_id: input.workspaceId,
      connector_key: input.connectorKey,
      entity_id: input.entityId ?? null,
      display_name: input.displayName,
      status: 'active',
      secret_enc: secretEnc,
      config_json: JSON.stringify(input.config ?? {}),
      cursor: null,
      last_sync_at: null,
      last_success_at: null,
      last_error: null,
      created_by: input.createdBy,
      created_at: nowIso(),
    })
    .execute()
  return id
}

export type { NormalizedEvent }

/**
 * Tell the ledger about accounts whose company was set outside a person's action (migration 0301's backfill), so it
 * re-posts the events it held as "unassigned". Runs at boot; each account is handled once.
 */
export async function applyPendingReassignments(db: Kysely<CoreTables>, ledger: Pick<Ledger, 'accountChanged'>): Promise<number> {
  const q = db as unknown as Kysely<{ account_reassignments: { id: string; workspace_id: string; account_id: string } }>
  const rows = await q.selectFrom('account_reassignments').select(['id', 'workspace_id', 'account_id']).execute()
  for (const r of rows) {
    await ledger.accountChanged?.(r.workspace_id, r.account_id)
    await q.deleteFrom('account_reassignments').where('id', '=', r.id).execute()
  }
  return rows.length
}

async function mapSeq<T, R>(xs: readonly T[], fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (const x of xs) out.push(await fn(x))
  return out
}

/** config.sharedSecretKey: connections from one sign-in that share one rotating token (e.g. Xero organisations). */
function sharedSecretKeyOf(configJson: string): string | undefined {
  try {
    const v = (JSON.parse(configJson) as Record<string, unknown>).sharedSecretKey
    return typeof v === 'string' && v ? v : undefined
  } catch {
    return undefined
  }
}

/** Any other live connection of this provider account, in any workspace (only the account key leaves the query). */
async function liveElsewhere(db: Kysely<CoreTables>, row: { id: string; connector_key: string }, same: (config: Record<string, unknown>) => boolean): Promise<boolean> {
  const rows = await withBypass('disconnect:same-account', () =>
    db.selectFrom('connections').select(['config_json']).where('connector_key', '=', row.connector_key).where('status', '!=', 'disconnected').where('id', '!=', row.id).execute(),
  )
  return rows.some((r) => same(JSON.parse(r.config_json) as Record<string, unknown>))
}

/** The other live connections of the same workspace and connector that share this token. */
async function siblingsOf(
  db: Kysely<CoreTables>,
  row: { id: string; workspace_id: string; connector_key: string },
  grant: string,
): Promise<Array<{ id: string }>> {
  const rows = await db
    .selectFrom('connections')
    .select(['id', 'config_json'])
    .where('workspace_id', '=', row.workspace_id)
    .where('connector_key', '=', row.connector_key)
    .where('status', '!=', 'disconnected')
    .where('id', '!=', row.id)
    .execute()
  return rows.filter((r) => sharedSecretKeyOf(r.config_json) === grant).map((r) => ({ id: r.id }))
}

/** Account types counted as cash by default: money you hold (bank accounts, cash on hand, processor balances). */
/** A sync's lease on its token (renewed every third of this while it runs); a dead machine's expires after it. */
const SYNC_LEASE_MS = 90_000
/** How often a sync waiting on another machine's lease looks again. */
const SYNC_LEASE_POLL_MS = 250
const CASH_TYPES: ReadonlySet<string> = new Set(['depository', 'cash_on_hand', 'processor_balance'])

/** Whether two free-text institution labels could name the same bank. A missing label can't contradict, so it's
 *  compatible with anything. Otherwise we compare on letters and digits only (dropping spaces, case and punctuation):
 *  equal, or one a prefix of the other, counts as drift of the same name ("Mercury" ⊂ "Mercury Bank, N.A."). Two
 *  present, clearly different labels ("Chase" vs "Wells Fargo") are taken as different banks — the mask alone (four
 *  digits) is too weak to merge on, so we keep them separate and let the possible-duplicate flag surface a real match. */
export function institutionsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return true
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '')
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!x || !y) return true
  return x === y || x.startsWith(y) || y.startsWith(x)
}
