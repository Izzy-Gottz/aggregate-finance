// Harbor Coffee's extras for "Ask your books": the Bean Club moves every month, and the card has real terms.
import { describe, expect, it } from 'vitest'
import { beanMembers, beanPlanAt, hcCardTerms } from './harbor-extras.ts'

const ctx = { seed: 'aggregate-demo-v1', start: '2024-10-01' }

describe('Harbor Coffee extras', () => {
  it('the Bean Club has members joining every month, one upgrading from the second month and one leaving from the third', () => {
    const members = beanMembers(ctx)
    const months = ['2024-11', '2025-03', '2025-12', '2026-09']
    for (const m of months) {
      expect(members.filter((x) => x.joined.startsWith(m)).length, `joins ${m}`).toBeGreaterThanOrEqual(2)
      expect(members.filter((x) => x.plans.slice(1).some((p) => p.from.startsWith(m))).length, `upgrades ${m}`).toBe(1)
    }
    for (const m of months.slice(1)) expect(members.filter((x) => x.ended?.startsWith(m)).length, `leaves ${m}`).toBe(1)
    // An upgrade only ever moves up a plan.
    for (const x of members) for (let i = 1; i < x.plans.length; i++) expect(x.plans[i]!.minor).toBeGreaterThan(x.plans[i - 1]!.minor)
    expect(beanMembers(ctx)).toBe(members) // the same simulation every time it's asked
    expect(members.some((x) => beanPlanAt(x, '2026-09-30') === 54_00)).toBe(true)
  })

  it('the card shows last month’s statement, an APR and the next due date', () => {
    expect(hcCardTerms(ctx, '2026-09-30')).toEqual({ kind: 'credit', apr: '24.49', lastStatementDate: '2026-08-31', lastStatementBalance: { minor: 249_79, currency: 'USD' }, nextPaymentDueDate: '2026-10-25', minimumPayment: { minor: 35_00, currency: 'USD' } })
    expect(hcCardTerms(ctx, '2026-09-10').nextPaymentDueDate).toBe('2026-09-25')
  })
})

describe('Bean Club upgrades', () => {
  it('take effect on the billing day, charged at the new plan that day (the charge history shows the month)', () => {
    for (const m of beanMembers(ctx)) for (const p of m.plans.slice(1)) expect(Number(p.from.slice(8))).toBe(m.billingDay)
  })
})
