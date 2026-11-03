import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { connectionsBody } from './docs-shell.ts'
import { groupCounts, INSTITUTION_GROUPS, INSTITUTIONS_JS, institutionsBody, loadInstitutions, orderHits } from './docs-institutions.ts'

describe('Banks and institutions', () => {
  it('the data file holds names, one group flag per name and its date, nothing else', () => {
    const raw = JSON.parse(readFileSync(new URL('../../../docs/institutions.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw).sort()).toEqual(['flags', 'generated', 'names'])
    const list = loadInstitutions()!
    expect(list.names.length).toBeGreaterThan(9_000)
    expect(new Set(list.names).size).toBe(list.names.length)
    expect(list.names.every((n) => typeof n === 'string' && n.length > 0 && !n.startsWith('ins_'))).toBe(true)
    expect(list.flags).toMatch(/^[0-9a-f]+$/)
    expect(list.flags.length).toBe(list.names.length)
    const [banks, brokerages, loans, crypto] = groupCounts(list)
    expect(banks).toBeGreaterThan(5_000)
    expect(brokerages).toBeGreaterThan(2_000)
    expect(loans).toBeGreaterThan(2_000)
    expect(list.names.filter((_, i) => parseInt(list.flags[i]!, 16) & 8)).toContain('Coinbase Crypto')
    expect(crypto).toBeLessThan(20)
  })

  it('says supported by Plaid, and that listing is no endorsement', () => {
    const body = institutionsBody({ generated: '2026-10-16', names: Array.from({ length: 1_234 }, (_, i) => `Bank ${i}`), flags: '1'.repeat(1_230) + '8888' })
    expect(body).toContain('Through Plaid, Aggregate can connect to thousands of US banks and financial institutions.')
    expect(body).toContain('Search over 1,200 US institutions supported by Plaid')
    expect(body).toContain('Banks and credit unions <span>over 1,200</span>')
    expect(body).toContain('Crypto exchanges <span>4</span>')
    expect(body).toContain('Brokerages and retirement <span>0</span>')
    expect(INSTITUTION_GROUPS).toHaveLength(4)
    expect(body).not.toMatch(/every (US )?bank|all banks/i)
    expect(body).toContain('October 16, 2026')
    expect(body).toContain('Being listed doesn’t mean an institution endorses Aggregate')
    expect(body).not.toMatch(/<img|connects today|Works with/i)
  })

  it('puts the obvious names first in a group, A–Z within each tier, without changing who is in it', () => {
    const list = loadInstitutions()!
    const [, brokerages, loans] = INSTITUTION_GROUPS
    const inGroup = (bit: number) => list.names.filter((_, i) => parseInt(list.flags[i]!, 16) & bit)
    const b = orderHits(inGroup(2), '', brokerages)
    expect(b).toHaveLength(inGroup(2).length)
    expect(b.slice(0, brokerages!.top!.length)).toEqual(brokerages!.top)
    expect(b.slice(0, 3)).toEqual(['Fidelity', 'Charles Schwab', 'Vanguard'])
    const rest = b.slice(brokerages!.top!.length, brokerages!.top!.length + 20)
    expect(rest.every((n) => new RegExp(brokerages!.lead!, 'i').test(n))).toBe(true)
    expect(rest[0]!.localeCompare(rest[1]!, 'en', { sensitivity: 'base' })).toBeLessThanOrEqual(0)
    const banks = INSTITUTION_GROUPS[0]!
    expect(orderHits(inGroup(1), '', banks).slice(0, 4)).toEqual(['Chase', 'Bank of America', 'Wells Fargo', 'Citibank Online'])
    // Every top name is in Plaid's file, in that group, once.
    for (const g of INSTITUTION_GROUPS) {
      const members = new Set(inGroup(g.bit))
      for (const n of g.top ?? []) expect(members.has(n), `${g.label}: ${n}`).toBe(true)
      expect(new Set(g.top ?? []).size).toBe((g.top ?? []).length)
    }
    // The query still comes first: "van" starts Vanguard and others before any top name that doesn't start with it.
    expect(orderHits(inGroup(2), 'van', brokerages)[0]).toBe('Vanguard')
    const l = orderHits(inGroup(4), '', loans)
    expect(l.slice(0, 20).some((n) => /credit union/i.test(n))).toBe(false)
    expect(l.slice(0, 40)).toContain('American Express')
    expect(orderHits(['Acme Investments', 'Zeta Bank', 'Zed Securities'], 'ze', brokerages)).toEqual(['Zed Securities', 'Zeta Bank', 'Acme Investments'])
    for (const g of INSTITUTION_GROUPS) if (g.lead) expect(() => new RegExp(g.lead!, 'i')).not.toThrow()
    expect(INSTITUTIONS_JS).toContain('j.groups')
  })

  it('without the data file the section just isn’t there', () => {
    expect(institutionsBody(loadInstitutions(new URL('file:///nonexistent/institutions.json')))).toBe('')
    expect(connectionsBody('intro\n## Banks\n\n## Everything else\n', (m) => m, {})).not.toContain('data-institutions')
  })
})
