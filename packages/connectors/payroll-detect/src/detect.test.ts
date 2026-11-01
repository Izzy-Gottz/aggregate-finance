import type { PayrollRun, TxnUpsert } from '@agfn/contracts'
import { assertRedacted } from '@agfn/connector-sdk/testing'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classify, detectPayroll, matchSettlements } from './detect.ts'
import { parseCsv, parseDate, parsePayrollRegister, RegisterError } from './register.ts'

const BANK = 'conn_bank'
let n = 0
function txn(date: string, minor: number, rawText: string, o: Partial<TxnUpsert> = {}): TxnUpsert {
  n++
  return {
    type: 'txn.upsert',
    externalId: `t${String(n).padStart(3, '0')}`,
    connectionId: BANK,
    accountExternalId: 'chk',
    date,
    amount: { minor, currency: 'USD' },
    status: 'posted',
    rawText,
    ...o,
  }
}
const usd = (minor: number) => ({ minor, currency: 'USD' })

describe('classify', () => {
  it('recognizes provider and component from the descriptor', () => {
    expect(classify(txn('2026-10-01', -100, 'GUSTO NET 241001 ACME INC'))).toMatchObject({ provider: 'Gusto', component: 'net' })
    expect(classify(txn('2026-10-01', -100, 'GUSTO TAX 241001 ACME INC'))).toMatchObject({ provider: 'Gusto', component: 'tax' })
    expect(classify(txn('2026-10-01', -100, 'GUSTO FEE 241001'))).toMatchObject({ provider: 'Gusto', component: 'fee' })
    expect(classify(txn('2026-10-01', -100, 'ZENPAYROLL CND 0912'))).toMatchObject({ provider: 'Gusto', component: 'net' })
    expect(classify(txn('2026-10-01', -100, 'ADP WAGE PAY WAGE PAY 123'))).toMatchObject({ provider: 'ADP', component: 'net' })
    expect(classify(txn('2026-10-01', -100, 'ADP Tax ADP Tax'))).toMatchObject({ provider: 'ADP', component: 'tax' })
    expect(classify(txn('2026-10-01', -100, 'ADP PAYROLL FEES'))).toMatchObject({ provider: 'ADP', component: 'fee' })
    expect(classify(txn('2026-10-01', -100, 'RIPPLING PAYROLL'))).toMatchObject({ provider: 'Rippling', component: 'net' })
    expect(classify(txn('2026-10-01', -100, 'INTUIT PAYROLL DD'))).toMatchObject({ provider: 'QuickBooks Payroll' })
    expect(classify(txn('2026-10-01', -100, 'AUGUST RENT'))).toBe(null)
    expect(classify(txn('2026-10-01', -100, 'IRS USATAXPYMT'))).toBe(null) // ambiguous: could be income tax
  })
})

describe('detectPayroll (golden)', () => {
  const rows = (): TxnUpsert[] => {
    n = 0
    return [
      txn('2026-09-01', -38_947_50, 'GUSTO NET 240901 ACME'),
      txn('2026-09-02', -15_174_25, 'GUSTO TAX 240902 ACME'),
      txn('2026-09-02', -149_00, 'GUSTO FEE 240902'),
      txn('2026-09-15', -39_000_00, 'GUSTO NET 240915 ACME'),
      txn('2026-09-16', -15_200_00, 'GUSTO TAX 240916 ACME'),
      txn('2026-09-16', -2_500_00, 'GUSTO BENEFITS 401K'),
      txn('2026-09-17', 1_250_00, 'GUSTO NET REVERSAL'),
      txn('2026-09-20', -1_000_00, 'ACME PEO PAYROLL'),
      txn('2026-10-20', -1_000_00, 'ACME PEO PAYROLL'),
      txn('2026-09-21', -5_000_00, 'GUSTO NET pending', { status: 'pending' }),
      txn('2026-09-22', -9_999_00, 'WEWORK'),
    ]
  }

  it('turns repeating descriptor patterns into estimated runs with settlement links', () => {
    const r = detectPayroll(rows(), { connectionId: 'conn_detect' })
    expect(r.runs).toHaveLength(2)
    const [a, b] = r.runs as [PayrollRun, PayrollRun]
    expect(a).toMatchObject({
      externalId: 'bank:gusto:conn_bank:t001',
      payDate: '2026-09-01',
      net: usd(38_947_50),
      gross: usd(54_121_75),
      companyDebit: usd(54_121_75),
      employerTaxes: usd(0),
      estimated: true,
      source: 'bank_detected',
      provider: 'Gusto',
      settlementTxnExternalIds: ['t001', 't002'],
    })
    // Reversal nets against net pay; benefits are part of the cost; the fee is not.
    expect(b).toMatchObject({ net: usd(37_750_00), employerBenefits: usd(2_500_00), companyDebit: usd(55_450_00) })
    expect(b.settlementTxnExternalIds).toEqual(['t004', 't005', 't006', 't007'])
    expect(r.links).toHaveLength(6)
    expect(r.classified.find((c) => c.component === 'fee')?.txn.externalId).toBe('t003')
    expect(r.suggestions).toEqual([{ descriptor: 'ACME PEO PAYROLL', count: 2, txnExternalIds: ['t008', 't009'] }])
  })

  it('is deterministic and respects custom patterns, suppression and known runs', () => {
    expect(JSON.stringify(detectPayroll(rows(), { connectionId: 'c' }))).toBe(JSON.stringify(detectPayroll(rows(), { connectionId: 'c' })))
    const custom = detectPayroll(rows(), { connectionId: 'c', customPatterns: [{ provider: 'Acme PEO', match: /\bACME PEO\b/ }] })
    expect(custom.runs.filter((x) => x.provider === 'Acme PEO')).toHaveLength(2)
    expect(custom.suggestions).toEqual([])
    expect(detectPayroll(rows(), { connectionId: 'c', suppressProviders: ['gusto'] }).runs).toEqual([])
    const known = detectPayroll(rows(), { connectionId: 'c', knownRuns: [{ payDate: '2026-09-03', provider: 'Gusto' }] })
    expect(known.runs.map((x) => x.payDate)).toEqual(['2026-09-15'])
  })
})

describe('matchSettlements', () => {
  it('links the debits of a provider-reported run by exact subset-sum, else by net pay', () => {
    n = 0
    const bank = [
      txn('2026-10-01', -3_894_75, 'GUSTO NET 241001'),
      txn('2026-10-02', -1_517_75, 'GUSTO TAX 241002'),
      txn('2026-10-02', -149_00, 'GUSTO FEE'),
      txn('2026-10-02', -1_517_75, 'AMEX PAYMENT'),
    ]
    const run = { externalId: 'finch:p1', payDate: '2026-10-03', net: usd(3_894_75), companyDebit: usd(5_412_50), provider: 'Gusto' }
    expect(matchSettlements(run, bank).map((l) => [l.toId, l.confidence])).toEqual([
      ['t001', 0.97],
      ['t002', 0.97],
    ])
    expect(matchSettlements({ ...run, companyDebit: usd(9_999_99) }, bank).map((l) => [l.toId, l.confidence])).toEqual([['t001', 0.8]])
    expect(matchSettlements({ ...run, payDate: '2026-12-01' }, bank)).toEqual([])
  })
})

describe('payroll register upload', () => {
  const csv = readFileSync(new URL('../fixtures/redacted/gusto-payroll-journal.csv', import.meta.url), 'utf8')

  it('fixture is redacted', () => assertRedacted(csv))

  it('groups per-person rows into runs (golden), skipping title and total rows', () => {
    const r = parsePayrollRegister(csv, { connectionId: 'conn_up', currency: 'USD', provider: 'Gusto', rawRef: 'raw_1' })
    expect(r.issues).toEqual([])
    expect(r.rowsRead).toBe(4)
    expect(r.columns).toMatchObject({ payDate: 'Check date', gross: 'Gross pay', net: 'Net pay', person: 'Employee' })
    expect(r.runs).toHaveLength(2)
    expect(r.runs[0]).toMatchObject({
      externalId: 'register:2026-10-03:2026-09-16:2026-09-30:USD',
      payDate: '2026-10-03',
      periodStart: '2026-09-16',
      periodEnd: '2026-09-30',
      gross: usd(9_700_00),
      net: usd(7_999_65),
      employeeTaxes: usd(1_745_35),
      employerTaxes: usd(678_10),
      employerBenefits: usd(500_00),
      reimbursements: usd(45_00),
      companyDebit: usd(7_999_65 + 1_745_35 + 678_10 + 500_00 + 45_00),
      employeeCount: 2,
      source: 'register_upload',
      estimated: false,
      provider: 'Gusto',
      rawRef: 'raw_1',
    })
    expect(r.runs[0]?.lines?.map((l) => [l.person, l.kind])).toEqual([
      ['Doe, Jane', 'employee'],
      ['Smith Alex', 'employee'],
      ['Contractor Pat', 'contractor'],
    ])
  })

  it('accepts summary-only files, semicolons, D/M dates; reports bad rows; rejects files missing columns', () => {
    const summary = 'Pay date;Gross;Net;Employer taxes\n03/10/2026;10.000,00;7.000,00;800,00\n'
    // European decimals aren't guessed: they are reported, not misread.
    const bad = parsePayrollRegister(summary, { connectionId: 'c', currency: 'EUR', dateOrder: 'dmy' })
    expect(bad.runs).toEqual([])
    expect(bad.issues.length).toBeGreaterThan(0)
    const ok = parsePayrollRegister(summary, { connectionId: 'c', currency: 'EUR', dateOrder: 'dmy', decimal: ',' })
    expect(ok.runs[0]).toMatchObject({ payDate: '2026-10-03', gross: { minor: 1_000_000, currency: 'EUR' }, employerTaxes: { minor: 80_000, currency: 'EUR' } })
    expect(ok.runs[0]?.companyDebit).toEqual({ minor: 1_080_000, currency: 'EUR' }) // no withholding column: gross + employer taxes
    expect(ok.runs[0]?.lines).toBeUndefined()
    const issues = parsePayrollRegister('Check date,Gross pay,Net pay\n13/45/2026,1,1\n10/01/2026,abc,1\n', { connectionId: 'c', currency: 'USD' }).issues
    expect(issues.map((i) => i.row)).toEqual([2, 3])
    expect(() => parsePayrollRegister('Name,Amount\nx,1\n', { connectionId: 'c', currency: 'USD' })).toThrow(RegisterError)
  })

  it('csv and date primitives', () => {
    expect(parseCsv('a,"b ""q"", c",d\r\n1,2,3\n')).toEqual([
      ['a', 'b "q", c', 'd'],
      ['1', '2', '3'],
    ])
    expect(() => parseCsv('a,"open')).toThrow(RegisterError)
    expect(parseDate('2026-10-09')).toBe('2026-10-09')
    expect(parseDate('10/9/26')).toBe('2026-10-09')
    expect(parseDate('9/10/2026', 'dmy')).toBe('2026-10-09')
    expect(parseDate('Oct 9, 2026')).toBe('2026-10-09')
    expect(parseDate('02/30/2026')).toBe(null)
  })
})

describe('provider helpers', async () => {
  const { providerRun, startWindow, stepWindow } = await import('./provider.ts')
  it('windows cover the range exactly once, then a lookback pass', () => {
    let s: ReturnType<typeof startWindow> | null = startWindow(null, '2026-10-09', { backfillDays: 200, windowDays: 90, aheadDays: 10 })
    const pages: string[] = []
    while (s) {
      const w = stepWindow(s, { windowDays: 90 })
      pages.push(`${w.from}..${w.to}`)
      s = w.next
    }
    expect(pages).toEqual(['2026-03-23..2026-06-20', '2026-06-21..2026-09-18', '2026-09-19..2026-10-19'])
    expect(startWindow({ from: 'x', end: 'y', mark: '2026-10-09' }, '2026-10-20').from).toBe('2026-08-25')
  })
  it('scheduled vs paid vs void', () => {
    const base = { externalId: 'r', connectionId: 'c', provider: 'Finch', currency: 'USD', gross: 100, net: 80, employerTaxes: 8, today: '2026-10-09' }
    expect(providerRun({ ...base, payDate: '2026-10-15' }).status).toBe('scheduled')
    expect(providerRun({ ...base, payDate: '2026-10-01' })).toMatchObject({ status: 'paid', source: 'provider', estimated: false })
    expect(providerRun({ ...base, payDate: '2026-10-01', voided: true }).status).toBe('void')
  })
})
