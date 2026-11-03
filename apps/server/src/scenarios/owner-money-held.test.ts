// Owner money with no account, on a company with a bank: the AI hears the refusal when it writes, even when writes are
// held for review, because nobody at Review could add the account. It names Cash on hand for physical cash.
import { describe, expect, it } from 'vitest'
import { connectAi, connectProvider, entities, READ_WRITE_ALL, signIn, startServer } from './harness.ts'

describe('owner money that needs an account', () => {
  it('is refused at submit, not held, and physical cash has a way through', async () => {
    const srv = await startServer()
    try {
      const s = await signIn(srv, 'founder-held@example.com', 'Acme')
      const E = await entities(s)
      const bank = await connectProvider(srv, s, 'plaid', { entityId: E.Acme, name: 'Chase' })
      bank.push((c) => [{ type: 'account.upsert', externalId: 'chk', connectionId: c, name: 'Acme Checking', accountType: 'depository', currency: 'USD', institution: 'Chase' }])
      expect((await bank.sync()).status).toBe('ok')

      const ai = await connectAi(srv, s, { ...READ_WRITE_ALL, reviewMode: 'review_all' })
      const entry = { company: 'Acme', kind: 'owner_contribution', amount: { amount: '500.00', currency: 'USD' }, date: '2026-10-02', paid_by: 'owner' }
      const refused = await ai.try('add_entry', { ...entry, idempotency_key: 'owner-held-0001' })
      expect(refused.isError).toBe(true)
      const message = refused.text
      expect(message).toContain('Which account did it go into?')
      const id = /Cash on hand \(([^)]+)\)/.exec(message)?.[1]
      expect(id).toBeTruthy()

      const held = await ai.call<{ status: string }>('add_entry', { ...entry, account_id: id, idempotency_key: 'owner-held-0002' })
      expect(held.status).toBe('pending_review')

      // The rest of what Apply would refuse is refused here too, instead of being held first.
      const fromCompany = await ai.try('add_entry', { ...entry, paid_by: 'Acme', account_id: id, idempotency_key: 'owner-held-0003' })
      expect(fromCompany.text).toContain('Owner money must be paid by "owner"')
      const payOwner = await ai.try('add_entry', { ...entry, kind: 'reimbursement', account_id: id, idempotency_key: 'owner-held-0004' })
      expect(payOwner.text).toContain('paid_by should be the company')
    } finally {
      await srv.close()
    }
  })
})
