// Run by backup.test.ts in a child process with a hard heap limit (--max-old-space-size): backs up a PGlite database
// holding more rows than that heap could hold at once. Exits 0 and prints the result when the backup stayed inside it;
// a whole-table dump dies of "heap out of memory" instead. argv: rows, path of the backup module to use.
import { statSync } from 'node:fs'
import { sql } from 'kysely'
import { connectPglite } from '@agfn/db'
import { generateMasterKey, loadKeyRing } from '@agfn/security'

const rows = Number(process.argv[2] ?? 60_000)
const mod = (await import(process.argv[3] ?? './backup.ts')) as typeof import('./backup.ts')
const handle = await connectPglite<Record<string, never>>()
const db = handle.db as any
await sql`create table big_rows (id integer primary key, payload text not null)`.execute(db)
await sql`insert into big_rows select g, repeat(md5(g::text), 40) from generate_series(1, ${rows}) g`.execute(db)
let uploaded = 0
const target = {
  put: async (_k: string, b: Uint8Array) => void (uploaded = b.length),
  putFile: async (_k: string, path: string) => void (uploaded = statSync(path).size),
  get: async () => null,
  delete: async () => {},
  list: async () => [],
}
const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
const r = await mod.createBackup({ db, kind: 'postgres', keys, target })
process.stdout.write(JSON.stringify({ rows: r.rows, bytes: r.bytes, uploaded, heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6) }) + '\n')
await handle.close()
process.exit(0)
