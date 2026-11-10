// The "statement first, bank later" adoption (retire.ts) runs in the afterSync hook, which the worker wraps in
// withWorkspace(job.workspace_id) (boot.ts WORKSPACE_JOBS). This proves the whole path is safe under row-level
// security (PGlite with AGFN_PG_RLS=1, as rls-e2e does): the keep_separate marker is written under the workspace
// context (as chooseAccount does on an upload request) and read during adopt, and a marker with NO context is refused
// by RLS — which is the shape of the failure f5 saw on staging (a settings insert that escapes the workspace context
// lands with an empty agfn.workspace_id and matches neither policy branch). The adopt path itself never writes
// settings; it only reads the marker, so it is not that failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateMasterKey, loadKeyRing } from '@agfn/security'
import { connectPglite, ensureAppRole, exclusivePool, migrateToLatest, newId, nowIso, rlsPool, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Kysely } from 'kysely'
import { boot, type Booted } from './boot.ts'
import { loadConfig } from './config.ts'
import { loadInstalledModules } from './modules.ts'
import { adoptStatementAccounts, keepSeparateKey } from './retire.ts'

const BASE = 'http://localhost:8795'
let booted: Booted
const ws = newId()
const co = newId()
const bankConn = newId() // a synced bank (plaid-like) connection
const filesConn = newId() // the files connection holding uploaded-statement accounts

const account = (id: string, connectionId: string, over: Partial<CoreTables['accounts']> = {}): CoreTables['accounts'] => ({
  id,
  workspace_id: ws,
  entity_id: co,
  connection_id: connectionId,
  external_id: null,
  name: 'Checking',
  account_type: 'depository',
  currency: 'USD',
  mask: '0000',
  institution: null,
  business_hint: null,
  include_in_cash: 1,
  duplicate_of: null,
  created_at: nowIso(),
  closed_at: null,
  ...over,
})

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
  await withBypass('test-setup', async () => {
    const h = booted.handle.db
    await h.insertInto('workspaces').values({ id: ws, name: 'W', base_currency: 'USD', time_zone: 'UTC', created_at: nowIso() }).execute()
    await h.insertInto('entities').values({ id: co, workspace_id: ws, kind: 'company', name: 'Acme', base_currency: 'USD', owner_person_id: null, parent_entity_id: null, fiscal_year_start_month: 1, created_at: nowIso() }).execute()
    await h.insertInto('connections').values({ id: bankConn, workspace_id: ws, connector_key: 'plaid', entity_id: co, display_name: 'Bank', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
    await h.insertInto('connections').values({ id: filesConn, workspace_id: ws, connector_key: 'files', entity_id: co, display_name: 'Statements', status: 'active', secret_enc: null, config_json: '{}', cursor: null, last_sync_at: null, last_success_at: null, last_error: null, created_by: null, created_at: nowIso() }).execute()
  })
}, 120_000)

afterAll(async () => {
  delete process.env.AGFN_PG_RLS
  await booted?.shutdown()
})

describe('adopt + keep_separate marker under RLS', () => {
  it('RLS is enforced: a bare read sees nothing', async () => {
    expect(await booted.handle.db.selectFrom('connections').selectAll().execute()).toEqual([])
  })

  it('a keep_separate marker is written under the workspace context (as chooseAccount does), and refused without one', async () => {
    const h = booted.handle.db
    const acctId = newId()
    // chooseAccount writes this on an upload request, which runs inside withWorkspace — it must succeed under RLS.
    await withWorkspace(ws, () =>
      h.insertInto('settings').values({ workspace_id: ws, key: keepSeparateKey(acctId), value_json: '{}', updated_at: nowIso() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing()).execute(),
    )
    const seen = await withWorkspace(ws, () => h.selectFrom('settings').select('key').where('workspace_id', '=', ws).where('key', 'like', 'stmt:keep_separate:%').execute())
    expect(seen.map((r) => r.key)).toEqual([keepSeparateKey(acctId)])

    // The same insert with NO AsyncLocalStorage context lands with an empty agfn.workspace_id and matches neither the
    // workspace branch nor the owner/bypass branch — the RLS violation f5 saw. The marker path never does this; this
    // asserts the failure requires a missing context, not the marker.
    await expect(h.insertInto('settings').values({ workspace_id: ws, key: keepSeparateKey(newId()), value_json: '{}', updated_at: nowIso() }).execute()).rejects.toThrow(/row-level security/i)
  })

  it('adopt (in the sync afterSync context) reads the marker and keeps a marked account separate', async () => {
    const h = booted.handle.db
    const synced = newId()
    const uploadedKept = newId() // explicitly "new": a marker keeps it separate
    const uploadedTwin = newId() // no marker: a true twin, adopted
    await withBypass('test-setup', async () => {
      await h.insertInto('accounts').values(account(synced, bankConn, { name: 'Bank checking', institution: 'Chase' })).execute()
      await h.insertInto('accounts').values(account(uploadedKept, filesConn, { name: 'Uploaded (kept)', institution: null })).execute()
      await h.insertInto('accounts').values(account(uploadedTwin, filesConn, { name: 'Uploaded (twin)', institution: null, mask: '0000' })).execute()
    })
    // uploadedTwin shares mask/type/currency/entity with the synced account and has no contradicting bank name, so it
    // is a twin; uploadedKept is identical but carries the keep_separate marker, so it must stay its own account.
    await withWorkspace(ws, () => h.insertInto('settings').values({ workspace_id: ws, key: keepSeparateKey(uploadedKept), value_json: '{}', updated_at: nowIso() }).onConflict((oc) => oc.columns(['workspace_id', 'key']).doNothing()).execute())

    // adoptStatementAccounts runs inside withWorkspace, exactly as the worker wraps the sync job (boot.ts WORKSPACE_JOBS).
    const adopted = await withWorkspace(ws, () => adoptStatementAccounts(booted.services, ws, bankConn))
    expect(adopted).toBe(1)

    const rows = await withWorkspace(ws, () => h.selectFrom('accounts').select(['id', 'duplicate_of', 'include_in_cash']).where('id', 'in', [uploadedKept, uploadedTwin]).execute())
    const by = (id: string) => rows.find((r) => r.id === id)!
    expect(by(uploadedTwin).duplicate_of).toBe(synced) // adopted
    expect(by(uploadedTwin).include_in_cash).toBe(0)
    expect(by(uploadedKept).duplicate_of).toBe(null) // kept separate by the marker
    expect(by(uploadedKept).include_in_cash).toBe(1)
  })
})
