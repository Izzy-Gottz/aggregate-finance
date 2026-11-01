import type { CreditNoteUpsert, InvoiceUpsert, Money, PaymentApplied } from '@agfn/contracts'
import { describe, expect, it } from 'vitest'
import { aging, bucketFor } from './aging.ts'
import { oldestExactSubset } from './match.ts'
import { apDue, arOpen, arOverdue, daysOutstanding } from './metrics.ts'
import { docKey, normalizeName, Subledger } from './subledger.ts'

const C = 'conn_qbo'
const usd = (minor: number): Money => ({ minor, currency: 'USD' })

function inv(id: string, o: Partial<InvoiceUpsert> = {}): InvoiceUpsert {
  return {
    type: 'invoice.upsert',
    externalId: id,
    connectionId: C,
    direction: 'receivable',
    number: id.toUpperCase(),
    counterparty: 'Globex Corp',
    issueDate: '2026-08-01',
    dueDate: '2026-08-31',
    total: usd(1_000_00),
    amountPaid: usd(0),
    status: 'open',
    ...o,
  }
}

function pay(id: string, amount: number, apps: Array<[string, number]>, o: Partial<PaymentApplied> = {}): PaymentApplied {
  return {
    type: 'payment.applied',
    externalId: id,
    connectionId: C,
    direction: 'receivable',
    date: '2026-09-05',
    amount: usd(amount),
    applications: apps.map(([invoiceExternalId, a]) => ({ invoiceExternalId, amount: usd(a) })),
    ...o,
  }
}

const k = (id: string): string => docKey(C, id)

describe('subledger: partial payments and statuses (N18, N19)', () => {
  it('open → partially_paid → paid, overdue computed from due date', () => {
    const s = new Subledger()
    s.apply(inv('inv-1', { total: usd(10_000_00) }))
    expect(s.view(k('inv-1'), '2026-08-15')).toMatchObject({ status: 'open', overdue: false, remaining: usd(10_000_00) })
    expect(s.view(k('inv-1'), '2026-09-10')).toMatchObject({ status: 'open', overdue: true, daysOverdue: 10 })

    s.apply(pay('p-1', 4_000_00, [['inv-1', 4_000_00]]))
    const v = s.view(k('inv-1'), '2026-09-10')
    expect(v).toMatchObject({ status: 'partially_paid', paid: usd(4_000_00), remaining: usd(6_000_00), overdue: true, paidBasis: 'applications' })
    // Before the payment date the payment didn't exist yet.
    expect(s.view(k('inv-1'), '2026-09-01')?.remaining).toEqual(usd(10_000_00))

    s.apply(pay('p-2', 6_000_00, [['inv-1', 6_000_00]], { date: '2026-09-20' }))
    expect(s.view(k('inv-1'), '2026-09-30')).toMatchObject({ status: 'paid', remaining: usd(0), overdue: false, daysOverdue: 0 })
  })

  it('falls back to provider totals when no application data exists', () => {
    const s = new Subledger()
    s.apply(inv('inv-2', { amountPaid: usd(250_00), status: 'partially_paid' }))
    expect(s.view(k('inv-2'), '2026-08-10')).toMatchObject({ paid: usd(250_00), remaining: usd(750_00), paidBasis: 'provider', status: 'partially_paid' })
    // Provider says paid without detail (paid out of band).
    s.apply(inv('inv-3', { amountPaid: usd(1_000_00), status: 'paid' }))
    expect(s.view(k('inv-3'), '2026-08-10')?.status).toBe('paid')
  })

  it('void, draft, disputed and uncollectible', () => {
    const s = new Subledger()
    s.apply(inv('a', { status: 'void' }))
    s.apply(inv('b', { status: 'draft' }))
    s.apply(inv('c', { status: 'disputed' }))
    s.apply(inv('d'))
    s.writeOff(k('d'), '2026-12-01')
    expect(s.view(k('a'), '2026-10-01')?.status).toBe('void')
    expect(s.view(k('b'), '2026-10-01')?.status).toBe('draft')
    expect(s.view(k('c'), '2026-10-01')).toMatchObject({ status: 'disputed', overdue: true })
    expect(s.view(k('d'), '2026-12-02')).toMatchObject({ status: 'uncollectible', writtenOff: usd(1_000_00), remaining: usd(0) })
    // Void and draft are never open, never overdue.
    expect(s.list({ asOf: '2026-12-31', openOnly: true }).map((v) => v.key)).toEqual([k('c')])
  })
})

describe('subledger: one payment, several invoices (N20)', () => {
  it('splits one payment across invoices and keeps the overpayment as credit', () => {
    const s = new Subledger()
    s.apply(inv('i1', { total: usd(10_000_00) }))
    s.apply(inv('i2', { total: usd(12_000_00) }))
    s.apply(inv('i3', { total: usd(8_000_00) }))
    const r = s.apply(pay('wire', 30_500_00, [['i1', 10_000_00], ['i2', 12_000_00], ['i3', 8_000_00]], { counterparty: 'Globex Corp' }))
    expect(r.issues).toEqual([])
    for (const id of ['i1', 'i2', 'i3']) expect(s.view(k(id), '2026-09-30')?.status).toBe('paid')
    expect(s.unappliedCredits('receivable')).toEqual([
      { sourceKey: k('wire'), sourceType: 'payment', direction: 'receivable', counterparty: 'Globex Corp', amount: usd(500_00), date: '2026-09-05' },
    ])
    expect(s.applicationsFromSource(k('wire'))).toHaveLength(3)
  })

  it('re-sync of a changed payment replaces its applications; void removes them; identical is unchanged', () => {
    const s = new Subledger()
    s.apply(inv('i1'))
    s.apply(inv('i2'))
    expect(s.apply(pay('p', 1_000_00, [['i1', 1_000_00]])).outcome).toBe('created')
    expect(s.apply(pay('p', 1_000_00, [['i1', 1_000_00]], { rawRef: 'raw_2' })).outcome).toBe('unchanged')
    expect(s.apply(pay('p', 1_000_00, [['i2', 1_000_00]])).outcome).toBe('updated')
    expect(s.view(k('i1'), '2026-09-30')?.status).toBe('open')
    expect(s.view(k('i2'), '2026-09-30')?.status).toBe('paid')
    expect(s.apply(pay('p', 1_000_00, [['i2', 1_000_00]], { status: 'void' })).outcome).toBe('voided')
    expect(s.view(k('i2'), '2026-09-30')?.status).toBe('open')
  })

  it('flags bad shapes instead of silently accepting them', () => {
    const s = new Subledger()
    s.apply(inv('i1'))
    s.apply(inv('bill', { direction: 'payable' }))
    expect(s.apply(pay('x1', 500_00, [['i1', 600_00]])).issues.map((i) => i.code)).toContain('application_sum_mismatch')
    expect(s.apply(pay('x2', 100_00, [['i1', 100_00]], { amount: { minor: 100_00, currency: 'EUR' } })).issues.map((i) => i.code)).toContain(
      'currency_mismatch',
    )
    expect(s.apply(pay('x3', 100_00, [['bill', 100_00]])).issues.map((i) => i.code)).toContain('direction_mismatch')
    // Over-application across two payments is caught by checks.
    s.apply(pay('x4', 900_00, [['i1', 900_00]]))
    expect(s.view(k('i1'), '2026-09-30')).toMatchObject({ remaining: usd(0), overApplied: usd(500_00) })
    expect(s.checks('2026-09-30').map((i) => i.code)).toContain('over_applied')
  })

  it('accepts a payment before its invoice syncs, then resolves it', () => {
    const s = new Subledger()
    const r = s.apply(pay('early', 1_000_00, [['late-inv', 1_000_00]]))
    expect(r.issues.map((i) => i.code)).toEqual(['unknown_invoice'])
    s.apply(inv('late-inv'))
    expect(s.view(k('late-inv'), '2026-09-30')?.status).toBe('paid')
    expect(s.checks('2026-09-30')).toEqual([])
  })
})

describe('subledger: credit notes (N21)', () => {
  const cn = (o: Partial<CreditNoteUpsert>): CreditNoteUpsert => ({
    type: 'credit_note.upsert',
    externalId: 'cn-1',
    connectionId: C,
    direction: 'receivable',
    date: '2026-08-20',
    amount: usd(200_00),
    appliedTo: 'invoice',
    invoiceExternalId: 'i1',
    ...o,
  })

  it('reduces the amount due; multi-invoice allocation; remainder becomes customer credit', () => {
    const s = new Subledger()
    s.apply(inv('i1'))
    s.apply(inv('i2'))
    s.apply(cn({}))
    expect(s.view(k('i1'), '2026-09-01')).toMatchObject({ credited: usd(200_00), remaining: usd(800_00), status: 'partially_paid' })
    s.apply(cn({ externalId: 'cn-2', amount: usd(500_00), applications: [{ invoiceExternalId: 'i2', amount: usd(300_00) }] }))
    expect(s.view(k('i2'), '2026-09-01')?.remaining).toEqual(usd(700_00))
    expect(s.unappliedCredits().map((c) => c.amount)).toEqual([usd(200_00)])
    // A refunded credit note leaves no credit balance behind.
    s.apply(cn({ externalId: 'cn-3', appliedTo: 'refund', invoiceExternalId: undefined }))
    expect(s.unappliedCredits()).toHaveLength(1)
    s.apply(cn({ status: 'void' }))
    expect(s.view(k('i1'), '2026-09-01')?.remaining).toEqual(usd(1_000_00))
  })

  it('credit plus payment settles the invoice', () => {
    const s = new Subledger()
    s.apply(inv('i1'))
    s.apply(cn({}))
    s.apply(pay('p', 800_00, [['i1', 800_00]]))
    expect(s.view(k('i1'), '2026-09-30')).toMatchObject({ status: 'paid', paid: usd(800_00), credited: usd(200_00) })
  })
})

describe('aging (golden)', () => {
  it('buckets by days past due, per currency and counterparty, disputed flagged', () => {
    const s = new Subledger()
    const asOf = '2026-10-09'
    s.apply(inv('cur', { dueDate: '2026-10-20', total: usd(100_00) }))
    s.apply(inv('d10', { dueDate: '2026-09-29', total: usd(200_00) }))
    s.apply(inv('d30', { dueDate: '2026-09-09', total: usd(300_00), counterparty: 'Initech' }))
    s.apply(inv('d31', { dueDate: '2026-09-08', total: usd(400_00), counterparty: 'Initech' }))
    s.apply(inv('d75', { dueDate: '2026-07-26', total: usd(500_00), status: 'disputed' }))
    s.apply(inv('d120', { issueDate: '2026-05-01', dueDate: '2026-06-11', total: usd(600_00) }))
    s.apply(inv('eur', { dueDate: '2026-09-01', total: { minor: 700_00, currency: 'EUR' }, amountPaid: { minor: 0, currency: 'EUR' } }))
    s.apply(inv('paid', { total: usd(999_00) }))
    s.apply(pay('pp', 999_00, [['paid', 999_00]]))
    s.apply(inv('half', { dueDate: '2026-10-01', total: usd(1_000_00) }))
    s.apply(pay('ph', 250_00, [['half', 250_00]]))

    const [eur, usdR] = aging(s, 'receivable', asOf)
    expect(eur?.currency).toBe('EUR')
    expect(eur?.buckets['31_60']).toEqual({ minor: 700_00, currency: 'EUR' })
    expect(usdR?.buckets).toEqual({
      current: usd(100_00),
      '1_30': usd(200_00 + 300_00 + 750_00),
      '31_60': usd(400_00),
      '61_90': usd(500_00),
      '90_plus': usd(600_00),
    })
    expect(usdR?.total).toEqual(usd(2_850_00))
    expect(usdR?.disputed).toEqual(usd(500_00))
    expect(usdR?.byCounterparty.map((r) => [r.counterparty, r.total.minor])).toEqual([
      ['Globex Corp', 2_150_00],
      ['Initech', 700_00],
    ])
    expect([0, 1, 30, 31, 60, 61, 90, 91].map(bucketFor)).toEqual(['current', '1_30', '1_30', '31_60', '31_60', '61_90', '61_90', '90_plus'])
  })
})

describe('metrics', () => {
  it('ar_open, ar_overdue, ap_due, DSO', () => {
    const s = new Subledger()
    s.apply(inv('a', { issueDate: '2026-07-15', dueDate: '2026-08-14', total: usd(3_000_00) }))
    s.apply(inv('b', { issueDate: '2026-08-15', dueDate: '2026-09-14', total: usd(3_000_00) }))
    s.apply(inv('c', { issueDate: '2026-09-15', dueDate: '2026-10-15', total: usd(3_000_00) }))
    s.apply(pay('pa', 3_000_00, [['a', 3_000_00]]))
    s.apply(inv('bill1', { direction: 'payable', counterparty: 'AWS', issueDate: '2026-10-01', dueDate: '2026-10-12', total: usd(500_00) }))
    s.apply(inv('bill2', { direction: 'payable', counterparty: 'WeWork', issueDate: '2026-10-01', dueDate: '2026-11-01', total: usd(4_000_00) }))
    s.apply(inv('bill3', { direction: 'payable', counterparty: 'Law firm', issueDate: '2026-09-01', dueDate: '2026-10-01', total: usd(1_200_00) }))

    const asOf = '2026-10-09'
    expect(arOpen(s, asOf).totals).toEqual([usd(6_000_00)])
    expect(arOverdue(s, asOf)).toMatchObject({ totals: [usd(3_000_00)], rowIds: [k('b')] })
    const ap = apDue(s, asOf)
    expect(ap.open.totals).toEqual([usd(5_700_00)])
    expect(ap.overdue.totals).toEqual([usd(1_200_00)])
    expect(ap.dueNext7.totals).toEqual([usd(500_00)])
    expect(ap.dueNext30.totals).toEqual([usd(4_500_00)])
    expect(ap.upcoming.map((v) => v.counterparty)).toEqual(['Law firm', 'AWS', 'WeWork'])

    // Trailing 90 days from 2026-10-09 starts 2026-07-12: all three invoices count. 6000 / 9000 × 90 = 60.
    const [dso] = daysOutstanding(s, 'receivable', asOf)
    expect(dso).toMatchObject({ days: 60, issuedCount: 3, open: usd(6_000_00), issued: usd(9_000_00) })
    // DPO: 5700 open / 5700 billed × 90.
    expect(daysOutstanding(s, 'payable', asOf)[0]?.days).toBe(90)
    // Hidden under 3 documents in the window.
    expect(daysOutstanding(s, 'payable', asOf, 30)[0]).toMatchObject({ days: null, issuedCount: 2 })
  })
})

describe('subset-sum (one payment, several documents)', () => {
  it('prefers the oldest documents; null when nothing sums', () => {
    expect(oldestExactSubset([{ remaining: usd(100) }, { remaining: usd(200) }, { remaining: usd(100) }], usd(200))).toEqual([0, 2])
    expect(oldestExactSubset([{ remaining: usd(100) }], usd(300))).toBe(null)
    expect(normalizeName('The Globex Corporation, Inc.')).toBe('globex')
  })
})

describe('category roles', async () => {
  const { expenseRoleFor, incomeRoleFor } = await import('./categories.ts')
  it('maps common account names deterministically', () => {
    expect(expenseRoleFor('Cost of Goods Sold')).toBe('cogs')
    expect(expenseRoleFor('Payroll Expenses:Taxes')).toBe('payroll_expense')
    expect(expenseRoleFor('Payroll Tax Expense')).toBe('payroll_taxes')
    expect(expenseRoleFor('Software & Subscriptions')).toBe('software')
    expect(expenseRoleFor('AWS hosting')).toBe('cloud')
    expect(expenseRoleFor('Rent or Lease')).toBe('rent')
    expect(expenseRoleFor('Legal & Professional Fees')).toBe('professional_fees')
    expect(expenseRoleFor('Uncategorized Expense')).toBe('uncategorized_expense')
    expect(expenseRoleFor('Office Plants')).toBe('other_expense')
    expect(expenseRoleFor(undefined)).toBe('uncategorized_expense')
    expect(incomeRoleFor('Services')).toBe('revenue')
    expect(incomeRoleFor('Interest Earned')).toBe('interest_income')
  })
})
