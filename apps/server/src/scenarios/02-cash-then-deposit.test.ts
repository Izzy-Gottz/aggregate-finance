// Story 2: "I got $500 cash for Acme" — the AI records it with add_entry. Days later the founder deposits that cash
// at the bank. The deposit must be linked to the cash entry (a transfer from cash on hand), so neither cash nor
// revenue counts the $500 twice.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, minor, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('story 2: cash told to the AI, then deposited', () => {
  it('counts the $500 once, before and after the deposit', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder2@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'chk', at: '2026-10-01T08:00:00Z', current: usd(1_000_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s)
      const cash = async () => minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'cash', company: 'Acme' })).value)
      const revenueOct = async () => minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'revenue', company: 'Acme', from: '2026-10-01', to: '2026-10-31' })).value)
      expect(await cash()).toBe(1_000_000)

      // 0. A dry run on the real ledger shows the exact record and cash effect, and keeps nothing.
      const dry = await ai.call<{ status: string; summary: string; write_request_id: null; dry_run: { outcome: string; previewed: boolean; summary: string | null; cash_effect: Array<{ company: string; amount: { amount: string } }> } }>('add_entry', {
        company: 'Acme',
        kind: 'cash_income',
        amount: { amount: '500.00', currency: 'USD' },
        date: '2026-10-02',
        paid_by: 'Acme',
        counterparty: 'Walk-in customer',
        idempotency_key: 'cash-500-acme-0001',
        dry_run: true,
      })
      expect(dry).toMatchObject({ status: 'dry_run', write_request_id: null, dry_run: { outcome: 'would_apply', previewed: true, cash_effect: [{ company: 'Acme', amount: { amount: '500.00' } }] } })
      expect(dry.dry_run.summary).toBeTruthy()
      expect(dry.summary).toMatch(/^Dry run, nothing recorded/)
      expect(await cash()).toBe(1_000_000)

      // 1. "I got $500 cash for Acme from a walk-in customer."
      const added = await ai.call<{ status: string; record_id: string }>('add_entry', {
        company: 'Acme',
        kind: 'cash_income',
        amount: { amount: '500.00', currency: 'USD' },
        date: '2026-10-02',
        paid_by: 'Acme',
        counterparty: 'Walk-in customer',
        idempotency_key: 'cash-500-acme-0001',
      })
      expect(added.status).toBe('applied')
      expect((added as unknown as { summary: string }).summary).toMatch(/^Recorded/) // in structuredContent too
      // Same request again (an AI retry) is not a second $500.
      const retry = await ai.call<{ status: string }>('add_entry', { company: 'Acme', kind: 'cash_income', amount: { amount: '500.00', currency: 'USD' }, date: '2026-10-02', paid_by: 'Acme', counterparty: 'Walk-in customer', idempotency_key: 'cash-500-acme-0001' })
      expect(retry.status).toBe('duplicate')

      expect(await cash()).toBe(1_050_000) // bank 10,000 + cash on hand 500
      expect(await revenueOct()).toBe(50_000)
      const restBefore = (await s.get<{ cash: { answer: { value: { minor: number } } } }>(`/api/entities/${E.Acme}`)).body
      expect(restBefore.cash.answer.value.minor).toBe(1_050_000)

      // 2. Three days later the bank shows the deposit and the new balance.
      bank.push((c) => [
        { type: 'txn.upsert', externalId: 'dep', connectionId: c, accountExternalId: 'chk', date: '2026-10-05', amount: usd(50_000), status: 'posted', counterparty: 'Cash deposit', rawText: 'BRANCH CASH DEPOSIT' },
        { type: 'balance.snapshot', externalId: 'b1', connectionId: c, accountExternalId: 'chk', at: '2026-10-06T08:00:00Z', current: usd(1_050_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')

      expect(await cash()).toBe(1_050_000) // not 11,000: the cash moved from the drawer to the bank
      expect(await revenueOct()).toBe(50_000) // not 1,000: the deposit is a transfer
      const restAfter = (await s.get<{ cash: { answer: { value: { minor: number } } } }>(`/api/entities/${E.Acme}`)).body
      expect(restAfter.cash.answer.value.minor).toBe(1_050_000)

      const dep = (await ai.call<{ transactions: Array<{ counterparty: string | null; kind: string; linked: number | null; amount: { amount: string } }> }>('search_transactions', { company: 'Acme', limit: 20 })).transactions.find((t) => t.counterparty === 'Cash deposit')
      expect(dep).toMatchObject({ amount: { amount: '500.00' }, linked: 1 })
      expect(dep?.kind).not.toBe('revenue')

      // 3. "September is done; close it." The AI's request waits for the owner, who approves it in the app.
      const close = await ai.call<{ status: string; held_because: string; approval_url: string; write_request_id: string }>('close_period', { company: 'Acme', through: '2026-09-30', idempotency_key: 'close-sep-acme-0001' })
      expect(close).toMatchObject({ status: 'pending_review', held_because: 'needs_approval' })
      const review = (await s.get<Array<{ id: string }>>('/api/review')).body
      const item = review.find((r) => r.id.includes(close.write_request_id))
      expect(item).toBeTruthy()
      expect((await s.post(`/api/review/${item!.id}`, { action: 'confirm' })).status).toBe(200)
      const ov = await ai.call<{ companies: Array<{ company: string; books_closed_through?: string }> }>('get_overview', { company: 'Acme' })
      expect(ov.companies[0]?.books_closed_through).toBe('2026-09-30')
      // A late September receipt now posts in October; the answer says so before and after.
      const late = { company: 'Acme', kind: 'expense', amount: { amount: '5.00', currency: 'USD' }, date: '2026-09-15', paid_by: 'Acme', counterparty: 'Staples', idempotency_key: 'late-sep-receipt-0001' }
      const preview = await ai.call<{ summary: string; closed_period: { posts_on: string } }>('add_entry', { ...late, dry_run: true })
      expect(preview.closed_period.posts_on).toBe('2026-10-01')
      expect((await ai.call<{ summary: string }>('add_entry', late)).summary).toMatch(/so it posts on 2026-10-01 as an adjustment/)
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
