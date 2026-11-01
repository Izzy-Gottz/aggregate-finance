// Turns a run's scores.jsonl into results.md and chart.svg (accuracy by model × arm), with confidently-wrong counts,
// per-category accuracy and run-to-run spread. Every number in the write-up comes from this script.
//
//   node scripts/benchmark/summarize.ts docs/benchmark/results/<run>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Row { run: number; model: string; arm: 'A' | 'B'; id: string; category: string; verdict: string; usd: number }

export function summarize(rows: Row[]) {
  const key = (r: Row) => `${r.model}|${r.arm}`
  const groups = new Map<string, Row[]>()
  for (const r of rows) groups.set(key(r), [...(groups.get(key(r)) ?? []), r])
  return [...groups].map(([k, rs]) => {
    const [model, arm] = k.split('|') as [string, 'A' | 'B']
    const runs = [...new Set(rs.map((r) => r.run))]
    const accByRun = runs.map((n) => { const x = rs.filter((r) => r.run === n); return x.filter((r) => r.verdict === 'correct').length / x.length })
    const mean = accByRun.reduce((s, a) => s + a, 0) / accByRun.length
    const count = (v: string) => rs.filter((r) => r.verdict === v).length / runs.length
    const cats = [...new Set(rs.map((r) => r.category))].sort().map((c) => { const x = rs.filter((r) => r.category === c); return { category: c, accuracy: x.filter((r) => r.verdict === 'correct').length / x.length } })
    return { model, arm, n: rs.length / runs.length, runs: runs.length, accuracy: mean, min: Math.min(...accByRun), max: Math.max(...accByRun),
      confidentlyWrong: count('wrong'), abstained: count('abstained'), noAnswer: count('no_answer'), errors: count('error'), usd: rs.reduce((s, r) => s + r.usd, 0), cats }
  }).sort((a, b) => a.model.localeCompare(b.model) || a.arm.localeCompare(b.arm))
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export function chartSvg(s: ReturnType<typeof summarize>): string {
  const models = [...new Set(s.map((x) => x.model))]
  const W = 640, H = 300, left = 48, bottom = 40, top = 24, gw = (W - left - 16) / Math.max(1, models.length), bw = Math.min(56, gw / 3)
  const y = (v: number) => top + (1 - v) * (H - top - bottom)
  const bars = models.flatMap((m, i) => (['A', 'B'] as const).map((arm, j) => {
    const r = s.find((x) => x.model === m && x.arm === arm); if (!r) return ''
    const x = left + i * gw + gw / 2 - bw + j * bw
    return `<rect x="${x}" y="${y(r.accuracy)}" width="${bw - 4}" height="${y(0) - y(r.accuracy)}" fill="${arm === 'A' ? '#b9b4aa' : '#1f1d1a'}"/>` +
      `<text x="${x + (bw - 4) / 2}" y="${y(r.accuracy) - 6}" text-anchor="middle" font-size="12">${Math.round(r.accuracy * 100)}%</text>`
  }))
  const labels = models.map((m, i) => `<text x="${left + i * gw + gw / 2}" y="${H - 16}" text-anchor="middle" font-size="12">${m}</text>`)
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${left}" x2="${W - 16}" y1="${y(v)}" y2="${y(v)}" stroke="#e6e2da"/><text x="${left - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11">${v * 100}%</text>`)
  const legend = `<rect x="${left}" y="4" width="10" height="10" fill="#b9b4aa"/><text x="${left + 14}" y="13" font-size="11">Raw exports</text><rect x="${left + 100}" y="4" width="10" height="10" fill="#1f1d1a"/><text x="${left + 114}" y="13" font-size="11">Connected to Aggregate</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif" fill="#1f1d1a"><rect width="${W}" height="${H}" fill="#faf9f6"/>${grid.join('')}${bars.join('')}${labels.join('')}${legend}</svg>\n`
}

export function resultsMd(s: ReturnType<typeof summarize>, meta: { runId: string; freezeHash: string }): string {
  const lines = [`# Results: ${meta.runId}`, '', `Freeze hash \`${meta.freezeHash}\`. Method: [method.md](../../method.md).`, '', '![Accuracy by model and arm](chart.svg)', '',
    '| Model | Arm | Questions | Runs | Accuracy (min–max) | Confidently wrong | Abstained | No answer | Errors | Cost |', '|---|---|---|---|---|---|---|---|---|---|',
    ...s.map((r) => `| ${r.model} | ${r.arm === 'A' ? 'Raw exports' : 'Aggregate'} | ${r.n} | ${r.runs} | ${pct(r.accuracy)} (${pct(r.min)}–${pct(r.max)}) | ${r.confidentlyWrong} | ${r.abstained} | ${r.noAnswer} | ${r.errors} | $${r.usd.toFixed(2)} |`),
    '', '## By category', '', `| Category | ${s.map((r) => `${r.model} ${r.arm}`).join(' | ')} |`, `|---|${s.map(() => '---').join('|')}|`]
  const cats = [...new Set(s.flatMap((r) => r.cats.map((c) => c.category)))].sort()
  for (const c of cats) lines.push(`| ${c} | ${s.map((r) => { const x = r.cats.find((y) => y.category === c); return x ? pct(x.accuracy) : '–' }).join(' | ')} |`)
  return lines.join('\n') + '\n'
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2]!
  const rows: Row[] = readFileSync(join(dir, 'scores.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
  const s = summarize(rows)
  writeFileSync(join(dir, 'chart.svg'), chartSvg(s)); writeFileSync(join(dir, 'results.md'), resultsMd(s, meta))
  console.log(resultsMd(s, meta))
}
