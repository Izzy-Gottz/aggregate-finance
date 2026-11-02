import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { connectionsBody } from './docs-shell.ts'
import { institutionsBody, loadInstitutions } from './docs-institutions.ts'

describe('Find your institution', () => {
  it('the data file holds names and its date, nothing else', () => {
    const raw = JSON.parse(readFileSync(new URL('../../../docs/institutions.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['generated', 'names'])
    const list = loadInstitutions()!
    expect(list.names.length).toBeGreaterThan(9_000)
    expect(new Set(list.names).size).toBe(list.names.length)
    expect(list.names.every((n) => typeof n === 'string' && n.length > 0 && !n.startsWith('ins_'))).toBe(true)
  })

  it('says supported by Plaid, and that listing is no endorsement', () => {
    const body = institutionsBody({ generated: '2026-10-16', names: Array.from({ length: 1_234 }, (_, i) => `Bank ${i}`) })
    expect(body).toContain('over 1,200 US institutions supported by Plaid')
    expect(body).toContain('October 16, 2026')
    expect(body).toContain('Being listed doesn’t mean an institution endorses Aggregate')
    expect(body).not.toMatch(/<img|connects today|Works with/i)
  })

  it('without the data file the section just isn’t there', () => {
    expect(institutionsBody(loadInstitutions(new URL('file:///nonexistent/institutions.json')))).toBe('')
    expect(connectionsBody('intro\n## Banks\n\n## Everything else\n', (m) => m, {})).not.toContain('data-institutions')
  })
})
