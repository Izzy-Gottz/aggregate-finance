import { describe, expect, it } from 'vitest'
import { add, formatAmount, MoneyError, parseAmount, sum } from './money.ts'

describe('money', () => {
  it('parses decimals to minor units without floats', () => {
    expect(parseAmount('1234.56', 'USD')).toEqual({ minor: 123456, currency: 'USD' })
    expect(parseAmount('1,234.5', 'usd')).toEqual({ minor: 123450, currency: 'USD' })
    expect(parseAmount(19.99, 'USD').minor).toBe(1999)
    expect(parseAmount(1.005, 'KWD').minor).toBe(1005)
    expect(parseAmount('(250.00)', 'USD').minor).toBe(-25000)
    expect(parseAmount('-0.07', 'EUR').minor).toBe(-7)
    expect(parseAmount('500', 'JPY').minor).toBe(500)
    expect(parseAmount('12.300', 'USD').minor).toBe(1230)
    expect(parseAmount('-0', 'USD').minor).toBe(0)
  })

  it('rejects ambiguous or lossy input', () => {
    expect(() => parseAmount('12.345', 'USD')).toThrow(MoneyError)
    expect(() => parseAmount('1.5', 'JPY')).toThrow(MoneyError)
    expect(() => parseAmount('abc', 'USD')).toThrow(MoneyError)
    expect(() => parseAmount('', 'USD')).toThrow(MoneyError)
    expect(() => parseAmount('10.000,00', 'EUR')).toThrow(MoneyError)
    expect(() => parseAmount('1,5', 'EUR')).toThrow(MoneyError)
    expect(() => parseAmount(Number.NaN, 'USD')).toThrow(MoneyError)
  })

  it('formats and refuses to mix currencies', () => {
    expect(formatAmount({ minor: -5, currency: 'USD' })).toBe('-0.05')
    expect(formatAmount({ minor: 1005, currency: 'KWD' })).toBe('1.005')
    expect(formatAmount({ minor: 500, currency: 'JPY' })).toBe('500')
    expect(() => add({ minor: 1, currency: 'USD' }, { minor: 1, currency: 'EUR' })).toThrow(MoneyError)
    expect(sum([], 'USD')).toEqual({ minor: 0, currency: 'USD' })
  })
})
