import { describe, expect, it } from 'vitest'
import { camtAccountNumber } from './camt.ts'

describe('camtAccountNumber', () => {
  it('reads the IBAN, or the other id, and a run of spaces can’t stall it', () => {
    expect(camtAccountNumber('<IBAN> DE12 3456 </IBAN>')).toBe('DE123456')
    expect(camtAccountNumber('<ns:Othr><ns:Id>12345</ns:Id></ns:Othr>')).toBe('12345')
    const started = Date.now()
    expect(camtAccountNumber(`<IBAN>${' '.repeat(200_000)}!`)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(500)
  })
})
