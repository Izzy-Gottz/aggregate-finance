import { describe, expect, it } from 'vitest'
import { suggestConnectors } from './app.ts'

describe('suggested connections', () => {
  const all = ['billcom', 'xero', 'quickbooks', 'stripe', 'plaid', 'simplefin', 'files', 'demo', 'payroll-detect', 'finch', 'wise'].map((key) => ({ key }))
  const keys = (connected: string[]) => suggestConnectors(all, new Set(connected)).map((d) => d.key)
  it('a QuickBooks + Plaid workspace is offered Stripe and payroll first, not BILL or Xero', () => {
    expect(keys(['quickbooks', 'plaid'])).toEqual(['stripe', 'finch', 'wise', 'files'])
  })
  it('a new workspace starts with a bank, then Stripe and accounting', () => {
    expect(keys([]).slice(0, 4)).toEqual(['plaid', 'stripe', 'quickbooks', 'xero'])
  })
})
