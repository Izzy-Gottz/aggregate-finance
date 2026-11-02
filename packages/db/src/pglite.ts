import { ownerPool, registerOwner } from './rls.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kysely, PostgresDialect } from 'kysely'
import type { DbHandle } from './connect.ts'
import { migrateToLatest, migrationsDir } from './migrate.ts'
import { heldCheckPool } from './held.ts'

/**
 * A PGlite already migrated to the latest schema, as a data-directory tarball: built once per set of migration files and
 * kept on disk (keyed by their names and contents), so every test that boots Postgres loads it instead of replaying ~500
 * DDL statements. Those replays were slow and, under memory pressure, stalled the merge gate for minutes (PGlite runs
 * synchronously in WASM). A changed migration changes the key, so the snapshot is never stale.
 */
let snapshot: Promise<Blob> | undefined
function migratedSnapshot(): Promise<Blob> {
  snapshot ??= buildSnapshot().catch((err: unknown) => {
    snapshot = undefined
    throw err
  })
  return snapshot
}
async function buildSnapshot(): Promise<Blob> {
  const dir = migrationsDir()
  const h = createHash('sha256').update(dir)
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.+\.(ts|mjs|js)$/.test(n)).sort()) h.update(f).update(readFileSync(join(dir, f)))
  const cacheDir = join(tmpdir(), 'agfn-pglite')
  const file = join(cacheDir, `migrated-${h.digest('hex').slice(0, 16)}.tar.gz`)
  try {
    return new Blob([readFileSync(file)])
  } catch {
    // Not built yet: build it below.
  }
  const { PGlite } = await import('@electric-sql/pglite')
  const pg = new PGlite()
  await pg.waitReady
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: { connect: async () => ({ query: async (sql: string, params: unknown[]) => { const r = await pg.query<Record<string, unknown>>(sql, params as never[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, command: sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '' } }, release() {} }), end: async () => {} } as never }) })
  await migrateToLatest(db, dir)
  const blob = await pg.dumpDataDir('gzip')
  await pg.close()
  // Written to a temporary name and renamed, so a worker reading it never sees half a file.
  mkdirSync(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}`
  writeFileSync(tmp, Buffer.from(await blob.arrayBuffer()))
  renameSync(tmp, file)
  // Snapshots of older migration sets are never read again (~5 MB each).
  for (const f of readdirSync(cacheDir)) if (f.startsWith('migrated-') && join(cacheDir, f) !== file && f.endsWith('.tar.gz')) rmSync(join(cacheDir, f), { force: true })
  return blob
}

/**
 * Real Postgres (compiled to WebAssembly) in-process, for tests that prove migrations and queries run on Postgres
 * without needing a database server. Dev/test only; production uses `connect('postgres://…')`.
 */
export async function connectPglite<T>(
  opts: {
    wrapPool?: <P extends { connect(): Promise<any>; end(): Promise<void> }>(pool: P) => P
    /** Start from an empty database (for tests of the migrations themselves); otherwise from the migrated snapshot
     * (AGFN_PGLITE_SNAPSHOT=0 turns the snapshot off everywhere). */
    empty?: boolean
  } = {},
): Promise<DbHandle<T>> {
  const { PGlite } = await import('@electric-sql/pglite')
  const pg = opts.empty || process.env.AGFN_PGLITE_SNAPSHOT === '0' ? new PGlite() : new PGlite({ loadDataDir: await migratedSnapshot() })
  await pg.waitReady
  let chain = Promise.resolve()
  // PGlite is single-connection; serialize queries the way a 1-connection pool would.
  const client = {
    async query(sql: string, params: unknown[]) {
      const run = chain.then(() => pg.query<Record<string, unknown>>(sql, params as never[]))
      chain = run.then(
        () => undefined,
        () => undefined,
      )
      const r = await run
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, command: sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '' }
    },
    release() {},
  }
  const base = { connect: async () => client, end: async () => pg.close() }
  // Checked outermost: under exclusivePool a nested checkout would otherwise wait forever before reaching the check.
  const pool = heldCheckPool(opts.wrapPool ? opts.wrapPool(base) : base)
  const db = new Kysely<T>({ dialect: new PostgresDialect({ pool: pool as never }) })
  const ownerDb = new Kysely<T>({ dialect: new PostgresDialect({ pool: ownerPool(pool) as never }) })
  registerOwner(db, ownerDb)
  return { db, ownerDb, kind: 'postgres', close: () => db.destroy() }
}

/**
 * Make PGlite's single shared client behave like a one-connection pg.Pool: one checkout at a time, released by
 * release(). Row-level security stamping relies on that exclusivity (docs/security/rls.md).
 */
export function exclusivePool<P extends { connect(): Promise<any>; end(): Promise<void> }>(pool: P): P {
  let tail: Promise<void> = Promise.resolve()
  let handle: { query(t: string, v?: unknown[]): Promise<unknown>; release(): void } | undefined
  let current: () => void = () => {}
  const wrapped = Object.create(pool) as P
  wrapped.connect = async () => {
    let free!: () => void
    const prev = tail
    tail = new Promise<void>((r) => (free = r))
    await prev
    const client = await pool.connect()
    handle ??= { query: (t: string, v?: unknown[]) => client.query(t, v), release: () => current() }
    current = free
    return handle
  }
  return wrapped
}
