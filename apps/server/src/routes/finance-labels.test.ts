import { describe, expect, it } from 'vitest'
import { bucketLine, categoryLabel, describeWithout } from './finance.ts'

describe('bucket line', () => {
  const fields = [{ key: 'kind', type: 'text' }, { key: 'amount', type: 'money' }, { key: 'date', type: 'date' }]
  it('a stake reads from what it holds; "N paid" only once there are payments', () => {
    const values = { kind: 'SAFE', amount: { minor: 2_500_000, currency: 'USD' }, date: '2026-03-01' }
    expect(bucketLine({ name: 'Stake in Lumen Health', fields, values, status: { paid: 0 } })).toBe('$25,000 · SAFE · Mar 1, 2026')
    expect(bucketLine({ name: 'SAFE in Lumen', fields, values, status: { paid: 0 } })).toBe('$25,000 · Mar 1, 2026')
    expect(bucketLine({ name: 'Rent', fields, values, status: { paid: 3 } })).toBe('3 paid')
    expect(bucketLine({ name: 'Taxes', fields: [], values: {}, status: { paid: 0 } }, { minor: 200_000, currency: 'USD' })).toBe('Set aside $2,000')
    expect(bucketLine({ name: 'Empty', fields: [], values: {}, status: { paid: 0 } })).toBe('Nothing paid yet')
  })
})

describe('transaction row labels', () => {
  it('ledger role keys read as words; custom categories keep their names', () => {
    expect(categoryLabel('clearing_payouts')).toBe('Payouts in transit')
    expect(categoryLabel('other_income')).toBe('Other income')
    expect(categoryLabel('Software')).toBe('Software')
    expect(categoryLabel(undefined)).toBe('')
  })
  it('roles that name a company or an account read as core’s chart of accounts says them, never with an id (43)', () => {
    const names = { entity: (id: string) => ({ e_bright: 'Brightline Studio', e_north: 'Northstar Labs' })[id], account: (id: string) => ({ a_kite: 'Kite Robotics' })[id] }
    expect(categoryLabel('due_to:e_bright', names)).toBe('Owed to Brightline Studio')
    expect(categoryLabel('due_from:e_north', names)).toBe('Owed by Northstar Labs')
    expect(categoryLabel('owner_payable:e_north', names)).toBe('Owed to Northstar Labs (owner)')
    expect(categoryLabel('investment:a_kite', names)).toBe('Investment in Kite Robotics')
    expect(categoryLabel('due_to:01M4RA5KENSWG2NJ49WF8KK9F0', names)).toBe('Owed to another company')
    expect(categoryLabel('due_to:01M4RA5KENSWG2NJ49WF8KK9F0')).not.toMatch(/01M4/)
  })
  it('rows without a counterparty are named by kind and source', () => {
    expect(describeWithout({ kind: 'payout' }, 'Stripe')).toBe('Stripe payout')
    expect(describeWithout({ kind: 'fee' }, 'Square')).toBe('Square fees')
    expect(describeWithout({ kind: 'revenue' }, '')).toBe('Card sales')
    expect(describeWithout({}, '')).toBe('Transaction')
  })
})

import { lastCompleteMonth } from './finance.ts'
describe('lastCompleteMonth', () => {
  it('is the calendar month before today (UTC), across a year boundary', () => {
    expect(lastCompleteMonth(new Date('2026-10-11T00:25:00Z'))).toBe('2026-09')
    expect(lastCompleteMonth(new Date('2027-01-03T12:00:00Z'))).toBe('2026-12')
  })
  it('from the workspace’s own day: 00:25 UTC on Nov 1 is still Oct 31 in New York, so the last month is September', async () => {
    const { localDate } = await import('@agfn/core')
    expect(lastCompleteMonth(localDate('2026-11-01T00:25:00Z', 'America/New_York'))).toBe('2026-09')
    expect(lastCompleteMonth(new Date('2026-11-01T00:25:00Z'))).toBe('2026-10') // the UTC reading the label used to take
  })
})
