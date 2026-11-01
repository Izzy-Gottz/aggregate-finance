// Test kit: the same ledger on three backends (memory, SQLite, Postgres via PGlite), plus event builders.
// Used by the golden-answer tests; not exported from the package.
import type {
  AccountType,
  BalanceSnapshot,
  EntityId,
  Id,
  InvoiceUpsert,
  Money,
  NormalizedEvent,
  ProcessorBalanceTxn,
  TxnUpsert,
} from '@agfn/contracts'
import { connect, connectPglite, migrateToLatest, newId, type CoreTables, type DbHandle } from '@agfn/db'
import type { Kysely } from 'kysely'
import { cashRole } from './coa.ts'
import { LedgerEngine } from './engine.ts'
import { MemoryRateSource } from './fx.ts'
import { DbScope, KyselyDirectory, KyselyLedgerStore, type LedgerTables } from './kysely-store.ts'
import { MemoryDirectory, MemoryLedgerStore, defaultIncludeInCash } from './memory-store.ts'
import type { Basis, SourceAccountInfo } from './model.ts'
import type { LedgerStore, RateSource } from './store.ts'

export type Backend = 'memory' | 'sqlite' | 'pglite'

export interface Kit {
  backend: Backend
  engine: LedgerEngine
  rates: MemoryRateSource
  ws: string
  /** Fixed clock; tests move it with setNow. */
  setNow(iso: string): void
  company(name: string, opts?: { currency?: string }): Promise<EntityId>
  personal(name: string, opts?: { currency?: string }): Promise<EntityId>
  connection(opts?: { entityId?: EntityId | null; key?: string; lastSuccessAt?: string | null; createdAt?: string; status?: 'active' | 'needs_reauth' | 'error' | 'paused' | 'disconnected' }): Promise<Id>
  /** The connection is disconnected from now on (what it already posted stays as it was). */
  disconnect(connectionId: Id): Promise<void>
  account(opts: { entityId: EntityId | null; type?: AccountType; currency?: string; name?: string; connectionId?: Id; includeInCash?: boolean; mask?: string; businessHint?: 'business' | 'personal' | 'unknown' }): Promise<SourceAccountInfo>
  assign(accountId: Id, entityId: EntityId): Promise<void>
  markDuplicate(accountId: Id, of: Id): Promise<void>
  /** Signed base balance (debit − credit) of a role in an entity. */
  bal(entityId: EntityId, role: string, basis?: Basis, toDate?: string): Promise<number>
  /** Sum of all base debits − credits for an entity/basis (must be 0). */
  tb(entityId: EntityId, basis?: Basis): Promise<number>
  close(): Promise<void>
}

export async function makeKit(backend: Backend, opts: { reporting?: string; now?: string; timeZone?: string; rates?: (store: LedgerStore) => RateSource } = {}): Promise<Kit> {
  let now = opts.now ?? '2026-10-09T12:00:00.000Z'
  const rates = new MemoryRateSource()
  const reporting = opts.reporting ?? 'USD'
  const ws = newId()
  if (backend === 'memory') {
    const store = new MemoryLedgerStore()
    const dir = new MemoryDirectory()
    dir.setReportingCurrency(ws, reporting)
    // Golden dates are UTC days; the local-date behaviour has its own tests.
    dir.setTimeZone(ws, opts.timeZone ?? 'UTC')
    const engine = new LedgerEngine({ store, directory: dir, rates: opts.rates?.(store) ?? rates, now: () => now })
    const kit: Kit = {
      backend,
      engine,
      rates,
      ws,
      setNow: (iso) => {
        now = iso
      },
      company: async (name, o = {}) => dir.addEntity(ws, { id: newId(), name, kind: 'company', baseCurrency: o.currency ?? 'USD' }).id,
      personal: async (name, o = {}) => dir.addEntity(ws, { id: newId(), name, kind: 'personal', baseCurrency: o.currency ?? 'USD', ownerPersonId: newId() }).id,
      disconnect: async (id) => dir.setConnectionStatus(id, 'disconnected'),
      connection: async (o = {}) => dir.addConnection(ws, { id: newId(), connectorKey: o.key ?? 'test', entityId: o.entityId ?? null, lastSuccessAt: o.lastSuccessAt === undefined ? now : o.lastSuccessAt, createdAt: o.createdAt ?? now, ...(o.status ? { status: o.status } : {}) }).id,
      account: async (o) => {
        const connectionId = o.connectionId ?? (await kit.connection())
        const type = o.type ?? 'depository'
        return dir.addAccount(ws, {
          id: newId(),
          name: o.name ?? type,
          connectionId,
          externalId: `ext-${newId()}`,
          entityId: o.entityId,
          accountType: type,
          currency: o.currency ?? 'USD',
          includeInCash: o.includeInCash ?? defaultIncludeInCash(type),
          mask: o.mask ?? null,
          businessHint: o.businessHint ?? null,
        })
      },
      assign: async (accountId, entityId) => {
        dir.assignAccount(accountId, entityId)
        await engine.accountChanged(ws, accountId)
      },
      markDuplicate: async (accountId, of) => {
        dir.updateAccount(accountId, { duplicateOf: of })
        await engine.accountChanged(ws, accountId)
      },
      bal: (e, role, basis = 'cash', toDate) => balance(engine, ws, e, role, basis, toDate),
      tb: (e, basis = 'cash') => trial(engine, ws, e, basis),
      close: async () => undefined,
    }
    return kit
  }

  // PGlite is slow to start and migrate, so one instance is shared; every kit gets its own workspace.
  const h: DbHandle<CoreTables & LedgerTables> = backend === 'sqlite' ? connect('sqlite::memory:') : await sharedPglite()
  if (backend === 'sqlite') await migrateToLatest(h.db as Kysely<unknown> as Kysely<any>)
  const db = h.db
  await db.insertInto('workspaces').values({ id: ws, name: 'Test', base_currency: reporting, time_zone: opts.timeZone ?? 'UTC', created_at: now }).execute()
  const scope = new DbScope(db)
  const store = new KyselyLedgerStore(scope)
  const dir = new KyselyDirectory(scope)
  const engine = new LedgerEngine({ store, directory: dir, rates: opts.rates?.(store) ?? rates, now: () => now })
  const addEntity = async (name: string, kind: 'company' | 'personal', currency: string): Promise<EntityId> => {
    const id = newId()
    let owner: string | null = null
    if (kind === 'personal') {
      owner = newId()
      await db.insertInto('people').values({ id: owner, auth_user_id: null, name, email: `${owner}@example.test`, created_at: now }).execute()
    }
    await db
      .insertInto('entities')
      .values({ id, workspace_id: ws, kind, name, base_currency: currency, owner_person_id: owner, parent_entity_id: null, fiscal_year_start_month: 1, created_at: now, archived_at: null })
      .execute()
    return id
  }
  const kit: Kit = {
    backend,
    engine,
    rates,
    ws,
    setNow: (iso) => {
      now = iso
    },
    company: (name, o = {}) => addEntity(name, 'company', o.currency ?? 'USD'),
    personal: (name, o = {}) => addEntity(name, 'personal', o.currency ?? 'USD'),
    disconnect: async (id) => {
      await db.updateTable('connections').set({ status: 'disconnected' }).where('id', '=', id).execute()
    },
    connection: async (o = {}) => {
      const id = newId()
      await db
        .insertInto('connections')
        .values({
          id,
          workspace_id: ws,
          connector_key: o.key ?? 'test',
          display_name: o.key ?? 'test',
          status: o.status ?? 'active',
          secret_enc: null,
          config_json: '{}',
          entity_id: o.entityId ?? null,
          cursor: null,
          last_sync_at: null,
          last_success_at: o.lastSuccessAt === undefined ? now : o.lastSuccessAt,
          last_error: null,
          created_by: null,
          created_at: o.createdAt ?? now,
        })
        .execute()
      return id
    },
    account: async (o) => {
      const connectionId = o.connectionId ?? (await kit.connection())
      const type = o.type ?? 'depository'
      const id = newId()
      await db
        .insertInto('accounts')
        .values({
          id,
          workspace_id: ws,
          entity_id: o.entityId,
          connection_id: connectionId,
          external_id: `ext-${id}`,
          name: o.name ?? type,
          account_type: type,
          currency: o.currency ?? 'USD',
          mask: o.mask ?? null,
          institution: null,
          business_hint: o.businessHint ?? null,
          include_in_cash: (o.includeInCash ?? defaultIncludeInCash(type)) ? 1 : 0,
          duplicate_of: null,
          created_at: now,
          closed_at: null,
        })
        .execute()
      return (await dir.getSourceAccount(ws, id)) as SourceAccountInfo
    },
    assign: async (accountId, entityId) => {
      await db.updateTable('accounts').set({ entity_id: entityId }).where('id', '=', accountId).execute()
      await engine.accountChanged(ws, accountId)
    },
    markDuplicate: async (accountId, of) => {
      await db.updateTable('accounts').set({ duplicate_of: of }).where('id', '=', accountId).execute()
      await engine.accountChanged(ws, accountId)
    },
    bal: (e, role, basis = 'cash', toDate) => balance(engine, ws, e, role, basis, toDate),
    tb: (e, basis = 'cash') => trial(engine, ws, e, basis),
    close: () => (backend === 'sqlite' ? h.close() : Promise.resolve()),
  }
  return kit
}

let pglite: Promise<DbHandle<CoreTables & LedgerTables>> | null = null

function sharedPglite(): Promise<DbHandle<CoreTables & LedgerTables>> {
  pglite ??= (async () => {
    const h = await connectPglite<CoreTables & LedgerTables>()
    await migrateToLatest(h.db as Kysely<unknown> as Kysely<any>)
    return h
  })()
  return pglite
}

async function balance(engine: LedgerEngine, ws: string, entityId: EntityId, role: string, basis: Basis, toDate?: string): Promise<number> {
  const acct = await engine.store.findLedgerAccount(ws, entityId, role as never)
  if (!acct) return 0
  const lines = await engine.store.listLines(ws, { entityIds: [entityId], basis, ledgerAccountIds: [acct.id], ...(toDate ? { toDate } : {}) })
  return lines.reduce((s, l) => s + l.baseDebitMinor - l.baseCreditMinor, 0)
}

async function trial(engine: LedgerEngine, ws: string, entityId: EntityId, basis: Basis): Promise<number> {
  const totals = await engine.store.accountTotals(ws, { entityIds: [entityId], basis })
  return totals.reduce((s, t) => s + t.baseDebitMinor - t.baseCreditMinor, 0)
}

// ---------- Event builders ----------

export const usd = (minor: number): Money => ({ minor, currency: 'USD' })
export const eur = (minor: number): Money => ({ minor, currency: 'EUR' })

let seq = 0
const ext = (p: string): string => `${p}-${++seq}`

export function txn(acc: SourceAccountInfo, date: string, amount: Money | number, o: Partial<TxnUpsert> = {}): TxnUpsert {
  return {
    type: 'txn.upsert',
    externalId: ext('txn'),
    connectionId: acc.connectionId as string,
    accountExternalId: acc.externalId as string,
    date,
    amount: typeof amount === 'number' ? { minor: amount, currency: acc.currency } : amount,
    status: 'posted',
    ...o,
  }
}

export function snapshot(acc: SourceAccountInfo, at: string, current: number, o: Partial<BalanceSnapshot> = {}): BalanceSnapshot {
  return {
    type: 'balance.snapshot',
    externalId: ext('bal'),
    connectionId: acc.connectionId as string,
    accountExternalId: acc.externalId as string,
    at: at.length === 10 ? `${at}T23:00:00Z` : at,
    current: { minor: current, currency: acc.currency },
    ...o,
  }
}

export function stripe(acc: SourceAccountInfo, at: string, kind: ProcessorBalanceTxn['kind'], gross: number, fee: number, o: Partial<ProcessorBalanceTxn> = {}): ProcessorBalanceTxn {
  const c = acc.currency
  return {
    type: 'processor.balance_txn',
    externalId: ext('txn_stripe'),
    connectionId: acc.connectionId as string,
    accountExternalId: acc.externalId as string,
    at: at.length === 10 ? `${at}T10:00:00Z` : at,
    kind,
    gross: { minor: gross, currency: c },
    fee: { minor: fee, currency: c },
    net: { minor: gross - fee, currency: c },
    ...o,
  }
}

export function invoice(connectionId: Id, o: Partial<InvoiceUpsert> & Pick<InvoiceUpsert, 'total'>): InvoiceUpsert {
  return {
    type: 'invoice.upsert',
    externalId: ext('inv'),
    connectionId,
    direction: 'receivable',
    counterparty: 'Globex Corp',
    issueDate: '2026-09-01',
    dueDate: '2026-09-30',
    amountPaid: { minor: 0, currency: o.total.currency },
    status: 'open',
    ...o,
  }
}

export function asEvents(...evs: NormalizedEvent[]): NormalizedEvent[] {
  return evs
}

export { cashRole }
