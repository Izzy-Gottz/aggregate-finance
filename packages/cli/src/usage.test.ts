import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Io } from './io.ts'
import { usageCommand } from './usage.ts'

function io(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = []
  const errors: string[] = []
  return { cwd: process.cwd(), env: {}, out: (s: string) => void lines.push(s), err: (s: string) => void errors.push(s), lines, errors } as unknown as Io & { lines: string[]; errors: string[] }
}

const bootFn = async () => {
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'sqlite::memory:', BASE_URL: 'http://localhost:8787', WEB_DIST: '/nonexistent' }), runWorker: false }
  const b = await boot({ config, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), mailer: { send: async () => {} } })
  const at = new Date().toISOString()
  await b.handle.db.insertInto('workspaces').values({ id: 'w1', name: 'Acme', base_currency: 'USD', created_at: at }).execute()
  await b.handle.db.insertInto('connections').values({ id: 'c1', workspace_id: 'w1', connector_key: 'plaid', entity_id: null, display_name: 'Chase', status: 'active', secret_enc: null, config_json: '{"products":["liabilities"]}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: at }).execute()
  return b
}

describe('agfn usage', () => {
  it('prints per-workspace usage and instance totals, or JSON', async () => {
    const t = io()
    expect(await usageCommand([], t, bootFn)).toBe(0)
    const out = t.lines.join('\n')
    expect(out).toMatch(/^instance: 1 workspace/)
    expect(out).toContain('Acme (w1)')
    expect(out).toContain('Plaid Items 1 (transactions 1, liabilities 1)')
    const j = io()
    expect(await usageCommand(['--json', '--workspace', 'w1', '--days', '7'], j, bootFn)).toBe(0)
    expect(JSON.parse(j.lines.join('\n'))).toMatchObject({ instance: { workspaces: 1 }, workspaces: [{ id: 'w1', today: { plaidItems: { active: 1 } } }] })
  })

  it('rejects bad options', async () => {
    await expect(usageCommand(['--days', '0'], io(), bootFn)).rejects.toThrow(/--days/)
    await expect(usageCommand(['--frobnicate'], io(), bootFn)).rejects.toThrow()
  })
})
