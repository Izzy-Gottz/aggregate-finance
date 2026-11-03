// Card and loan terms and investment positions: the bank reports a card's APR, minimum payment and due date, a
// student loan's terms, and a brokerage's holdings day by day. The reader shows the terms and the latest positions
// (with history), bills due in 30 days and the Monday note count each card/loan payment once (a recurring loan
// payment from checking is the same payment, not a second one), and a later sync updates the terms in place.
import { describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { withBypass, withWorkspace } from '@agfn/db'
import { digestWithRecurring } from '../digest.ts'
import { financeFor } from '../finance.ts'
import { connectProvider, entities, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('scenario 11: card and loan terms, investment holdings', () => {
  it('positions from an evening sync belong to the workspace\'s own day', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder11b@example.com', 'Acme')
      const E = await entities(s)
      await withBypass('test:zone', () => (srv.booted.services.db as never as { updateTable(t: string): { set(v: object): { where(a: string, b: string, c: string): { execute(): Promise<unknown> } } } }).updateTable('workspaces').set({ time_zone: 'America/New_York' }).where('id', '=', s.workspaceId).execute())
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'brk', connectionId: c, name: 'Acme Brokerage', accountType: 'investment', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'brk@1', connectionId: c, accountExternalId: 'brk', at: '2026-10-10T01:00:00Z', current: usd(72_500), holdings: [{ securityExternalId: 'sec_vti', ticker: 'VTI', name: 'VTI', quantity: '2.5', value: usd(72_500) }] },
      ] as NormalizedEvent[])
      expect((await bank.sync()).status).toBe('ok')
      const held = await withWorkspace(s.workspaceId, () => financeFor(srv.booted.services).reader.holdings!({ workspaceId: s.workspaceId, entityIds: [E.Acme!] }, { asOf: '2026-10-09' }))
      expect(held.map((h) => [h.ticker, h.asOf])).toEqual([['VTI', '2026-10-09']])
    } finally {
      await srv.close()
    }
  })

  it('terms and positions stored from sync, payments due counted once, updates in place', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder11@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      const card = (min: number, apr: string) => ({
        type: 'account.upsert' as const, externalId: 'card', name: 'Acme Card', accountType: 'credit_card' as const, currency: 'USD', institution: 'Chase',
        liability: { kind: 'credit' as const, apr, minimumPayment: usd(min), nextPaymentDueDate: '2026-10-14', lastStatementBalance: usd(120_000), lastStatementDate: '2026-09-20', lastPaymentAmount: usd(5_000), lastPaymentDate: '2026-09-12' },
      })
      const navient = ['2026-07-28', '2026-08-28', '2026-09-28'].map((d, i) => ({ type: 'txn.upsert' as const, externalId: `nav${i}`, accountExternalId: 'chk', date: d, amount: usd(-25_000), status: 'posted' as const, counterparty: 'Navient', rawText: 'NAVIENT ACH' }))
      const holdings = (day: string, rows: Array<[string, string, string, number, number?]>) => ({
        type: 'balance.snapshot' as const, externalId: `brk@${day}`, accountExternalId: 'brk', at: `${day}T08:00:00Z`, current: usd(rows.reduce((t, r) => t + r[3], 0)),
        holdings: rows.map(([id, ticker, quantity, value, cost]) => ({ securityExternalId: id, ticker, name: ticker, quantity, value: usd(value), ...(cost ? { costBasis: usd(cost) } : {}) })),
      })
      const page = (c: string, events: Array<Record<string, unknown>>) => events.map((e) => ({ ...e, connectionId: c }) as NormalizedEvent)
      bank.push((c) =>
        page(c, [
          { type: 'account.upsert', externalId: 'chk', name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
          card(3_500, '24.9'),
          { type: 'account.upsert', externalId: 'blank', name: 'Acme Mercury Card', accountType: 'credit_card', currency: 'USD', institution: 'Mercury', liability: { kind: 'credit' } },
          { type: 'account.upsert', externalId: 'loan', name: 'Acme Student Loan', accountType: 'loan', currency: 'USD', institution: 'Navient', liability: { kind: 'student', apr: '5.25', minimumPayment: usd(25_000), nextPaymentDueDate: '2026-10-28', originationPrincipal: usd(4_000_000), maturityDate: '2032-06-01' } },
          { type: 'account.upsert', externalId: 'brk', name: 'Acme Brokerage', accountType: 'investment', currency: 'USD', institution: 'Chase' },
          { type: 'balance.snapshot', externalId: 'chk@1', accountExternalId: 'chk', at: '2026-10-09T08:00:00Z', current: usd(5_000_000) },
          holdings('2026-10-08', [['sec_aapl', 'AAPL', '10', 230_000, 150_000], ['sec_vti', 'VTI', '2.5', 72_500]]),
          holdings('2026-10-09', [['sec_vti', 'VTI', '3.5', 101_500]]),
          ...navient,
        ]),
      )
      expect((await bank.sync()).status).toBe('ok')

      const sv = srv.booted.services
      const reader = financeFor(sv).reader
      const scope = { workspaceId: s.workspaceId, entityIds: [E.Acme!] }
      const asWs = <T>(f: () => Promise<T>) => withWorkspace(s.workspaceId, f)

      const terms = await asWs(() => reader.liabilities!(scope))
      expect(terms.map((t) => t.accountName)).not.toContain('Acme Mercury Card')
      expect(terms.map((t) => [t.accountName, t.kind, t.apr, t.minimumPayment?.minor, t.nextPaymentDueDate])).toEqual([
        ['Acme Card', 'credit', '24.9', 3_500, '2026-10-14'],
        ['Acme Student Loan', 'student', '5.25', 25_000, '2026-10-28'],
      ])
      expect(terms[0]).toMatchObject({ institution: 'Chase', lastStatementBalance: usd(120_000), lastStatementDate: '2026-09-20', lastPaymentAmount: usd(5_000), lastPaymentDate: '2026-09-12' })
      expect(terms[1]).toMatchObject({ originationPrincipal: usd(4_000_000), maturityDate: '2032-06-01' })

      // Latest positions (AAPL was sold on the 9th), and the day before on request.
      const now = await asWs(() => reader.holdings!(scope))
      expect(now.map((h) => [h.ticker, h.quantity, h.value.minor, h.price?.minor, h.asOf])).toEqual([['VTI', '3.5', 101_500, 29_000, '2026-10-09']])
      const before = await asWs(() => reader.holdings!(scope, { asOf: '2026-10-08' }))
      expect(before.map((h) => [h.ticker, h.value.minor, h.costBasis?.minor ?? null])).toEqual([['AAPL', 230_000, 150_000], ['VTI', 72_500, null]])
      // Nobody outside the company's scope sees them.
      expect(await asWs(() => reader.liabilities!({ workspaceId: s.workspaceId, entityIds: [E.Personal!] }))).toEqual([])

      // Upcoming: both payments, scheduled; the Navient charge from checking is that loan payment, not a subscription too.
      const up = await asWs(() => reader.upcoming(scope, 30))
      expect(up.filter((u) => u.kind === 'loan_payment').map((u) => [u.date, u.paymentOf, u.what, u.amount.minor, u.confidence])).toEqual([
        ['2026-10-14', 'card', 'Acme Card minimum payment', -3_500, 'scheduled'],
        ['2026-10-28', 'loan', 'Acme Student Loan minimum payment', -25_000, 'scheduled'],
      ])
      expect(up.filter((u) => u.what === 'Navient')).toEqual([])
      const ov = await asWs(() => reader.overview(scope))
      expect(ov.entities.find((e) => e.entityId === E.Acme)!.billsDue30d).toEqual(usd(28_500))
      // Nothing billed, only minimums: the app still shows the section, with the same number.
      const shown = (await s.get<{ bills: { dueSoon: unknown } | null }>(`/api/entities/${E.Acme}`)).body.bills
      expect(shown?.dueSoon).toEqual(usd(28_500))

      // The drawers carry one line of terms per card or loan (and nothing on the others).
      type Row = { name: string; terms?: Record<string, unknown> }
      const drawer = await s.get<{ accounts: Row[] }>(`/api/entities/${E.Acme}`)
      const conn = await s.get<{ accounts: Row[] }>(`/api/connections/${bank.id}`)
      for (const rows of [drawer.body.accounts, conn.body.accounts]) {
        const by = Object.fromEntries(rows.map((r) => [r.name, r.terms]))
        expect(by['Acme Card']).toEqual({ kind: 'credit', apr: '24.9', minimumPayment: usd(3_500), nextPaymentDueDate: '2026-10-14' })
        expect(by['Acme Student Loan']).toEqual({ kind: 'student', apr: '5.25', minimumPayment: usd(25_000), nextPaymentDueDate: '2026-10-28' })
        expect(by['Acme Checking']).toBeUndefined()
      }

      // Monday note: the card payment is due this week; the loan isn't yet.
      const digest = digestWithRecurring(sv.ledger as never, sv.db, () => reader)
      const note = await withBypass('test:digest', () => digest?.(s.workspaceId, new Date('2026-10-12T08:00:00Z')))
      expect(note?.lines[3]).toBe('Bills due this week: 1, $35 (1 card payment: Acme Card)')

      // The bank reports new terms: same row, updated.
      bank.push((c) => page(c, [card(4_000, '26.24')]))
      expect((await bank.sync()).status).toBe('ok')
      const again = await asWs(() => reader.liabilities!(scope))
      expect(again.find((t) => t.kind === 'credit')).toMatchObject({ apr: '26.24', minimumPayment: usd(4_000) })
      expect(again).toHaveLength(2)
    } finally {
      await srv.close()
    }
  })
})
