// Scenario accuracy runs (34's "prove accuracy" plan): a scenario's questions, asked through a staging test account's
// MCP with Claude Haiku 5.5, scored to the cent against c6's key. Reuses the benchmark's chat loop, MCP client, judge
// and system prompt unchanged; lives outside scripts/benchmark so the benchmark's freeze hash doesn't move.
//
//   node --env-file=$HOME/meridn/.env.benchmark scripts/scenarios/run.ts --questions <key.json> --key-file <{url,key}.json>
//        [--only id,id] [--label s1] [--budget 2]
//
// Writes docs/scenarios/results/<label>-<time>/{scores.jsonl,transcripts.jsonl,table.md}. Each miss gets a first-pass
// class from the transcript: SERVER? when no tool output contains the key's value, COMBINE? when one does (the AI had
// the right number and still answered wrong), LIMIT when it used all 12 turns without answering. The final class (SERVER, COMBINE or READ) is decided by reading it.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chat, type ModelSpec } from '../benchmark/models.ts'
import { connectMcp } from '../benchmark/mcp.ts'
import { judge, type Expected, type Tolerance } from '../benchmark/score.ts'
import { SYSTEM } from '../benchmark/run.ts'

const ROOT = new URL('../../', import.meta.url).pathname
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
interface Q { id: string; category?: string; question: string; answer: Expected; tolerance?: Tolerance | null; as_of?: string; check?: unknown; app?: boolean; known_issue?: unknown }

const spec: ModelSpec = { provider: 'anthropic', model: 'claude-haiku-5-5' }
const price = { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }
const raw = JSON.parse(readFileSync(arg('questions')!, 'utf8'))
const all: Q[] = Array.isArray(raw) ? raw : raw.questions
const only = arg('only')?.split(',')
// --app: only the questions marked for the apps. Otherwise the scripted set, without app-only ones (check: null) and
// without c6's known_issue ones (reported separately with --only).
const pick = only ? all.filter((q) => only.includes(q.id)) : process.argv.includes('--app') ? all.filter((q) => q.app) : all.filter((q) => q.check !== null && !q.known_issue)
const { url, key } = JSON.parse(readFileSync(arg('key-file')!, 'utf8')) as { url: string; key: string }
const budget = Number(arg('budget') ?? 2)
const asOf = arg('as-of') ?? pick[0]?.as_of ?? new Date().toISOString().slice(0, 10)

/** Ways a value may appear in a tool's output: 1423.18, 1,423.18, $1,423.18, -1423.18 … */
function forms(v: unknown): string[] {
  if (typeof v !== 'number') return [String(v)]
  const a = Math.abs(v), fixed = a.toFixed(2), comma = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return [...new Set([fixed, comma, String(a), a.toLocaleString('en-US')])]
}

const out = join(ROOT, 'docs/scenarios/results', `${arg('label') ?? 'scenario'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
mkdirSync(out, { recursive: true })
const mcp = await connectMcp(url, key)
let spent = 0
const rows: string[] = ['| id | key | answer | verdict | first-pass class | tools | $ |', '|---|---|---|---|---|---|---|']
for (const q of pick) {
  if (spent >= budget) { console.log(`Budget reached ($${spent.toFixed(2)}); stopping.`); break }
  const r = await chat({ spec, system: SYSTEM(asOf), question: q.question, maxTurns: 12, maxOutput: 4096, tools: mcp.tools, callTool: (n, a) => mcp.call(n, a) })
  const usd = (r.usage.input * price.input + r.usage.cachedInput * price.cachedInput + r.usage.cacheWrite * price.cacheWrite + r.usage.output * price.output) / 1e6
  spent += usd
  const { verdict, given } = judge(r.finalText, q.answer, q.tolerance ?? { abs: 0.01 }, r.error)
  const outputs = r.turns.flatMap((t) => t.results ?? []).map((x) => x.output).join('\n')
  const tools = r.turns.flatMap((t) => t.calls ?? []).map((c) => c.name)
  const cls = verdict === 'correct' ? '' : r.error ? (/turn limit/.test(r.error) ? 'LIMIT' : 'ERROR') : forms(q.answer.value).some((f) => outputs.includes(f)) ? 'COMBINE?' : 'SERVER?'
  appendFileSync(join(out, 'scores.jsonl'), JSON.stringify({ id: q.id, category: q.category, verdict, given, expected: q.answer.value, class: cls, tools, usd: Number(usd.toFixed(5)), error: r.error }) + '\n')
  appendFileSync(join(out, 'transcripts.jsonl'), JSON.stringify({ id: q.id, question: q.question, turns: r.turns, finalText: r.finalText, error: r.error }) + '\n')
  rows.push(`| ${q.id} | ${q.answer.value} | ${given ?? '—'} | ${verdict} | ${cls} | ${[...new Set(tools)].join(', ')} | ${usd.toFixed(4)} |`)
  console.log(`${q.id} ${verdict.padEnd(9)} given=${given ?? '-'} want=${q.answer.value} ${cls} $${usd.toFixed(4)} (total $${spent.toFixed(2)})`)
}
writeFileSync(join(out, 'table.md'), rows.join('\n') + '\n')
console.log(`done: ${out} ($${spent.toFixed(2)})`)
process.exit(0)
