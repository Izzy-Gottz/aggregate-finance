import { sql } from 'kysely'
import { describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { boot } from '@agfn/server/boot'
import { loadConfig } from '@agfn/server/config'
import type { Io } from './io.ts'
import { exportCommand } from './export.ts'
import { rebuildCommand } from './rebuild.ts'
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

describe('operator access on the hosted service', () => {
  const hosted = (env: Record<string, string>) => ({ ...io(), env: { AGFN_HOSTED: '1', ...env } })

  it('needs a name and a reason before it boots anything', async () => {
    const never = async () => { throw new Error('booted') }
    await expect(usageCommand([], hosted({ AGFN_OPERATOR: 'f5' }), never as never)).rejects.toThrow(/--reason/)
    await expect(usageCommand(['--reason', '  '], hosted({ AGFN_OPERATOR: 'f5' }), never as never)).rejects.toThrow(/--reason/)
    await expect(usageCommand(['--reason', 'cost check'], hosted({}), never as never)).rejects.toThrow(/AGFN_OPERATOR/)
  })

  it('records one workspace in its own activity log, and all of them in operator_access', async () => {
    let db: any
    const keep = async () => { const b = await bootFn(); db = b.handle.db; const down = b.shutdown; b.shutdown = async () => { rows = await read(); await down() }; return b }
    let rows: { activity: any[]; platform: any[] } = { activity: [], platform: [] }
    const read = async () => ({ activity: await db.selectFrom('activity_log').selectAll().execute(), platform: await db.selectFrom('operator_access').selectAll().execute() })

    expect(await usageCommand(['--workspace', 'w1', '--reason', 'support ticket 12'], hosted({ AGFN_OPERATOR: 'f5' }), keep)).toBe(0)
    expect(rows.platform).toHaveLength(0)
    expect(rows.activity).toHaveLength(1)
    expect(rows.activity[0]).toMatchObject({ actor_kind: 'operator', actor_label: 'Aggregate support', action: 'operator.access', target_id: 'usage', detail: 'support ticket 12' })
    expect(JSON.parse(rows.activity[0].args_json)).toEqual({ operator: 'f5' })

    expect(await usageCommand(['--reason', 'cost check'], hosted({ AGFN_OPERATOR: 'f5' }), keep)).toBe(0)
    expect(rows.activity).toHaveLength(0)
    expect(rows.platform).toHaveLength(1)
    expect(rows.platform[0]).toMatchObject({ operator: 'f5', command: 'usage', reason: 'cost check' })
  })

  it('covers export before it runs, and rebuild needs a reason too', async () => {
    let db: any
    let activity: any[] = []
    const keep = async () => { const b = await bootFn(); db = b.handle.db; const down = b.shutdown; b.shutdown = async () => { activity = await db.selectFrom('activity_log').selectAll().execute(); await down() }; return b }
    const t = hosted({ AGFN_OPERATOR: 'f5' })
    await expect(exportCommand(['--format', 'hledger'], t, keep)).rejects.toThrow(/--reason/)
    await expect(rebuildCommand([], t, keep)).rejects.toThrow(/--reason/)

    // This server has no ledger, so the export itself fails: the record is already written by then.
    await expect(exportCommand(['--format', 'hledger', '--workspace', 'w1', '--reason', 'their request'], t, keep)).rejects.toThrow(/ledger/)
    expect(activity.map((r) => [r.action, r.target_id])).toEqual([['operator.access', 'export']])
  })

  it('refuses to run when the record cannot be written', async () => {
    const broken = async () => { const b = await bootFn(); await b.handle.db.schema.dropTable('operator_access').execute(); return b }
    const t = hosted({ AGFN_OPERATOR: 'f5' })
    await expect(usageCommand(['--reason', 'cost check'], t, broken)).rejects.toThrow(/operator_access/)
    const noLog = async () => { const b = await bootFn(); await sql`alter table activity_log rename to activity_log_gone`.execute(b.handle.db); return b }
    await expect(usageCommand(['--workspace', 'w1', '--reason', 'support'], t, noLog)).rejects.toThrow(/activity_log/)
    expect(t.lines).toEqual([])
  })

  it('stays out of the way when self-hosted', async () => {
    expect(await usageCommand([], io(), bootFn)).toBe(0)
  })
})
