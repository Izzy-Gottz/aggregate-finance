// Story 17 (B4): reconciliation as a user. A bank and QuickBooks for the same company: six invoices and bills paid by
// bank rows link on their own; a payment $0.29 short of its invoice waits in Review instead; an open invoice and a
// past-due bill stay open. Then data health, coverage, closing September (the AI asks, the owner confirms), a late
// expense after the close, and a read-only AI that sees the same books and can't reopen them. Records from af's
// QuickBooks sandbox plan (made-up names).
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (n: number) => ({ minor: Math.round(n * 100), currency: 'USD' })
const START = 20_000
const BANK = [
  ['rent8', '2026-08-01', -2400, 'PIER PROPERTIES RENT'],
  ['r1', '2026-08-10', 156.0, 'RED ROCK DINER PAYMENT'],
  ['g1', '2026-08-14', -61.2, 'COSTCO WHOLESALE'],
  ['b1', '2026-09-01', -86.44, 'PG&E WEB ONLINE PAYMENT'],
  ['rent9', '2026-09-01', -2400, 'PIER PROPERTIES RENT'],
  ['b2', '2026-09-15', -315.0, 'ROBERTSON & ASSOCIATES ACH'],
  ['b3', '2026-09-18', -241.32, 'BROSNAHAN INSURANCE AGENCY'],
  ['rent10', '2026-10-01', -2400, 'PIER PROPERTIES RENT'],
  ['r2', '2026-10-02', 274.5, 'BARNETT DESIGN ACH CREDIT'],
  ['r3', '2026-10-09', 954.75, 'PAULSEN MEDICAL SUPPLIES'],
  ['near', '2026-10-10', 414.71, 'TRAVIS WALDRON PAYMENT'],
] as const
const END = START + BANK.reduce((a, r) => a + r[2], 0) // 13,896.00

const doc = (id: string, direction: 'receivable' | 'payable', counterparty: string, number: string, issueDate: string, dueDate: string, total: number, paidOn?: string) => [
  { type: 'invoice.upsert', externalId: id, direction, number, counterparty, issueDate, dueDate, total: usd(total), amountPaid: usd(paidOn ? total : 0), status: paidOn ? 'paid' : 'open' },
  ...(paidOn ? [{ type: 'payment.applied', externalId: `pay_${id}`, direction, date: paidOn, amount: usd(total), counterparty, applications: [{ invoiceExternalId: id, amount: usd(total) }], reference: number }] : []),
]
const BOOKS = [
  ...doc('i1', 'receivable', 'Red Rock Diner', 'INV-1001', '2026-08-01', '2026-08-31', 156.0, '2026-08-10'),
  ...doc('i2', 'receivable', 'Barnett Design', 'INV-1002', '2026-09-20', '2026-10-20', 274.5, '2026-10-02'),
  ...doc('i3', 'receivable', 'Paulsen Medical Supplies', 'INV-1003', '2026-09-25', '2026-10-25', 954.75, '2026-10-09'),
  ...doc('b1', 'payable', 'PG&E', 'PGE-0820', '2026-08-20', '2026-09-05', 86.44, '2026-09-01'),
  ...doc('b2', 'payable', 'Robertson & Associates', 'RA-0901', '2026-09-01', '2026-09-30', 315.0, '2026-09-15'),
  ...doc('b3', 'payable', 'Brosnahan Insurance Agency', 'BIA-0905', '2026-09-05', '2026-09-25', 241.32, '2026-09-18'),
  // Controls: an open invoice with no bank row, a payment $0.29 short (a fee), a past-due bill.
  ...doc('c1', 'receivable', 'Barnett Design', 'INV-1004', '2026-10-05', '2026-11-04', 500.0),
  ...doc('c2', 'receivable', 'Travis Waldron', 'INV-1005', '2026-09-28', '2026-10-28', 415.0),
  ...doc('c3', 'payable', 'Robertson & Associates', 'RA-0920', '2026-09-20', '2026-10-05', 315.0),
]

type Txn = { date: string; amount: { amount: string }; links?: unknown[] }
type Overview = { companies: Array<{ cash: { amount: string } | null; books_closed_through?: string }> }
type Totals = { open: { amount: string }; overdue: { amount: string } }

describe('story 17: reconcile a bank with QuickBooks, then close the month', () => {
  it('links what matches, holds the near miss for a person, closes September, and a read-only AI sees the same books', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'b4@example.com', 'Recon Co')
      const co = (await entities(s))['Recon Co']!
      const bank = await connectProvider(srv, s, 'plaid', { entityId: co, name: 'Bank' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Business Checking', accountType: 'depository', currency: 'USD', institution: 'First Platypus Bank', mask: '0001' },
        { type: 'balance.snapshot', externalId: 'start', connectionId: c, accountExternalId: 'chk', at: '2026-07-31T23:00:00Z', current: usd(START) },
        ...BANK.map(([id, date, amt, text]) => ({ type: 'txn.upsert', externalId: `bank_${id}`, connectionId: c, accountExternalId: 'chk', date, amount: usd(amt), status: 'posted', counterparty: null, rawText: text })),
        { type: 'balance.snapshot', externalId: 'now', connectionId: c, accountExternalId: 'chk', at: '2026-10-10T20:00:00Z', current: usd(END) },
      ] as never)
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: co, name: 'QuickBooks' })
      qb.push((c) => BOOKS.map((e) => ({ ...e, connectionId: c })) as never)
      expect((await bank.sync()).status).toBe('ok')
      expect((await qb.sync()).status).toBe('ok')
      const ai = await connectAi(srv, s)
      const company = { company: 'Recon Co' }

      // Cash is the bank's balance.
      expect(minor((await ai.call<Overview>('get_overview', company)).companies[0]!.cash)).toBe(usd(END).minor)

      // The six paid documents link to their bank rows; the $0.29-short payment does not.
      const tx = (await ai.call<{ transactions: Txn[] }>('search_transactions', { ...company, from: '2026-08-01', to: '2026-10-12', limit: 100, response_format: 'detailed' })).transactions
      expect(tx.filter((t) => (t.links ?? []).length).map((t) => t.amount.amount).sort()).toEqual(['-241.32', '-315.00', '-86.44', '156.00', '274.50', '954.75'])
      expect(tx.find((t) => t.amount.amount === '414.71')!.links ?? []).toEqual([])

      // Review holds only that near miss, offered as a payment with the $0.29 left owed.
      const review = (await s.get<Array<{ kind: string; detail?: string; confirmLabel?: string }>>('/api/review')).body
      expect(review).toHaveLength(1)
      expect(review[0]!.kind).toBe('match')
      expect(review[0]!.detail).toContain('INV-1005')
      expect(review[0]!.confirmLabel).toContain('$0.29 stays owed')

      // Still owed: the two open invoices; owing: the past-due bill, also on the calendar.
      const ar = (await ai.call<{ owed_to_you: { totals: Totals[] } }>('search_invoices', { ...company, side: 'owed_to_you', status: 'open' })).owed_to_you.totals[0]!
      const ap = (await ai.call<{ you_owe: { totals: Totals[] } }>('search_invoices', { ...company, side: 'you_owe', status: 'open' })).you_owe.totals[0]!
      expect(ar.open.amount).toBe('915.00')
      expect([ap.open.amount, ap.overdue.amount]).toEqual(['315.00', '315.00'])
      const upcoming = await ai.call<{ items: Array<{ what: string; amount: { amount: string } }> }>('list_upcoming', { ...company, days: 30, kinds: ['bill'] })
      expect(upcoming.items.map((i) => [i.what, i.amount.amount])).toEqual([['RA-0920 Robertson & Associates', '-315.00']])

      // Data health: nothing failed; the near miss is the one item waiting.
      const health = await ai.call<{ checks: { failed: number; pending_review: number } }>('get_metric', { metric: 'data_health', ...company })
      expect([health.checks.failed, health.checks.pending_review]).toEqual([0, 1])

      // Coverage: August and September complete, October under way.
      const months = Object.fromEntries((await ai.call<{ accounts: Array<{ months: Array<{ month: string; status: string }> }> }>('get_coverage', company)).accounts[0]!.months.map((m) => [m.month, m.status]))
      expect([months['2026-08'], months['2026-09'], months['2026-10']]).toEqual(['covered', 'covered', 'in_progress'])

      // Close September: the AI asks, the owner confirms in Review.
      const close = await ai.call<{ status: string; write_request_id: string }>('close_period', { ...company, through: '2026-09-30', idempotency_key: 'b4-close-sep-0001' })
      expect(close.status).toBe('pending_review')
      const ask = (await s.get<Array<{ id: string }>>('/api/review')).body.find((r) => r.id.includes(close.write_request_id))!
      expect((await s.post(`/api/review/${ask.id}`, { action: 'confirm' })).status).toBe(200)
      expect((await ai.call<Overview>('get_overview', company)).companies[0]!.books_closed_through).toBe('2026-09-30')

      // A September expense after the close lands on October 1 as an adjustment; September doesn't move.
      const late = await ai.try('add_entry', { ...company, kind: 'expense', date: '2026-09-10', amount: { amount: '12.00', currency: 'USD' }, paid_by: 'Recon Co', counterparty: 'Late receipt', idempotency_key: 'b4-late-0001', reason: 'a receipt found after the close' })
      expect(late.isError).toBe(false)
      expect(late.text).toContain('posts on 2026-10-01 as an adjustment')
      const ownerCash = minor((await ai.call<Overview>('get_overview', company)).companies[0]!.cash)
      await ai.close()

      // A read-only AI sees the same cash, receivables and closed date, and can't reopen.
      const ro = await connectAi(srv, s, { entityIds: 'all', dataTypes: ['balances', 'transactions', 'invoices', 'bills', 'reports'], write: false, reviewMode: 'instant', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } as never, 'Read-only check')
      const roOv = (await ro.call<Overview>('get_overview', company)).companies[0]!
      expect([minor(roOv.cash), roOv.books_closed_through]).toEqual([ownerCash, '2026-09-30'])
      expect((await ro.call<{ owed_to_you: { totals: Totals[] } }>('search_invoices', { ...company, side: 'owed_to_you', status: 'open' })).owed_to_you.totals[0]!.open.amount).toBe('915.00')
      expect(await ro.try('reopen_period', { ...company, idempotency_key: 'b4-ro-reopen-0001' })).toMatchObject({ isError: true, data: { error: 'forbidden' } })
      await ro.close()
    } finally {
      await srv.close()
    }
  })
})
