// Review items say what Confirm does, offer only answers that can apply, and write dates like the app.
import { describe, expect, it } from 'vitest'
import { shortDate, whoseMoneyChoices } from './review.ts'

const kinds = (cs: Array<{ edits: Record<string, string> }>) => cs.map((c) => c.edits.kind)

describe('review labels', () => {
  it('dates read like the app', () => {
    expect(shortDate('2026-10-03', '2026')).toBe('Oct 3')
    expect(shortDate('2025-12-31', '2026')).toBe('Dec 31, 2025')
  })

  it('answers to "What is this money?" are only ones the ledger accepts for that record', () => {
    // Money into a company, one Personal space, two companies: everything.
    expect(kinds(whoseMoneyChoices({ owner: false, inflow: true, company: true, ownerSpace: true, companies: 2 }))).toEqual(['revenue', 'refund', 'owner_loan', 'owner_contribution', 'transfer', 'intercompany', 'other'])
    // Money out: never revenue, a refund or owner money in.
    expect(kinds(whoseMoneyChoices({ owner: false, inflow: false, company: true, ownerSpace: true, companies: 2 }))).toEqual(['transfer', 'intercompany', 'other'])
    // No single Personal space to owe it to: no owner answers. One company: no "between my companies".
    expect(kinds(whoseMoneyChoices({ owner: false, inflow: true, company: true, ownerSpace: false, companies: 1 }))).toEqual(['revenue', 'refund', 'transfer', 'other'])
    // Into Personal itself: not revenue.
    expect(kinds(whoseMoneyChoices({ owner: false, inflow: true, company: false, ownerSpace: true, companies: 1 }))).toEqual(['transfer', 'other'])
    // "A loan or an investment?": just those two, when they can apply.
    expect(kinds(whoseMoneyChoices({ owner: true, inflow: true, company: true, ownerSpace: true, companies: 1 }))).toEqual(['owner_loan', 'owner_contribution'])
    expect(whoseMoneyChoices({ owner: true, inflow: true, company: true, ownerSpace: false, companies: 1 })).toEqual([])
  })
})
