// The frozen benchmark answers (docs/benchmark/questions.json) must be exactly what the truth script computes from the
// benchmark's events: if the demo generator changes Harbor Coffee, this fails instead of the benchmark silently grading
// against stale answers.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildQuestions } from '../docs/benchmark/truth.ts'

describe('Finance Agent Benchmark truth', () => {
  it('questions.json matches the answers computed from the events', async () => {
    const frozen = JSON.parse(readFileSync(new URL('../docs/benchmark/questions.json', import.meta.url), 'utf8')) as { questions: unknown[] }
    const now = await buildQuestions()
    expect(now).toHaveLength(100)
    expect(new Set(now.map((q) => q.id)).size).toBe(100)
    expect(now).toEqual(frozen.questions)
  }, 120_000)
})
