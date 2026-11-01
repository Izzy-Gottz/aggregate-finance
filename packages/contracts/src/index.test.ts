import { describe, expect, it } from 'vitest'
import { toWire, type ProcessorBalanceTxn } from './index.ts'

describe('toWire', () => {
  it('formats minor units as a decimal string', () => {
    expect(toWire({ minor: 123456, currency: 'USD' })).toEqual({ amount: '1234.56', currency: 'USD' })
    expect(toWire({ minor: -5, currency: 'USD' })).toEqual({ amount: '-0.05', currency: 'USD' })
    expect(toWire({ minor: 1000, currency: 'JPY' }, 0)).toEqual({ amount: '1000', currency: 'JPY' })
  })
})

describe('ProcessorBalanceTxn.salesTax', () => {
  it('is optional and survives JSON (how records are stored), absent when not set', () => {
    const base: ProcessorBalanceTxn = {
      type: 'processor.balance_txn',
      externalId: 'GPA.1:tax:202608',
      connectionId: 'c1',
      accountExternalId: 'googleplay:b:USD',
      at: '2026-08-03T11:33:17.000Z',
      kind: 'adjustment',
      gross: { minor: 80, currency: 'USD' },
      fee: { minor: 0, currency: 'USD' },
      net: { minor: 80, currency: 'USD' },
    }
    const tax: ProcessorBalanceTxn = { ...base, salesTax: true }
    expect((JSON.parse(JSON.stringify(tax)) as ProcessorBalanceTxn).salesTax).toBe(true)
    expect('salesTax' in (JSON.parse(JSON.stringify(base)) as ProcessorBalanceTxn)).toBe(false)
  })
})
