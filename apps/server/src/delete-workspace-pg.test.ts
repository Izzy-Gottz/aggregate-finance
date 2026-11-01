// A full demo workspace deletes cleanly on Postgres (DELETE /api/workspace, account deletion, the orphan pass).
import { afterEach, describe, expect, it } from 'vitest'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import { sql, type Kysely, type KyselyPlugin } from 'kysely'
import { deleteMemberlessWorkspaces } from './orphans.ts'
import { MemoryFileStore } from '@agfn/files'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { deleteWorkspace } from './delete-workspace.ts'
import { serverDemoBuilder } from './reviewer.ts'

let booted: Booted | undefined
afterEach(async () => {
  await booted?.shutdown()
  booted = undefined
  delete process.env.AGFN_PG_RLS
})

async function rowsLeft(db: Kysely<CoreTables>, ws: string): Promise<Record<string, number>> {
  const left: Record<string, number> = {}
  for (const t of (await db.introspection.getTables()).filter((t) => t.columns.some((c) => c.name === 'workspace_id'))) {
    const n = (await withBypass('test', () => (db as any).selectFrom(t.name).select((eb: any) => eb.fn.countAll().as('n')).where('workspace_id', '=', ws).executeTakeFirst())) as { n: number | string }
    if (Number(n.n)) left[t.name] = Number(n.n)
  }
  return left
}

describe('deleting a workspace on Postgres', () => {
  it('a filled demo workspace (with an undone entry) leaves no rows behind', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), db: await connectPglite<CoreTables>(), fileStore: new MemoryFileStore(), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const db = booted.handle.db
    const personId = newId()
    await db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'D', email: 'd@example.com', created_at: nowIso() }).execute()
    const ws = await serverDemoBuilder(booted.services)(personId)
    const r = await withWorkspace(ws, () => deleteWorkspace({ db, files: booted!.services.files, sync: booted!.services.sync }, ws))
    expect(r.rows).toBeGreaterThan(100)
    const left: Record<string, number> = {}
    for (const t of (await db.introspection.getTables()).filter((t) => t.columns.some((c) => c.name === 'workspace_id'))) {
      const n = (await withBypass('test', () => (db as any).selectFrom(t.name).select((eb: any) => eb.fn.countAll().as('n')).where('workspace_id', '=', ws).executeTakeFirst())) as { n: number | string }
      if (Number(n.n)) left[t.name] = Number(n.n)
    }
    expect(left).toEqual({})
  }, 180_000)

  it('as the non-bypass app role with row-level security on (hosted), through the orphan pass', async () => {
    process.env.AGFN_PG_RLS = '1'
    const handle = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
    await withBypass('test', async () => {
      await migrateToLatest(handle.db)
      await ensureAppRole(handle.db as Kysely<any>)
    })
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), db: handle, fileStore: new MemoryFileStore(), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const db = booted.handle.db
    const personId = newId()
    await withBypass('test', () => db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'D', email: 'd@example.com', created_at: nowIso() }).execute())
    const ws = await withBypass('test', () => serverDemoBuilder(booted!.services)(personId))
    await withBypass('test', () => db.updateTable('memberships').set({ revoked_at: nowIso() }).where('workspace_id', '=', ws).execute())
    expect(await withBypass('orphans:boot', () => deleteMemberlessWorkspaces({ db, files: booted!.services.files, sync: booted!.services.sync }))).toBe(1)
    expect(await rowsLeft(db, ws)).toEqual({})
  }, 180_000)

  it('finishes even when a sync elsewhere adds journal lines after that table was cleared', async () => {
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
    booted = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), db: await connectPglite<CoreTables>(), fileStore: new MemoryFileStore(), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
    const db = booted.handle.db
    const personId = newId()
    await db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'D', email: 'd@example.com', created_at: nowIso() }).execute()
    const ws = await serverDemoBuilder(booted.services)(personId)
    const anyDb = db as unknown as Kysely<Record<string, Record<string, unknown>>>
    const sample = (await anyDb.selectFrom('journal_lines').selectAll().where('workspace_id', '=', ws).executeTakeFirstOrThrow()) as Record<string, unknown>
    // The "other server": right after the first delete from journal_lines, it writes one more line.
    let writes = 0
    const deletes = new Map<unknown, string>()
    const late: KyselyPlugin = {
      transformQuery: (a) => {
        const node = a.node as { kind: string; from?: { froms: Array<{ table?: { identifier?: { name: string } } }> } }
        if (node.kind === 'DeleteQueryNode') deletes.set(a.queryId, node.from?.froms[0]?.table?.identifier?.name ?? '')
        return a.node
      },
      transformResult: async (a) => {
        if (deletes.get(a.queryId) === 'journal_lines' && writes++ === 0) await anyDb.insertInto('journal_lines').values({ ...sample, id: newId() }).execute()
        return a.result
      },
    }
    const r = await deleteWorkspace({ db: db.withPlugin(late), files: booted.services.files, sync: booted.services.sync }, ws)
    expect(writes).toBeGreaterThan(1) // it did write in the middle
    expect(r.rows).toBeGreaterThan(100)
    expect(await rowsLeft(db, ws)).toEqual({})
  }, 180_000)

  it('every foreign key into a ledger table has an index, so deletes don’t scan every workspace per row', async () => {
    const h = await connectPglite<CoreTables>()
    try {
      await withBypass('test', () => migrateToLatest(h.db))
      const r = await sql<{ tbl: string; col: string; target: string }>`
        select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as target
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and array_length(c.conkey, 1) = 1
          and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`.execute(h.db)
      // Big tables (a year of history is thousands of rows per workspace): referencing them unindexed times out.
      const big = /^(journal_entries|journal_lines|ledger_|accounts$|entities$)/
      expect(r.rows.filter((x) => big.test(x.target) && big.test(x.tbl)).map((x) => `${x.tbl}.${x.col} → ${x.target}`)).toEqual([])
    } finally {
      await h.close()
    }
  })
})
