// Shared story setups (imported by several scenario files).
import type { NormalizedEvent } from '@agfn/contracts'
import { expect } from 'vitest'
import { accountIds, connectProvider, entities, signIn, type Server } from './harness.ts'

const usd = (m: number) => ({ minor: m, currency: 'USD' })
const MONTHS = ['2026-07', '2026-08', '2026-09'] as const

export async function founderStory(srv: Server) {
  const s = await signIn(srv, 'founder@example.com', 'Acme')
  for (const name of ['Bluebird', 'Harbor']) expect((await s.post('/api/entities', { name })).status).toBe(201)
  const E = await entities(s)

  // ---- one bank login, five accounts, three months of rows ----
  const bank = await connectProvider(srv, s, 'plaid', { name: 'Chase' })
  bank.push((c) => {
    const acct = (id: string, name: string, accountType: 'depository' | 'credit_card'): NormalizedEvent => ({ type: 'account.upsert', externalId: id, connectionId: c, name, accountType, currency: 'USD', institution: 'Chase' })
    const bal = (id: string, m: number): NormalizedEvent => ({ type: 'balance.snapshot', externalId: `bal_${id}`, connectionId: c, accountExternalId: id, at: '2026-10-09T08:00:00Z', current: usd(m) })
    const txn = (id: string, account: string, date: string, m: number, counterparty: string, extra: Record<string, unknown> = {}): NormalizedEvent =>
      ({ type: 'txn.upsert', externalId: id, connectionId: c, accountExternalId: account, date, amount: usd(m), status: 'posted', counterparty, rawText: counterparty.toUpperCase(), ...extra }) as NormalizedEvent
    const rows: NormalizedEvent[] = [
      acct('acme_chk', 'Acme Checking', 'depository'),
      acct('acme_card', 'Acme Card', 'credit_card'),
      acct('nex_chk', 'Bluebird Checking', 'depository'),
      acct('cla_chk', 'Harbor Checking', 'depository'),
      acct('pers_chk', 'Personal Checking', 'depository'),
      bal('acme_chk', 10_000_000),
      bal('acme_card', -30_000),
      bal('nex_chk', 5_000_000),
      bal('cla_chk', 2_000_000),
      bal('pers_chk', 750_000),
    ]
    for (const m of MONTHS) {
      rows.push(
        txn(`rent_${m}`, 'acme_chk', `${m}-01`, -400_000, 'WeWork'),
        txn(`aws_${m}`, 'acme_chk', `${m}-15`, -100_000, 'Amazon Web Services'),
        txn(`globex_${m}`, 'acme_chk', `${m}-20`, 200_000, 'Globex Corp'),
        // Card purchase, then the card payment: one expense, plus a transfer between own accounts.
        txn(`figma_${m}`, 'acme_card', `${m}-05`, -30_000, 'Figma'),
        txn(`cardpay_out_${m}`, 'acme_chk', `${m}-25`, -30_000, 'Chase Card Payment', { linkRefs: { card_payment: `cp_${m}` } }),
        txn(`cardpay_in_${m}`, 'acme_card', `${m}-25`, 30_000, 'Payment Thank You', { linkRefs: { card_payment: `cp_${m}` } }),
        txn(`upwork_${m}`, 'nex_chk', `${m}-10`, -1_500_000, 'Upwork'),
        // The Stripe payout landing two days after it left Stripe.
        txn(`stripe_dep_${m}`, 'nex_chk', `${m}-24`, 970_970, 'Stripe Transfer', { rawText: 'STRIPE TRANSFER ST-PAYOUT' }),
      )
    }
    return rows
  })
  expect((await bank.sync()).status).toBe('ok')
  const A = await accountIds(srv, bank.id)
  const assign = await s.post('/api/accounts/assign', {
    assignments: [
      { accountId: A.acme_chk, entityId: E.Acme },
      { accountId: A.acme_card, entityId: E.Acme },
      { accountId: A.nex_chk, entityId: E.Bluebird },
      { accountId: A.cla_chk, entityId: E.Harbor },
      { accountId: A.pers_chk, entityId: 'personal' },
    ],
  })
  expect(assign.status).toBe(200)

  // ---- Stripe for Bluebird: a charge, its fee, and the payout each month ----
  const stripe = await connectProvider(srv, s, 'stripe', { entityId: E.Bluebird })
  stripe.push((c) => {
    const rows: NormalizedEvent[] = [
      { type: 'account.upsert', externalId: 'stripe_bal', connectionId: c, name: 'Stripe balance', accountType: 'processor_balance', currency: 'USD', institution: 'Stripe' },
      { type: 'balance.snapshot', externalId: 'stripe_bal_now', connectionId: c, accountExternalId: 'stripe_bal', at: '2026-10-09T08:00:00Z', current: usd(0) },
    ]
    for (const m of MONTHS) {
      rows.push(
        { type: 'processor.balance_txn', externalId: `ch_${m}`, connectionId: c, accountExternalId: 'stripe_bal', at: `${m}-12T15:00:00Z`, kind: 'charge', gross: usd(1_000_000), fee: usd(29_030), net: usd(970_970), customer: 'Initech' },
        { type: 'processor.balance_txn', externalId: `po_${m}`, connectionId: c, accountExternalId: 'stripe_bal', at: `${m}-22T15:00:00Z`, kind: 'payout', gross: usd(-970_970), fee: usd(0), net: usd(-970_970), payoutExternalId: `po_${m}` },
      )
    }
    return rows
  })
  expect((await stripe.sync()).status).toBe('ok')
  return { s, E, bank, stripe }
}

