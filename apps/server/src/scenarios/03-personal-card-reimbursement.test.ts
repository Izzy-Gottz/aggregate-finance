// Story 3: the founder pays a $340 Acme bill with a personal card. The AI marks it as Acme's expense paid with
// personal money → "Acme owes you $340". Acme later pays the founder back; linking the repayment closes the balance,
// and Acme's spending counts the $340 once (the repayment isn't a second expense).
import { describe, expect, it } from 'vitest'
import { accountIds, connectAi, connectProvider, entities, minor, READ_WRITE_ALL, signIn, startServer } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })

describe('story 3: personal card pays a company bill, then a reimbursement', () => {
  it('Acme owes you $340, then nothing', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder3@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { name: 'Chase' })
      bank.push((c) => [
        { type: 'account.upsert', externalId: 'acme_chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'account.upsert', externalId: 'pers_card', connectionId: c, name: 'Sapphire', accountType: 'credit_card', currency: 'USD', institution: 'Chase' },
        { type: 'account.upsert', externalId: 'pers_chk', connectionId: c, name: 'Total Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' },
        { type: 'balance.snapshot', externalId: 'b0', connectionId: c, accountExternalId: 'acme_chk', at: '2026-10-01T08:00:00Z', current: usd(500_000) },
        { type: 'txn.upsert', externalId: 'adobe', connectionId: c, accountExternalId: 'pers_card', date: '2026-10-03', amount: usd(-34_000), status: 'posted', counterparty: 'Adobe', rawText: 'ADOBE *CREATIVE CLD' },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const A = await accountIds(srv, bank.id)
      expect((await s.post('/api/accounts/assign', { assignments: [{ accountId: A.acme_chk, entityId: E.Acme }, { accountId: A.pers_card, entityId: 'personal' }, { accountId: A.pers_chk, entityId: 'personal' }] })).status).toBe(200)

      const ai = await connectAi(srv, s, { ...READ_WRITE_ALL, dataTypes: [...READ_WRITE_ALL.dataTypes, 'personal'] })
      const owed = async () => (await ai.call<{ balances: Array<{ company: string; company_owes_you: { amount: string }; unreimbursed_expenses: { amount: string } }> }>('get_owner_balance', { company: 'Acme' })).balances.find((b) => b.company === 'Acme')
      const acmeSpendOct = async () => minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'gross_burn', company: 'Acme', from: '2026-10-01', to: '2026-10-31' })).value)

      // 1. "That Adobe charge was for Acme."
      const adobe = (await ai.call<{ transactions: Array<{ id: string; counterparty: string | null }> }>('search_transactions', { company: 'Personal', query: 'Adobe', limit: 5 })).transactions.find((t) => t.counterparty === 'Adobe')
      expect(adobe).toBeTruthy()
      // Who paid is fixed by the account (the personal card); the AI only says whose expense it was.
      const upd = await ai.call<{ status: string }>('update_record', { id: adobe?.id, for_company: 'Acme', category: 'software', idempotency_key: 'adobe-for-acme-0001' })
      expect(upd.status).not.toBe('rejected')

      expect(minor((await owed())?.company_owes_you)).toBe(34_000)
      expect(await acmeSpendOct()).toBe(34_000)
      const drawer = (await s.get<{ whoseMoney: Array<{ label: string; amount: { minor: number } }> }>(`/api/entities/${E.Acme}`)).body
      expect(drawer.whoseMoney).toEqual([expect.objectContaining({ label: 'Acme owes you', amount: usd(34_000) })])

      // 2. Acme pays the founder back by Zelle: out of Acme Checking, into the founder's personal checking. The AI
      //    links the two sides as a reimbursement (money-out row → money-in row).
      bank.push((c) => [
        { type: 'txn.upsert', externalId: 'zelle', connectionId: c, accountExternalId: 'acme_chk', date: '2026-10-08', amount: usd(-34_000), status: 'posted', counterparty: 'Zelle to founder', rawText: 'ZELLE TO FOUNDER' },
        { type: 'txn.upsert', externalId: 'zelle_in', connectionId: c, accountExternalId: 'pers_chk', date: '2026-10-08', amount: usd(34_000), status: 'posted', counterparty: 'Zelle from Acme', rawText: 'ZELLE FROM ACME INC' },
        { type: 'balance.snapshot', externalId: 'b1', connectionId: c, accountExternalId: 'acme_chk', at: '2026-10-09T08:00:00Z', current: usd(466_000) },
      ])
      expect((await bank.sync()).status).toBe('ok')
      const zelle = (await ai.call<{ transactions: Array<{ id: string; counterparty: string | null }> }>('search_transactions', { company: 'Acme', query: 'Zelle', limit: 5 })).transactions.find((t) => t.counterparty === 'Zelle to founder')
      const zelleIn = (await ai.call<{ transactions: Array<{ id: string; counterparty: string | null }> }>('search_transactions', { company: 'Personal', query: 'Zelle', limit: 5 })).transactions.find((t) => t.counterparty === 'Zelle from Acme')
      expect(zelle && zelleIn).toBeTruthy()
      const linked = await ai.call<{ status: string }>('update_record', { id: zelle?.id, link_to: { record_id: zelleIn?.id, type: 'reimbursement' }, idempotency_key: 'zelle-reimburse-0001' })
      expect(linked.status).toBe('applied')

      expect(minor((await owed())?.company_owes_you) ?? 0).toBe(0)
      expect(await acmeSpendOct()).toBe(34_000) // still once: the repayment isn't spending
      expect(minor((await ai.call<{ value: { amount: string } }>('get_metric', { metric: 'cash', company: 'Acme' })).value)).toBe(466_000)
      const after = (await s.get<{ whoseMoney: unknown[] }>(`/api/entities/${E.Acme}`)).body
      expect(after.whoseMoney).toEqual([])
      await ai.close()
    } finally {
      await srv.close()
    }
  }, 120_000)
})
