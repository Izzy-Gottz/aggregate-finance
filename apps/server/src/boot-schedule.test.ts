// A boot schedules the nightly backup at its fixed time and never runs it early, even though every other recurring job
// (demo watchdog, public demo build, challenge reset) is pulled to now at start (boot.ts; the queue's daily guard).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { nextDailyUtc } from '@agfn/db'
import type { BackupTarget } from './backup.ts'
import { BACKUP_AT_UTC_MINUTES, boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const target = (puts: string[]): BackupTarget => ({
  put: async (k) => void puts.push(k),
  get: async () => null,
  delete: async () => undefined,
  list: async () => [],
})

describe('boot schedule', () => {
  it('leaves the nightly backup at the next 07:00Z across restarts, while the watchdog runs at once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agfn-boot-schedule-'))
    dirs.push(dir)
    const keys = loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() })
    const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: `sqlite:${join(dir, 'agfn.db')}`, BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: true }
    const puts: string[] = []
    const at = nextDailyUtc(BACKUP_AT_UTC_MINUTES, new Date()).toISOString()
    for (let i = 0; i < 2; i++) {
      const booted: Booted = await boot({ config, keys, backupTarget: target(puts), mailer: { send: async () => undefined } })
      const jobs = await booted.services.db.selectFrom('jobs').select(['kind', 'run_at', 'status']).where('kind', 'in', ['backup.nightly', 'demo.watchdog']).execute()
      const backup = jobs.filter((j) => j.kind === 'backup.nightly')
      expect(backup, `boot ${i + 1}`).toEqual([{ kind: 'backup.nightly', run_at: at, status: 'queued' }])
      expect(backup[0]!.run_at.slice(11)).toBe('07:00:00.000Z')
      // The watchdog is due now, or already ran (it replaced the direct boot call): never left a minute out.
      const watchdog = jobs.filter((j) => j.kind === 'demo.watchdog' && j.status === 'queued')
      expect(watchdog.length, `boot ${i + 1}`).toBe(1)
      expect(Date.parse(watchdog[0]!.run_at)).toBeLessThanOrEqual(Date.now() + 1000)
      await booted.shutdown()
    }
    expect(puts).toEqual([])
  }, 60_000)
})
