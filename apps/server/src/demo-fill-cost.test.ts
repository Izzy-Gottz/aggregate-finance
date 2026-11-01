// What one demo fill costs the database, and what it leaves behind. Run on demand (it's a measurement, not a check):
//   AGFN_FILL_MEASURE=<out.json> npx vitest run apps/server/src/demo-fill-cost.test.ts
// writes the statement count and CPU of the fill (its perf lines show each sync and the warm), and a digest of the filled workspace's values
// (ledger, books, payroll, holdings, links), ids and times taken out, so two builds can be compared exactly.
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { withBypass, withPerf, type CoreTables } from '@agfn/db'
import { poolStatus } from '@agfn/demo'
import type { Kysely } from 'kysely'
import { boot } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { topUpDemoPool } from './demo-start.ts'
import { deleteIfMemberless } from './orphans.ts'

const out = process.env.AGFN_FILL_MEASURE

const TABLES = ['ledger_records', 'journal_entries', 'journal_lines', 'ledger_accounts', 'ledger_links', 'ledger_overrides', 'books_documents', 'payroll_runs', 'account_holdings', 'account_liabilities', 'accounts', 'entities']
const ID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g
// Raw refs and content hashes are made from ids, so they differ run to run too.
const HASH = /\b(raw_[0-9a-f]{32}|[0-9a-f]{64})\b/g
const TIME = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g

/** Every row of the workspace in these tables, with ids, times and row order taken out. */
async function digest(db: Kysely<CoreTables>, ws: string): Promise<Record<string, string[]>> {
  const res: Record<string, string[]> = {}
  for (const t of TABLES) {
    const rows = (await withBypass('measure', () => (db as any).selectFrom(t).selectAll().where('workspace_id', '=', ws).execute().catch(() => [] as unknown[]))) as Array<Record<string, unknown>>
    res[t] = rows
      .map((r) => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'id' && !k.endsWith('_at') && k !== 'version').map(([k, v]) => [k, typeof v === 'string' ? v.replace(ID, 'ID').replace(HASH, 'H').replace(TIME, 'T') : v]))))
      .sort()
  }
  return res
}

describe.runIf(!!out)('demo fill cost', () => {
  it('measures one pooled demo fill and its warm', async () => {
    process.env.AGFN_PERF_LOG = '1'
    // The fill's own perf lines (each sync, the warm it runs before saying ready), kept for the report.
    const lines: string[] = []
    const info = console.info
    console.info = (...a: unknown[]) => void lines.push(a.map(String).join(' ').replace(ID, 'ID'))
    const env = { AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent', AGFN_DEMO_POOL: '1', AGFN_DEMO_FILL_CONCURRENCY: '1' }
    const b = await boot({ config: { ...loadConfig(env), runWorker: false }, env, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => undefined }, ...(await loadInstalledModules(env)) })
    try {
      const db = b.services.db
      const fill = await withPerf(async () => {
        await topUpDemoPool(b.services, (ids) => deleteIfMemberless({ db, files: b.services.files, sync: b.services.sync }, ids))
        for (let i = 0; i < 40; i++) {
          const job = await withBypass('test', () => db.selectFrom('jobs').select(['id', 'unique_key']).where('kind', '=', 'connection.sync').where('status', '=', 'queued').orderBy('run_at').executeTakeFirst())
          if (!job) break
          await withBypass('test', () => db.deleteFrom('jobs').where('id', '=', job.id).execute())
          await withBypass('test', () => b.services.sync.sync(job.unique_key!))
        }
      })
      const ws = (await withBypass('test', () => poolStatus(db))).ready[0]!.ws
      const values = await digest(db as unknown as Kysely<CoreTables>, ws)
      writeFileSync(out!, JSON.stringify({ fill: { statements: fill.counts.statements, cpuMs: Math.round(fill.cpuMs), ms: Math.round(fill.ms) }, perf: lines, rows: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.length])), values }, null, 1))
    } finally {
      console.info = info
      await b.shutdown()
    }
  }, 600_000)
})
