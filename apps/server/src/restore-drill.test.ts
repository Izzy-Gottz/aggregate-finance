// Restore drill (docs/security/backup-restore.md): a filled workspace is backed up, restored into a fresh database
// and an empty file store, and comes back identical: cash, profit and loss, connections (their bank secrets still
// open with the same master key and with no other), and documents byte for byte. Postgres (hosted) and SQLite.
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { connectPglite, newId, nowIso, withBypass, type CoreTables } from '@agfn/db'
import { MemoryFileStore } from '@agfn/files'
import { generateMasterKey, loadKeyRing, unseal, type KeyRing } from '@agfn/security'
import { SECRET_PURPOSE } from '@agfn/sync'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { createBackup, readBackup, restoreFiles, restorePostgres, restoreSqliteFile, type BackupTarget } from './backup.ts'
import { serverDemoBuilder } from './reviewer.ts'
import { createApp } from './app.ts'

const BASE = 'http://localhost:8787'
const open: Booted[] = []
afterEach(async () => {
  for (const b of open.splice(0)) await b.shutdown()
})

function memoryTarget(): BackupTarget {
  const objects = new Map<string, Uint8Array>()
  return {
    put: async (k, b) => void objects.set(k, new Uint8Array(b)),
    get: async (k) => objects.get(k) ?? null,
    delete: async (k) => void objects.delete(k),
    list: async (p) => [...objects.keys()].filter((k) => k.startsWith(p)).map((key) => ({ key, lastModified: '' })),
  }
}

async function start(dbUrl: string, keys: KeyRing, files: MemoryFileStore, db?: Awaited<ReturnType<typeof connectPglite<CoreTables>>>) {
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: dbUrl, BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  const b = await boot({ config, keys, fileStore: files, ...(db ? { db } : {}), mailer: { send: async () => undefined }, ...(await loadInstalledModules({})) })
  open.push(b)
  return b
}

/** A demo workspace (three companies, a year of bank history, invoices, payroll, cap table, a receipt). */
async function filled(b: Booted): Promise<string> {
  const personId = newId()
  await b.handle.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Drill', email: 'drill@example.com', created_at: nowIso() }).execute()
  return serverDemoBuilder(b.services)(personId)
}

/** Everything the drill compares, computed from the books (not copied rows). */
async function snapshot(b: Booted, ws: string, keys: KeyRing) {
  return withBypass('test', async () => {
    const db = b.handle.db
    const ledger = b.services.ledger as unknown as {
      metric(n: string, s: { workspaceId: string; entityIds: string[] }): Promise<{ value: unknown }>
      profitAndLoss(ws: string, o: { entityIds: string[]; from: string; to: string; basis: 'cash' | 'accrual' }): Promise<unknown>
    }
    const today = new Date().toISOString().slice(0, 10)
    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
    const companies = await db.selectFrom('entities').select(['id', 'name']).where('workspace_id', '=', ws).orderBy('name').execute()
    const books: Record<string, unknown> = {}
    for (const e of companies) {
      books[e.name] = {
        cash: (await ledger.metric('cash', { workspaceId: ws, entityIds: [e.id] })).value,
        net_cash: (await ledger.metric('net_cash', { workspaceId: ws, entityIds: [e.id] })).value,
        pnl: await ledger.profitAndLoss(ws, { entityIds: [e.id], from: yearAgo, to: today, basis: 'cash' }),
      }
    }
    const conns = await db.selectFrom('connections').select(['id', 'workspace_id', 'connector_key', 'status', 'secret_enc']).where('workspace_id', '=', ws).orderBy('id').execute()
    const connections = conns.map((c) => ({
      id: c.id,
      key: c.connector_key,
      status: c.status,
      secret: c.secret_enc ? unseal(keys, c.secret_enc, { workspaceId: c.workspace_id, recordId: c.id, purpose: SECRET_PURPOSE }) : null,
    }))
    const docs = await db.selectFrom('documents').select(['id', 'storage_key', 'sha256', 'status', 'original_name']).where('workspace_id', '=', ws).orderBy('id').execute()
    const documents = []
    for (const d of docs) {
      const bytes = await b.services.files.get(d.storage_key)
      documents.push({ ...d, fileSha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null })
    }
    return { books, connections, documents, sealed: conns.find((c) => c.secret_enc) }
  })
}

function expectFilled(s: Awaited<ReturnType<typeof snapshot>>) {
  expect(Object.keys(s.books)).toEqual(expect.arrayContaining(['Bluebird Studio', 'Harbor Coffee', 'Northwind Labs']))
  expect(s.connections.length).toBeGreaterThanOrEqual(4)
  expect(s.connections.filter((c) => c.secret !== null).length).toBeGreaterThanOrEqual(4) // the demo bank feeds carry sealed secrets
  // Real numbers, so "identical" means something: every demo company has cash and a year of income.
  for (const [name, b] of Object.entries(s.books).filter(([n]) => n !== 'Personal')) {
    expect((b as { cash: { minor: number } | null }).cash?.minor, name).toBeGreaterThan(0)
    expect(JSON.stringify((b as { pnl: unknown }).pnl), name).toMatch(/"minor":[1-9]/)
  }
  expect(s.documents).toHaveLength(1)
  expect(s.documents[0]!.fileSha256).toBe(s.documents[0]!.sha256)
}

describe('restore drill', () => {
  it('Postgres: a filled workspace comes back identical in a fresh database and an empty file store', async () => {
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const src = await start('postgres://unused', keys, new MemoryFileStore(), await connectPglite<CoreTables>())
    const ws = await filled(src)
    const before = await snapshot(src, ws, keys)
    expectFilled(before)
    // An AI app registered over OAuth (its JSON columns hold arrays, which once failed to restore).
    const reg = await createApp(src.services).request('/api/auth/oauth2/register', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'openid offline_access finance:read' }) })
    expect(reg.status).toBeLessThan(300)
    const clients = (b: Booted) => withBypass('test', () => (b.handle.db as any).selectFrom('oauthClient').selectAll().orderBy('id').execute())
    const clientsBefore = await clients(src)
    expect(clientsBefore.length).toBeGreaterThan(0)

    const target = memoryTarget()
    const made = await withBypass('test', () => createBackup({ db: src.handle.db, kind: 'postgres', keys, target, files: src.services.files }))
    expect(made.files).toBe(1)

    const freshFiles = new MemoryFileStore()
    const dst = await start('postgres://unused', keys, freshFiles, await connectPglite<CoreTables>())
    const backup = await readBackup(keys, target, made.key)
    await withBypass('test', () => restorePostgres(dst.handle.db, backup))
    expect(await restoreFiles(freshFiles, backup.files)).toEqual({ written: 1, present: 0 })
    const after = await snapshot(dst, ws, keys)
    expect({ ...after, sealed: undefined }).toEqual({ ...before, sealed: undefined })
    expect(await clients(dst)).toEqual(clientsBefore)

    // The master key is the whole story: another key opens neither the backup nor a restored bank secret.
    const other = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    await expect(readBackup(other, target, made.key)).rejects.toThrow()
    const s = after.sealed!
    expect(() => unseal(other, s.secret_enc!, { workspaceId: s.workspace_id, recordId: s.id, purpose: SECRET_PURPOSE })).toThrow()
    // And never over live data.
    await expect(withBypass('test', () => restorePostgres(dst.handle.db, backup))).rejects.toThrow(/already has workspaces/)
  }, 180_000)

  it('SQLite: the restored file boots and shows the same books, connections and documents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-drill-'))
    try {
      const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
      const src = await start(`sqlite:${join(dir, 'live.db')}`, keys, new MemoryFileStore())
      const ws = await filled(src)
      const before = await snapshot(src, ws, keys)
      expectFilled(before)
      const target = memoryTarget()
      const made = await createBackup({ db: src.handle.db, kind: 'sqlite', keys, target, files: src.services.files })

      const backup = await readBackup(keys, target, made.key)
      const restored = join(dir, 'restored.db')
      restoreSqliteFile(backup, restored)
      const freshFiles = new MemoryFileStore()
      await restoreFiles(freshFiles, backup.files)
      const dst = await start(`sqlite:${restored}`, keys, freshFiles)
      const after = await snapshot(dst, ws, keys)
      expect({ ...after, sealed: undefined }).toEqual({ ...before, sealed: undefined })
    } finally {
      for (const b of open.splice(0)) await b.shutdown()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
