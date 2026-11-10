// The Glass Ledger's own workspace (L7): one persistent Harbor Coffee, synthetic, separate from the nightly public demo,
// created once and never rebuilt, so the agents' activity log (what the public log is made of) is kept. Its demo
// connection adds a deterministic week every Monday (connector-demo glass.ts) on its ordinary syncs, and the planted
// rows say " [planted]" in their bank text so the log labels them automatically. Run once by ops:
// `agfn glass-ledger create --from <launch Monday>`.
import type { Kysely } from 'kysely'
import { newId, nowIso, withBypass, withWorkspace, type CoreTables } from '@agfn/db'
import type { LedgerEngine } from '@agfn/core'
import { createDemoWorkspace, DEMO_AI_SETTING } from '@agfn/demo'
import { equityFor } from './equity.ts'
import { demoDocuments } from './reviewer.ts'
import type { Services } from './services.ts'

/** A reserved, undeliverable address: the workspace's system owner, never a customer. */
export const GLASS_EMAIL = 'glass-ledger@aggregate.invalid'
export const GLASS_NAME = 'Glass Ledger · Harbor Coffee (synthetic)'

async function glassPerson(db: Kysely<CoreTables>): Promise<string> {
  // The operator runs this before the glass workspace exists, so there's no membership to make the person visible: a
  // named bypass finds or creates it.
  const found = await withBypass('glass:person', () => db.selectFrom('people').select('id').where('email', '=', GLASS_EMAIL).executeTakeFirst())
  if (found) return found.id
  const id = newId()
  await withBypass('glass:person', () => db.insertInto('people').values({ id, auth_user_id: null, name: 'Glass Ledger', email: GLASS_EMAIL, created_at: nowIso() }).execute())
  return id
}

/**
 * Create the Glass Ledger workspace starting the week of `from` (YYYY-MM-DD; the generator starts on the Monday on or
 * after it), or return the one already made. A second call with a different start is refused: the weeks are a pure
 * function of it, so changing it would rewrite the public history.
 */
export async function createGlassLedger(s: Pick<Services, 'db' | 'keys' | 'sync' | 'ledger' | 'documents'>, from: string): Promise<{ workspaceId: string; created: boolean; from: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || Number.isNaN(Date.parse(from))) throw new Error('--from must be a date, e.g. 2026-10-26')
  const personId = await glassPerson(s.db)
  const membership = await s.db.selectFrom('memberships').select('workspace_id').where('person_id', '=', personId).where('revoked_at', 'is', null).executeTakeFirst()
  if (membership) {
    const ws = membership.workspace_id
    const row = await withWorkspace(ws, () => s.db.selectFrom('settings').select('value_json').where('workspace_id', '=', ws).where('key', '=', 'glass_ledger').executeTakeFirst())
    const was = row ? (JSON.parse(row.value_json) as { from: string }).from : null
    if (was && was !== from) throw new Error(`the Glass Ledger already runs from ${was}; its weeks can't be moved`)
    return { workspaceId: ws, created: false, from: was ?? from }
  }
  const ledger = s.ledger as Partial<Pick<LedgerEngine, 'createBucket' | 'createRule'>>
  const demo = await createDemoWorkspace(
    {
      // Synced below, after the flags: not here.
      db: s.db,
      keys: s.keys,
      extras: { ...(ledger.createBucket && ledger.createRule ? { buckets: s.ledger as unknown as Pick<LedgerEngine, 'createBucket' | 'createRule'> } : {}), equity: equityFor(s), documents: demoDocuments(s) },
    },
    { personId, profiles: ['harbor'], glass: from, glassTag: true, workspaceName: GLASS_NAME },
  )
  // No seeded "Claude (demo)" write and no tidy-up for show: every AI action in this log has to be a real agent's.
  await withWorkspace(demo.workspaceId, () =>
    s.db
      .insertInto('settings')
      .values([
        { workspace_id: demo.workspaceId, key: 'glass_ledger', value_json: JSON.stringify({ from }), updated_at: nowIso() },
        { workspace_id: demo.workspaceId, key: DEMO_AI_SETTING, value_json: JSON.stringify({ skipped: 'glass ledger' }), updated_at: nowIso() },
      ])
      .execute(),
  )
  for (const id of demo.connections) await withWorkspace(demo.workspaceId, () => s.sync.sync(id))
  return { workspaceId: demo.workspaceId, created: true, from }
}
