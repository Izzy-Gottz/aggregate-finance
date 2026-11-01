// Finance Agent Benchmark runner. See docs/benchmark/method.md.
//
//   node --env-file=.env.benchmark scripts/benchmark/run.ts --arms A,B --runs 1 [--only q001,q002] [--estimate] [--pilot]
//
// A scored run refuses to start unless docs/benchmark/FROZEN holds the sha256 of the questions, the method and this
// harness (scripts/benchmark/*.ts), so nothing can change after the first scored answer. --pilot runs without the
// freeze, writes to results/pilot-*, and is never published as a result. Spending stops at BENCH_BUDGET_USD.
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chat, type ModelSpec, type Usage } from './models.ts'
import { connectMcp, type McpSession } from './mcp.ts'
import { judge, type Expected, type Tolerance } from './score.ts'
import { openSandbox, RUN_PYTHON, sandboxVersions } from './sandbox.ts'

const ROOT = new URL('../../', import.meta.url).pathname
const DOCS = join(ROOT, 'docs/benchmark')
const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const flag = (k: string) => process.argv.includes(`--${k}`)

interface Question { id: string; category: string; question: string; answer: Expected; tolerance?: Tolerance; as_of: string }
interface Config { as_of: string; models: Array<ModelSpec & { label: string; price: { input: number; cachedInput: number; cacheWrite: number; output: number } }> }

const questions: Question[] = JSON.parse(readFileSync(join(DOCS, 'questions.json'), 'utf8')).questions
const config: Config = JSON.parse(readFileSync(join(DOCS, 'config.json'), 'utf8'))
const arms = (arg('arms') ?? 'A,B').split(',') as Array<'A' | 'B'>
const runs = Number(arg('runs') ?? 1)
const only = arg('only')?.split(',')
const pick = only ? questions.filter((q) => only.includes(q.id)) : questions
const budget = Number(process.env.BENCH_BUDGET_USD ?? 50)

export function freezeHash(): string {
  const h = createHash('sha256')
  for (const f of ['docs/benchmark/questions.json', 'docs/benchmark/method.md', 'docs/benchmark/config.json',
    ...readdirSync(join(ROOT, 'scripts/benchmark')).filter((f) => f.endsWith('.ts')).sort().map((f) => `scripts/benchmark/${f}`),
    ...readdirSync(join(DOCS, 'exports')).sort().map((f) => `docs/benchmark/exports/${f}`)]) {
    h.update(f + '\0' + readFileSync(join(ROOT, f)) + '\0')
  }
  return h.digest('hex')
}

export const SYSTEM = (asOf: string) => [
  `You are a careful financial analyst for one company. Today is ${asOf}. Use only the data you are given or can retrieve with your tools; never guess numbers.`,
  'Amounts are in US dollars. Answer the question, briefly show how you got it, then end with exactly one line:',
  'ANSWER: <value>',
  'Write money and numbers as plain numbers without currency symbols or thousands separators (for example 12345.67 or -800), dates as YYYY-MM-DD, and lists as comma-separated values.',
  'If the data cannot answer the question, end with "ANSWER: unknown".',
].join('\n')

/** Arm A's prompt: the uploaded files by name, with their size and first lines, as a chat app with a code tool shows
 *  them. The model reads the rest with run_python. */
function armAContext(): string {
  const dir = join(DOCS, 'exports')
  const files = readdirSync(dir).sort()
  return ['The company\'s exported files are uploaded to /data, exactly as each provider produces them. Use run_python to read them.', '',
    ...files.map((f) => { const t = readFileSync(join(dir, f), 'utf8'), lines = t.split('\n'); return `/data/${f} (${lines.length - 1} lines). First lines:\n${lines.slice(0, 3).join('\n')}\n` })].join('\n')
}

const cost = (u: Usage, p: Config['models'][number]['price']) => (u.input * p.input + u.cachedInput * p.cachedInput + u.cacheWrite * p.cacheWrite + u.output * p.output) / 1e6

async function main() {
  const pilot = flag('pilot'), estimate = flag('estimate')
  const hash = freezeHash()
  if (!pilot && !estimate) {
    const frozen = existsSync(join(DOCS, 'FROZEN')) ? readFileSync(join(DOCS, 'FROZEN'), 'utf8').trim() : ''
    if (frozen !== hash) throw new Error(`Not frozen: docs/benchmark/FROZEN is "${frozen.slice(0, 12)}…", the files hash to ${hash.slice(0, 12)}…. Freeze (commit FROZEN) before a scored run, or use --pilot.`)
  }
  const context = arms.includes('A') ? armAContext() : ''
  if (estimate) {
    // Characters / 4 is a rough token count; the real figure comes from the first pilot calls.
    const ctxTok = Math.round(context.length / 4)
    for (const m of config.models) {
      const perQ = { A: 6 * (ctxTok + 4_000) * m.price.input / 1e6 * 0.5 + 6 * 500 * m.price.output / 1e6, B: 6 * 12_000 * m.price.input / 1e6 * 0.5 + 6 * 400 * m.price.output / 1e6 }
      const total = arms.reduce((s, a) => s + perQ[a] * pick.length * runs, 0) + (arms.includes('A') ? ctxTok * m.price.cacheWrite / 1e6 : 0)
      console.log(`${m.label}: context ≈ ${ctxTok} tokens; ≈ $${total.toFixed(2)} for ${pick.length} questions × ${runs} run(s) × arms ${arms.join('+')}`)
    }
    return
  }
  const runId = `${pilot ? 'pilot-' : ''}${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  const out = join(DOCS, 'results', runId); mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'run.json'), JSON.stringify({ runId, freezeHash: hash, pilot, arms, runs, ...(arms.includes('A') ? { sandbox: sandboxVersions() } : {}), questions: pick.map((q) => q.id), models: config.models.map((m) => m.label), startedAt: new Date().toISOString() }, null, 2))
  let mcp: McpSession | null = null
  if (arms.includes('B')) {
    // serve.ts writes { url, key } to BENCH_KEY_FILE (0600); BENCH_MCP_URL/BENCH_MCP_KEY still work for another server.
    const file = process.env.BENCH_KEY_FILE ? (JSON.parse(readFileSync(process.env.BENCH_KEY_FILE, 'utf8')) as { url: string; key: string }) : null
    mcp = await connectMcp(process.env.BENCH_MCP_URL ?? file?.url ?? 'http://localhost:8890/mcp', process.env.BENCH_MCP_KEY ?? file?.key ?? '')
  }
  let spent = 0
  for (let run = 1; run <= runs; run++) {
    for (const m of config.models) {
      for (const arm of arms) {
        for (const q of pick) {
          if (spent >= budget) { console.log(`Budget reached ($${spent.toFixed(2)}); stopping.`); return finish(out, spent) }
          const t0 = Date.now()
          // Both arms: the same prompt, the same 12-turn and output limits; only the tools differ.
          const box = arm === 'A' ? openSandbox(join(DOCS, 'exports')) : null
          const r = await chat({ spec: m, system: SYSTEM(config.as_of), context: arm === 'A' ? context : undefined, question: q.question, maxTurns: 12, maxOutput: 4096,
            ...(arm === 'A' && box ? { tools: [RUN_PYTHON], callTool: async (_n: string, a: any) => box.run(String(a?.code ?? '')) } : {}),
            ...(arm === 'B' && mcp ? { tools: mcp.tools, callTool: (n: string, a: unknown) => mcp!.call(n, a) } : {}) }).finally(() => box?.close())
          const usd = cost(r.usage, m.price); spent += usd
          const { verdict, given } = judge(r.finalText, q.answer, q.tolerance, r.error)
          const row = { run, model: m.label, arm, id: q.id, category: q.category, verdict, given, expected: q.answer.value, usd: Number(usd.toFixed(5)), ms: Date.now() - t0, usage: r.usage, error: r.error }
          appendFileSync(join(out, 'scores.jsonl'), JSON.stringify(row) + '\n')
          appendFileSync(join(out, `transcripts-${m.label}-${arm}.jsonl`), JSON.stringify({ run, id: q.id, question: q.question, turns: r.turns, finalText: r.finalText, error: r.error }) + '\n')
          console.log(`${run} ${m.label} ${arm} ${q.id} ${verdict.padEnd(9)} given=${given ?? '-'} want=${q.answer.value} $${usd.toFixed(4)} (total $${spent.toFixed(2)})`)
        }
      }
    }
  }
  finish(out, spent)
}

function finish(out: string, spent: number) {
  const meta = JSON.parse(readFileSync(join(out, 'run.json'), 'utf8'))
  writeFileSync(join(out, 'run.json'), JSON.stringify({ ...meta, finishedAt: new Date().toISOString(), spentUsd: Number(spent.toFixed(2)) }, null, 2))
  console.log(`done: ${out} ($${spent.toFixed(2)})`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
