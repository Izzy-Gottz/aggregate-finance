import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine } from '@agfn/sync'
import { createDemoConnector } from '@agfn/connector-demo'
import { ledgerFor } from '@agfn/server/modules'
import { EquityService, type EquityLedgerPort, type EquityTables } from '@agfn/equity'
import type { Kysely } from 'kysely'
import { glassManifest, SAFE_WIRES } from '@agfn/connector-demo'
import { createDemoWorkspace } from './index.ts'

let h: DbHandle<CoreTables> | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const NOW = new Date('2026-10-09T12:00:00Z')

async function setup() {
  h = connect<CoreTables>('sqlite::memory:')
  await migrateToLatest(h.db)
  const keys = loadKeyRing({ AGFN_MASTER_KEY: randomBytes(32).toString('base64') })
  const registry = new ConnectorRegistry()
  const clock = { now: () => NOW.getTime(), sleep: async () => {} }
  registry.register((deps) => createDemoConnector({ ...deps, clock }), { raw: { put: async () => '' } })
  const ledger = ledgerFor(h.db)
  const sync = new SyncEngine({ db: h.db, keys, registry, ledger, queue: new JobQueue(h.db), connectorDeps: { clock } })
  const personId = newId()
  await h.db.insertInto('people').values({ id: personId, auth_user_id: null, name: 'Demo Person', email: 'demo@example.com', created_at: nowIso() }).execute()
  return { db: h.db, keys, sync, ledger, personId }
}

describe('the Glass Ledger on Harbor Coffee', () => {
  it('each planted case lands where correct books need it: caught, asked about, or applied', async () => {
    const { db, keys, sync, ledger, personId } = await setup()
    const glass = '2026-08-10'
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW }, { personId, historyDays: 90, glass })
    const harbor = ws.entities.find((e) => e.profile === 'harbor')!.id
    const records = await ledger.store.listRecords(ws.workspaceId, { entityIds: [harbor] })
    const byExt = new Map(records.map((r) => [r.externalId, r]))
    const links = await ledger.store.listLinks(ws.workspaceId, {})
    const linksOf = (id: string) => links.filter((l) => l.fromId === id || l.toId === id)
    const review = await ledger.reviewItems(ws.workspaceId)

    const planted = glassManifest({ seed: 'aggregate-demo-v1', start: ws.start, glass }, '2026-10-09')
    expect(planted.map((p) => p.kind)).toEqual(['untagged_transfer', 'near_amount', 'unexplained_deposit', 'split_payment', 'untagged_transfer', 'near_amount', 'unexplained_deposit', 'untagged_transfer'])
    for (const p of planted) {
      const rows = p.rowIds.map((x) => byExt.get(x)!)
      expect(rows.every(Boolean), `${p.kind} ${p.week}: rows posted`).toBe(true)
      if (p.kind === 'untagged_transfer') {
        expect(linksOf(rows[0]!.id).filter((l) => l.type === 'transfer' && l.status === 'confirmed').map((l) => l.toId)).toEqual([rows[1]!.id])
      }
      if (p.kind === 'near_amount') {
        // Suggested, never confirmed on its own: a person decides about the difference.
        const l = linksOf(rows[0]!.id).find((x) => x.type === 'invoice_payment')
        expect(l?.status, p.what).toBe('proposed')
        expect(review.some((i) => i.kind === 'suggested_match' && i.linkId === l!.id)).toBe(true)
      }
      if (p.kind === 'unexplained_deposit') {

        expect(review.some((i) => i.kind === 'unexplained_money' && i.recordIds.includes(rows[0]!.id)), p.what).toBe(true)
      }
      if (p.kind === 'split_payment') {
        // Each part is less than the bill: both are asked about, against this bill, never confirmed on their own.
        const bill = byExt.get(`hc-bill-ppc-${p.week}`)!
        const asked = links.filter((l) => l.type === 'invoice_payment' && l.fromId === bill.id && l.status === 'proposed').map((l) => l.toId).sort()
        expect(asked, p.what).toEqual(rows.map((r) => r.id).sort())
      }
    }
    // Ordinary bills name their number on the payment and are matched without asking.
    for (const id of ['hc-bill-ppc-2026-08-10', 'hc-bill-bbs-2026-08-10', 'hc-bill-bbs-2026-08-31']) {
      const bill = byExt.get(id)!
      expect(links.filter((l) => l.type === 'invoice_payment' && l.fromId === bill.id).map((l) => l.status), id).toEqual(['confirmed'])
    }
    const health = await ledger.dataHealth(ws.workspaceId)
    expect(health.counts.failedChecks).toBe(0)
  }, 300_000)
})
