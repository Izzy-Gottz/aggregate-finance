// Re-judges a finished run from its own transcripts with the current score.ts, without asking any model again.
// Used once, openly: the first frozen scorer had no 'count' or 'percent' case, so those 20 questions could never be
// marked correct (method.md, "Freeze"). The original file is kept as scores.original.jsonl next to the new one.
//
//   node scripts/benchmark/rescore.ts docs/benchmark/results/<run>
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { judge, type Expected, type Tolerance } from './score.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: rescore.ts <run dir>')
const DOCS = new URL('../../docs/benchmark/', import.meta.url).pathname
const raw = JSON.parse(readFileSync(join(DOCS, 'questions.json'), 'utf8'))
const questions = new Map<string, { answer: Expected; tolerance?: Tolerance }>((Array.isArray(raw) ? raw : raw.questions).map((q: { id: string }) => [q.id, q]))

// The final text of every answer, by (run, model, arm, id), from the transcripts.
const finals = new Map<string, { finalText: string; error?: string }>()
for (const f of readdirSync(dir).filter((f) => f.startsWith('transcripts-') && f.endsWith('.jsonl'))) {
  const [, model, arm] = f.match(/^transcripts-(.+)-([AB])\.jsonl$/) ?? []
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean)) {
    const t = JSON.parse(line) as { run: number; id: string; finalText: string; error?: string }
    finals.set(`${t.run}|${model}|${arm}|${t.id}`, t)
  }
}

const original = join(dir, 'scores.original.jsonl')
if (!existsSync(original)) copyFileSync(join(dir, 'scores.jsonl'), original)
let changed = 0
const rows = readFileSync(original, 'utf8').split('\n').filter(Boolean).map((line) => {
  const r = JSON.parse(line)
  const t = finals.get(`${r.run}|${r.model}|${r.arm}|${r.id}`), q = questions.get(r.id)
  if (!t || !q) throw new Error(`no transcript or question for ${r.id}`)
  const { verdict, given } = judge(t.finalText, q.answer, q.tolerance, t.error)
  if (verdict !== r.verdict) changed++
  return { ...r, verdict, given }
})
writeFileSync(join(dir, 'scores.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`re-scored ${rows.length} answers in ${dir}: ${changed} verdicts changed (original kept as scores.original.jsonl)`)
