// Scoring: exact or within-tolerance match of the model's final "ANSWER:" line against the frozen expected answer.
// No partial credit and no model grading. An answer of "unknown" is an abstention, not a confident error.

export type AnswerType = 'number' | 'money' | 'count' | 'percent' | 'date' | 'text' | 'list'
export interface Expected { type: AnswerType; value: number | string | string[]; aliases?: string[] }
export interface Tolerance { abs?: number; rel?: number }
export type Verdict = 'correct' | 'wrong' | 'abstained' | 'no_answer' | 'error'

/** The last "ANSWER:" line in the reply, or null when there is none. */
export function extractAnswer(reply: string): string | null {
  const m = [...reply.matchAll(/^\s*\**\s*ANSWER\s*\**\s*:\s*\**\s*(.+?)\s*\**\s*$/gim)]
  return m.length ? m[m.length - 1]![1]!.trim() : null
}

export function parseNumber(s: string): number | null {
  let t = s.trim().replace(/[`*]/g, '').replace(/\b(USD|dollars?)\b/gi, '').replace(/[$€£,\s]/g, '')
  let neg = false
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1) }
  if (t.startsWith('-') || t.startsWith('−')) { neg = !neg; t = t.slice(1) }
  const m = t.match(/^(\d+(?:\.\d+)?)(%|k|m)?$/i)
  if (!m) return null
  const mult = { k: 1e3, m: 1e6, '%': 1 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | '%'] ?? 1
  const n = Number(m[1]) * mult
  return neg ? -n : n
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim()

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
/** "2026-08", "August 2026", "Aug 2026" and "08/2026" all as "2026-08"; null when the text isn't one month. (v3) */
export function monthKey(s: string): string | null {
  const t = s.replace(/[`*]/g, '').trim().toLowerCase()
  let m = t.match(/^(\d{4})-(\d{1,2})$/) ?? null
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]!.padStart(2, '0')}` : null
  m = t.match(/^(\d{1,2})\/(\d{4})$/)
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${m[1]!.padStart(2, '0')}` : null
  m = t.match(/^([a-z]+)\.?,?\s+(\d{4})$/)
  if (!m) return null
  const i = MONTHS.findIndex((name) => name === m![1] || (m![1]!.length >= 3 && name.startsWith(m![1]!)))
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`
}

export function judge(reply: string, expected: Expected, tol: Tolerance = {}, error?: string): { verdict: Verdict; given: string | null } {
  if (error) return { verdict: 'error', given: null }
  const given = extractAnswer(reply)
  if (given === null) return { verdict: 'no_answer', given }
  if (/^(unknown|n\/?a|cannot (be )?determine|not enough (data|information))\b/i.test(given)) return { verdict: 'abstained', given }
  return { verdict: matches(given, expected, tol) ? 'correct' : 'wrong', given }
}

export function matches(given: string, e: Expected, tol: Tolerance): boolean {
  switch (e.type) {
    case 'number':
    case 'count':
    case 'percent':
    case 'money': {
      const n = parseNumber(given), want = Number(e.value)
      if (n === null) return false
      const slack = Math.max(tol.abs ?? (e.type === 'money' ? 0.005 : 0), (tol.rel ?? 0) * Math.abs(want))
      return Math.abs(n - want) <= slack + 1e-9
    }
    case 'date': return given.replace(/[`*]/g, '').trim().slice(0, 10) === String(e.value)
    case 'text': {
      const month = monthKey(given)
      return [String(e.value), ...(e.aliases ?? [])].some((v) => norm(v) === norm(given) || (month !== null && monthKey(v) === month))
    }
    case 'list': {
      const want = new Set((e.value as string[]).map(norm)), got = new Set(given.split(/[;,]|\band\b/).map(norm).filter(Boolean))
      return want.size === got.size && [...want].every((w) => got.has(w))
    }
  }
}
