// Golden tests for cap-table math. Every expected number is worked out by hand in the comment next to it.
import { describe, expect, it } from 'vitest'
import { fullyDiluted, holders, modelRound, replay, vestedShares, vestingSchedule, waterfall, accruedInterest, convertMinor, inCurrency, homeTotals, type EquityObject } from './math.ts'
import { looksInstitutional } from './model.ts'

const usd = (dollars: number) => ({ minor: Math.round(dollars * 100 * 10_000) / 10_000, currency: 'USD' })
const common = (id = 'common', authorized: number | null = 20_000_000): EquityObject => ({ type: 'STOCK_CLASS', id, name: 'Common', classType: 'COMMON', authorized, seniority: 0, liquidationPrefMultiple: 0, participating: false, participationCapMultiple: null, conversionRatio: 1 })
const person = (id: string, name: string, relationship: 'FOUNDER' | 'INVESTOR' | 'EMPLOYEE' = 'FOUNDER'): EquityObject => ({ type: 'STAKEHOLDER', id, name, stakeholderType: looksInstitutional(name) ? 'INSTITUTION' : 'INDIVIDUAL', relationship })
const issue = (id: string, who: string, quantity: number, cls = 'common', date = '2025-01-01', price?: number): EquityObject => ({
  type: 'TX_STOCK_ISSUANCE', id, date, securityId: 'S-' + id, stakeholderId: who, stockClassId: cls, quantity, ...(price != null ? { pricePerShare: usd(price) } : {}),
})

describe('vesting', () => {
  const v = { start: '2025-01-15', months: 48, cliffMonths: 12 }
  it('nothing before the cliff, a quarter at the cliff, all at the end', () => {
    expect(vestedShares(48_000, v, '2026-01-14')).toBe(0) // 11 months
    expect(vestedShares(48_000, v, '2026-01-15')).toBe(12_000) // 12/48
    expect(vestedShares(48_000, v, '2027-01-15')).toBe(24_000) // 24/48
    expect(vestedShares(48_000, v, '2030-01-01')).toBe(48_000)
    expect(vestedShares(48_000, undefined, '2020-01-01')).toBe(48_000)
  })
  it('rounds down cumulatively so the schedule adds up exactly', () => {
    const sched = vestingSchedule(1_000, { start: '2025-01-31', months: 48, cliffMonths: 12 })
    expect(sched[0]).toEqual({ date: '2026-01-31', amount: 250 })
    expect(sched.reduce((a, x) => a + x.amount, 0)).toBe(1_000)
    expect(sched[1]!.date).toBe('2026-02-28') // month-end clamped
  })
})

describe('replay and fully diluted', () => {
  const objs: EquityObject[] = [
    common(),
    person('a', 'Ada'),
    person('b', 'Ben'),
    person('e', 'Eve', 'EMPLOYEE'),
    { type: 'STOCK_PLAN', id: 'plan', name: '2025 Plan', stockClassId: 'common', size: 1_500_000 },
    issue('i1', 'a', 6_000_000),
    issue('i2', 'b', 2_500_000),
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: '2025-02-01', securityId: 'O-1', stakeholderId: 'e', stockPlanId: 'plan', stockClassId: 'common', compensationType: 'OPTION_ISO', quantity: 400_000, exercisePrice: usd(0.1), vesting: { start: '2025-02-01', months: 48, cliffMonths: 12 } },
    { type: 'TX_EQUITY_COMPENSATION_EXERCISE', id: 'x1', date: '2026-03-01', securityId: 'O-1', quantity: 100_000, resultingSecurityId: 'S-x1' },
    { type: 'TX_EQUITY_COMPENSATION_CANCELLATION', id: 'c1', date: '2026-04-01', securityId: 'O-1', quantity: 50_000 },
    { type: 'TX_STOCK_TRANSFER', id: 't1', date: '2026-05-01', securityId: 'S-i2', quantity: 500_000, toStakeholderId: 'a' },
  ]
  it('counts stock + outstanding options + unissued pool', () => {
    const s = replay(objs, '2026-06-01')
    const fd = fullyDiluted(s)
    // stock: 6,000,000 + 2,500,000 + 100,000 exercised = 8,600,000
    // options outstanding: 400,000 − 100,000 − 50,000 = 250,000
    // pool: 1,500,000 − (400,000 − 50,000 cancelled returns) = 1,150,000
    expect(fd).toEqual({ issued: 8_600_000, options: 250_000, stockOptions: 250_000, rsus: 0, warrants: 0, poolAvailable: 1_150_000, total: 10_000_000 })
    const h = holders(s)
    expect(h.map((x) => [x.name, x.fullyDilutedShares])).toEqual([
      ['Ada', 6_500_000], // 6.0M + 0.5M transferred
      ['Ben', 2_000_000],
      ['Available option pool', 1_150_000],
      ['Eve', 350_000], // 100k stock + 250k options
    ])
    expect(h[0]!.fullyDilutedPct).toBeCloseTo(65)
    expect(s.warnings).toEqual([])
  })
  it('as of an earlier date ignores later transactions', () => {
    expect(fullyDiluted(replay(objs, '2025-01-15')).total).toBe(10_000_000) // 8.5M stock + 1.5M pool
  })
  it('warns instead of failing on impossible history', () => {
    const s = replay([...objs, { type: 'TX_STOCK_TRANSFER', id: 't2', date: '2026-07-01', securityId: 'S-i2', quantity: 9_000_000, toStakeholderId: 'a' }])
    expect(s.warnings[0]).toMatch(/Ben transferred 9,000,000 shares but held 2,000,000/)
    expect(s.stock.find((p) => p.securityId === 'S-i2')).toBeUndefined() // all moved, nothing negative
  })
})

describe('round modeling: SAFEs and notes', () => {
  const base = [common(), person('f', 'Founder'), issue('i', 'f', 9_000_000)]
  it('post-money SAFE at its cap owns exactly amount ÷ cap before new money', () => {
    // $1M at $10M post-money cap on 9,000,000 shares: S = 1M × (9M + S) / 10M → S = 1,000,000 (cap price $1.00).
    // Round: $20M pre / (9M + 1M) = $2.00 a share > $1.00, so the cap wins. New money $5M / $2 = 2,500,000.
    const s = replay([...base, person('v', 'Kite Ventures', 'INVESTOR'), { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'safe', date: '2025-06-01', securityId: 'C-1', stakeholderId: 'v', kind: 'SAFE', amount: usd(1_000_000), valuationCap: usd(10_000_000), timing: 'POST_MONEY' }])
    const r = modelRound(s, { date: '2026-01-01', preMoney: usd(20_000_000), investment: usd(5_000_000) })
    expect(r.conversions[0]).toMatchObject({ shares: 1_000_000, basis: 'cap' })
    expect(r.pricePerShare).toBeCloseTo(200, 6) // cents
    expect(r.newShares).toBe(2_500_000)
    expect(r.postMoneyFullyDiluted).toBe(12_500_000)
    expect(r.table.find((x) => x.name === 'Kite Ventures')!.pct).toBeCloseTo(8, 6)
  })
  it('pre-money SAFE cap uses shares before the SAFE', () => {
    // $1M at $10M pre-money cap on 9,000,000: cap price = 10M / 9M = $1.111…; S = 1M / 1.111… = 900,000.
    const s = replay([...base, person('v', 'Angel'), { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'safe', date: '2025-06-01', securityId: 'C-1', stakeholderId: 'v', kind: 'SAFE', amount: usd(1_000_000), valuationCap: usd(10_000_000), timing: 'PRE_MONEY' }])
    expect(modelRound(s, { date: '2026-01-01', preMoney: usd(20_000_000), investment: usd(5_000_000) }).conversions[0]!.shares).toBe(900_000)
  })
  it('discount-only SAFE converts at round price × (1 − discount)', () => {
    // 8,000,000 shares; $500k, 20% off; $8M pre. P = 8M/(8M+S); S = 500k/(0.8P) = 625k(8M+S)/8M
    // → S × (1 − 0.078125) = 625,000 → S = 677,966.1 → 677,966.
    const s = replay([common(), person('f', 'F'), issue('i', 'f', 8_000_000), person('v', 'V'), { type: 'TX_CONVERTIBLE_ISSUANCE', id: 's', date: '2025-01-01', securityId: 'C', stakeholderId: 'v', kind: 'SAFE', amount: usd(500_000), discountPct: 20, timing: 'POST_MONEY' }])
    const r = modelRound(s, { date: '2026-01-01', preMoney: usd(8_000_000), investment: usd(2_000_000) })
    expect(r.conversions[0]).toMatchObject({ shares: 677_966, basis: 'discount' })
  })
  it('note converts principal plus simple interest', () => {
    // $100k at 8% for 365 days = $108,000. Cap $5M pre on 5,000,000 shares → $1.00; round $10M/(5M+S) ≈ $1.96, cap wins.
    const s = replay([common(), person('f', 'F'), issue('i', 'f', 5_000_000), person('n', 'Noteholder'), { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'n', date: '2025-01-01', securityId: 'N', stakeholderId: 'n', kind: 'NOTE', amount: usd(100_000), interestPct: 8, valuationCap: usd(5_000_000), timing: 'PRE_MONEY' }])
    const r = modelRound(s, { date: '2026-01-01', preMoney: usd(10_000_000), investment: usd(1_000_000) })
    expect(r.conversions[0]!.convertingAmount).toEqual(usd(108_000))
    expect(r.conversions[0]).toMatchObject({ shares: 108_000, basis: 'cap' })
    expect(accruedInterest({ amount: usd(100_000), interestPct: 8, date: '2025-01-01' }, '2025-07-02')).toBe(398_904) // 182 days: 100,000 × 8% × 182/365 = $3,989.04
  })
  it('tops up the pool before the money comes in (the pool shuffle)', () => {
    // 9,000,000 shares, no pool. $9M pre, $3M in, pool 10% post.
    // P = 9M/(9M+Q); N = 3M/P = (9M+Q)/3; post = 4(9M+Q)/3; Q = 0.1 × post → Q = 1,384,615.38 → 1,384,615.
    const r = modelRound(replay(base), { date: '2026-01-01', preMoney: usd(9_000_000), investment: usd(3_000_000), poolTargetPct: 10 })
    expect(r.poolIncrease).toBe(1_384_615)
    expect(r.pricePerShare).toBeCloseTo(9_000_000_00 / (9_000_000 + 1_384_615.3846), 4)
    const pool = r.table.find((x) => x.kind === 'pool')!
    expect(pool.pct).toBeCloseTo(10, 3)
  })
})

describe('waterfall', () => {
  const pref = (participating: boolean, cap: number | null = null): EquityObject => ({ type: 'STOCK_CLASS', id: 'A', name: 'Series A', classType: 'PREFERRED', authorized: null, seniority: 1, pricePerShare: usd(1), liquidationPrefMultiple: 1, participating, participationCapMultiple: cap, conversionRatio: 1 })
  const table = (p: EquityObject) => replay([common(), p, person('f', 'Founders'), person('v', 'Fund', 'INVESTOR'), issue('c', 'f', 4_000_000), issue('p', 'v', 1_000_000, 'A', '2025-01-01', 1)])
  const amt = (r: ReturnType<typeof waterfall>, n: string) => r.holders.find((h) => h.name === n)!.amount.minor / 100

  it('1x non-participating takes its preference when that is more', () => {
    // $2M exit: preference $1M vs 20% as converted = $400k → keeps preference. Common gets $1M.
    const r = waterfall(table(pref(false)), usd(2_000_000))
    expect([amt(r, 'Fund'), amt(r, 'Founders')]).toEqual([1_000_000, 1_000_000])
    expect(r.classes[0]!.converted).toBe(false)
  })
  it('converts when its share is worth more', () => {
    // $10M exit: 20% = $2M > $1M → converts. Founders $8M.
    const r = waterfall(table(pref(false)), usd(10_000_000))
    expect([amt(r, 'Fund'), amt(r, 'Founders')]).toEqual([2_000_000, 8_000_000])
    expect(r.classes[0]!.converted).toBe(true)
  })
  it('participating takes preference and its share of the rest', () => {
    // $10M: $1M pref + 20% of $9M = $2.8M. Founders $7.2M.
    const r = waterfall(table(pref(true)), usd(10_000_000))
    expect([amt(r, 'Fund'), amt(r, 'Founders')]).toEqual([2_800_000, 7_200_000])
  })
  it('capped participation stops at the cap, then converts when better', () => {
    // 2x cap = $2M total. At $10M: participating would be $2.8M > cap → $2M; converting gives $2M (20%). Tie: stays.
    expect(amt(waterfall(table(pref(true, 2)), usd(10_000_000)), 'Fund')).toBe(2_000_000)
    // At $20M: capped $2M vs converted 20% = $4M → converts.
    const r = waterfall(table(pref(true, 2)), usd(20_000_000))
    expect(amt(r, 'Fund')).toBe(4_000_000)
    expect(r.classes[0]!.converted).toBe(true)
  })
  it('options in the money net their strike; amounts add up to the exit to the cent', () => {
    const s = replay([common(), person('f', 'F'), person('e', 'E', 'EMPLOYEE'), issue('c', 'f', 900_000), { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g', date: '2020-01-01', securityId: 'O', stakeholderId: 'e', stockClassId: 'common', compensationType: 'OPTION_NSO', quantity: 100_000, exercisePrice: usd(1) }])
    // $1,000,000.01 exit: v = (E + 100k × $1) / 1,000,000 = $1.10000001; E's options: 100k × $0.10000001.
    const r = waterfall(s, { minor: 100_000_001, currency: 'USD' })
    expect(r.commonPerShare).toBeCloseTo(110.000001, 5)
    expect(r.holders.reduce((a, h) => a + h.amount.minor, 0)).toBe(100_000_001)
    // Out of the money: a $50k exit is $0.0555/share < $1 strike → options get nothing.
    expect(waterfall(s, usd(50_000)).holders.find((h) => h.name === 'E')).toBeUndefined()
  })
})

import { exportOcf, importOcf } from './ocf.ts'
import { importCapTableCsv, parseCsv } from './csv.ts'

describe('OCF', () => {
  const objs: EquityObject[] = [
    common('cs'),
    { type: 'STOCK_CLASS', id: 'pa', name: 'Series A Preferred', classType: 'PREFERRED', authorized: 2_000_000, seniority: 1, pricePerShare: usd(1.2345), liquidationPrefMultiple: 1, participating: true, participationCapMultiple: 3, conversionRatio: 1 },
    person('a', 'Ada'),
    person('v', 'Kite Ventures LLC', 'INVESTOR'),
    { type: 'STOCK_PLAN', id: 'plan', name: '2025 Plan', stockClassId: 'cs', size: 1_000_000 },
    { type: 'VALUATION', id: 'val', date: '2025-03-01', stockClassId: 'cs', pricePerShare: usd(0.31), kind: '409A', provider: 'Carta' },
    { ...(issue('i1', 'a', 8_000_000, 'cs', '2025-01-01', 0.0001) as object), vesting: { start: '2025-01-01', months: 48, cliffMonths: 12 } } as EquityObject,
    issue('i2', 'v', 1_000_000, 'pa', '2025-06-01', 1.2345),
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c1', date: '2025-02-01', securityId: 'C1', stakeholderId: 'v', kind: 'NOTE', amount: usd(250_000), valuationCap: usd(8_000_000), discountPct: 20, interestPct: 6, maturityDate: '2027-02-01', timing: 'PRE_MONEY' },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: '2025-04-01', securityId: 'O1', stakeholderId: 'a', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'OPTION_ISO', quantity: 100_000, exercisePrice: usd(0.31), vesting: { start: '2025-04-01', months: 48, cliffMonths: 12 } },
    { type: 'TX_STOCK_TRANSFER', id: 't1', date: '2025-09-01', securityId: 'S-i1', quantity: 100_000, toStakeholderId: 'v' },
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g2', date: '2025-04-01', securityId: 'R1', stakeholderId: 'a', stockPlanId: 'plan', stockClassId: 'cs', compensationType: 'RSU', quantity: 48_000, vesting: { start: '2025-04-01', months: 48, cliffMonths: 12 } },
    { type: 'TX_EQUITY_COMPENSATION_RELEASE', id: 'r1', date: '2026-04-01', securityId: 'R1', quantity: 12_000, withheld: 3_000, resultingSecurityId: 'S-r1' },
    { type: 'TX_WARRANT_ISSUANCE', id: 'w1', date: '2025-05-01', securityId: 'W1', stakeholderId: 'v', stockClassId: 'pa', quantity: 50_000, exercisePrice: usd(1.2345), purchasePrice: usd(500), expirationDate: '2032-05-01' },
    { type: 'TX_WARRANT_EXERCISE', id: 'we1', date: '2025-12-01', securityId: 'W1', quantity: 10_000, netFairValue: usd(2.5), resultingSecurityId: 'S-we1' },
    { type: 'TX_WARRANT_CANCELLATION', id: 'wc1', date: '2025-12-15', securityId: 'W1', quantity: 5_000 },
  ]
  it('round-trips: export then import gives the same cap table', () => {
    const files = exportOcf({ id: 'acme', legalName: 'Acme Inc.' }, objs, '2026-01-01')
    expect(Object.keys(files).sort()).toEqual(['Manifest.ocf.json', 'Stakeholders.ocf.json', 'StockClasses.ocf.json', 'StockPlans.ocf.json', 'Transactions.ocf.json', 'Valuations.ocf.json'])
    expect((files['StockClasses.ocf.json']!.items as Array<Record<string, unknown>>)[1]!.price_per_share).toEqual({ amount: '1.2345', currency_code: 'USD' })
    const back = importOcf(JSON.parse(JSON.stringify(files)))
    expect(back.notes).toEqual([])
    const byId = (xs: EquityObject[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id))
    expect(byId(back.objects)).toEqual(byId(objs))
    const a = replay(objs, '2026-01-01')
    const b = replay(back.objects, '2026-01-01')
    expect(holders(b)).toEqual(holders(a))
  })
  it('reads a flat array and reports what it skips', () => {
    const r = importOcf([{ object_type: 'STAKEHOLDER', id: 'x', name: { legal_name: 'X' }, stakeholder_type: 'INDIVIDUAL' }, { object_type: 'STOCK_LEGEND_TEMPLATE', id: 'l' }, { object_type: 'TX_STOCK_ISSUANCE', id: 'bad' }])
    expect(r.objects).toHaveLength(1)
    expect(r.notes).toEqual(['TX_STOCK_ISSUANCE bad: missing date', 'Skipped 1 STOCK_LEGEND_TEMPLATE object (not used for the cap table yet).'])
  })
})

describe('Carta / Pulley CSV', () => {
  const csv = [
    'Stakeholder Name,Relationship,Security Type,Share Class,Quantity,Issue Date,Price Per Share,Principal,Valuation Cap,Discount,Vesting Start Date,Vesting Term,Cliff',
    'Ada Lovelace,Founder,Common Stock,Common,"6,000,000",01/02/2025,$0.0001,,,,01/02/2025,48,12',
    'Kite Ventures LLC,Investor,SAFE,,,03/15/2025,,"$500,000","$10,000,000",20%,,,',
    'Eve Park,Employee,ISO,,40000,2025-04-01,$0.31,,,,2025-04-01,48,12',
    '"Fund, L.P.",Investor,Preferred Stock,Series Seed,1000000,2025-06-01,1.50,,,,,,',
    ',,Common,Common,10,2025-01-01,,,,,,,',
  ].join('\n')
  it('parses quotes and commas', () => {
    expect(parseCsv('a,"b, c","d ""e"""\n1,2,3')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2', '3']])
  })
  it('builds stakeholders, classes, pool, grants and SAFEs from one ledger file', () => {
    const r = importCapTableCsv(csv)
    expect(r.rows).toBe(5)
    const s = replay(r.objects, '2026-01-01')
    expect(s.stakeholders.map((x) => [x.name, x.relationship, x.stakeholderType])).toEqual([
      ['Ada Lovelace', 'FOUNDER', 'INDIVIDUAL'],
      ['Kite Ventures LLC', 'INVESTOR', 'INSTITUTION'],
      ['Eve Park', 'EMPLOYEE', 'INDIVIDUAL'],
      ['Fund, L.P.', 'INVESTOR', 'INSTITUTION'],
    ])
    expect(s.convertibles[0]).toMatchObject({ amount: usd(500_000), valuationCap: usd(10_000_000), discountPct: 20, timing: 'POST_MONEY' })
    expect(s.grants[0]).toMatchObject({ compensationType: 'OPTION_ISO', granted: 40_000, exercisePrice: usd(0.31) })
    expect(fullyDiluted(s)).toEqual({ issued: 7_000_000, options: 40_000, stockOptions: 40_000, rsus: 0, warrants: 0, poolAvailable: 0, total: 7_040_000 })
    expect(s.classes.find((c) => c.name === 'Series Seed')).toMatchObject({ classType: 'PREFERRED', pricePerShare: usd(1.5) })
    expect(r.notes).toContain('Row 6: no holder name, skipped.')
    expect(r.notes.some((n) => n.includes('option pool'))).toBe(true)
  })
  it('explains a file it can’t read', () => {
    expect(importCapTableCsv('foo,bar\n1,2').notes[0]).toMatch(/Couldn’t find the holder/)
  })
  it('reads warrant and RSU rows: warrants outside the pool with expiry, RSUs with releases; a currency column per row', () => {
    const file = [
      'Stakeholder,Security Type,Share Class,Quantity,Issue Date,Exercise Price,Expiration Date,Exercised,Released,Cancelled,Vesting Start Date,Vesting Term,Cliff,Currency',
      'Ada Lovelace,Common Stock,Common,9000000,2024-01-01,,,,,,,,,',
      'Harbor Bank,Warrant,Series A Preferred,50000,2024-06-01,1.20,2031-06-01,10000,,5000,,,,',
      'Rui Costa,RSU,,48000,2021-01-01,,,,12000,,2021-01-01,48,12,',
      'Vela GmbH,Warrant,Common,20000,2024-06-01,0.90,,,,,,,,EUR',
    ].join('\n')
    const r = importCapTableCsv(file)
    const s = replay(r.objects, '2026-01-01')
    expect(s.warrants.map((w) => [w.granted, w.exercised, w.cancelled, w.expirationDate ?? null])).toEqual([[50_000, 10_000, 5_000, '2031-06-01'], [20_000, 0, 0, null]])
    expect(s.warrants[0]!.exercisePrice).toEqual(usd(1.2))
    expect(s.warrants[1]!.exercisePrice).toEqual({ minor: 90, currency: 'EUR' })
    expect(s.classes.find((c) => c.name === 'Series A Preferred')?.classType).toBe('PREFERRED')
    // RSUs: 48,000 granted, 12,000 released (the 4-year schedule has ended, so all had vested).
    expect(s.grants[0]).toMatchObject({ compensationType: 'RSU', granted: 48_000, released: 12_000 })
    // The pool is sized to the RSUs only; warrants don't come out of it.
    expect(s.plans[0]!.size).toBe(48_000)
    // 9,000,000 + 10,000 warrant shares + 12,000 RSU shares; RSUs 36,000; warrants 35,000 + 20,000.
    expect(fullyDiluted(s)).toMatchObject({ issued: 9_022_000, rsus: 36_000, warrants: 55_000, poolAvailable: 0 })
    expect(s.warnings).toEqual([])
  })
})

describe('RSUs', () => {
  const base: EquityObject[] = [
    common(),
    person('a', 'Ada'),
    person('r', 'Rui', 'EMPLOYEE'),
    { type: 'STOCK_PLAN', id: 'plan', name: 'Plan', stockClassId: 'common', size: 1_000_000 },
    issue('i1', 'a', 9_000_000),
    // 48,000 RSUs, 4 years monthly with a 1-year cliff from 2025-01-01.
    { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: '2025-01-01', securityId: 'R-1', stakeholderId: 'r', stockPlanId: 'plan', stockClassId: 'common', compensationType: 'RSU', quantity: 48_000, vesting: { start: '2025-01-01', months: 48, cliffMonths: 12 } },
  ]
  it('unreleased RSUs count in fully diluted, vested or not', () => {
    const fd = fullyDiluted(replay(base, '2025-06-01'))
    // 9,000,000 stock + 48,000 RSUs + (1,000,000 − 48,000) pool = 10,000,000
    expect(fd).toEqual({ issued: 9_000_000, options: 48_000, stockOptions: 0, rsus: 48_000, warrants: 0, poolAvailable: 952_000, total: 10_000_000 })
  })
  it('a release issues the vested units, less any withheld for tax; fully diluted drops by the withheld units', () => {
    const objs: EquityObject[] = [...base, { type: 'TX_EQUITY_COMPENSATION_RELEASE', id: 'rel1', date: '2026-01-01', securityId: 'R-1', quantity: 12_000, withheld: 4_000, resultingSecurityId: 'S-rel1' }]
    const s = replay(objs, '2026-01-01')
    const fd = fullyDiluted(s)
    // At the cliff 12/48 × 48,000 = 12,000 vest and are released; 4,000 kept for tax, 8,000 shares issued.
    // stock 9,008,000; RSUs left 48,000 − 12,000 = 36,000; pool unchanged 952,000. Total 9,996,000.
    expect(fd).toMatchObject({ issued: 9_008_000, rsus: 36_000, poolAvailable: 952_000, total: 9_996_000 })
    expect(holders(s).find((h) => h.name === 'Rui')).toMatchObject({ rsus: 36_000, vestedRsus: 0, fullyDilutedShares: 44_000 })
    expect(s.warnings).toEqual([])
  })
  it('can’t release more than has vested; it warns and releases what had', () => {
    const objs: EquityObject[] = [...base, { type: 'TX_EQUITY_COMPENSATION_RELEASE', id: 'rel1', date: '2026-02-01', securityId: 'R-1', quantity: 20_000, resultingSecurityId: 'S-rel1' }]
    const s = replay(objs, '2026-02-01')
    // 13 months: 13/48 × 48,000 = 13,000 vested.
    expect(s.stock.find((p) => p.securityId === 'S-rel1')?.quantity).toBe(13_000)
    expect(s.warnings).toEqual(['Rui: 20,000 RSUs released on 2026-02-01, but only 13,000 had vested.'])
  })
  it('in an exit, vested RSUs share like common with no strike', () => {
    // As of 2027-01-01 half (24,000) has vested. Exit $10,002,400 over 9,000,000 + 24,000 = 9,024,000 common
    // equivalents... use a round exit: $9,024,000 → $1.00 each.
    const r = waterfall(replay(base, '2027-01-01'), usd(9_024_000))
    expect(r.holders.find((h) => h.name === 'Rui')?.amount).toEqual(usd(24_000))
    expect(r.holders.find((h) => h.name === 'Ada')?.amount).toEqual(usd(9_000_000))
  })
})

describe('warrants', () => {
  const pref: EquityObject = { type: 'STOCK_CLASS', id: 'a', name: 'Series A Preferred', classType: 'PREFERRED', authorized: null, seniority: 1, pricePerShare: usd(2), liquidationPrefMultiple: 1, participating: false, participationCapMultiple: null, conversionRatio: 1 }
  const base: EquityObject[] = [
    common(),
    pref,
    person('a', 'Ada'),
    { type: 'STAKEHOLDER', id: 'l', name: 'Lender Bank', stakeholderType: 'INSTITUTION', relationship: 'INVESTOR' },
    issue('i1', 'a', 9_900_000),
    // A warrant for 100,000 common at $0.50, $1,000 paid for it, expiring 2030-06-30.
    { type: 'TX_WARRANT_ISSUANCE', id: 'w1', date: '2025-06-01', securityId: 'W-1', stakeholderId: 'l', stockClassId: 'common', quantity: 100_000, exercisePrice: usd(0.5), purchasePrice: usd(1_000), expirationDate: '2030-06-30' },
  ]
  it('live warrants count in fully diluted until the day after they expire', () => {
    expect(fullyDiluted(replay(base, '2030-06-30'))).toMatchObject({ issued: 9_900_000, warrants: 100_000, options: 100_000, total: 10_000_000 })
    expect(fullyDiluted(replay(base, '2030-07-01'))).toMatchObject({ warrants: 0, total: 9_900_000 })
  })
  it('a cash exercise issues the shares at the exercise price', () => {
    const s = replay([...base, { type: 'TX_WARRANT_EXERCISE', id: 'we1', date: '2026-01-01', securityId: 'W-1', quantity: 40_000, resultingSecurityId: 'S-we1' }], '2026-01-01')
    expect(s.stock.find((p) => p.securityId === 'S-we1')).toMatchObject({ quantity: 40_000, pricePerShare: usd(0.5) })
    // 60,000 warrant shares left; fully diluted unchanged at 10,000,000.
    expect(fullyDiluted(s)).toMatchObject({ issued: 9_940_000, warrants: 60_000, total: 10_000_000 })
  })
  it('a cashless exercise pays the price in shares: q × (FV − price) / FV', () => {
    // 100,000 × ($2.00 − $0.50) / $2.00 = 75,000 shares; the other 25,000 pay the price.
    const s = replay([...base, { type: 'TX_WARRANT_EXERCISE', id: 'we1', date: '2026-01-01', securityId: 'W-1', quantity: 100_000, netFairValue: usd(2), resultingSecurityId: 'S-we1' }], '2026-01-01')
    expect(s.stock.find((p) => p.securityId === 'S-we1')?.quantity).toBe(75_000)
    expect(fullyDiluted(s)).toMatchObject({ issued: 9_975_000, warrants: 0, total: 9_975_000 })
  })
  it('a warrant for preferred counts as converted; in an exit it nets its price per common share', () => {
    const objs: EquityObject[] = [...base.slice(0, 5), { type: 'TX_WARRANT_ISSUANCE', id: 'w2', date: '2025-06-01', securityId: 'W-2', stakeholderId: 'l', stockClassId: 'a', quantity: 100_000, exercisePrice: usd(1) }]
    const s = replay(objs, '2026-01-01')
    expect(fullyDiluted(s)).toMatchObject({ warrants: 100_000, total: 10_000_000 })
    // Exit $20,100,000 over 10,000,000 common equivalents with one $1 strike on 100,000:
    // per share p solves 9,900,000p + 100,000(p − 1) = 20,100,000 → p = 2.02. Lender: 100,000 × 1.02 = $102,000.
    const r = waterfall(s, usd(20_100_000))
    expect(r.holders.find((h) => h.name === 'Lender Bank')?.amount).toEqual(usd(102_000))
    expect(r.warnings).toContain('Warrants for preferred shares are counted as if exercised and converted to common; their preference isn’t added until they’re exercised.')
  })
  it('older records that kept warrants as a grant type read as warrants', () => {
    const s = replay([...base.slice(0, 5), { type: 'TX_EQUITY_COMPENSATION_ISSUANCE', id: 'g1', date: '2025-06-01', securityId: 'W-old', stakeholderId: 'l', stockClassId: 'common', compensationType: 'WARRANT', quantity: 100_000, exercisePrice: usd(0.5) }], '2026-01-01')
    expect(s.grants).toEqual([])
    expect(fullyDiluted(s)).toMatchObject({ warrants: 100_000, stockOptions: 0 })
  })
})

describe('more than one currency', () => {
  const eur = (x: number) => ({ minor: Math.round(x * 100 * 10_000) / 10_000, currency: 'EUR' })
  const prefEur: EquityObject = { type: 'STOCK_CLASS', id: 'a', name: 'Series A Preferred', classType: 'PREFERRED', authorized: null, seniority: 1, pricePerShare: eur(1), liquidationPrefMultiple: 1, participating: false, participationCapMultiple: null, conversionRatio: 1 }
  const objs: EquityObject[] = [
    common(),
    prefEur,
    person('a', 'Ada'),
    person('v', 'Vela GmbH', 'INVESTOR'),
    issue('i1', 'a', 8_000_000),
    // €2,000,000 raised at €1.00 a share.
    { type: 'TX_STOCK_ISSUANCE', id: 'i2', date: '2025-06-01', securityId: 'S-i2', stakeholderId: 'v', stockClassId: 'a', quantity: 2_000_000, pricePerShare: eur(1) },
    { type: 'TX_CONVERTIBLE_ISSUANCE', id: 'c1', date: '2026-01-01', securityId: 'C1', stakeholderId: 'v', kind: 'SAFE', amount: eur(500_000), valuationCap: eur(20_000_000), timing: 'POST_MONEY' },
  ]
  it('converts minor units between currencies with different decimals', () => {
    expect(convertMinor(100_00, 'EUR', 'USD', 1.1)).toBeCloseTo(110_00) // €100.00 → $110.00
    expect(convertMinor(100_00, 'USD', 'JPY', 150)).toBeCloseTo(15_000) // $100.00 → ¥15,000 (no decimals)
  })
  it('totals in the company’s currency; unknown (null) when a rate is missing', () => {
    const s = replay(objs, '2026-06-01')
    // Preference: 2,000,000 × €1.00 × 1 = €2,000,000 → $2,200,000 at 1.10. SAFE €500,000 → $550,000.
    expect(homeTotals(s, 'USD', { EUR: 1.1 }, '2026-06-01')).toEqual({ currency: 'USD', rates: { EUR: 1.1 }, missing: [], safesAndNotes: usd(550_000), preferences: usd(2_200_000) })
    expect(homeTotals(s, 'USD', {}, '2026-06-01')).toMatchObject({ missing: ['EUR'], safesAndNotes: null, preferences: null })
  })
  it('an exit in dollars pays a euro preference at the rate', () => {
    // Exit $2,200,000 = exactly the €2,000,000 preference at 1.10: preferred takes it all (converting would get 20%).
    const r = waterfall(replay(objs, '2026-06-01'), usd(2_200_000), { rates: { EUR: 1.1 } })
    expect(r.missingRates).toEqual([])
    expect(r.holders.find((h) => h.name === 'Vela GmbH')?.amount).toEqual(usd(2_200_000))
    const none = waterfall(replay(objs, '2026-06-01'), usd(2_200_000))
    expect(none.missingRates).toEqual(['EUR'])
    expect(none.holders).toEqual([])
  })
  it('a round in dollars converts a euro SAFE at the rate, and refuses without one', () => {
    // SAFE €500,000 → $550,000 at a €20M → $22M post-money cap: owns 550,000 / 22,000,000 = 2.5% before new money.
    const s = replay(objs, '2026-06-01')
    const r = modelRound(s, { date: '2026-06-01', preMoney: usd(30_000_000), investment: usd(5_000_000), rates: { EUR: 1.1 } })
    expect(r.conversions[0]!.convertingAmount).toEqual(usd(550_000))
    expect(r.conversions[0]!.basis).toBe('cap')
    expect(() => modelRound(s, { date: '2026-06-01', preMoney: usd(30_000_000), investment: usd(5_000_000) })).toThrow('There’s no exchange rate from EUR to USD yet, so this round can’t be worked out.')
  })
  it('converting the state keeps share counts and changes only amounts', () => {
    const s = replay(objs, '2026-06-01')
    const { state, missing } = inCurrency(s, 'USD', { EUR: 1.1 })
    expect(missing).toEqual([])
    expect(fullyDiluted(state)).toEqual(fullyDiluted(s))
    expect(state.convertibles[0]!.amount).toEqual(usd(550_000))
  })
})

describe('one percent per holder on every screen (docs/qa/web-number-sources.md)', () => {
  it('the cap table page’s holder percent is get_cap_table’s, rounded the same (2 places)', async () => {
    const { capTableView, equityDetail } = await import('./view.ts')
    // 3 holders of 3,000,000 common: 33.333…% each, which the page showed unrounded and get_cap_table as 33.33.
    const s = replay([common(), person('a', 'Ada'), person('b', 'Ben'), person('c', 'Cy'), issue('i1', 'a', 1_000_000), issue('i2', 'b', 1_000_000), issue('i3', 'c', 1_000_000)], '2026-01-01')
    const table = capTableView('e', s).holders
    const page = equityDetail('e', s).holders.filter((h) => h.id !== null)
    for (const h of page) expect(h.pct).toBe(table.find((t) => t.name === h.name)!.fullyDilutedPct)
    expect(page[0]!.pct).toBe(33.33)
  })
})

describe('share price text in any currency', () => {
  it('yen have no minor unit and dinars three: a price is never 100× off', async () => {
    const { fmtPrice } = await import('./view.ts')
    expect(fmtPrice({ minor: 0.6522 * 100, currency: 'USD' })).toBe('$0.6522')
    expect(fmtPrice({ minor: 125, currency: 'JPY' })).toBe('¥125')
    expect(fmtPrice({ minor: 1_250, currency: 'KWD' }).replace(/\s/g, ' ')).toBe('KWD 1.25')
  })
})
