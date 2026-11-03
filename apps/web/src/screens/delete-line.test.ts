import { describe, expect, it } from 'vitest'
import { deleteLine } from './connections.ts'

describe('the "delete its data" line', () => {
  it('counts what a connection with no accounts takes (Deel: payroll runs)', () => {
    expect(deleteLine({ accountCount: 0, payrollRunCount: 41 }, 'Deel')).toBe('This deletes 41 payroll runs from Aggregate. Nothing changes at Deel.')
  })
  it('names accounts, payroll runs and invoices together', () => {
    expect(deleteLine({ accountCount: 2, payrollRunCount: 1, documentCount: 1200 }, 'Chase')).toBe(
      'This deletes 2 accounts and all their transactions, 1 payroll run and 1,200 invoices and bills from Aggregate. Nothing changes at Chase.',
    )
    expect(deleteLine({ accountCount: 1 }, 'Chase')).toBe('This deletes 1 account and all its transactions from Aggregate. Nothing changes at Chase.')
  })
  it('never says 0', () => {
    expect(deleteLine({ accountCount: 0 }, 'BILL')).toBe('This deletes everything this connection brought in from Aggregate. Nothing changes at BILL.')
  })
})
