// Ledger benchmark (opt-in). Seeds a big workspace and times backfill, an incremental sync, overview, metrics,
// search and P&L on SQLite and Postgres (PGlite).
//
//   AGFN_BENCH=1 node packages/core/src/bench/run.ts
//   AGFN_BENCH_SCALE=0.1 AGFN_BENCH_BACKENDS=sqlite AGFN_BENCH=1 node packages/core/src/bench/run.ts   (quick)
//
// Full-scale runs refuse to start while the 1-minute load average is ≥ 12 (shared dev machine).
import { loadavg } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createFinance } from '../finance.ts'
import { makeKit, type Backend } from '../test-kit.ts'
import { seedBig } from './seed.ts'

if (process.env.AGFN_BENCH !== '1') {
  console.log('Set AGFN_BENCH=1 to run the ledger benchmark.')
  process.exit(0)
}
const scale = Number(process.env.AGFN_BENCH_SCALE ?? '1')
const years = Number(process.env.AGFN_BENCH_YEARS ?? '3')
const backends = (process.env.AGFN_BENCH_BACKENDS ?? 'sqlite,pglite').split(',') as Backend[]
const load = loadavg()[0] ?? 0
if (scale >= 0.5 && load >= 12) {
  console.log(`Load average is ${load.toFixed(1)} (≥ 12): not running a full-scale benchmark on a busy machine. Try later.`)
  process.exit(0)
}

const TARGETS = { overviewMs: 300, incrementalMs: 5_000 }

async function time<T>(label: string, fn: () => Promise<T>, rows: Array<[string, string]>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now()
  const value = await fn()
  const ms = performance.now() - t0
  rows.push([label, `${ms.toFixed(0)} ms`])
  return { ms, value }
}

let failed = false
for (const backend of backends) {
  const rows: Array<[string, string]> = []
  const k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
  const seeded = await seedBig(k, { scale, years })
  const ws = k.ws
  const counts = new Map<string, number>()
  for (const ev of seeded.events) counts.set(ev.type, (counts.get(ev.type) ?? 0) + 1)
  rows.push(['events', `${seeded.events.length} (${[...counts].map(([t, n]) => `${t} ${n}`).join(', ')})`])

  const page = 500
  const { ms: backfillMs } = await time(
    'backfill (pages of 500)',
    async () => {
      for (let i = 0; i < seeded.events.length; i += page) await k.engine.postBatch(ws, seeded.events.slice(i, i + page))
    },
    rows,
  )
  rows.push(['backfill rate', `${Math.round(seeded.events.length / (backfillMs / 1000))} events/s`])
  await time('reconcile (full)', () => k.engine.reconcile(ws), rows)

  k.setNow('2026-10-11T12:00:00.000Z')
  const inc = seeded.nextDay(500)
  const { ms: incMs } = await time(`incremental sync (${inc.length} rows)`, () => k.engine.postBatch(ws, inc), rows)

  const f = createFinance(k.engine)
  const scope = { workspaceId: ws, entityIds: seeded.entities }
  await time('overview (cold)', () => f.reader.overview(scope), rows)
  const { ms: overviewMs } = await time('overview (warm)', () => f.reader.overview(scope), rows)
  await time('cash, one company', () => f.reader.metric('cash', { workspaceId: ws, entityIds: [seeded.entities[0] as string] }), rows)
  await time('runway, one company', () => f.reader.metric('runway', { workspaceId: ws, entityIds: [seeded.entities[0] as string] }), rows)
  await time('search "uber" (50)', () => f.reader.searchTransactions(scope, { text: 'uber', limit: 50 }), rows)
  await time('P&L 12 months, all', () => f.reader.reports(scope, 'profit_and_loss', '2025-10-01', '2026-09-30', 'accrual'), rows)
  await time('data health', () => k.engine.dataHealth(ws), rows)
  await time('weekly digest', () => k.engine.weeklyDigest(ws, new Date('2026-10-12T08:00:00Z')), rows)
  const tb = await k.engine.checks(ws, { problemsOnly: true })
  rows.push(['failing checks', String(tb.filter((c) => c.status === 'fail').length)])

  console.log(`\n${backend} · scale ${scale} · ${years} years`)
  for (const [a, b] of rows) console.log(`  ${a.padEnd(34)} ${b}`)
  if (backend === 'sqlite' && scale >= 1) {
    const ok = overviewMs < TARGETS.overviewMs && incMs < TARGETS.incrementalMs
    console.log(`  targets (overview < ${TARGETS.overviewMs} ms, 500-row sync < ${TARGETS.incrementalMs} ms): ${ok ? 'met' : 'MISSED'}`)
    if (!ok) failed = true
  }
  await k.close()
}
process.exit(failed ? 1 : 0)
