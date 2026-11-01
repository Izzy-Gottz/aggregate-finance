import { describe, expect, it } from 'vitest'
import { localDay, monthPeriods } from './dates.ts'

describe('company-local calendar days', () => {
  const t = Date.parse('2026-10-01T03:00:00Z')

  it('localDay is the date in that zone; an unknown or missing zone is UTC', () => {
    expect(localDay(t, 'America/Los_Angeles')).toBe('2026-09-30')
    expect(localDay(t, 'Asia/Tokyo')).toBe('2026-10-01')
    expect(localDay(t, 'Not/AZone')).toBe('2026-10-01')
    expect(localDay(t)).toBe('2026-10-01')
  })

  it('monthPeriods: this month so far, then whole months back across a year end', () => {
    expect(monthPeriods('2026-01-15', 2)).toEqual([
      { from: '2026-01-01', to: '2026-01-15' },
      { from: '2025-12-01', to: '2025-12-31' },
      { from: '2025-11-01', to: '2025-11-30' },
    ])
    expect(monthPeriods('2028-03-01', 1)[1]).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })
})
