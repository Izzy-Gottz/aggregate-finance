// The Glass Ledger's own workspace (L7): one persistent synthetic Harbor Coffee for the public log, made once.
import { describe, expect, it } from 'vitest'
import { withBypass, withWorkspace } from '@agfn/db'
import { createDemoConnector, glassManifest } from '@agfn/connector-demo'
import { startServer } from './scenarios/harness.ts'
import { createGlassLedger, GLASS_EMAIL, GLASS_NAME } from './glass-ledger.ts'

describe('the Glass Ledger workspace', () => {
  it('Harbor Coffee only, named as synthetic, planted rows marked, no seeded AI; made once, its start fixed', async () => {
    const srv = await startServer({ connectors: [(d) => createDemoConnector(d)] })
    try {
      const s = srv.booted.services
      // Four weeks back, so some weeks (and their planted cases) exist today.
      const from = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10)
      const r = await withBypass('t', () => createGlassLedger(s, from))
      expect(r).toMatchObject({ created: true, from })
      const ws = r.workspaceId
      const rows = await withBypass('t', async () => ({
        name: (await s.db.selectFrom('workspaces').select('name').where('id', '=', ws).executeTakeFirstOrThrow()).name,
        companies: (await s.db.selectFrom('entities').select(['name', 'kind']).where('workspace_id', '=', ws).execute()).filter((e) => e.kind === 'company').map((e) => e.name),
        owner: await s.db.selectFrom('memberships').innerJoin('people', 'people.id', 'memberships.person_id').select(['people.email', 'memberships.role']).where('memberships.workspace_id', '=', ws).execute(),
        grants: await (s.db as any).selectFrom('grants').select('client_name').where('workspace_id', '=', ws).execute(),
        activity: await (s.db as any).selectFrom('activity_log').select('actor_kind').where('workspace_id', '=', ws).where('actor_kind', '=', 'agent').execute(),
      }))
      expect(rows.name).toBe(GLASS_NAME)
      expect(rows.companies).toEqual(['Harbor Coffee'])
      expect(rows.owner).toEqual([{ email: GLASS_EMAIL, role: 'owner' }])
      // No seeded "Claude (demo)" connection or write: every AI action in this log is a real agent's.
      expect(rows.grants).toEqual([])
      expect(rows.activity).toEqual([])

      // The planted rows say so in their bank text; nothing else does.
      const conn = await withBypass('t', () => s.db.selectFrom('connections').select('config_json').where('workspace_id', '=', ws).executeTakeFirstOrThrow())
      const cfg = JSON.parse(conn.config_json) as { seed: string; start: string; glass: string }
      const today = new Date().toISOString().slice(0, 10)
      const plantedIds = new Set(glassManifest(cfg, today).flatMap((p) => p.rowIds))
      const ledger = (s.ledger as unknown as { store: { listRecords(ws: string, f: object): Promise<Array<{ externalId: string; date: string; event: { rawText?: string } }>> } }).store
      const txns = await withBypass('t', () => ledger.listRecords(ws, { eventTypes: ['txn.upsert'] }))
      const tagged = txns.filter((x) => x.event.rawText?.endsWith(' [planted]')).map((x) => x.externalId).sort()
      expect(tagged.length).toBeGreaterThan(0)
      expect(tagged).toEqual(txns.filter((x) => plantedIds.has(x.externalId)).map((x) => x.externalId).sort())

      // Made once: the same workspace again; a different start is refused (it would rewrite the public history).
      expect(await withBypass('t', () => createGlassLedger(s, from))).toEqual({ workspaceId: ws, created: false, from })
      await expect(withBypass('t', () => createGlassLedger(s, '2020-01-06'))).rejects.toThrow(/already runs from/)
    } finally {
      await srv.close()
    }
  }, 300_000)
})
