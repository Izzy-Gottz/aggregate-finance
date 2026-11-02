import { Kysely, PostgresDialect } from 'kysely'
import pg from 'pg'
import { nodeSqliteDialect } from './sqlite-dialect.ts'
import { ownerPool, registerOwner, rlsEnabled, rlsPool } from './rls.ts'
import { perfCount, perfEnabled, perfPool } from './perf.ts'
import { heldCheckPool } from './held.ts'

export type DbKind = 'sqlite' | 'postgres'

export interface DbHandle<T> {
  db: Kysely<T>
  /** Always on the bypass side of RLS, on the same pool. Only for Better Auth. */
  ownerDb?: Kysely<T>
  kind: DbKind
  close(): Promise<void>
}

// Postgres returns int8 (bigint) as strings; money is stored in minor units well inside Number's safe range.
pg.types.setTypeParser(20, (v: string) => {
  const n = Number(v)
  if (!Number.isSafeInteger(n)) throw new Error(`bigint out of safe range: ${v}`)
  return n
})

/**
 * DATABASE_URL forms: "sqlite:/data/agfn.db", "sqlite::memory:", or "postgres://user:pass@host/db".
 * Self-host defaults to SQLite; hosted runs Postgres with row-level security (S9).
 */
const pooled = new WeakSet<object>()

/**
 * Whether this database has more than one connection (a Postgres pool). SQLite and PGlite have one: a transaction
 * held open there blocks every other query on the same database until it ends.
 */
export function isPooled(db: object): boolean {
  return pooled.has(db)
}

/** How long a checkout waits for a free connection before failing (AGFN_PG_CHECKOUT_TIMEOUT_MS, default 15 s). */
const checkoutMs = () => Number(process.env.AGFN_PG_CHECKOUT_TIMEOUT_MS ?? 15_000)

export class PoolBusyError extends Error {}

/**
 * A checkout that waits past the timeout fails with one clear log line (pool sizes, connections in use, waiters, the
 * call site) instead of hanging: a starved pool shows up as a named error, not a silent stall or a bare 500.
 */
export function failFastCheckout<P extends { connect(): Promise<any> }>(pool: P, pools: Array<{ name: string; totalCount: number; idleCount: number; waitingCount: number; options?: { max?: number } }>, ms: number = checkoutMs()): P {
  const wrapped = Object.create(pool) as P
  wrapped.connect = async () => {
    try {
      return await pool.connect()
    } catch (err) {
      if (!(err instanceof Error) || !/timeout exceeded when trying to connect/i.test(err.message)) throw err
      const state = pools.map((p) => `${p.name}: max ${p.options?.max ?? '?'}, open ${p.totalCount}, idle ${p.idleCount}, waiting ${p.waitingCount}`).join('; ')
      const site = (new Error().stack ?? '').split('\n').slice(2).filter((l) => !l.includes('node_modules') && !l.includes('node:internal')).slice(0, 6).map((l) => l.trim().replace(/^at /, '')).join(' < ')
      console.warn(`[agfn] database pool busy: no connection within ${ms} ms (${state}) at ${site || 'unknown'}`)
      throw new PoolBusyError(`The database is busy right now (no connection within ${Math.round(ms / 1000)} s). Try again in a moment.`)
    }
  }
  return wrapped
}

/** The request pool for phase 2: same limits as the main pool, logging in as the app role. */
function secondPool(url: string, onError: (err: Error) => void, statementMs: number, idleTxMs: number): pg.Pool {
  const p = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10), connectionTimeoutMillis: checkoutMs() })
  p.on('error', onError)
  p.on('connect', (client) => {
    client.on('error', onError)
    client.query(`set statement_timeout = ${Math.max(0, Math.floor(statementMs))}; set idle_in_transaction_session_timeout = ${Math.max(0, Math.floor(idleTxMs))}`).catch(() => undefined)
  })
  return p
}

export function connect<T>(url: string): DbHandle<T> {
  if (url.startsWith('sqlite:')) {
    const path = url.slice('sqlite:'.length) || ':memory:'
    // AGFN_PERF_LOG=1 counts SQLite statements too (each query Kysely runs), so a fill can be measured locally.
    const counter = { transformQuery: (a: { node: any }) => (perfCount('statement'), a.node), transformResult: async (a: { result: any }) => a.result }
    const db = new Kysely<T>({ dialect: nodeSqliteDialect(path), ...(perfEnabled() ? { plugins: [counter] } : {}) })
    return { db, kind: 'sqlite', close: () => db.destroy() }
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const raw = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10), connectionTimeoutMillis: checkoutMs() })
    // A connection the server ends (restart, idle-in-transaction timeout, network blip) emits 'error'. Unhandled, that
    // kills the whole process; handled, only the query on that connection fails and the pool replaces it.
    const onError = (err: Error) => console.warn('[agfn] database connection error:', err.message)
    raw.on('error', onError)
    // The same limits on any Postgres (Neon ends idle transactions on its own schedule): no statement runs longer than
    // 30 s and no transaction sits idle over 60 s. Set per connection, so it works through poolers too.
    const statementMs = Number(process.env.AGFN_PG_STATEMENT_TIMEOUT_MS ?? 30_000)
    const idleTxMs = Number(process.env.AGFN_PG_IDLE_TX_TIMEOUT_MS ?? 60_000)
    raw.on('connect', (client) => {
      client.on('error', onError)
      client.query(`set statement_timeout = ${Math.max(0, Math.floor(statementMs))}; set idle_in_transaction_session_timeout = ${Math.max(0, Math.floor(idleTxMs))}`).catch(() => undefined)
    })
    // Prototype (docs/security/rls.md): stamp each checkout with the request's workspace. Off by default.
    // The RLS stamp is inside the counting wrapper, so its round trip counts as a statement too.
    const counted = perfEnabled() ? perfPool(raw) : raw
    // Phase 2: requests use their own login (AGFN_PG_APP_URL, the RLS-bound role); this pool is then for bypass work only.
    const appUrl = rlsEnabled() ? process.env.AGFN_PG_APP_URL : undefined
    const appPool = appUrl ? secondPool(appUrl, onError, statementMs, idleTxMs) : undefined
    const pool = rlsEnabled() ? rlsPool(counted, { ...(process.env.AGFN_PG_RLS_ROLE ? { role: process.env.AGFN_PG_RLS_ROLE } : {}), ...(appPool ? { appPool: perfEnabled() ? perfPool(appPool) : appPool } : {}) }) : counted
    const pools = [Object.assign(raw, { name: 'main' }), ...(appPool ? [Object.assign(appPool, { name: 'app' })] : [])]
    const checked = failFastCheckout(heldCheckPool(pool), pools)
    const db = new Kysely<T>({ dialect: new PostgresDialect({ pool: checked }) })
    pooled.add(db)
    const ownerDb = new Kysely<T>({ dialect: new PostgresDialect({ pool: ownerPool(checked) }) })
    registerOwner(db, ownerDb)
    return { db, ownerDb, kind: 'postgres', close: () => db.destroy() }
  }
  throw new Error('DATABASE_URL must start with sqlite: or postgres://')
}
