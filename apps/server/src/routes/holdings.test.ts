import { describe, expect, it } from 'vitest'
import { holdingRows } from './finance.ts'

describe('holdings in the company drawer', () => {
  it('names a position by ticker (company name under it), else by name; none at all is null', () => {
    const usd = (minor: number) => ({ minor, currency: 'USD' })
    expect(holdingRows([])).toBeNull()
    expect(holdingRows(null)).toBeNull()
    expect(
      holdingRows([
        { accountId: 'a1', entityId: 'p', accountName: 'Brokerage', securityId: 's1', ticker: 'VTI', name: 'Vanguard Total Stock Market ETF', quantity: '12.5', value: usd(312_500), asOf: '2026-10-11' },
        { accountId: 'a1', entityId: 'p', accountName: 'Brokerage', securityId: 's2', name: 'Private fund', quantity: '1', value: usd(10_000_00), asOf: '2026-10-11' },
        { accountId: 'a2', entityId: 'p', accountName: 'IRA', securityId: 's3', quantity: '3', value: usd(900), asOf: '2026-10-11' },
      ]),
    ).toEqual([
      { id: 's1:a1', name: 'VTI', detail: 'Vanguard Total Stock Market ETF', quantity: '12.5', value: usd(312_500), account: 'Brokerage' },
      { id: 's2:a1', name: 'Private fund', detail: '', quantity: '1', value: usd(10_000_00), account: 'Brokerage' },
      { id: 's3:a2', name: 'Unnamed security', detail: '', quantity: '3', value: usd(900), account: 'IRA' },
    ])
  })
})
