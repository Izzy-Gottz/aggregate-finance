import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { connect, migrateToLatest, newId, nowIso, JobQueue, type CoreTables, type DbHandle } from '@agfn/db'
import { loadKeyRing } from '@agfn/security'
import { ConnectorRegistry, SyncEngine } from '@agfn/sync'
import { createDemoConnector } from '@agfn/connector-demo'
import { ledgerFor } from '@agfn/server/modules'
import { runwayBand, verifiedBadges } from '@agfn/core'
import { EquityService, type EquityLedgerPort, type EquityTables } from '@agfn/equity'
import type { Kysely } from 'kysely'
import { SAFE_WIRES } from '@agfn/connector-demo'
import { assertConnectorAllowed, createDemoWorkspace, demoCapTable, demoImporting, nextDemoImport, findDemoWorkspace, isDemoReady, isDemoWorkspace, leaveDemoWorkspace, seedDemoAiWhenReady, stalledDemoImports, tidyDemoReview, type SeedDemoAi } from './index.ts'

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

describe('demo workspace', () => {
  it('creates three companies + Personal, syncs them through the real ledger, and is idempotent', async () => {
    const { db, keys, sync, ledger, personId } = await setup()
    // 45 days keeps the real-ledger run quick; the connector's own tests cover the full year.
    const equity = new EquityService({ db: db as unknown as Kysely<CoreTables & EquityTables>, ledger: ledger as unknown as EquityLedgerPort })
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW, extras: { buckets: ledger, equity } }, { personId, historyDays: 45 })
    expect(ws.created).toBe(true)
    expect(ws.entities.map((e) => e.name)).toEqual(['Northwind Labs', 'Bluebird Studio', 'Harbor Coffee', 'Personal'])
    expect(await isDemoWorkspace(db, ws.workspaceId)).toBe(true)

    const conns = await db.selectFrom('connections').selectAll().where('workspace_id', '=', ws.workspaceId).where('connector_key', '=', 'demo').execute()
    expect(conns.map((c) => c.status)).toEqual(['active', 'active', 'active', 'active'])
    // Every account belongs to its company: the demo never asks "which company is this?".
    const unassigned = await db.selectFrom('accounts').select('id').where('workspace_id', '=', ws.workspaceId).where('entity_id', 'is', null).execute()
    expect(unassigned).toHaveLength(0)
    const raw = await db.selectFrom('raw_records').select(({ fn }) => fn.countAll<number>().as('n')).where('workspace_id', '=', ws.workspaceId).executeTakeFirstOrThrow()
    expect(Number(raw.n)).toBeGreaterThan(200)

    const northwind = ws.entities[0]!.id
    const cash = await ledger.metric('cash', { workspaceId: ws.workspaceId, entityIds: [northwind] })
    expect(cash.value).not.toBeNull()
    expect(typeof cash.value === 'object' && cash.value !== null && 'minor' in cash.value ? cash.value.minor : 0).toBeGreaterThan(400_000_00)

    // Buckets route by rule as rows post; the cap table is on Northwind.
    const views = await ledger.listBuckets(ws.workspaceId, undefined, '2026-10-09')
    expect(views.map((v) => v.bucket.name).sort()).toEqual(['Contractors', 'Rent', 'Suppliers'])
    const rent = views.find((v) => v.bucket.name === 'Rent')
    expect(rent?.payments.length).toBeGreaterThan(0)
    expect(rent?.status).toBe('paid')
    const [table] = await equity.capTable({ workspaceId: ws.workspaceId, entityIds: [northwind] })
    expect(table?.holders.some((h) => h.name === 'Alex Morgan')).toBe(true)
    expect(table?.optionPool).toMatchObject({ size: 1_500_000 })
    expect(table?.optionPool?.granted).toBeGreaterThanOrEqual(250_000)
    // A partly vested RSU grant whose first year was released net of tax (12,000 units, 3,000 withheld: 9,000 shares),
    // and a lender's warrant on the seed preferred. Read once everything has happened.
    const cap = await equity.state(ws.workspaceId, northwind, '2030-01-01')
    expect(cap.warnings).toEqual([])
    expect(cap.grants.find((g) => g.securityId === 'RSU-1')).toMatchObject({ compensationType: 'RSU', granted: 48_000 })
    expect(cap.stock.find((x) => x.securityId === 'RSU-1:stock')?.quantity).toBe(9_000)
    expect(cap.warrants).toEqual([expect.objectContaining({ securityId: 'W-1', granted: 50_000, stockClassId: 'seed' })])

    const again = await createDemoWorkspace({ db, keys, sync, now: () => NOW }, { personId, historyDays: 45 })
    expect(again).toMatchObject({ workspaceId: ws.workspaceId, created: false })
    expect(again.connections).toHaveLength(4)
  }, 120_000)

  it('a finished demo looks healthy: no failed checks of any kind and nothing in transit', async () => {
    const { db, keys, sync, ledger, personId } = await setup()
    const equity = new EquityService({ db: db as unknown as Kysely<CoreTables & EquityTables>, ledger: ledger as unknown as EquityLedgerPort })
    // The full year: month boundaries are where a row dated in the wrong local day shows up.
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW, extras: { buckets: ledger, equity } }, { personId })
    const health = await ledger.dataHealth(ws.workspaceId)
    expect(health.items.filter((i) => i.kind === 'failed_check')).toEqual([])
    expect(health.counts.failedChecks).toBe(0)
    // Every payout and wire inside the window has its bank leg; equity issued before the bank history starts (the seed
    // round, founder shares) counts as already in the opening balances.
    expect(health.items.filter((i) => i.kind === 'in_transit')).toEqual([])

    // Twelve whole months behind today, for a year's P&L and balance sheet.
    expect(ws.start).toBe('2025-10-01')
    // Harbor Coffee is the "Stripe + Shopify + bank = one P&L" company.
    const harbor = ws.entities.find((e) => e.profile === 'harbor')!.id
    const accounts = await db.selectFrom('accounts').select(['institution', 'account_type']).where('workspace_id', '=', ws.workspaceId).where('entity_id', '=', harbor).execute()
    expect(new Set(accounts.map((a) => a.institution))).toEqual(new Set(['Stripe', 'Shopify', 'Demo Community Bank', 'Harbor Coffee']))
    // Its bank deposits carry no payout id: the matcher pairs every Stripe and Shopify payout with its deposit by itself.
    const links = await ledger.store.listLinks(ws.workspaceId, { types: ['payout', 'transfer'] })
    const rawText = async (id: string) => {
      const r = await ledger.store.getRecord(ws.workspaceId, id)
      return r?.event.type === 'txn.upsert' ? (r.event.rawText ?? '') : ''
    }
    const caught = { stripe: 0, shopify: 0, topup: 0 }
    for (const l of links) {
      if (l.status !== 'confirmed' || l.method !== 'rule') continue
      const text = await rawText(l.toId)
      if (l.type === 'payout' && text.startsWith('STRIPE TRANSFER')) caught.stripe++
      if (l.type === 'payout' && text === 'SHOPIFY PAYMENTS PAYOUT') caught.shopify++
      if (l.type === 'transfer' && text.startsWith('ONLINE TRANSFER FROM SAV')) caught.topup++
    }
    expect(caught.stripe).toBeGreaterThan(300)
    expect(caught.shopify).toBeGreaterThan(45)
    // The one savings top-up ($15,000) is a transfer, not income.
    expect(caught.topup).toBe(1)
  }, 300_000)

  it('a Harbor-only build for the benchmark: one company, a fixed seed and start, MRR moving every month, books clean', async () => {
    const { db, keys, sync, ledger, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW, extras: { buckets: ledger } }, { personId, profiles: ['harbor'], seed: 'aggregate-bench-v1', start: '2024-10-01' })
    expect(ws.entities.map((e) => e.profile)).toEqual(['harbor'])
    expect(ws.start).toBe('2024-10-01')
    const conns = await db.selectFrom('connections').select('config_json').where('workspace_id', '=', ws.workspaceId).execute()
    expect(conns.map((c) => JSON.parse(c.config_json))).toEqual([{ profile: 'harbor', start: '2024-10-01', seed: 'aggregate-bench-v1' }])
    const health = await ledger.dataHealth(ws.workspaceId)
    expect(health.counts.failedChecks).toBe(0)
    expect(health.items.filter((i) => i.kind === 'in_transit')).toEqual([])
    // The Bean Club: members join, upgrade and leave every month (upgrades dated when they happened, not at import).
    const months = await ledger.mrrMovements(ws.workspaceId, { from: '2025-01', to: '2026-09' })
    expect(months).toHaveLength(21)
    for (const m of months) {
      expect([m.month, m.new.minor > 0, m.expansion.minor > 0, m.churn.minor > 0]).toEqual([m.month, true, true, true])
    }
    // Software on the card is its own line.
    const sw = await ledger.store.listRecords(ws.workspaceId, { eventTypes: ['txn.upsert'] })
    expect(sw.filter((r) => r.event.type === 'txn.upsert' && r.event.counterparty === 'QuickBooks Online')).toHaveLength(24)

    // "Verified by Aggregate": clean books, so the badges are vouched for; each shows its formula.
    const v = await verifiedBadges(ledger, ws.workspaceId, ws.entities[0]!.id, { today: '2026-10-09' })
    expect([v.asOf, v.verified, v.reasons]).toEqual(['2026-09-30', true, []])
    expect(v.badges.map((b) => [b.key, b.state])).toEqual([['mrr', 'ok'], ['growth', 'ok'], ['runway', 'ok']])
    const [mrr, growth, runway] = v.badges
    expect(mrr!.display).toMatch(/^\$[\d,]+$/)
    expect(growth!.label).toBe('MRR growth')
    expect(growth!.display).toMatch(/^[+-]\d+\.\d% in 3 months$/)
    expect(runway!.band).toBeTruthy()
    for (const b of v.badges) expect(b.formula.length).toBeGreaterThan(20)
  }, 300_000)

  it('runway shows as a band, never the exact months', () => {
    expect([runwayBand(3.2, false), runwayBand(6, false), runwayBand(18.5, false), runwayBand(40, false), runwayBand(null, true), runwayBand(null, false)]).toEqual(['Under 6 months', '6–12 months', '12–24 months', '24+ months', 'Not burning', null])
  })

  it('the cap table SAFEs fall on the days their wires reach the bank', () => {
    const objs = demoCapTable('2025-10-09')
    const safes = objs.filter((o) => o.type === 'TX_CONVERTIBLE_ISSUANCE') as Array<{ date: string; amount: { minor: number } }>
    expect(safes.map((x) => [x.date, x.amount.minor]).sort()).toEqual(
      SAFE_WIRES.map((w) => [new Date(Date.parse('2025-10-09T00:00:00Z') + w.offset * 86_400_000).toISOString().slice(0, 10), w.minor]).sort(),
    )
    // The operator's real surname never appears in demo data (kept encoded so the public repo doesn't carry it either).
    const realSurname = Buffer.from('R290dGxpZWI=', 'base64').toString()
    expect(objs.some((o) => o.type === 'STAKEHOLDER' && (o as { name: string }).name.includes(realSurname))).toBe(false)
  })

  it('keeps real and demo data apart', async () => {
    const { db, keys, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId })
    await expect(assertConnectorAllowed(db, ws.workspaceId, 'plaid')).rejects.toThrow(/demo workspace/)
    await expect(assertConnectorAllowed(db, ws.workspaceId, 'demo')).resolves.toBeUndefined()
    const other = newId()
    await db.insertInto('workspaces').values({ id: other, name: 'Real', base_currency: 'USD', created_at: nowIso() }).execute()
    await expect(assertConnectorAllowed(db, other, 'demo')).rejects.toThrow(/only live in the demo/)
    await expect(assertConnectorAllowed(db, other, 'plaid')).resolves.toBeUndefined()
  })

  it('leaving the demo revokes access and pauses its connections', async () => {
    const { db, keys, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId })
    expect(await leaveDemoWorkspace(db, personId)).toBe(true)
    expect(await findDemoWorkspace(db, personId)).toBeUndefined()
    const statuses = await db.selectFrom('connections').select('status').where('workspace_id', '=', ws.workspaceId).execute()
    expect(statuses.every((s) => s.status === 'paused')).toBe(true)
    expect(await leaveDemoWorkspace(db, personId)).toBe(false)
  })
})

describe('demo AI seed', () => {
  it('waits until every demo connection has caught up, then seeds once as the owner', async () => {
    const { db, keys, sync, personId } = await setup()
    const calls: Array<{ workspaceId: string; personId: string; write: { company: string; date: string } }> = []
    const seed: SeedDemoAi = async (input) => {
      calls.push(input)
    }
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).toBe(false)
    expect(await isDemoReady(db, ws.workspaceId)).toBe(false)

    for (const id of ws.connections.slice(0, 3)) await sync.sync(id)
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).toBe(false)

    await sync.sync(ws.connections[3]!)
    let tidied = 0
    // Not ready while the tidy runs (it answers review questions, which moves cash): only after the AI write too.
    let readyDuringTidy: boolean | undefined
    const tidy = async () => {
      tidied++
      readyDuringTidy = await isDemoReady(db, ws.workspaceId, () => NOW)
    }
    // Warmed after the AI write (it changes the books) and before it says ready; a warm that fails doesn't hold it up.
    let readyDuringWarm: boolean | undefined
    const warm = async () => {
      readyDuringWarm = await isDemoReady(db, ws.workspaceId, () => NOW)
      expect(calls).toHaveLength(1)
      throw new Error('warm failed')
    }
    expect(await seedDemoAiWhenReady({ db, seed, tidy, warm, now: () => NOW }, ws.workspaceId)).toBe(true)
    expect(readyDuringTidy).toBe(false)
    expect(readyDuringWarm).toBe(false)
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).toBe(false)
    expect(tidied).toBe(1)
    expect(await isDemoReady(db, ws.workspaceId)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ workspaceId: ws.workspaceId, personId, write: { company: 'Harbor Coffee', date: '2026-10-07' } })
  })

  it('waits for other connections\' sync jobs to finish, not just their cursors', async () => {
    const { db, keys, sync, personId } = await setup()
    const seed: SeedDemoAi = async () => undefined
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    for (const id of ws.connections) await sync.sync(id)
    const [a, b] = ws.connections as [string, string]
    const job = (id: string, uniqueKey: string, status: 'running' | 'queued', runAt: string) => ({
      id,
      workspace_id: ws.workspaceId,
      kind: 'connection.sync',
      payload_json: '{}',
      status,
      run_at: runAt,
      attempts: 0,
      max_attempts: 5,
      lease_until: null,
      locked_by: null,
      last_error: null,
      unique_key: uniqueKey,
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    })
    // Connection b's job is still posting: not ready, even though every cursor is caught up.
    await db.insertInto('jobs').values(job('job_b', b, 'running', NOW.toISOString())).execute()
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId, a)).toBe(false)
    // b finishes but queued its next page 5 s out: still not ready.
    await db.updateTable('jobs').set({ status: 'queued', run_at: new Date(NOW.getTime() + 5_000).toISOString() }).where('id', '=', 'job_b').execute()
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId, a)).toBe(false)
    // Only the caller's own running job is left (and an hourly round far away): ready.
    await db.updateTable('jobs').set({ run_at: new Date(NOW.getTime() + 3_600_000).toISOString() }).where('id', '=', 'job_b').execute()
    await db.insertInto('jobs').values(job('job_a', a, 'running', NOW.toISOString())).execute()
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId, a)).toBe(true)
    expect(await isDemoReady(db, ws.workspaceId)).toBe(true)
  })

  it('demos seeded before the ready marker count as ready once the claim is 10 minutes old', async () => {
    const { db, keys, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    await db.insertInto('settings').values({ workspace_id: ws.workspaceId, key: 'demo_ai_seeded', value_json: 'true', updated_at: NOW.toISOString() }).execute()
    expect(await isDemoReady(db, ws.workspaceId, () => new Date(NOW.getTime() + 60_000))).toBe(false)
    expect(await isDemoReady(db, ws.workspaceId, () => new Date(NOW.getTime() + 11 * 60_000))).toBe(true)
  })

  it('imports one company after another: Northwind, Bluebird, Harbor, then Personal', async () => {
    const { db, keys, sync, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    const [nw, bb, hc, pe] = ws.connections as [string, string, string, string]
    const today = NOW.toISOString().slice(0, 10)
    expect(await nextDemoImport(db, ws.workspaceId, nw, today)).toBeNull() // not caught up yet
    const cursor = async (id: string) => (await db.selectFrom('connections').select('cursor').where('id', '=', id).executeTakeFirstOrThrow()).cursor
    expect(demoImporting('demo', await cursor(bb), today)).toBe(true)
    await sync.sync(nw)
    expect(await nextDemoImport(db, ws.workspaceId, nw, today)).toBe(bb)
    await sync.sync(bb)
    expect(await nextDemoImport(db, ws.workspaceId, bb, today)).toBe(hc)
    await sync.sync(hc)
    expect(await nextDemoImport(db, ws.workspaceId, hc, today)).toBe(pe)
    await sync.sync(pe)
    expect(await nextDemoImport(db, ws.workspaceId, pe, today)).toBeNull()
    expect(demoImporting('demo', await cursor(pe), today)).toBe(false)
  })

  it('a failed import doesn’t stop the others: Bluebird fails, Harbor and Personal still import, and the demo is ready', async () => {
    const { db, keys, personId } = await setup()
    // The server's wiring (boot.ts + modules.ts): the next import starts after a success or a failure; ready is
    // checked after both.
    const registry = new ConnectorRegistry()
    const clock = { now: () => NOW.getTime(), sleep: async () => {} }
    registry.register((deps) => createDemoConnector({ ...deps, clock }), { raw: { put: async () => '' } })
    const queue = new JobQueue(db)
    const today = NOW.toISOString().slice(0, 10)
    let engine: SyncEngine | undefined
    const seeded: string[] = []
    const ready = (ws: string, id: string) => seedDemoAiWhenReady({ db, seed: async (i) => void seeded.push(i.workspaceId), now: () => NOW }, ws, id).then(() => undefined)
    const next = (failed: boolean) => async (ws: string, id: string) => {
      const n = await nextDemoImport(db, ws, id, today, { failed })
      if (n) await engine!.request(ws, n)
    }
    engine = new SyncEngine({ db, keys, registry, ledger: ledgerFor(db), queue, connectorDeps: { clock }, afterSync: [next(false), ready], afterFailure: [next(true), ready] })
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    const [nw, bb, hc, pe] = ws.connections as [string, string, string, string]
    // Bluebird's import fails (its config is broken: a permanent error, not retried).
    await db.updateTable('connections').set({ config_json: JSON.stringify({ profile: 'bluebird', start: 'not-a-date' }) }).where('id', '=', bb).execute()

    // Drive the queue like the worker: run whatever is due, one at a time, starting from Northwind only.
    await engine.request(ws.workspaceId, nw)
    const order: string[] = []
    for (let i = 0; i < 10; i++) {
      const job = await db.selectFrom('jobs').select(['id', 'unique_key']).where('workspace_id', '=', ws.workspaceId).where('status', '=', 'queued').orderBy('created_at').executeTakeFirst()
      if (!job) break
      await db.deleteFrom('jobs').where('id', '=', job.id).execute()
      order.push(job.unique_key!)
      await engine.sync(job.unique_key!).catch(() => undefined)
    }
    expect(order).toEqual([nw, bb, hc, pe])
    const status = Object.fromEntries((await db.selectFrom('connections').select(['id', 'status']).where('workspace_id', '=', ws.workspaceId).execute()).map((r) => [r.id, r.status]))
    expect(status[bb]).toBe('error')
    expect([status[nw], status[hc], status[pe]]).toEqual(['active', 'active', 'active'])
    expect(seeded).toEqual([ws.workspaceId])
    expect(await isDemoReady(db, ws.workspaceId, () => NOW)).toBe(true)
  })

  // S2: the chain moves only from a sync's own hooks, so a lost job (a restart mid-fill) left the demo "Filling…" for
  // good. The watchdog finds it and names the connection to request; the fill then finishes and the demo is ready.
  it('the watchdog restarts a lost import chain: mid-import first, then the next not started', async () => {
    const { db, keys, personId } = await setup()
    const registry = new ConnectorRegistry()
    const clock = { now: () => NOW.getTime(), sleep: async () => {} }
    registry.register((deps) => createDemoConnector({ ...deps, clock }), { raw: { put: async () => '' } })
    const today = NOW.toISOString().slice(0, 10)
    let engine: SyncEngine | undefined
    const seeded: string[] = []
    const ready = (ws: string, id: string) => seedDemoAiWhenReady({ db, seed: async (i) => void seeded.push(i.workspaceId), now: () => NOW }, ws, id).then(() => undefined)
    const next = async (ws: string, id: string) => {
      const n = await nextDemoImport(db, ws, id, today)
      if (n) await engine!.request(ws, n)
    }
    engine = new SyncEngine({ db, keys, registry, ledger: ledgerFor(db), queue: new JobQueue(db), connectorDeps: { clock }, afterSync: [next, ready] })
    const ws = await createDemoWorkspace({ db, keys, now: () => NOW }, { personId, historyDays: 10 })
    const [nw, bb, hc, pe] = ws.connections as [string, string, string, string]
    const later = new Date(NOW.getTime() + 10 * 60_000)
    const drain = async () => {
      for (let i = 0; i < 10; i++) {
        const job = await db.selectFrom('jobs').select(['id', 'unique_key']).where('workspace_id', '=', ws.workspaceId).where('status', '=', 'queued').orderBy('created_at').executeTakeFirst()
        if (!job) return
        await db.deleteFrom('jobs').where('id', '=', job.id).execute()
        await engine!.sync(job.unique_key!)
      }
    }
    // Nothing queued yet and nothing done: the first import is due.
    expect(await stalledDemoImports(db, { now: later })).toEqual([{ workspaceId: ws.workspaceId, connectionId: nw }])
    await engine.sync(nw)
    // The restart: Bluebird's queued job is lost.
    await db.deleteFrom('jobs').where('workspace_id', '=', ws.workspaceId).execute()
    // A job queued or running means it isn't stalled.
    await engine.request(ws.workspaceId, hc)
    expect(await stalledDemoImports(db, { now: later })).toEqual([])
    await db.deleteFrom('jobs').where('workspace_id', '=', ws.workspaceId).execute()
    // ... unless it's queued far ahead (the hourly round's spread): that isn't progress.
    await engine.request(ws.workspaceId, bb, new Date(later.getTime() + 40 * 60_000))
    await db.updateTable('jobs').set({ updated_at: NOW.toISOString() }).where('workspace_id', '=', ws.workspaceId).execute()
    expect(await stalledDemoImports(db, { now: later })).toEqual([{ workspaceId: ws.workspaceId, connectionId: bb }])
    await db.deleteFrom('jobs').where('workspace_id', '=', ws.workspaceId).execute()
    // One stopped mid-import comes before the next not started.
    await db.updateTable('connections').set({ cursor: 'partial' }).where('id', '=', hc).execute()
    expect(await stalledDemoImports(db, { now: later })).toEqual([{ workspaceId: ws.workspaceId, connectionId: hc }])
    await db.updateTable('connections').set({ cursor: null }).where('id', '=', hc).execute()
    const [restart] = await stalledDemoImports(db, { now: later })
    expect(restart).toEqual({ workspaceId: ws.workspaceId, connectionId: bb })
    await engine.request(restart!.workspaceId, restart!.connectionId)
    await drain()
    expect(demoImporting('demo', (await db.selectFrom('connections').select('cursor').where('id', '=', pe).executeTakeFirstOrThrow()).cursor, today)).toBe(false)
    expect(seeded).toEqual([ws.workspaceId])
    expect(await isDemoReady(db, ws.workspaceId, () => NOW)).toBe(true)
    expect(await stalledDemoImports(db, { now: later })).toEqual([])
  })

  it('lets a failed seed try again, and never runs outside demo workspaces', async () => {
    const { db, keys, sync, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW }, { personId, historyDays: 7 })
    let fail = true
    const seed: SeedDemoAi = async () => {
      if (fail) throw new Error('not yet')
    }
    await expect(seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).rejects.toThrow('not yet')
    fail = false
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).toBe(true)
    await db.deleteFrom('settings').where('workspace_id', '=', ws.workspaceId).execute()
    expect(await seedDemoAiWhenReady({ db, seed, now: () => NOW }, ws.workspaceId)).toBe(false)
  })
})

describe('demo review tidy', () => {
  it('files older unexplained deposits and keeps the newest one plus the founder-loan question', async () => {
    const { db, keys, sync, ledger, personId } = await setup()
    const ws = await createDemoWorkspace({ db, keys, sync, now: () => NOW, extras: { buckets: ledger } }, { personId, historyDays: 60 })
    const before = await ledger.reviewItems(ws.workspaceId)
    const count = (items: Array<{ kind: string }>, k: string) => items.filter((i) => i.kind === k).length
    expect(count(before, 'unexplained_money')).toBeGreaterThan(1)
    await tidyDemoReview(ledger as never, ws.workspaceId)
    const after = await ledger.reviewItems(ws.workspaceId)
    expect(count(after, 'unexplained_money')).toBe(1)
    expect(count(after, 'owner_money')).toBe(count(before, 'owner_money'))
  }, 120_000)
})
