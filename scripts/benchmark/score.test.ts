import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { extractAnswer, judge, matches, parseNumber } from './score.ts'
import { chartSvg, summarize } from './summarize.ts'

describe('benchmark scoring', () => {
  it('takes the last ANSWER line, with or without markdown', () => {
    expect(extractAnswer('First ANSWER: 1\nthen\nANSWER: 2')).toBe('2')
    expect(extractAnswer('**ANSWER:** 12,345.67')).toBe('12,345.67')
    expect(extractAnswer('The answer is 5')).toBeNull()
  })
  it('reads money the way models write it', () => {
    expect(parseNumber('$12,345.67')).toBe(12345.67)
    expect(parseNumber('(800.00)')).toBe(-800)
    expect(parseNumber('-1,200 USD')).toBe(-1200)
    expect(parseNumber('1.5m')).toBe(1_500_000)
    expect(parseNumber('about 5')).toBeNull()
  })
  it('money is exact to the cent unless a tolerance is set', () => {
    const e = { type: 'money' as const, value: 1000.5 }
    expect(judge('ANSWER: 1000.50', e).verdict).toBe('correct')
    expect(judge('ANSWER: 1000.51', e).verdict).toBe('wrong')
    expect(judge('ANSWER: 1010', e, { rel: 0.01 }).verdict).toBe('correct')
    expect(judge('ANSWER: 1011', e, { rel: 0.01 }).verdict).toBe('wrong')
  })
  it('separates abstentions, missing answers and harness errors from wrong answers', () => {
    const e = { type: 'number' as const, value: 3 }
    expect(judge('ANSWER: unknown', e).verdict).toBe('abstained')
    expect(judge('no idea', e).verdict).toBe('no_answer')
    expect(judge('', e, {}, '500 overloaded').verdict).toBe('error')
  })
  it('counts are exact and percents use their tolerance', () => {
    expect(judge('ANSWER: 365', { type: 'count', value: 365 }).verdict).toBe('correct')
    expect(judge('ANSWER: 364', { type: 'count', value: 365 }).verdict).toBe('wrong')
    expect(judge('ANSWER: 2.24%', { type: 'percent', value: 2.24 }, { abs: 0.1 }).verdict).toBe('correct')
    expect(judge('ANSWER: 2.4', { type: 'percent', value: 2.24 }, { abs: 0.1 }).verdict).toBe('wrong')
  })

  it('every answer type in questions.json can be scored', () => {
    const qs = JSON.parse(readFileSync(new URL('../../docs/benchmark/questions.json', import.meta.url), 'utf8'))
    for (const q of Array.isArray(qs) ? qs : qs.questions) expect(matches(String(q.answer.value), q.answer, q.tolerance ?? {}), q.id).toBe(true)
  })

  it('dates, text with aliases, and unordered lists', () => {
    expect(judge('ANSWER: 2026-03-31', { type: 'date', value: '2026-03-31' }).verdict).toBe('correct')
    expect(judge('ANSWER: Lumen Health Inc.', { type: 'text', value: 'Lumen Health', aliases: ['Lumen Health Inc'] }).verdict).toBe('correct')
    expect(judge('ANSWER: Ferris & Co, Lumen Health', { type: 'list', value: ['Lumen Health', 'Ferris & Co'] }).verdict).toBe('correct')
    expect(judge('ANSWER: Lumen Health', { type: 'list', value: ['Lumen Health', 'Ferris & Co'] }).verdict).toBe('wrong')
  })

  it('a month answer matches in any common format (v3)', () => {
    const aug = { type: 'text' as const, value: 'August 2026' }
    for (const a of ['2026-08', 'August 2026', 'Aug 2026', 'aug. 2026', '08/2026', '**2026-08**']) expect(judge(`ANSWER: ${a}`, aug).verdict, a).toBe('correct')
    for (const a of ['2026-09', 'August 2025', 'Augustus 2026', '2026-13']) expect(judge(`ANSWER: ${a}`, aug).verdict, a).toBe('wrong')
    expect(judge('ANSWER: August 2026', { type: 'text', value: '2026-08' }).verdict).toBe('correct')
  })
})

describe('benchmark summary', () => {
  it('averages accuracy across runs and counts confident errors per run', () => {
    const rows = [1, 2].flatMap((run) => ['q1', 'q2'].map((id) => ({ run, model: 'm', arm: 'B' as const, id, category: 'cash', verdict: run === 1 || id === 'q1' ? 'correct' : 'wrong', usd: 0.01 })))
    const [s] = summarize(rows)
    expect(s).toMatchObject({ accuracy: 0.75, min: 0.5, max: 1, confidentlyWrong: 0.5, runs: 2, n: 2 })
    expect(chartSvg([s!])).toContain('75%')
  })
})
