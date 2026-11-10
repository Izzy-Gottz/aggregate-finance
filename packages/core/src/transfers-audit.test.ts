// Money moving between a company's own accounts is never revenue, spending or burn: checking to savings, a card
// payment, a processor payout, Wise to the bank, and two banks through different connectors (Plaid and Mercury). A
// transfer with only one side connected is labelled, not counted; equal amounts alone never pair unrelated rows.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, stripe, txn, usd, type Kit } from './test-kit.ts'

describe('transfers between own accounts', () => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit('memory')
    acme = await k.company('Acme')
    for (const d of ['2026-09-10', '2026-09-11', '2026-09-30', '2026-10-09']) k.rates.set(d, 'EUR', 'USD', '1.10')
  })
  afterEach(async () => {
    await k.close()
  })
  const sept = () => ({ workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' })
  const flows = async () => ({
    gross: (await k.engine.metric('gross_burn', sept())).value,
    revenue: (await k.engine.metric('revenue', sept())).value,
  })
  const confirmed = async (type: string) => (await k.engine.store.listLinks(k.ws, { types: [type as never], statuses: ['confirmed'] })).length

  it('checking to savings: one transfer, no revenue or spending', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    const sav = await k.account({ entityId: acme, name: 'Savings', connectionId: plaid })
    await k.engine.postBatch(k.ws, [txn(chk, '2026-09-10', -500_000, { rawText: 'ONLINE TRANSFER TO SAV 4321' }), txn(sav, '2026-09-10', 500_000, { rawText: 'ONLINE TRANSFER FROM CHK 1234' })])
    expect(await confirmed('transfer')).toBe(1)
    expect(await k.bal(acme, 'clearing_transfers')).toBe(0)
    expect(await flows()).toEqual({ gross: usd(0), revenue: usd(0) })
  })

  it('a card payment from checking: the purchases are the spending, the payment is not', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    const card = await k.account({ entityId: acme, name: 'Amex', type: 'credit_card', connectionId: plaid })
    await k.engine.postBatch(k.ws, [
      txn(card, '2026-09-03', -30_000, { counterparty: 'Notion' }),
      txn(chk, '2026-09-20', -30_000, { rawText: 'AMEX EPAYMENT ACH PMT' }),
      txn(card, '2026-09-19', 30_000, { rawText: 'PAYMENT RECEIVED - THANK YOU' }),
    ])
    expect(await confirmed('card_payment')).toBe(1)
    expect(await flows()).toEqual({ gross: usd(30_000), revenue: usd(0) })
  })

  it('a Stripe payout to the bank: revenue is the sales, the deposit is not revenue again', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const st = await k.account({ entityId: acme, type: 'processor_balance', name: 'Stripe' })
    const bank = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    await k.engine.postBatch(k.ws, [stripe(st, '2026-09-01', 'charge', 10_000, 320), stripe(st, '2026-09-03', 'payout', -9_680, 0), txn(bank, '2026-09-05', 9_680, { rawText: 'STRIPE PAYOUT' })])
    expect(await confirmed('payout')).toBe(1)
    expect(await flows()).toEqual({ gross: usd(320), revenue: usd(10_000) })
  })

  it('Wise euros to the dollar bank: a transfer (with its FX), not income or spending', async () => {
    const wiseConn = await k.connection({ entityId: acme, key: 'wise' })
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const wise = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR', connectionId: wiseConn })
    const bank = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    await k.engine.postBatch(k.ws, [txn(wise, '2026-09-10', -100_000, { rawText: 'TRANSFER TO ACME CHECKING' }), txn(bank, '2026-09-11', 109_000, { rawText: 'WISE TRANSFER' })])
    expect(await confirmed('transfer')).toBe(1)
    expect(await flows()).toEqual({ gross: usd(0), revenue: usd(0) })
  })

  it('Plaid checking to a Mercury account (two connectors): one transfer', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const merc = await k.connection({ entityId: acme, key: 'mercury' })
    const chk = await k.account({ entityId: acme, name: 'Chase Checking', connectionId: plaid })
    const mer = await k.account({ entityId: acme, name: 'Mercury', connectionId: merc })
    await k.engine.postBatch(k.ws, [txn(chk, '2026-09-10', -2_500_000, { rawText: 'ONLINE TRANSFER TO MERCURY' }), txn(mer, '2026-09-11', 2_500_000, { rawText: 'Transfer from Chase' })])
    expect(await confirmed('transfer')).toBe(1)
    expect(await flows()).toEqual({ gross: usd(0), revenue: usd(0) })
  })

  it('a transfer out with the other side not connected is labelled plainly where it counts as spending', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    // The bank calls it a transfer, but it may be a payment: it stays spending until someone says, and burn says so.
    await k.engine.postBatch(k.ws, [txn(chk, '2026-08-10', -10_000, { counterparty: 'Rent' }), txn(chk, '2026-09-10', -500_000, { rawText: 'ONLINE TRANSFER TO SAV 4321', categoryHint: 'TRANSFER_OUT_ACCOUNT_TRANSFER' })])
    const burn = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [acme] })
    expect(burn.coverage?.gaps ?? []).toContainEqual('$5,000.00 the bank calls transfers to another account counts as spending, because no matching deposit was found in a connected account')
    expect((await k.engine.metric('revenue', sept())).value).toEqual(usd(0))
  })

  it('a transfer in from an account not connected is not revenue', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    await k.engine.postBatch(k.ws, [txn(chk, '2026-09-10', 500_000, { rawText: 'ONLINE TRANSFER FROM SAV 4321', categoryHint: 'TRANSFER_IN_ACCOUNT_TRANSFER' })])
    expect(await flows()).toEqual({ gross: usd(0), revenue: usd(0) })
  })

  it('$12,000 rent out and a $12,000 customer payment in are never one transfer', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    const sav = await k.account({ entityId: acme, name: 'Savings', connectionId: plaid })
    await k.engine.postBatch(k.ws, [txn(chk, '2026-09-01', -1_200_000, { counterparty: 'Landlord LLC', rawText: 'LANDLORD LLC RENT' }), txn(sav, '2026-09-02', 1_200_000, { counterparty: 'Globex', rawText: 'GLOBEX ACH PMT', categoryHint: 'INCOME_SALES' })])
    expect(await confirmed('transfer')).toBe(0)
    const burn = await k.engine.metric('gross_burn', sept())
    expect(burn.value).toEqual(usd(1_200_000))
  })
})
