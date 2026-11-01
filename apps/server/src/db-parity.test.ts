// Self-hosters run on SQLite (`npm start`, `npx aggregate-finance demo`); hosted runs on Postgres. The same business must give the
// same numbers on both. Imported through the app on each database: Harbor Coffee as the benchmark has it (fixed seed and
// clock), and the whole demo `npx aggregate-finance demo` opens (every company, Personal, buckets, the cap table, documents). Then
// every overview figure, metric, check, data-health line, match, review item and report is compared. Ids differ
// between the two runs, so everything is compared by what it names (external ids, roles, names).
import { describe, expect, it } from 'vitest'
import type { MetricName } from '@agfn/contracts'
import { createDemoConnector } from '@agfn/connector-demo'
import { createConnection } from '@agfn/sync'
import { createDemoWorkspace } from '@agfn/demo'
import { withBypass, withWorkspace } from '@agfn/db'
import { BENCHMARK } from '../../../docs/benchmark/events.ts'
import { equityFor } from './equity.ts'
import { financeFor } from './finance.ts'
import { demoDocuments } from './reviewer.ts'
import { entities, signIn, startServer, type Server, type Session } from './scenarios/harness.ts'

const AT = Date.parse(BENCHMARK.clock)
const AS_OF = BENCHMARK.asOf
const METRICS: MetricName[] = ['cash', 'card_balances', 'net_cash', 'gross_burn', 'net_burn', 'runway', 'mrr', 'arr', 'revenue', 'ar_open', 'ar_overdue', 'ap_due', 'payroll_cost', 'recurring_spend', 'owner_balance', 'intercompany_balance', 'data_health', 'mrr_churn_rate', 'net_new_mrr']

type Engine = {
  metric(n: MetricName, s: unknown): Promise<unknown>
  checks(ws: string, o: unknown): Promise<unknown[]>
  dataHealth(ws: string, ids: string[]): Promise<unknown>
  reviewItems(ws: string, o: unknown): Promise<unknown[]>
  profitAndLoss(ws: string, o: unknown): Promise<unknown>
  balanceSheet(ws: string, o: unknown): Promise<unknown>
}

/** What a setup leaves: the workspace's companies by name, all imported. */
type Setup = (srv: Server, s: Session) => Promise<{ workspaceId: string; entities: Record<string, string> }>

const syncAll = async (srv: Server, ids: string[]) => {
  for (const id of ids) for (let i = 0; i < 200; i++) if (((await withBypass('worker:connection.sync', () => srv.booted.services.sync.sync(id))) as { status: string }).status !== 'partial') break
}

const harborOnly: Setup = async (srv, s) => {
  const harbor = (await entities(s))['Harbor Coffee'] as string
  const sv = srv.booted.services
  const conn = await withWorkspace(s.workspaceId, () =>
    createConnection(sv.db, sv.keys, { workspaceId: s.workspaceId, connectorKey: 'demo', displayName: 'Harbor', secret: { demo: true }, config: { profile: BENCHMARK.profile, start: BENCHMARK.start, seed: BENCHMARK.seed, glass: BENCHMARK.glass }, createdBy: s.personId, entityId: harbor }),
  )
  await syncAll(srv, [conn])
  return { workspaceId: s.workspaceId, entities: { 'Harbor Coffee': harbor } }
}

/** As `npx aggregate-finance demo` makes it (demo-local.ts), on the benchmark's date. */
const wholeDemo: Setup = async (srv, s) => {
  const sv = srv.booted.services
  const ledger = sv.ledger as { createBucket?: unknown; createRule?: unknown }
  const demo = await createDemoWorkspace(
    { db: sv.db, keys: sv.keys, now: () => new Date(AT), extras: { ...(ledger.createBucket && ledger.createRule ? { buckets: sv.ledger as never } : {}), equity: equityFor(sv), documents: demoDocuments(sv) } },
    { personId: s.personId, historyDays: 120 },
  )
  await withWorkspace(demo.workspaceId, () => syncAll(srv, demo.connections))
  return { workspaceId: demo.workspaceId, entities: Object.fromEntries(demo.entities.map((e) => [e.name, e.id])) }
}

async function fingerprint(pglite: boolean, setup: Setup): Promise<Record<string, unknown>> {
  const srv = await startServer({ pglite, connectors: [(d) => createDemoConnector({ ...d, clock: { now: () => AT, sleep: async () => {} } })] })
  try {
    const s = await signIn(srv, `parity-${pglite ? 'pg' : 'sqlite'}@example.com`, 'Harbor Coffee')
    const sv = srv.booted.services
    const { workspaceId: ws, entities: byName } = await setup(srv, s)
    const ids = Object.values(byName)

    return await withWorkspace(ws, async () => {
      const db = sv.db as never as import('kysely').Kysely<any>
      // Stable names for ids: records by event type and external id, accounts by external id, ledger accounts by role.
      const names = new Map<string, string>([[ws, 'ws'], ...Object.entries(byName).map(([n, id]) => [id, n] as [string, string])])
      for (const c of await db.selectFrom('connections').select(['id', 'display_name']).where('workspace_id', '=', ws).execute()) names.set(c.id, `connection:${c.display_name}`)
      for (const r of await db.selectFrom('ledger_records').select(['id', 'event_type', 'external_id']).where('workspace_id', '=', ws).execute()) names.set(r.id, `${r.event_type}:${r.external_id}`)
      for (const a of await db.selectFrom('accounts').select(['id', 'external_id', 'name']).where('workspace_id', '=', ws).execute()) names.set(a.id, `account:${a.external_id ?? a.name}`)
      const named = (v: string) => v.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, (id) => names.get(id) ?? '<id>')
      for (const a of await db.selectFrom('ledger_accounts').select(['id', 'role']).where('workspace_id', '=', ws).execute()) names.set(a.id, `ledger:${named(a.role)}`)
      const linkName = new Map<string, string>()
      const links = (await db.selectFrom('ledger_links').selectAll().where('workspace_id', '=', ws).execute()).map((l) => {
        const key = `${l.type}|${names.get(l.from_id) ?? l.from_id}|${names.get(l.to_id) ?? l.to_id}`
        linkName.set(l.id, `link:${key}`)
        return { key, status: l.status, amount: l.amount_minor === null ? null : Number(l.amount_minor), currency: l.currency, confidence: Number(l.confidence), method: l.method }
      })
      for (const [id, n] of linkName) names.set(id, n)
      // Ids anywhere in a string (roles like cash:<account id>) become names. Order counts where a person or an AI sees
      // it: the rows behind a figure (the first 200 when there are more), the review queue and the ten data-health items
      // must come back the same on every run and database. Other lists are compared as sets.
      const text = (v: string) => names.get(v) ?? v.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, (id) => names.get(id) ?? '<id>')
      const ORDERED = new Set(['rowIds', 'items'])
      const norm = (v: unknown, ordered = false): unknown => {
        if (typeof v === 'string') return text(v)
        if (Array.isArray(v)) {
          const xs = v.map((x) => norm(x))
          return ordered ? xs : xs.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0))
        }
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, ORDERED.has(k))]))
        return v
      }
      const engine = sv.ledger as unknown as Engine
      const metrics: Record<string, unknown> = {}
      for (const [name, id] of [...Object.entries(byName), ['all', ids] as const]) for (const m of METRICS) {
        const scope = { workspaceId: ws, entityIds: Array.isArray(id) ? id : [id], to: AS_OF }
        metrics[`${name}|${m}`] = norm(await engine.metric(m, scope))
      }
      const reader = financeFor(sv).reader
      // Lines per ledger account and basis: the whole ledger, summed.
      const lines = await db
        .selectFrom('journal_lines as l')
        .innerJoin('journal_entries as e', 'e.id', 'l.entry_id')
        .select(['l.ledger_account_id', 'e.basis', 'l.currency'])
        .select((eb) => [eb.fn.sum('l.debit_minor').as('d'), eb.fn.sum('l.credit_minor').as('c'), eb.fn.countAll().as('n')])
        .where('e.workspace_id', '=', ws)
        .groupBy(['l.ledger_account_id', 'e.basis', 'l.currency'])
        .execute()
      return {
        overview: norm(await reader.overview({ workspaceId: ws, entityIds: ids }, BENCHMARK.clock)),
        metrics,
        checks: norm(await engine.checks(ws, { entityIds: ids, asOf: AS_OF })),
        dataHealth: norm(await engine.dataHealth(ws, ids)),
        review: norm(await engine.reviewItems(ws, { entityIds: ids }), true),
        links: links.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
        ledger: lines.map((r) => ({ account: text(r.ledger_account_id), basis: r.basis, currency: r.currency, debit: Number(r.d), credit: Number(r.c), lines: Number(r.n) })).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        pnlCash: norm(await engine.profitAndLoss(ws, { entityIds: ids, from: '2025-10-01', to: AS_OF, basis: 'cash' })),
        pnlAccrual: norm(await engine.profitAndLoss(ws, { entityIds: ids, from: '2025-10-01', to: AS_OF, basis: 'accrual' })),
        balanceSheet: norm(await engine.balanceSheet(ws, { entityIds: ids, asOf: AS_OF, basis: 'accrual' })),
      }
    })
  } finally {
    await srv.close()
  }
}

describe('SQLite and Postgres give the same books', () => {
  const same = async (setup: Setup, minLinks: number) => {
    const sqlite = await fingerprint(false, setup)
    const pg = await fingerprint(true, setup)
    if (process.env.PARITY_DUMP) {
      const fs = await import('node:fs')
      fs.writeFileSync(`${process.env.PARITY_DUMP}-sqlite.json`, JSON.stringify(sqlite, null, 1))
      fs.writeFileSync(`${process.env.PARITY_DUMP}-pg.json`, JSON.stringify(pg, null, 1))
    }
    expect((sqlite.links as unknown[]).length).toBeGreaterThan(minLinks)
    for (const key of Object.keys(pg)) expect(sqlite[key], key).toEqual(pg[key])
  }

  it('Harbor Coffee as the benchmark has it', () => same(harborOnly, 100), 900_000)
  it('the whole demo `npx aggregate-finance demo` opens', () => same(wholeDemo, 50), 900_000)
})
