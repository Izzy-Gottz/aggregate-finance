// The "real app" pass without anyone's Claude account (8a's recipe): the Messages API with the MCP connector, so
// Anthropic's servers call the scenario's staging MCP the way claude.ai does, with a read-only key that belongs only
// to the test. Asks the questions marked "app" and scores them like run.ts.
//
//   node --env-file=$HOME/meridn/.env.benchmark scripts/scenarios/claude.ts --questions <key.json> --key-file <{url,key}.json>
//        [--model claude-sonnet-5-5] [--label s2-claude] [--budget 3] [--only id,id]
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { judge, type Expected, type Tolerance } from '../benchmark/score.ts'
import { SYSTEM } from '../benchmark/run.ts'

const ROOT = new URL('../../', import.meta.url).pathname
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
interface Q { id: string; question: string; answer: Expected; tolerance?: Tolerance | null; as_of?: string; app?: boolean }

const model = arg('model') ?? 'claude-sonnet-5-5'
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}
const price = PRICES[model] ?? (() => { throw new Error(`no price for ${model}`) })()
const raw = JSON.parse(readFileSync(arg('questions')!, 'utf8'))
const all: Q[] = Array.isArray(raw) ? raw : raw.questions
const only = arg('only')?.split(',')
const pick = only ? all.filter((q) => only.includes(q.id)) : all.filter((q) => q.app)
const { url, key } = JSON.parse(readFileSync(arg('key-file')!, 'utf8')) as { url: string; key: string }
const budget = Number(arg('budget') ?? 3)
const asOf = arg('as-of') ?? pick[0]?.as_of ?? new Date().toISOString().slice(0, 10)
const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')

// A cold staging machine would make the first question pay the start-up (8a's note 4).
await fetch(new URL('/healthz', url)).catch(() => {})

const out = join(ROOT, 'docs/scenarios/results', `${arg('label') ?? 'claude'}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
mkdirSync(out, { recursive: true })
let spent = 0
const rows = ['| id | key | answer | verdict | tools | $ |', '|---|---|---|---|---|---|']
for (const q of pick) {
  if (spent >= budget) { console.log(`Budget reached ($${spent.toFixed(2)}); stopping.`); break }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'mcp-client-2025-04-04' },
    body: JSON.stringify({ model, max_tokens: 4096, system: SYSTEM(asOf), messages: [{ role: 'user', content: q.question }],
      mcp_servers: [{ type: 'url', url, name: 'aggregate', ...(key ? { authorization_token: key } : {}) }] }),
  })
  const d: any = await r.json()
  const u = d.usage ?? {}
  const usd = ((u.input_tokens ?? 0) * price.input + (u.output_tokens ?? 0) * price.output + (u.cache_read_input_tokens ?? 0) * price.cacheRead + (u.cache_creation_input_tokens ?? 0) * price.cacheWrite) / 1e6
  spent += usd
  const blocks: any[] = d.content ?? []
  const finalText = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const tools = blocks.filter((b) => b.type === 'mcp_tool_use').map((b) => b.name)
  const error = r.ok ? (d.stop_reason === 'max_tokens' ? 'max_tokens' : undefined) : `${r.status} ${JSON.stringify(d.error ?? d).slice(0, 200)}`
  const { verdict, given } = judge(finalText, q.answer, q.tolerance ?? { abs: 0.01 }, error)
  appendFileSync(join(out, 'scores.jsonl'), JSON.stringify({ id: q.id, model, verdict, given, expected: q.answer.value, tools, usd: Number(usd.toFixed(5)), error }) + '\n')
  appendFileSync(join(out, 'transcripts.jsonl'), JSON.stringify({ id: q.id, question: q.question, content: blocks, error }) + '\n')
  rows.push(`| ${q.id} | ${q.answer.value} | ${given ?? '—'} | ${verdict} | ${[...new Set(tools)].join(', ')} | ${usd.toFixed(4)} |`)
  console.log(`${q.id} ${verdict.padEnd(9)} given=${given ?? '-'} want=${q.answer.value} $${usd.toFixed(4)} (total $${spent.toFixed(2)})${error ? ' ' + error.slice(0, 80) : ''}`)
}
writeFileSync(join(out, 'table.md'), rows.join('\n') + '\n')
console.log(`done: ${out} ($${spent.toFixed(2)})`)
process.exit(0)
