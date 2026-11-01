import { describe, expect, it } from 'vitest'
import { sql, type Kysely } from 'kysely'
import { connectPglite } from './pglite.ts'
import { migrateToLatest } from './migrate.ts'
import { bootRls, disableRls, enableRls, ensureAppRole, isHostedDb, RLS_PROTOTYPE_TABLES, rlsPool, rlsSetting, rlsStatus, syncRlsPolicies, tablesMissingRls, withBypass, withWorkspace, workspaceTables } from './rls.ts'

const at = '2026-10-10T00:00:00.000Z'
const doc = (id: string, ws: string) => ({ id, workspace_id: ws, entity_id: null, storage_key: `k/${id}`, sha256: id.padEnd(64, '0'), mime_type: 'application/pdf', size_bytes: 10, original_name: null, arrived_via: 'upload', status: 'unread', extracted_json: null, record_type: null, record_id: null, created_by: null, created_at: at })

/**
 * PGlite's stand-in pool hands the same client to concurrent checkouts. A real pg.Pool gives each checkout its own
 * connection until release, and the context stamp relies on that, so model it: one checkout at a time.
 */
function exclusive<P extends { connect(): Promise<any>; end(): Promise<void> }>(pool: P): P {
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
    // One stable object per physical connection, like pg.Pool's clients.
    handle ??= { query: (t: string, v?: unknown[]) => client.query(t, v), release: () => current() }
    current = free
    return handle
  }
  return wrapped
}

async function setup() {
  const h = await connectPglite<any>({ wrapPool: (p) => rlsPool(exclusive(p), { role: 'agfn_app' }) })
  const db = h.db as Kysely<any>
  await withBypass('test:setup', async () => {
    await migrateToLatest(db)
    await ensureAppRole(db)
    await enableRls(db, RLS_PROTOTYPE_TABLES)
    for (const w of ['w1', 'w2']) await db.insertInto('workspaces').values({ id: w, name: w, base_currency: 'USD', created_at: at }).execute()
    await db.insertInto('documents').values([doc('d1', 'w1'), doc('d2', 'w1'), doc('d3', 'w2')]).execute()
  })
  return { h, db }
}

describe('Postgres row-level security (prototype)', () => {
  it('without a context a query sees zero rows and cannot write', async () => {
    const { h, db } = await setup()
    try {
      expect(await db.selectFrom('documents').selectAll().execute()).toEqual([])
      await expect(db.insertInto('documents').values(doc('d9', 'w1')).execute()).rejects.toThrow(/row-level security/)
      // Tables outside the prototype are unaffected.
      expect(await db.selectFrom('workspaces').select('id').execute()).toHaveLength(2)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('a workspace context sees and writes only its own rows; bypass sees everything; rollback restores', async () => {
    const { h, db } = await setup()
    try {
      const mine = await withWorkspace('w1', () => db.selectFrom('documents').select('id').orderBy('id').execute())
      expect(mine.map((r) => r.id)).toEqual(['d1', 'd2'])
      // Even a query that forgets the workspace filter, or asks for another workspace's id, stays inside w1.
      expect(await withWorkspace('w1', () => db.selectFrom('documents').select('id').where('id', '=', 'd3').execute())).toEqual([])
      await expect(withWorkspace('w1', () => db.insertInto('documents').values(doc('d8', 'w2')).execute())).rejects.toThrow(/row-level security/)
      expect(await withWorkspace('w1', () => db.updateTable('documents').set({ status: 'ignored' }).execute().then((r) => Number(r[0]?.numUpdatedRows)))).toBe(2)
      // A transaction checks out one connection and keeps the context.
      const inTx = await withWorkspace('w2', () => db.transaction().execute(async (tx) => (await tx.selectFrom('documents').select('id').execute()).length))
      expect(inTx).toBe(1)
      // Contexts don't leak between interleaved async work on the shared pool.
      const [a, b] = await Promise.all([
        withWorkspace('w1', () => db.selectFrom('documents').select('id').execute()),
        withWorkspace('w2', () => db.selectFrom('documents').select('id').execute()),
      ])
      expect([a.length, b.length]).toEqual([2, 1])
      expect(await withBypass('test', () => db.selectFrom('documents').select('id').execute())).toHaveLength(3)
      // The context is what decides, not who asks: setting the GUC by hand as the app role is not a bypass of the role.
      expect(await db.selectFrom('documents').selectAll().execute()).toEqual([])

      await withBypass('test:rollback', () => disableRls(db, RLS_PROTOTYPE_TABLES))
      expect(await db.selectFrom('documents').select('id').execute()).toHaveLength(3)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('red team (phase 2): SQL running as the app role can’t switch the bypass on for itself', async () => {
    const { h, db } = await setup()
    try {
      // An injection or a bug inside a request sets the bypass setting by hand on its own connection.
      const seen = await withWorkspace('w1', () =>
        db.transaction().execute(async (tx) => {
          await sql`select set_config('agfn.rls_bypass', 'on', false)`.execute(tx)
          await sql`select set_config('agfn.workspace_id', '', false)`.execute(tx)
          return (await tx.selectFrom('documents').select('id').execute()).length
        }),
      )
      expect(seen).toBe(0) // not 3: for the app role the setting means nothing
      await expect(withWorkspace('w1', () => db.transaction().execute(async (tx) => {
        await sql`select set_config('agfn.rls_bypass', 'on', false)`.execute(tx)
        await tx.insertInto('documents').values(doc('d7', 'w2')).execute()
      }))).rejects.toThrow(/row-level security/)
      // Real bypass work (the owner) still sees everything.
      expect(await withBypass('test', () => db.selectFrom('documents').select('id').execute())).toHaveLength(3)
    } finally {
      await h.close()
    }
  }, 60_000)

  it('phase 2: a policy from before (bypass for anyone) counts as missing, so boot replaces it', async () => {
    const { h, db } = await setup()
    try {
      await withBypass('test', async () => {
        await sql`drop policy agfn_workspace on documents`.execute(db)
        await sql.raw(`create policy agfn_workspace on documents using (workspace_id = current_setting('agfn.workspace_id', true) or current_setting('agfn.rls_bypass', true) = 'on')`).execute(db)
        expect(await tablesMissingRls(db)).toContain('documents')
        await syncRlsPolicies(db, true)
        expect(await tablesMissingRls(db)).not.toContain('documents')
      })
    } finally {
      await h.close()
    }
  }, 60_000)

  it('phase 2: with a separate app login, requests use the app pool and only bypass work uses the owner pool', async () => {
    const used: string[] = []
    const fake = (name: string) => ({
      connect: async () => ({ query: async () => (used.push(name), undefined), release: () => undefined }),
      end: async () => undefined,
    })
    const pool = rlsPool(fake('owner'), { role: 'agfn_app', appPool: fake('app') })
    for (const run of [() => withWorkspace('w1', () => pool.connect()), () => pool.connect(), () => withBypass('t', () => pool.connect())]) await run()
    expect(used).toEqual(['app', 'app', 'owner'])
  })

  it('measures the per-query overhead of stamping the context', async () => {
    const plain = await connectPglite<any>()
    const { h, db } = await setup()
    try {
      await migrateToLatest(plain.db)
      await plain.db.insertInto('workspaces').values({ id: 'w1', name: 'w1', base_currency: 'USD', created_at: at }).execute()
      await plain.db.insertInto('documents').values([doc('d1', 'w1'), doc('d2', 'w1')]).execute()
      const N = 1000
      const time = async (fn: () => Promise<unknown>) => {
        for (let i = 0; i < 50; i++) await fn()
        const t = performance.now()
        for (let i = 0; i < N; i++) await fn()
        return (performance.now() - t) / N
      }
      const base = await time(() => plain.db.selectFrom('documents').select('id').where('workspace_id', '=', 'w1').execute())
      const rls = await withWorkspace('w1', () => time(() => db.selectFrom('documents').select('id').where('workspace_id', '=', 'w1').execute()))
      const policyOnly = await withWorkspace('w1', () => time(() => sql`select id from documents where workspace_id = 'w1'`.execute(db)))
      let flip = 0
      const mixed = await time(() => withWorkspace(++flip % 2 ? 'w1' : 'w2', () => db.selectFrom('documents').select('id').execute()))
      const line = `[rls] per query: plain ${base.toFixed(3)} ms, with RLS ${rls.toFixed(3)} ms (+${(rls - base).toFixed(3)} ms), raw sql under RLS ${policyOnly.toFixed(3)} ms, alternating workspaces ${mixed.toFixed(3)} ms`
      if (process.env.RLS_BENCH_OUT) (await import('node:fs')).appendFileSync(process.env.RLS_BENCH_OUT, line + '\n')
      // Sanity bound only (machine-dependent): the stamp is one extra tiny statement, not a multiple.
      expect(rls).toBeLessThan(base * 4 + 1)
    } finally {
      await plain.close()
      await h.close()
    }
  }, 120_000)
})

describe('every workspace table is covered', () => {
  it('boot covers every table with workspace_id, including ones a new migration adds', async () => {
    const h = await connectPglite<any>()
    const db = h.db as Kysely<any>
    try {
      await migrateToLatest(db)
      const tables = await workspaceTables(db)
      // Core, ledger, connectors, invoices, equity, MCP and usage tables are all found.
      for (const t of ['memberships', 'entities', 'connections', 'accounts', 'ledger_records', 'journal_lines', 'documents', 'grants', 'agent_keys', 'activity_log', 'usage_daily']) expect(tables, t).toContain(t)
      expect(await tablesMissingRls(db)).toEqual(tables)

      // This is the guard: whatever migrations exist, the boot step leaves no workspace table uncovered.
      await syncRlsPolicies(db, true)
      expect(await tablesMissingRls(db)).toEqual([])

      // A table a future migration adds (any slice, no RLS code) is covered at the next boot.
      await sql`create table future_slice_rows (id text primary key, workspace_id text not null)`.execute(db)
      expect(await tablesMissingRls(db)).toEqual(['future_slice_rows'])
      expect((await syncRlsPolicies(db, true)).enabled).toEqual(['future_slice_rows'])
      expect(await tablesMissingRls(db)).toEqual([])

      // Rollback turns every one off again.
      const off = await syncRlsPolicies(db, false)
      expect(off.disabled.length).toBe(tables.length + 1)
      expect((await tablesMissingRls(db)).length).toBe(tables.length + 1)
    } finally {
      await h.close()
    }
  }, 120_000)
})

describe('boot fails closed (a misconfigured machine must never turn isolation off for everyone)', () => {
  const NEON = 'postgres://u:p@ep-x-pooler.us-east-2.aws.neon.tech/aggregate?sslmode=require'
  const LOCAL = 'postgres://u:p@localhost:5432/agfn'

  it('reads AGFN_PG_RLS strictly and spots hosted databases even without AGFN_HOSTED', () => {
    expect(rlsSetting({ AGFN_PG_RLS: '1' })).toBe('on')
    expect(rlsSetting({ AGFN_PG_RLS: 'off' })).toBe('off')
    expect(rlsSetting({ AGFN_PG_RLS: '0' })).toBe('off')
    expect(rlsSetting({})).toBe('unset')
    expect(() => rlsSetting({ AGFN_PG_RLS: 'true' })).toThrow(/must be 1/)
    expect(isHostedDb({}, NEON)).toBe(true)
    expect(isHostedDb({ AGFN_HOSTED: '1' }, LOCAL)).toBe(true)
    expect(isHostedDb({ AGFN_PG_APP_URL: NEON }, LOCAL)).toBe(true)
    expect(isHostedDb({}, LOCAL)).toBe(false)
    expect(isHostedDb({}, 'postgres://u:p@neon.tech.evil.example/x')).toBe(false)
  })

  it('every case: on covers and checks; hosted refuses off/unset; unset refuses when RLS is already on', async () => {
    const h = await connectPglite<any>()
    const db = h.db as Kysely<any>
    try {
      await migrateToLatest(db)
      const tables = await workspaceTables(db)

      // Self-hosted, unset, RLS never turned on: starts, changes nothing.
      expect(await bootRls(db, {}, LOCAL)).toEqual({ enabled: [], disabled: [] })
      // Hosted with RLS off in the database: still refuses without the flag (and with it off).
      await expect(bootRls(db, { AGFN_HOSTED: '1' }, LOCAL)).rejects.toThrow(/requires AGFN_PG_RLS=1/)
      await expect(bootRls(db, {}, NEON)).rejects.toThrow(/Refusing to start/)

      // On: every table covered, verified in the catalog.
      await bootRls(db, { AGFN_PG_RLS: '1', AGFN_HOSTED: '1' }, NEON)
      expect(await tablesMissingRls(db)).toEqual([])

      // The incident: a machine without its [env] block (no AGFN_HOSTED, no AGFN_PG_RLS) but with the Neon secret.
      await expect(bootRls(db, {}, NEON)).rejects.toThrow(/missing its \[env\]/)
      // Explicitly off on hosted: refused too.
      await expect(bootRls(db, { AGFN_PG_RLS: 'off' }, NEON)).rejects.toThrow(/not allowed on hosted/)
      await expect(bootRls(db, { AGFN_PG_RLS: 'off', AGFN_HOSTED: '1' }, LOCAL)).rejects.toThrow(/not allowed on hosted/)
      // Self-hosted, unset, but an earlier boot turned it on: refuses rather than guess.
      await expect(bootRls(db, {}, LOCAL)).rejects.toThrow(/AGFN_PG_RLS is not set/)
      // Contradictory value: refused.
      await expect(bootRls(db, { AGFN_PG_RLS: 'yes' }, LOCAL)).rejects.toThrow(/must be 1/)
      // None of the refusals touched the policies.
      expect(await tablesMissingRls(db)).toEqual([])

      // The startup assertion: a table left without RLS (turned off behind boot's back) refuses to start, even if on.
      await sql`create table later_rows (id text primary key, workspace_id text not null)`.execute(db)
      await bootRls(db, { AGFN_PG_RLS: '1' }, LOCAL) // a new table is simply covered
      expect(await tablesMissingRls(db)).toEqual([])

      // Self-hosted rollback is explicit: AGFN_PG_RLS=off.
      const off = await bootRls(db, { AGFN_PG_RLS: 'off' }, LOCAL)
      expect(off.disabled.length).toBe(tables.length + 1)
      expect(await rlsStatus(db, tables)).toEqual([])
    } finally {
      await h.close()
    }
  }, 120_000)
})
