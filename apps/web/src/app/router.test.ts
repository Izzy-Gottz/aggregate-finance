import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from './router.ts'

describe('router', () => {
  it('parses pages, steps and drawer stacks', () => {
    expect(parseHash('')).toEqual({ page: 'workspace', step: 0, stack: [], params: {} })
    expect(parseHash('#/review').page).toBe('review')
    expect(parseHash('#/welcome/3')).toMatchObject({ page: 'welcome', step: 3 })
    expect(parseHash('#/welcome/99').step).toBe(4)
    expect(parseHash('#/?d=company:e_acme/bucket:b_rent').stack).toEqual([
      { kind: 'company', id: 'e_acme' },
      { kind: 'bucket', id: 'b_rent' },
    ])
  })
  it('round-trips every view kind', () => {
    const hashes = ['#/?d=company:e_acme/explain:e_acme:cash', '#/?d=add:cash', '#/?d=connect/connect:plaid', '#/preferences?d=invite', '#/?d=connect-ai', '#/?d=ai:g_claude', '#/welcome/2']
    for (const h of hashes) expect(formatHash(parseHash(h))).toBe(h)
  })
  it('drops anything it does not understand (links are untrusted)', () => {
    expect(parseHash('#/?d=company:<script>/nope:1/add:rm').stack).toEqual([])
    expect(parseHash('#/admin').page).toBe('workspace')
    expect(parseHash('#/?d=explain:e_acme:everything').stack).toEqual([])
  })
  it('handles the OAuth consent page and keeps its params', () => {
    const r = parseHash('#/connect-ai/consent?client_id=claude&scope=read&consent_code=x1')
    expect(r.page).toBe('consent')
    expect(r.params).toEqual({ client_id: 'claude', scope: 'read', consent_code: 'x1' })
    expect(formatHash(r)).toBe('#/connect-ai/consent?client_id=claude&scope=read&consent_code=x1')
  })
})
