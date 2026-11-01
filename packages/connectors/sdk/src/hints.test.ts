import { describe, expect, it } from 'vitest'
import { textCategoryHint } from './hints.ts'

describe('textCategoryHint', () => {
  it('names paychecks, interest and dividends on money in, and bank fees on money out', () => {
    for (const t of ['ACME CORP PAYROLL', 'DIRECT DEP GUSTO', 'DIR DEP', 'SALARY OCT', 'Pay day!']) expect(textCategoryHint(t, true)).toBe('INCOME_WAGES')
    for (const t of ['INTRST PYMNT', 'INTEREST PAYMENT', 'Interest earned', 'INTEREST']) expect(textCategoryHint(t, true)).toBe('INCOME_INTEREST_EARNED')
    expect(textCategoryHint('VANGUARD DIVIDEND', true)).toBe('INCOME_DIVIDENDS')
    for (const t of ['MONTHLY MAINTENANCE FEE', 'SERVICE CHARGE', 'OVERDRAFT FEE', 'WIRE TRANSFER FEE', 'NSF FEE', 'FOREIGN TRANSACTION FEE']) expect(textCategoryHint(t, false)).toBe('BANK_FEES')
  })

  it('leaves everything else alone, and never reads a direction the words don’t fit', () => {
    for (const t of ['Mobile deposit', 'ZELLE FROM J SMITH', 'STRIPE TRANSFER', 'Online transfer from savings', '', undefined]) expect(textCategoryHint(t, true)).toBeUndefined()
    expect(textCategoryHint('GUSTO PAYROLL', false)).toBeUndefined()
    expect(textCategoryHint('INTEREST CHARGE ON PURCHASES', false)).toBeUndefined()
    expect(textCategoryHint('MONTHLY MAINTENANCE FEE', true)).toBeUndefined()
  })
})
