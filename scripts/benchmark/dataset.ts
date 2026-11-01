// Arm A's files: renders the benchmark's one event stream (docs/benchmark/events.ts, the same events arm B imports and
// truth.ts answers from) as provider exports in docs/benchmark/exports.
//
//   node scripts/benchmark/dataset.ts
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROFILES } from '../../packages/connectors/demo/src/index.ts'
import { BENCHMARK, benchmarkEvents } from '../../docs/benchmark/events.ts'
import { renderExports } from './exports.ts'

const DOCS = new URL('../../docs/benchmark/', import.meta.url).pathname

if (import.meta.url === `file://${process.argv[1]}`) {
  const ev = await benchmarkEvents()
  const dir = join(DOCS, 'exports'); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true })
  let chars = 0
  for (const f of renderExports(PROFILES[BENCHMARK.profile], ev, BENCHMARK.asOf)) { writeFileSync(join(dir, f.name), f.body); chars += f.body.length; console.log(f.name, f.body.split('\n').length - 1, 'lines') }
  console.log(`${ev.length} events → ${chars} characters (≈ ${Math.round(chars / 4)} tokens)`)
}
