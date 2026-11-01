// The benchmark's one event stream: Harbor Coffee from the demo connector, fixed seed and dates, synced to the end at
// as_of. Arm A's exports and arm B's ledger both start from exactly these events; the truth is computed from them too.
import type { NormalizedEvent } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { createDemoConnector } from '@agfn/connector-demo'

export const BENCHMARK = {
  profile: 'harbor',
  seed: 'aggregate-bench-v1',
  start: '2024-10-01',
  glass: '2024-10-01',
  asOf: '2026-09-30',
  /** The clock the sync runs at: mid-afternoon UTC on as_of, after the day's rows (they sit 13:00–19:00Z). */
  clock: '2026-09-30T22:00:00.000Z',
} as const

export async function benchmarkEvents(): Promise<NormalizedEvent[]> {
  const at = Date.parse(BENCHMARK.clock)
  const connector = createDemoConnector({ raw: new MemoryRawSink(), clock: { now: () => at, sleep: async () => {} } })
  const conn = { id: 'conn_bench_harbor', workspaceId: 'ws_bench', connectorKey: 'demo', secret: { demo: true }, config: { profile: BENCHMARK.profile, start: BENCHMARK.start, seed: BENCHMARK.seed, glass: BENCHMARK.glass } }
  return (await runSync(connector, conn, null)).events
}
