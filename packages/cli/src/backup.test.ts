import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Io } from './io.ts'
import { backupCommand } from './backup.ts'

const dir = mkdtempSync(join(tmpdir(), 'agfn-cli-bk-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const objects = new Map<string, Uint8Array>()
const target = {
  put: async (k: string, b: Uint8Array) => void objects.set(k, new Uint8Array(b)),
  get: async (k: string) => objects.get(k) ?? null,
  delete: async (k: string) => void objects.delete(k),
  list: async (p: string) => [...objects.keys()].filter((k) => k.startsWith(p)).map((key) => ({ key, lastModified: '' })),
}
const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
const bootFn = (withTarget = true) => async () =>
  boot({ config: { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: `sqlite:${join(dir, 'live.db')}`, BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }, keys, mailer: { send: async () => {} }, ...(withTarget ? { backupTarget: target } : {}) })

function io(): Io & { lines: string[] } {
  const lines: string[] = []
  return { cwd: dir, env: {}, out: (s: string) => void lines.push(s), err: (s: string) => void lines.push(s), lines } as unknown as Io & { lines: string[] }
}

describe('agfn backup', () => {
  it('now, list, restore --to', async () => {
    const seed = await bootFn()()
    await seed.services.db.insertInto('workspaces').values({ id: 'ws_bk', name: 'W', base_currency: 'USD', created_at: new Date().toISOString() }).execute()
    await seed.shutdown()
    const a = io()
    expect(await backupCommand(['now'], a, bootFn())).toBe(0)
    expect(a.lines[0]).toMatch(/^uploaded backups\/agfn-sqlite-.*\.agfnbak/)
    const l = io()
    await backupCommand(['list'], l, bootFn())
    expect(l.lines).toHaveLength(1)
    const to = join(dir, 'restored.db')
    // It asks first: nobody at a terminal needs --yes; anything but "restore" cancels with nothing written.
    await expect(backupCommand(['restore', l.lines[0]!, '--to', to], io(), bootFn())).rejects.toThrow(/--yes/)
    const no = Object.assign(io(), { ask: async () => 'no' })
    expect(await backupCommand(['restore', l.lines[0]!, '--to', to], no, bootFn())).toBe(1)
    expect(existsSync(to)).toBe(false)
    const r = Object.assign(io(), { ask: async () => 'restore' })
    expect(await backupCommand(['restore', l.lines[0]!, '--to', to], r, bootFn())).toBe(0)
    expect(existsSync(to)).toBe(true)
    expect(r.lines.join('\n')).toMatch(/Restoring into the new file/)
    // Never over an existing file.
    await expect(backupCommand(['restore', l.lines[0]!, '--to', to, '--yes'], io(), bootFn())).rejects.toThrow(/already exists/)
    // Without --to, a database that holds data is never touched.
    await expect(backupCommand(['restore', l.lines[0]!, '--yes'], io(), bootFn())).rejects.toThrow(/already holds data.*--to/)
  }, 60_000)

  it('restore without --to fills a fresh DATA_DIR: the empty database this command created is replaced', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'agfn-cli-fresh-'))
    try {
      const freshBoot = async () =>
        boot({ config: { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATA_DIR: fresh, BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }, keys, mailer: { send: async () => {} }, backupTarget: target })
      const [key] = [...objects.keys()].filter((k) => k.endsWith('.agfnbak'))
      const r = io()
      expect(await backupCommand(['restore', key!, '--yes'], r, freshBoot)).toBe(0)
      expect(r.lines.join('\n')).toMatch(/Restoring into the empty database at .*agfn\.db[\s\S]*Start the server with this DATA_DIR/)
      // The restored copy has the source's workspaces.
      const again = await freshBoot()
      try {
        const { n } = await again.services.db.selectFrom('workspaces').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow()
        expect(Number(n)).toBeGreaterThan(0)
      } finally {
        await again.shutdown()
      }
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  }, 60_000)

  it('explains how to turn backups on, and rejects bad usage', async () => {
    await expect(backupCommand(['now'], io(), bootFn(false))).rejects.toThrow(/BACKUP_S3_BUCKET/)
    await expect(backupCommand(['restore'], io(), bootFn())).rejects.toThrow(/usage/)
    await expect(backupCommand(['explode'], io(), bootFn())).rejects.toThrow(/usage/)
  })
})
