// Story 18: a reserve, an advance, a topup and a sale also in QuickBooks. What the AI reads: none of the first three is
// burn or revenue, and the sale is asked about, then counts once. 43's steps: docs/qa/processor-fixes-steps-2026-11.md.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, READ_WRITE_ALL, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
const row = (c: string, externalId: string, at: string, kind: 'charge' | 'other' | 'transfer', gross: number, extra: object = {}) => ({ type: 'processor.balance_txn', externalId, connectionId: c, accountExternalId: 'bal', at, kind, gross: usd(gross), fee: usd(0), net: usd(gross), ...extra })

describe('story 18: processor money on the balance sheet', () => {
  it('stays out of burn and revenue, and a sale in two sources counts once', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder18@example.test', 'Acme')
      const E = await entities(s)
      const stripe = await connectProvider(srv, s, 'stripe', { entityId: E.Acme, name: 'Stripe' })
      stripe.push((c) => [
        { type: 'account.upsert', externalId: 'bal', connectionId: c, name: 'Stripe balance', accountType: 'processor_balance', currency: 'USD' },
        row(c, 'hold', '2026-09-03T10:00:00Z', 'other', -2_500_000, { balanceRole: 'other_assets' }),
        row(c, 'adv', '2026-09-04T10:00:00Z', 'other', 10_000_000, { balanceRole: 'other_liabilities' }),
        row(c, 'top', '2026-09-08T10:00:00Z', 'transfer', 500_000, { balanceRole: 'clearing_payouts' }),
        row(c, 'sale', '2026-09-12T10:00:00Z', 'charge', 1_000_000, { counterparty: 'Globex Corp' }),
      ] as never)
      expect((await stripe.sync()).status).toBe('ok')
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'txn.upsert', externalId: 'topup', connectionId: c, accountExternalId: 'chk', date: '2026-09-09', amount: usd(-500_000), status: 'posted', rawText: 'STRIPE TOPUP' },
      ] as never)
      expect((await bank.sync()).status).toBe('ok')
      const qbo = await connectProvider(srv, s, 'quickbooks', { entityId: E.Acme, name: 'QuickBooks' })
      qbo.push((c) => [
        { type: 'invoice.upsert', externalId: 'INV-1', connectionId: c, direction: 'receivable', counterparty: 'Globex Corp', issueDate: '2026-09-01', total: usd(1_000_000), amountPaid: usd(1_000_000), status: 'paid' },
        { type: 'payment.applied', externalId: 'PAY-1', connectionId: c, direction: 'receivable', date: '2026-09-11', amount: usd(1_000_000), counterparty: 'Globex Corp', applications: [{ invoiceExternalId: 'INV-1', amount: usd(1_000_000) }], status: 'posted' },
      ] as never)
      expect((await qbo.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s, READ_WRITE_ALL)
      const metric = async (name: string) => minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: name, company: 'Acme', from: '2026-09-01', to: '2026-09-30' })).value)
      expect(await metric('gross_burn')).toBe(0)
      expect(await metric('revenue')).toBe(2_000_000)

      const review = (await s.get<Array<{ id: string; title: string }>>('/api/review')).body
      const same = review.find((i) => i.title.startsWith('Same money?'))
      expect(same, JSON.stringify(review)).toBeTruthy()
      expect((await s.post(`/api/review/${same?.id}`, { action: 'confirm' })).status).toBe(200)
      expect(await metric('revenue')).toBe(1_000_000)
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
