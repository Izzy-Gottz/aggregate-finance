import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Io } from './io.ts'
import { wipeCommand } from './wipe.ts'

function io(): Io & { lines: string[] } {
  const lines: string[] = []
  return { cwd: process.cwd(), env: {}, out: (s: string) => void lines.push(s), err: () => {}, lines } as unknown as Io & { lines: string[] }
}

let booted = 0
const bootFn = async () => {
  booted++
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
  const b = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
  await b.handle.db.insertInto('workspaces').values({ id: 'w1', name: 'Real Co', base_currency: 'USD', created_at: new Date().toISOString() }).execute()
  return b
}

describe('agfn prelaunch-wipe (retired on live)', () => {
  it('refuses --apply without --branch-copy, before touching the database', async () => {
    booted = 0
    await expect(wipeCommand(['--apply', '--confirm', 'WIPE'], io(), bootFn)).rejects.toThrow('Live has real users; the pre-launch wipe is retired.')
    expect(booted).toBe(0)
  })

  it('the dry run still lists the plan and deletes nothing', async () => {
    const t = io()
    expect(await wipeCommand([], t, bootFn)).toBe(0)
    expect(t.lines.join('\n')).toContain('w1  Real Co')
    expect(t.lines.at(-1)).toContain('dry run: nothing deleted')
  })

  it('a branch copy still needs --confirm WIPE', async () => {
    await expect(wipeCommand(['--apply', '--branch-copy'], io(), bootFn)).rejects.toThrow(/--confirm WIPE/)
  })
})
