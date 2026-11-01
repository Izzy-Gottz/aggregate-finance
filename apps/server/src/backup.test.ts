import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connect, connectPglite, withBypass, type CoreTables } from '@agfn/db'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from './boot.ts'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { backupTime, createBackup, parentsFirst, readBackup, restorePostgres, restoreSqliteFile, type BackupTarget } from './backup.ts'

const BASE = 'http://localhost:8787'

function memoryTarget(): BackupTarget & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>()
  return {
    objects,
    put: async (k, b) => void objects.set(k, new Uint8Array(b)),
    get: async (k) => objects.get(k) ?? null,
    delete: async (k) => void objects.delete(k),
    list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).map((key) => ({ key, lastModified: '' })),
  }
}

async function seeded(dbUrl: string, keys: ReturnType<typeof loadKeyRing>, db?: Awaited<ReturnType<typeof connectPglite<CoreTables>>>) {
  const outbox: Array<{ to: string; text: string }> = []
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: dbUrl, BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  const booted = await boot({ config, keys, ...(db ? { db } : {}), mailer: { send: async (m) => void outbox.push({ to: m.to, text: m.text }) } })
  const app = createApp(booted.services)
  return { booted, app, outbox }
}

async function makeWorkspace(app: ReturnType<typeof createApp>, outbox: Array<{ to: string; text: string }>) {
  await app.request('/api/auth/sign-in/magic-link', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ email: 'f@example.com', callbackURL: '/' }) })
  const link = outbox.at(-1)!.text.match(/https?:\/\/\S+/)![0]
  const res = await app.request(link.replace(BASE, ''), { headers: { origin: BASE } })
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  const r = await app.request('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, cookie }, body: JSON.stringify({ companyName: 'Acme' }) })
  expect(r.status).toBe(201)
}

describe('encrypted backups', () => {
  it('SQLite: VACUUM INTO, encrypted, restores to a working database file; prunes past 25 days', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-bk-'))
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const { booted, app, outbox } = await seeded(`sqlite:${join(dir, 'live.db')}`, keys)
    try {
      await makeWorkspace(app, outbox)
      const target = memoryTarget()
      target.objects.set('backups/agfn-sqlite-2026-08-01T030000Z.agfnbak', new Uint8Array([1])) // 70 days old
      target.objects.set('backups/agfn-sqlite-2026-10-01T030000Z.agfnbak', new Uint8Array([1])) // 9 days old
      target.objects.set('backups/notes.txt', new Uint8Array([1])) // not ours: never touched
      const r = await createBackup({ db: booted.handle.db, kind: 'sqlite', keys, target, now: new Date('2026-10-10T03:00:00Z') })
      expect(r.key).toBe('backups/agfn-sqlite-2026-10-10T030000Z.agfnbak')
      expect(r.pruned).toBe(1)
      expect([...target.objects.keys()].sort()).toEqual(['backups/agfn-sqlite-2026-10-01T030000Z.agfnbak', 'backups/agfn-sqlite-2026-10-10T030000Z.agfnbak', 'backups/notes.txt'])
      // Encrypted: the SQLite header and the company name are not visible.
      const blob = Buffer.from(target.objects.get(r.key)!)
      expect(blob.includes(Buffer.from('SQLite format'))).toBe(false)
      expect(blob.includes(Buffer.from('Acme'))).toBe(false)

      const restored = join(dir, 'restored.db')
      restoreSqliteFile(await readBackup(keys, target, r.key), restored)
      const h = connect<CoreTables>(`sqlite:${restored}`)
      expect((await h.db.selectFrom('entities').select('name').where('kind', '=', 'company').execute()).map((e) => e.name)).toEqual(['Acme'])
      await h.close()
      expect(() => restoreSqliteFile({ header: { format: 'agfn-backup', version: 1, kind: 'sqlite', createdAt: '', migrations: [] }, body: Buffer.alloc(0) }, restored)).toThrow(/already exists/)
      // Without the master key it is useless.
      await expect(readBackup(loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), target, r.key)).rejects.toThrow(/not loaded/)
    } finally {
      await booted.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('Postgres: logical dump restores into a freshly booted empty database, row for row', async () => {
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const src = await seeded('postgres://unused', keys, await connectPglite<CoreTables>())
    const dst = await seeded('postgres://unused', keys, await connectPglite<CoreTables>())
    try {
      await makeWorkspace(src.app, src.outbox)
      const target = memoryTarget()
      const r = await withBypass('test', () => createBackup({ db: src.booted.handle.db, kind: 'postgres', keys, target }))
      expect(r.rows).toBeGreaterThan(5)
      const backup = await readBackup(keys, target, r.key)
      const out = await withBypass('test', () => restorePostgres(dst.booted.handle.db, backup))
      expect(out.rows).toBe(r.rows)
      for (const t of ['workspaces', 'memberships', 'entities', 'people', 'auth_user']) {
        const a = await (src.booted.handle.db as any).selectFrom(t).selectAll().execute()
        const b = await (dst.booted.handle.db as any).selectFrom(t).selectAll().execute()
        expect(b, t).toEqual(a)
      }
      // A second restore is refused: the database is no longer empty.
      await expect(restorePostgres(dst.booted.handle.db, backup)).rejects.toThrow(/already has workspaces/)
      expect(backupTime(r.key)).toBeInstanceOf(Date)
    } finally {
      await src.booted.shutdown()
      await dst.booted.shutdown()
    }
  }, 120_000)

  it('orders rows that point at their own table (a reversal after the entry it reverses), even in chains', () => {
    const rows = [
      { id: 'c', reverses_id: 'b' },
      { id: 'b', reverses_id: 'a' },
      { id: 'x', reverses_id: null },
      { id: 'a', reverses_id: null },
      { id: 'o', reverses_id: 'gone' }, // points outside the dump: kept
      { id: 'p', reverses_id: 'q' }, // a cycle keeps its rows rather than looping
      { id: 'q', reverses_id: 'p' },
    ]
    const out = parentsFirst(rows, 'reverses_id', 'id').map((r) => r.id)
    expect(out).toHaveLength(rows.length)
    expect(out.indexOf('a')).toBeLessThan(out.indexOf('b'))
    expect(out.indexOf('b')).toBeLessThan(out.indexOf('c'))
  })

  it('Postgres: backs up more rows than its heap could hold (streamed: never a whole table, never the whole dump)', () => {
    // 2026-10-12: a whole-table dump of ~220 MB of ledger ran live's 512 MB machine out of memory. Here 60,000 rows of
    // ~1.3 KB back up in a child process capped at a 96 MB heap; the whole-table dump dies of "heap out of memory"
    // under the same cap (checked when this was written).
    const out = execFileSync(process.execPath, ['--max-old-space-size=96', join(import.meta.dirname, 'backup-memory.child.ts'), '60000'], { encoding: 'utf8', timeout: 240_000 })
    const r = JSON.parse(out.trim().split('\n').at(-1)!) as { rows: number; bytes: number; uploaded: number; heapUsedMb: number }
    expect(r.rows).toBe(60_000)
    expect(r.uploaded).toBe(r.bytes)
    expect(r.heapUsedMb).toBeLessThan(96)
  }, 300_000)
})

