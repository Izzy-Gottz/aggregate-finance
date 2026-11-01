// Story 4: Acme invoices Initech $12,000 in QuickBooks (due Aug 31, so 40 days overdue "today"). Initech pays $5,000,
// then the remaining $7,000. Each payment shows up twice — in QuickBooks and as a bank deposit — and must count once.
// Outstanding, aging and revenue are checked after every step, through REST and MCP.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
type Wire = { amount: string }
type Side = { invoices: Array<{ id: string; status: string; paid: Wire; outstanding: Wire; days_overdue?: number }>; aging: Array<Record<string, Wire>>; totals: Array<{ open: Wire; overdue: Wire }> }

describe('story 4: QuickBooks invoice, partial payment, then the rest', () => {
  it('outstanding, aging and revenue to the cent at each step', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder4@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-01T08:00:00Z', current: usd(1_000_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const qb = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
      const invoice = (paid: number, status: string) => ({ type: 'invoice.upsert', externalId: 'inv1001', direction: 'receivable', number: '1001', counterparty: 'Initech', issueDate: '2026-08-01', dueDate: '2026-08-31', total: usd(1_200_000), amountPaid: usd(paid), status })
      qb.push((c) => [{ ...invoice(0, 'open'), connectionId: c }] as never)
      expect((await qb.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s)
      const owedToYou = async () => (await ai.call<{ owed_to_you: Side }>('search_invoices', { company: 'Acme', side: 'owed_to_you' })).owed_to_you
      const metric = async (m: string, extra: Record<string, unknown> = {}) => minor((await ai.call<{ value: Wire }>('get_metric', { metric: m, company: 'Acme', ...extra })).value)
      const rest = async () => (await s.get<{ owedToYou: { total: { minor: number }; overdue: { minor: number }; aging: Array<{ label: string; amount: { minor: number } }> } | null; cash: { answer: { value: { minor: number } } } }>(`/api/entities/${E.Acme}`)).body
      const aging = (side: Side) => Object.fromEntries(Object.entries(side.aging[0] ?? {}).filter(([k]) => k !== 'currency').map(([k, v]) => [k, minor(v)]))

      // ---- 1. Sent, unpaid, 40 days overdue ----
      let side = await owedToYou()
      expect(side.invoices).toHaveLength(1)
      expect(side.invoices[0]).toMatchObject({ status: 'overdue', days_overdue: 40, paid: { amount: '0.00' }, outstanding: { amount: '12000.00' } })
      expect(aging(side)).toEqual({ current: 0, '1_30': 0, '31_60': 1_200_000, '61_90': 0, '90_plus': 0 })
      expect(await metric('ar_open')).toBe(1_200_000)
      expect(await metric('ar_overdue')).toBe(1_200_000)
      expect(await metric('revenue', { from: '2026-08-01', to: '2026-08-31', basis: 'accrual' })).toBe(1_200_000)
      expect(await metric('revenue', { from: '2026-10-01', to: '2026-10-31' })).toBe(0)
      let r = await rest()
      expect(r.owedToYou).toMatchObject({ total: usd(1_200_000), overdue: usd(1_200_000), aging: [{ label: '31–60 days', amount: usd(1_200_000) }] })

      // ---- 2. Initech pays $5,000: QuickBooks records the payment, the bank shows the deposit ----
      qb.push((c) => [
        { type: 'payment.applied', externalId: 'pay1', connectionId: c, direction: 'receivable', date: '2026-10-03', amount: usd(500_000), counterparty: 'Initech', applications: [{ invoiceExternalId: 'inv1001', amount: usd(500_000) }] },
        { ...invoice(500_000, 'partially_paid'), connectionId: c },
      ] as never)
      expect((await qb.sync()).status).toBe('ok')
      bank.push((c) => [
        { type: 'txn.upsert', externalId: 'dep1', connectionId: c, accountExternalId: 'chk', date: '2026-10-05', amount: usd(500_000), status: 'posted', counterparty: 'Initech', rawText: 'INITECH INC ACH PMT' },
        { type: 'balance.snapshot', externalId: 'b1', connectionId: c, accountExternalId: 'chk', at: '2026-10-06T08:00:00Z', current: usd(1_500_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')

      side = await owedToYou()
      expect(side.invoices[0]).toMatchObject({ paid: { amount: '5000.00' }, outstanding: { amount: '7000.00' } })
      expect(aging(side)).toEqual({ current: 0, '1_30': 0, '31_60': 700_000, '61_90': 0, '90_plus': 0 })
      expect(await metric('ar_open')).toBe(700_000)
      expect(await metric('ar_overdue')).toBe(700_000)
      expect(await metric('cash')).toBe(1_500_000)
      expect(await metric('revenue', { from: '2026-10-01', to: '2026-10-31' })).toBe(500_000) // once, not QB + bank
      expect(await metric('revenue', { from: '2026-08-01', to: '2026-08-31', basis: 'accrual' })).toBe(1_200_000) // unchanged
      r = await rest()
      expect(r.owedToYou).toMatchObject({ total: usd(700_000), overdue: usd(700_000), aging: [{ label: '31–60 days', amount: usd(700_000) }] })
      expect(r.cash.answer.value.minor).toBe(1_500_000)

      // ---- 3. The remaining $7,000 ----
      qb.push((c) => [
        { type: 'payment.applied', externalId: 'pay2', connectionId: c, direction: 'receivable', date: '2026-10-08', amount: usd(700_000), counterparty: 'Initech', applications: [{ invoiceExternalId: 'inv1001', amount: usd(700_000) }] },
        { ...invoice(1_200_000, 'paid'), connectionId: c },
      ] as never)
      expect((await qb.sync()).status).toBe('ok')
      bank.push((c) => [
        { type: 'txn.upsert', externalId: 'dep2', connectionId: c, accountExternalId: 'chk', date: '2026-10-09', amount: usd(700_000), status: 'posted', counterparty: 'Initech', rawText: 'INITECH INC ACH PMT' },
        { type: 'balance.snapshot', externalId: 'b2', connectionId: c, accountExternalId: 'chk', at: '2026-10-10T08:00:00Z', current: usd(2_200_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')

      side = await owedToYou()
      expect(side.invoices[0]).toMatchObject({ status: 'paid', paid: { amount: '12000.00' }, outstanding: { amount: '0.00' } })
      expect(side.aging.every((row) => Object.values(row).every((v) => typeof v === 'string' || minor(v) === 0))).toBe(true) // nothing open: no aging (or all zero)
      expect(await metric('ar_open')).toBe(0)
      expect(await metric('ar_overdue')).toBe(0)
      expect(await metric('cash')).toBe(2_200_000)
      expect(await metric('revenue', { from: '2026-10-01', to: '2026-10-31' })).toBe(1_200_000)
      expect(await metric('revenue', { from: '2026-08-01', to: '2026-08-31', basis: 'accrual' })).toBe(1_200_000)
      r = await rest()
      expect(r.owedToYou?.total.minor ?? 0).toBe(0)
      // Each deposit is tied to its QuickBooks payment rather than left as unexplained money.
      const review = await ai.call<{ items: Array<{ kind: string; company: string }> }>('list_review_items', {})
      expect(review.items.filter((i) => i.kind === 'whose_money')).toEqual([])
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
