import { describe, expect, it } from 'vitest'
import { addCadence, counterpartyKey, detectRecurring, dueBetween, type Row } from './detect.ts'

let n = 0
const row = (date: string, dollars: number, counterparty: string, entityId = 'acme', currency = 'USD'): Row => ({ id: `r${++n}`, entityId, date, minor: -Math.round(dollars * 100), currency, counterparty })
const monthly = (start: string, count: number, dollars: number | number[], who: string, entityId?: string) =>
  Array.from({ length: count }, (_, i) => {
    let d = start
    for (let k = 0; k < i; k++) d = addCadence(d, 'monthly')
    return row(d, Array.isArray(dollars) ? (dollars[i] as number) : dollars, who, entityId)
  })
const ASOF = '2026-10-10'

describe('recurring detection', () => {
  it('suggests after 2, acts after 3, and says when the next charge is due', () => {
    const [two] = detectRecurring(monthly('2026-08-12', 2, 49, 'Notion Labs'), ASOF)
    expect(two).toMatchObject({ status: 'suggested', occurrences: 2, cadence: 'monthly', nextDue: '2026-10-12', late: false })
    const [three] = detectRecurring(monthly('2026-07-03', 3, 15, 'Figma'), ASOF)
    expect(three).toMatchObject({ status: 'active', occurrences: 3, amountMinor: 1500, monthlyMinor: 1500, lastDate: '2026-09-03', nextDue: '2026-10-03', late: true })
    expect(detectRecurring(monthly('2026-09-03', 1, 15, 'Figma'), ASOF)).toEqual([])
  })

  it('groups amounts within 7.5% as one charge, and splits beyond that', () => {
    const [aws, ...rest] = detectRecurring(monthly('2026-06-01', 4, [100, 104.5, 98, 103], 'AMAZON WEB SERVICES'), ASOF)
    expect(rest).toEqual([])
    expect(aws).toMatchObject({ status: 'active', occurrences: 4, amountMinor: 10_300, events: [] })
    // Two plans at one vendor, charged the same days: two series.
    const both = detectRecurring([...monthly('2026-06-05', 4, 10, 'Google Workspace'), ...monthly('2026-06-05', 4, 50, 'Google Workspace')], ASOF)
    expect(both.map((s) => s.amountMinor).sort((a, b) => a - b)).toEqual([1000, 5000])
  })

  it('a later charge on the same cadence at a new price is a price change, not a new bill', () => {
    const [s, ...rest] = detectRecurring(monthly('2026-05-20', 5, [45, 45, 45, 60, 60], 'Slack Technologies'), ASOF)
    expect(rest).toEqual([])
    expect(s).toMatchObject({ status: 'active', occurrences: 5, amountMinor: 6000, events: [{ kind: 'price_increase', date: '2026-08-20', fromMinor: 4500, toMinor: 6000, pct: 33.3 }] })
    // Flagged as soon as the first higher charge lands.
    const [early] = detectRecurring(monthly('2026-07-20', 3, [45, 45, 52], 'Slack Technologies'), ASOF)
    expect(early?.events).toEqual([{ kind: 'price_increase', date: '2026-09-20', fromMinor: 4500, toMinor: 5200, pct: 15.6 }])
    const [down] = detectRecurring(monthly('2026-06-01', 4, [80, 80, 60, 60], 'Zoom'), ASOF)
    expect(down?.events[0]).toMatchObject({ kind: 'price_decrease', fromMinor: 8000, toMinor: 6000, pct: -25 })
  })

  it('a tiny first charge before the full price is a trial that converted', () => {
    const rows = [row('2026-07-01', 1, 'Linear'), ...monthly('2026-07-15', 3, 24, 'Linear')]
    const [s] = detectRecurring(rows, ASOF)
    expect(s).toMatchObject({ status: 'active', occurrences: 3, amountMinor: 2400, firstDate: '2026-07-01', events: [{ kind: 'trial_converted', date: '2026-07-15', trialMinor: 100, toMinor: 2400 }] })
    // $0 authorisations count too.
    const [z] = detectRecurring([row('2026-08-01', 0, 'Loom'), ...monthly('2026-08-08', 2, 15, 'Loom')], ASOF)
    expect(z?.events[0]).toMatchObject({ kind: 'trial_converted', trialMinor: 0 })
  })

  it('ends after two missed periods; ignores money in, irregular charges and nameless rows', () => {
    const [old] = detectRecurring(monthly('2026-02-10', 4, 30, 'Old SaaS'), ASOF)
    expect(old?.status).toBe('ended')
    expect(dueBetween([old!], '2026-01-01', '2027-01-01')).toEqual([])
    const income = monthly('2026-06-01', 4, 500, 'Client').map((r) => ({ ...r, minor: -r.minor }))
    expect(detectRecurring(income, ASOF)).toEqual([])
    expect(detectRecurring([row('2026-06-01', 20, 'Uber'), row('2026-06-04', 22, 'Uber'), row('2026-07-19', 21, 'Uber'), row('2026-09-02', 20, 'Uber')], ASOF)).toEqual([])
    expect(detectRecurring(monthly('2026-06-01', 4, 9, '#1234'), ASOF)).toEqual([])
  })

  it('weekly, biweekly, quarterly and yearly cadences; companies and currencies never mix', () => {
    const wk = Array.from({ length: 5 }, (_, i) => row(`2026-09-${String(1 + i * 7).padStart(2, '0')}`, 12, 'Sweetgreen Catering'))
    expect(detectRecurring(wk, ASOF)[0]).toMatchObject({ cadence: 'weekly', monthlyMinor: 5200, nextDue: '2026-10-06', late: true })
    const q = [row('2026-01-15', 300, 'Insurance Co'), row('2026-04-15', 300, 'Insurance Co'), row('2026-07-15', 300, 'Insurance Co')]
    expect(detectRecurring(q, ASOF)[0]).toMatchObject({ cadence: 'quarterly', nextDue: '2026-10-15', monthlyMinor: 10_000 })
    const y = [row('2024-11-01', 120, 'Domain Registrar'), row('2025-11-01', 120, 'Domain Registrar')]
    // Two yearly charges confirm it (a third would take more than two years).
    expect(detectRecurring(y, ASOF)[0]).toMatchObject({ cadence: 'yearly', status: 'active', nextDue: '2026-11-01' })
    expect(detectRecurring(y.slice(1), ASOF)).toEqual([])
    const mixed = [...monthly('2026-06-01', 2, 10, 'Figma', 'acme'), ...monthly('2026-08-01', 2, 10, 'Figma', 'nex')]
    expect(detectRecurring(mixed, ASOF).map((s) => [s.entityId, s.occurrences])).toEqual(expect.arrayContaining([['acme', 2], ['nex', 2]]))
    const eur = [...monthly('2026-06-01', 2, 10, 'Figma'), ...monthly('2026-08-01', 1, 10, 'Figma').map((r) => ({ ...r, currency: 'EUR' }))]
    expect(detectRecurring(eur, ASOF).find((s) => s.currency === 'EUR')).toBeUndefined()
  })

  it('normalizes bank descriptors to one key', () => {
    expect(counterpartyKey('ADOBE *CREATIVE CLD 800-833-6687')).toBe('adobe creative cld')
    expect(counterpartyKey('Figma, Inc.')).toBe('figma')
    expect(counterpartyKey('POS PURCHASE NETFLIX.COM')).toBe('netflix')
    expect(addCadence('2026-01-31', 'monthly')).toBe('2026-02-28')
  })
})
