import { describe, expect, it } from 'vitest'
import { PROMPTS, promptsFor } from './prompts.ts'
import { ALL_TOOLS } from './service.ts'

const only = (...names: string[]) => ALL_TOOLS.filter((t) => names.includes(t.name))

describe('prompts follow the connection', () => {
  it('a balances-only connection gets no workflow that needs data it cannot see', () => {
    expect(promptsFor(only('whoami', 'list_accounts', 'get_metric')).map((p) => p.name)).toEqual([])
    expect(promptsFor(only('get_overview')).map((p) => p.name)).toEqual(['what_changed'])
  })

  it('steps are renumbered around tools the connection lacks', () => {
    const close = PROMPTS.find((p) => p.name === 'monthly_close')!
    const has = (n: string) => ['get_reports', 'get_metric'].includes(n)
    const text = close.build({ month: '2026-09' }, has, '2026-10-10')
    expect(text).toMatch(/\n1\. get_metric data_health/)
    expect(text).toMatch(/\n2\. get_reports profit_and_loss/)
    expect(text).toMatch(/\n3\. get_metric cash/)
    expect(text).not.toMatch(/get_coverage|list_review_items|query_transactions/)
    expect(close.build({}, has, '2026-01-05')).toContain('close 2025-12')
  })
})
