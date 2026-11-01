// Nightly encrypted backups (security policies: data retention § Backups). Optional: runs when BACKUP_S3_* is set.
//
//   SQLite   → VACUUM INTO a temp file (a consistent copy while the app runs), the file is the payload.
//   Postgres → a logical dump through the app: every table, as JSON rows, plus the applied migration list.
//              No pg_dump binary to keep in step with Neon's server version, no extra machine, and the same restore
//              path is testable on PGlite. Neon's point-in-time restore stays the first line of recovery; this is the
//              independent off-site copy.
// Document files (receipts, statements) ride along from the file store, so one backup restores everything; they're
// small (8 MB max each) and content-addressed, so restoring them is put-if-missing.
// The payload is gzipped and envelope-encrypted with the master key (purpose "backup"), uploaded to R2 (any S3
// API), and backups older than 25 days are deleted. It is written as a stream (format 3): each table is read through a
// cursor in one snapshot, a page at a time, into gzip, sealed in 1 MiB frames, to a temp file that is uploaded in
// parts, so memory stays flat however large the books grow (a whole-table dump ran a 512 MB machine out of memory,
// 2026-10-12). Restoring needs the same master key (or it in
// AGFN_OLD_MASTER_KEYS). docs/self-hosting.md has the restore drill.

import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, gunzipSync } from 'node:zlib'
import { sql, type Kysely } from 'kysely'
import type { DbKind } from '@agfn/db'
import { isStreamSealed, sealStream, unsealBytes, unsealStream, type KeyRing } from '@agfn/security'

export interface BackupTarget {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<Array<{ key: string; lastModified: string }>>
  /** Upload a file without holding it in memory (S3 multipart). Without it the file is read and put whole. */
  putFile?(key: string, path: string): Promise<void>
}

export const BACKUP_PREFIX = 'backups/'
export const BACKUP_KEEP_DAYS = 25
// ledger_derived: results recomputed from the ledger on demand (0109), never a record; restoring one could only be stale.
// rate_limit_counters: per-minute counters that mean nothing an hour later.
const SKIP_TABLES = new Set(['kysely_migration', 'kysely_migration_lock', 'ledger_derived', 'rate_limit_counters'])
/** Rows per cursor page: one page of the widest table (ledger_records, ~3 KB a row) is a few MB. */
const PAGE_ROWS = 500
/** SQLite file bytes per line (base64). */
const SQLITE_CHUNK = 1 << 20

interface Header {
  format: 'agfn-backup'
  /**
   * 1: the body is the database payload. 2: the database payload (dbBytes) followed by the files, in order.
   * 3 (streamed): JSON lines — this header, then {t, rows} pages (Postgres) or {s: base64} chunks (SQLite), then
   * {f: key, b64} files, then {end: true, tables} — gzipped and sealed in frames (sealStream).
   */
  version: 1 | 2 | 3
  kind: DbKind
  createdAt: string
  migrations: string[]
  tables?: Record<string, number>
  dbBytes?: number
  files?: Array<{ key: string; size: number }>
}

export interface BackupFile {
  key: string
  bytes: Buffer
}
export interface Backup {
  header: Header
  body: Buffer
  files: BackupFile[]
}

/** Where documents' bytes live (the server's FileStore). */
export interface BackupFileSource {
  get(key: string): Promise<Uint8Array | null>
}

const ctxFor = (name: string) => ({ workspaceId: '_backup', recordId: name.slice(name.lastIndexOf('/') + 1), purpose: 'backup' })
const stamp = (d: Date) => d.toISOString().replace(/[:]/g, '').replace(/\.\d{3}Z$/, 'Z')
/** backups/agfn-<kind>-2026-10-10T030000Z.agfnbak → its time, or null. */
export function backupTime(key: string): Date | null {
  const m = /agfn-(?:sqlite|postgres)-(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z\.agfnbak$/.exec(key)
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : null
}

async function appliedMigrations(db: Kysely<any>): Promise<string[]> {
  const r = await db.selectFrom('kysely_migration').select('name').orderBy('name').execute().catch(() => [])
  return (r as Array<{ name: string }>).map((x) => x.name)
}

async function postgresTables(db: Kysely<any>): Promise<string[]> {
  const r = await sql<{ table_name: string }>`select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' order by table_name`.execute(db)
  return r.rows.map((x) => x.table_name).filter((t) => !SKIP_TABLES.has(t))
}

function unpack(gz: Buffer): Backup {
  const raw = gunzipSync(gz)
  const nl = raw.indexOf(0x0a)
  const header = JSON.parse(raw.subarray(0, nl).toString('utf8')) as Header
  if (header.format !== 'agfn-backup' || (header.version !== 1 && header.version !== 2)) throw new Error('not an Aggregate backup')
  const rest = raw.subarray(nl + 1)
  if (header.version === 1) return { header, body: rest, files: [] }
  let at = header.dbBytes ?? 0
  const files = (header.files ?? []).map((f) => {
    const bytes = rest.subarray(at, at + f.size)
    at += f.size
    return { key: f.key, bytes }
  })
  if (at !== rest.length) throw new Error('backup is truncated or damaged')
  return { header, body: rest.subarray(0, header.dbBytes ?? 0), files }
}

export async function createBackup(deps: { db: Kysely<any>; kind: DbKind; keys: KeyRing; target: BackupTarget; files?: BackupFileSource; now?: Date }): Promise<{ key: string; bytes: number; tables: number; rows: number; files: number; pruned: number }> {
  const now = deps.now ?? new Date()
  const key = `${BACKUP_PREFIX}agfn-${deps.kind}-${stamp(now)}.agfnbak`
  const migrations = await appliedMigrations(deps.db)
  const dir = mkdtempSync(join(tmpdir(), 'agfn-backup-'))
  const out = join(dir, 'backup.agfnbak')
  const counts: Record<string, number> = {}
  let tables = 0
  let rows = 0
  let fileCount = 0
  let bytes = 0
  const line = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n', 'utf8')
  const files = async function* (): AsyncGenerator<Buffer> {
    if (!deps.files) return
    const keys = (await deps.db.selectFrom('documents').select('storage_key').distinct().orderBy('storage_key').execute().catch(() => [])) as Array<{ storage_key: string }>
    for (const r of keys) {
      const bytes = await deps.files!.get(r.storage_key).catch(() => null)
      if (!bytes) continue
      fileCount++
      yield line({ f: r.storage_key, b64: Buffer.from(bytes).toString('base64') })
    }
  }
  const write = (body: AsyncGenerator<Buffer>) => pipeline(Readable.from(body), createGzip(), sealStream(deps.keys, ctxFor(key)), createWriteStream(out, { mode: 0o600 }))
  try {
    if (deps.kind === 'sqlite') {
      const file = join(dir, 'db.sqlite')
      await sql`vacuum into ${sql.lit(file)}`.execute(deps.db)
      await write(
        (async function* () {
          yield line({ format: 'agfn-backup', version: 3, kind: 'sqlite', createdAt: now.toISOString(), migrations })
          for await (const chunk of createReadStream(file, { highWaterMark: SQLITE_CHUNK })) yield line({ s: (chunk as Buffer).toString('base64') })
          yield* files()
          yield line({ end: true, files: fileCount })
        })(),
      )
    } else {
      // One snapshot for every table, read through a cursor a page at a time: never a whole table in memory.
      const names = await postgresTables(deps.db)
      await deps.db
        .transaction()
        .setIsolationLevel('repeatable read')
        .execute(async (tx) =>
          write(
            (async function* () {
              yield line({ format: 'agfn-backup', version: 3, kind: 'postgres', createdAt: now.toISOString(), migrations })
              for (const t of names) {
                await sql`declare agfn_backup no scroll cursor for select * from ${sql.id(t)}`.execute(tx)
                let n = 0
                for (;;) {
                  const page = (await sql<Record<string, unknown>>`fetch ${sql.lit(PAGE_ROWS)} from agfn_backup`.execute(tx)).rows
                  // Every table gets a line, even empty: restore clears the tables the backup names.
                  if (page.length || n === 0) yield line({ t, rows: page })
                  n += page.length
                  if (page.length < PAGE_ROWS) break
                }
                await sql`close agfn_backup`.execute(tx)
                counts[t] = n
                rows += n
                tables++
              }
              yield* files()
              yield line({ end: true, tables: counts, files: fileCount })
            })(),
          ),
        )
    }
    if (deps.target.putFile) await deps.target.putFile(key, out)
    else await deps.target.put(key, readFileSync(out))
  } finally {
    if (existsSync(out)) bytes = statSync(out).size
    rmSync(dir, { recursive: true, force: true })
  }

  // Keep 25 days (Intuit terms 8.2(f): erased data gone from backups within 30 days). Times come from the names this code writes, so other files in the bucket are never touched.
  const cutoff = now.getTime() - BACKUP_KEEP_DAYS * 86_400_000
  let pruned = 0
  for (const o of await deps.target.list(BACKUP_PREFIX)) {
    const t = backupTime(o.key)
    if (t && t.getTime() < cutoff) {
      await deps.target.delete(o.key)
      pruned++
    }
  }
  return { key, bytes, tables, rows, files: fileCount, pruned }
}

/** A streamed (format 3) payload, read back into the same shape as the older formats (restore holds it whole). */
function unpackStreamed(raw: Buffer): Backup {
  const text = raw.toString('utf8')
  let header: Header | null = null
  let end: { tables?: Record<string, number> } | null = null
  const byTable = new Map<string, Array<Record<string, unknown>>>()
  const sqlite: Buffer[] = []
  const files: BackupFile[] = []
  let at = 0
  while (at < text.length) {
    const nl = text.indexOf('\n', at)
    const l = text.slice(at, nl < 0 ? text.length : nl)
    at = nl < 0 ? text.length : nl + 1
    if (!l) continue
    const v = JSON.parse(l) as Record<string, unknown>
    if (!header) {
      header = v as unknown as Header
      continue
    }
    if (typeof v['t'] === 'string') {
      const list = byTable.get(v['t']) ?? []
      for (const r of v['rows'] as Array<Record<string, unknown>>) list.push(r)
      byTable.set(v['t'], list)
    } else if (typeof v['s'] === 'string') sqlite.push(Buffer.from(v['s'], 'base64'))
    else if (typeof v['f'] === 'string') files.push({ key: v['f'], bytes: Buffer.from(v['b64'] as string, 'base64') })
    else if (v['end'] === true) end = v as { tables?: Record<string, number> }
  }
  if (!header || header.format !== 'agfn-backup') throw new Error('not an Aggregate backup')
  if (!end) throw new Error('backup is truncated or damaged (no end marker)')
  const body = header.kind === 'sqlite' ? Buffer.concat(sqlite) : Buffer.from([...byTable].map(([t, r]) => JSON.stringify({ t, rows: r })).join('\n'), 'utf8')
  return { header: { ...header, ...(end.tables ? { tables: end.tables } : {}) }, body, files }
}

export async function readBackup(keys: KeyRing, target: BackupTarget, key: string): Promise<Backup> {
  const blob = await target.get(key)
  if (!blob) throw new Error(`no backup ${key}`)
  if (isStreamSealed(blob)) {
    const parts: Buffer[] = []
    unsealStream(keys, blob, ctxFor(key), (c) => parts.push(c))
    return unpackStreamed(gunzipSync(Buffer.concat(parts)))
  }
  return unpack(unsealBytes(keys, blob, ctxFor(key)))
}

/** SQLite: write the backed-up database to a new file (refuses to overwrite). */
export function restoreSqliteFile(backup: Pick<Backup, 'header' | 'body'>, path: string): void {
  if (backup.header.kind !== 'sqlite') throw new Error('this is a Postgres backup; restore it into Postgres')
  if (existsSync(path)) throw new Error(`${path} already exists; restore into a new file`)
  writeFileSync(path, backup.body, { mode: 0o600 })
}

/**
 * Postgres: load a logical dump into a database whose schema is already at the same migrations (boot it first) and
 * that holds no workspace yet. Rows are inserted in rounds so foreign keys resolve in any table order.
 */
export async function restorePostgres(db: Kysely<any>, backup: Pick<Backup, 'header' | 'body'>): Promise<{ tables: number; rows: number }> {
  if (backup.header.kind !== 'postgres') throw new Error('this is a SQLite backup; restore it as a file')
  const have = await appliedMigrations(db)
  const want = backup.header.migrations
  if (have.join(',') !== want.join(',')) {
    // Name the difference: migrations are applied by name, so a newer one can sort before the backup's last one.
    const missing = want.filter((m) => !have.includes(m))
    const extra = have.filter((m) => !want.includes(m))
    throw new Error(`schema mismatch: ${extra.length ? `this database has migrations the backup doesn't (${extra.join(', ')})` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `the backup has migrations this database doesn't (${missing.join(', ')})` : ''}. Restore with the Aggregate version that made the backup, then run agfn migrate with the current one (docs/security/backup-restore.md).`)
  }
  const ws = (await db.selectFrom('workspaces').select(db.fn.countAll().as('n')).executeTakeFirst()) as { n: number | string } | undefined
  if (Number(ws?.n ?? 0) > 0) throw new Error('this database already has workspaces; restore into an empty one')
  const dump = backup.body.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { t: string; rows: Array<Record<string, unknown>> })
  const present = new Set(await postgresTables(db))
  // Clear what boot seeded (auth keys and the like) so the backup's rows win.
  for (const { t } of dump) if (present.has(t)) await sql`delete from ${sql.id(t)}`.execute(db).catch(() => undefined)
  // A table that points at itself (journal_entries.reverses_id → journal_entries.id) must insert the referenced row
  // first; the rounds below only order whole tables.
  const selfRefs = await selfReferences(db)
  for (const d of dump) for (const ref of selfRefs.get(d.t) ?? []) d.rows = parentsFirst(d.rows, ref.column, ref.target)
  // json/jsonb columns go in as JSON text: the driver would send a JavaScript array as a Postgres array literal
  // ("{a,b}"), which a json column refuses (OAuth clients' redirect URIs, for one).
  const jsonCols = await jsonColumns(db)
  for (const d of dump) {
    const cols = jsonCols.get(d.t)
    if (cols) for (const r of d.rows) for (const c of cols) if (r[c] !== null && r[c] !== undefined) r[c] = JSON.stringify(r[c])
  }
  let pending = dump.filter((d) => present.has(d.t) && d.rows.length)
  let rows = 0
  for (let round = 0; round < 12 && pending.length; round++) {
    const failed: typeof pending = []
    const why = new Map<string, string>()
    for (const d of pending) {
      try {
        await db.transaction().execute(async (tx) => {
          for (let i = 0; i < d.rows.length; i += 200) await tx.insertInto(d.t).values(d.rows.slice(i, i + 200)).execute()
        })
        rows += d.rows.length
      } catch (err) {
        failed.push(d)
        why.set(d.t, err instanceof Error ? err.message.slice(0, 200) : String(err))
      }
    }
    if (failed.length === pending.length) throw new Error(`could not restore: ${failed.map((f) => `${f.t} (${why.get(f.t)})`).join('; ')}`)
    pending = failed
  }
  return { tables: dump.length, rows }
}

/** Put the backup's document files back into a file store; ones already there (same content address) are left alone. */
export async function restoreFiles(store: BackupFileSource & { put(key: string, bytes: Uint8Array): Promise<void> }, files: BackupFile[]): Promise<{ written: number; present: number }> {
  let written = 0
  let present = 0
  for (const f of files) {
    if (await store.get(f.key).catch(() => null)) present++
    else {
      await store.put(f.key, f.bytes)
      written++
    }
  }
  return { written, present }
}

/** Foreign keys from a table to itself: table → [{ column, target }]. */
async function jsonColumns(db: Kysely<any>): Promise<Map<string, string[]>> {
  const r = await sql<{ table_name: string; column_name: string }>`
    select table_name, column_name from information_schema.columns
    where table_schema = current_schema() and data_type in ('json', 'jsonb')`.execute(db)
  const out = new Map<string, string[]>()
  for (const x of r.rows) out.set(x.table_name, [...(out.get(x.table_name) ?? []), x.column_name])
  return out
}

async function selfReferences(db: Kysely<any>): Promise<Map<string, Array<{ column: string; target: string }>>> {
  const r = await sql<{ table_name: string; column_name: string; target: string }>`
    select kcu.table_name, kcu.column_name, ccu.column_name as target
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = current_schema() and ccu.table_name = kcu.table_name`.execute(db)
  const out = new Map<string, Array<{ column: string; target: string }>>()
  for (const x of r.rows) out.set(x.table_name, [...(out.get(x.table_name) ?? []), { column: x.column_name, target: x.target }])
  return out
}

/** Rows ordered so each row comes after the row its `column` points at (by `target`). Cycles keep their order. */
export function parentsFirst<R extends Record<string, unknown>>(rows: R[], column: string, target: string): R[] {
  const byKey = new Map(rows.map((r) => [r[target], r]))
  const placed = new Set<R>()
  const out: R[] = []
  const place = (r: R, depth: number) => {
    if (placed.has(r)) return
    const parent = r[column] == null ? undefined : byKey.get(r[column])
    if (parent && parent !== r && depth < rows.length) place(parent, depth + 1)
    if (!placed.has(r)) {
      placed.add(r)
      out.push(r)
    }
  }
  for (const r of rows) place(r, 0)
  return out
}
