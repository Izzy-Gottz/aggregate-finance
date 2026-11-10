// repost-dates under row-level security (the real server on PGlite with AGFN_PG_RLS=1, as rls-e2e does), not just
// SQLite: the dry run must write nothing (no ledger_versions bump), and the real run must have the workspace context
// its writes need under RLS (without it the ledger_versions insert is refused — the bug f5 hit).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely'
import type { Ledger } from '@agfn/contracts'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'

const BASE = 'http://localhost:8788'
let booted: Booted
let ledger: Ledger
const ws = newId()
const co = newId()
const conn = newId()
const usd = (minor: number) => ({ minor, currency: 'USD' })
// 03:28Z Dec 1 is still Dec 1 in UTC, but 22:28 Nov 30 in New York.
const run = { type: 'payroll.run' as const, externalId: 'r1', connectionId: conn, payDate: '2026-12-01', at: '2026-12-01T03:28:00Z', gross: usd(100_000), employerTaxes: usd(0), net: usd(100_000), status: 'paid' as const, provider: 'Deel' }

beforeAll(async () => {
  process.env.AGFN_PG_RLS = '1'
  const db = await connectPglite<CoreTables>({ wrapPool: (p) => rlsPool(exclusivePool(p), { role: 'agfn_app' }) })
  await withBypass('test-setup', async () => {
    await migrateToLatest(db.db)
    await ensureAppRole(db.db as Kysely<any>)
  })
  const config = { ...loadConfig({ AUTH_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://unused', BASE_URL: BASE, WEB_DIST: '/nonexistent' }), runWorker: false }
  const modules = await loadInstalledModules(process.env)
  booted = await boot({ config, db, keys: loadKeyRing({ AGFN_MASTER_KEY: generateMasterKey() }), ...modules })
  ledger = booted.services.ledger
  // Scaffold a workspace with one Deel connection, bypassing RLS for the setup inserts.
  await withBypass('test-setup', async () => {
    await booted.handle.db.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', time_zone: 'UTC', created_at: nowIso() }).execute()
    await booted.handle.db.insertInto('entities').values({ id: co, workspace_id: ws, kind: 'company', name: 'Acme', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso() }).execute()
    await booted.handle.db.insertInto('connections').values({ id: conn, workspace_id: ws, connector_key: 'deel', entity_id: co, display_name: 'Deel', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
  })
}, 120_000)
afterAll(async () => {
  delete process.env.AGFN_PG_RLS
  await booted?.shutdown()
})

const version = () => withBypass('t', () => (booted.handle.db as Kysely<any>).selectFrom('ledger_versions').select('version').where('workspace_id', '=', ws).executeTakeFirst()).then((r) => (r as { version?: number } | undefined)?.version ?? 0)
const journalDates = () => withWorkspace(ws, () => (ledger as unknown as { store: { listActiveEntries(ws: string, f: object): Promise<Array<{ date: string }>> } }).store.listActiveEntries(ws, { entityIds: [co], basis: 'accrual' })).then((es) => [...new Set(es.map((e) => e.date))])
const repost = (dryRun: boolean) => withWorkspace(ws, () => ledger.repostToRules!(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun }))

describe('repost-dates under RLS', () => {
  it('RLS is enforced: a bare read sees nothing', async () => {
    expect(await booted.handle.db.selectFrom('connections').selectAll().execute()).toEqual([])
  })

  it('dry run writes nothing; real run heals under the workspace context it needs', async () => {
    await withWorkspace(ws, () => ledger.post(ws, run))
    expect(await journalDates()).toEqual(['2026-12-01'])

    // Drift: the workspace moves to New York. redate (via directoryChanged) only moves balance/processor rows, so the
    // payroll run keeps its stale Dec 1 date — the shape the heal op targets.
    await withBypass('t', () => booted.handle.db.updateTable('workspaces').set({ time_zone: 'America/New_York' }).where('id', '=', ws).execute())
    await withWorkspace(ws, () => ledger.connectionChanged?.(ws, conn))
    await withWorkspace(ws, () => (ledger as unknown as { directoryChanged(ws: string): Promise<void> }).directoryChanged(ws))
    expect(await journalDates()).toEqual(['2026-12-01'])

    // Without the workspace context, the real run's ledger_versions bump is refused by RLS — the bug f5 hit. The op
    // fixes it by wrapping each call in withWorkspace; here we prove the context is load-bearing.
    await expect(ledger.repostToRules!(ws, { connectionIds: [conn], eventTypes: ['payroll.run'], dryRun: false })).rejects.toThrow()

    // Dry run (with context): returns the count and writes NOTHING — no version bump, no re-date.
    const vBefore = await version()
    expect(await repost(true)).toEqual({ [conn]: 1 })
    expect(await version()).toBe(vBefore)
    expect(await journalDates()).toEqual(['2026-12-01'])

    // Real run (with context): the entries move to Nov 30 and the version bumps.
    expect(await repost(false)).toEqual({ [conn]: 1 })
    expect(await journalDates()).toEqual(['2026-11-30'])
    expect(await version()).toBeGreaterThan(vBefore)

    // Idempotent: a second run changes nothing.
    expect(await repost(false)).toEqual({})
    expect(await repost(true)).toEqual({})
  })
})
