import { describe, expect, it } from 'vitest'
import { connectPglite } from './pglite.ts'
import { sql } from 'kysely'
import { migrateToLatest, newId, nowIso, JobQueue, type CoreTables } from './index.ts'

describe('Postgres compatibility (PGlite)', () => {
  it('runs every migration and core queries on Postgres', async () => {
    const h = await connectPglite<CoreTables>({ empty: true })
    try {
      const res = await migrateToLatest(h.db)
      expect(res.results?.every((r) => r.status === 'Success')).toBe(true)
      // 0512: the big ledger tables re-analyze after ~2% of rows change (autovacuum, never on a request).
      const opts = await sql<{ relname: string; reloptions: string[] | null }>`select relname, reloptions from pg_class where relname in ('journal_lines', 'journal_entries', 'ledger_records')`.execute(h.db)
      expect(opts.rows).toHaveLength(3)
      for (const r of opts.rows) expect(r.reloptions, r.relname).toEqual(expect.arrayContaining(['autovacuum_analyze_scale_factor=0.02', 'autovacuum_analyze_threshold=500']))
      const ws = newId()
      await h.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', created_at: nowIso() }).execute()
      await h.db
        .insertInto('documents')
        .values({ id: newId(), workspace_id: ws, entity_id: null, storage_key: 'k', sha256: 'abc', mime_type: 'application/pdf', size_bytes: 9_000_000_000, original_name: null, arrived_via: 'upload', status: 'unread', extracted_json: null, record_type: null, record_id: null, created_by: null, created_at: nowIso() })
        .execute()
      const doc = await h.db.selectFrom('documents').select('size_bytes').executeTakeFirstOrThrow()
      expect(Number(doc.size_bytes)).toBe(9_000_000_000)
      const q = new JobQueue(h.db)
      await q.enqueue('k', { a: 1 }, { uniqueKey: 'u' })
      expect(await q.enqueue('k', {}, { uniqueKey: 'u' })).toBeNull()
      const job = await q.claim('w', ['k'], 1000)
      expect(job?.payload).toEqual({ a: 1 })
    } finally {
      await h.close()
    }
  }, 30_000)
})
