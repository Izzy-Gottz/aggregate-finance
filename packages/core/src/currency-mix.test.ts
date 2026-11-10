// Totals never add a foreign amount to dollars as if it were dollars, and two rows of the same number in different
// currencies are never one transfer. Each path converts at the day's rate or leaves the amount out and says so.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, txn, usd, type Kit } from './test-kit.ts'

describe('currency mixing', () => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit('memory')
    acme = await k.company('Acme')
    for (const d of ['2026-09-01', '2026-09-10', '2026-09-15', '2026-09-30', '2026-10-09']) k.rates.set(d, 'EUR', 'USD', '1.10').set(d, 'GBP', 'USD', '1.30')
  })
  afterEach(async () => {
    await k.close()
  })
  const scope = () => ({ workspaceId: k.ws, entityIds: [acme] })

  it('cash adds a Wise euro balance at the day rate, not as dollars', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const wise = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-09', 100_000), snapshot(wise, '2026-10-09', 100_000)])
    expect((await k.engine.metric('cash', scope())).value).toEqual(usd(210_000))
  })

  it('burn, revenue and the P&L convert each foreign row at its own day', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const wise = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-09-10', -20_000, { counterparty: 'Rent' }),
      txn(wise, '2026-09-10', -10_000, { counterparty: 'Hetzner' }),
      txn(bank, '2026-09-15', 30_000, { counterparty: 'Client A', categoryHint: 'INCOME_SALES' }),
      txn(wise, '2026-09-15', 30_000, { counterparty: 'Kunde B', categoryHint: 'INCOME_SALES' }),
    ])
    const sept = { ...scope(), from: '2026-09-01', to: '2026-09-30' }
    expect((await k.engine.metric('gross_burn', sept)).value).toEqual(usd(31_000))
    expect((await k.engine.metric('net_burn', sept)).value).toEqual(usd(31_000 - 63_000))
    expect((await k.engine.metric('revenue', sept)).value).toEqual(usd(63_000))
    const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
    expect(pl.revenue.total).toEqual(usd(63_000))
    expect(pl.netIncome).toEqual(usd(63_000 - 31_000))
  })

  it('the balance sheet values a pound balance in dollars and still balances', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const gbp = await k.account({ entityId: acme, name: 'PayPal GBP', currency: 'GBP' })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-09-30', 100_000), snapshot(gbp, '2026-09-30', 100_000)])
    const bs = await k.engine.balanceSheet(k.ws, { entityIds: [acme], asOf: '2026-09-30', basis: 'cash' })
    expect(bs.assets.total).toEqual(usd(230_000))
    expect(bs.difference).toBe(0)
  })

  it('$100 out and £100 in on the same day are not one transfer (£100 is $130)', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const gbp = await k.account({ entityId: acme, name: 'Wise GBP', currency: 'GBP' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-09-15', -10_000, { rawText: 'TRANSFER' }), txn(gbp, '2026-09-15', 10_000, { rawText: 'TRANSFER' })])
    expect(await k.engine.store.listLinks(k.ws, { types: ['transfer'] })).toEqual([])
    expect(await k.engine.suggestLinks(k.ws)).toEqual([])
  })

  it('€250 out and $250 in is at most a transfer for Review, never confirmed (€250 is $275)', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const wise = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    await k.engine.postBatch(k.ws, [txn(wise, '2026-09-15', -25_000, { rawText: 'TRANSFER' }), txn(bank, '2026-09-15', 25_000, { rawText: 'TRANSFER' })])
    // Inside the 10% FX band, so it's asked about; equal numbers alone never make it an exact match.
    for (const p of await k.engine.suggestLinks(k.ws)) expect(p.confidence).toBeLessThanOrEqual(0.75)
    expect(await k.engine.store.listLinks(k.ws, { types: ['transfer'], statuses: ['confirmed'] })).toEqual([])
  })

  it('a Coinbase crypto wallet is left out of cash, and the answer says why', async () => {
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const btc = await k.account({ entityId: acme, name: 'Coinbase BTC', currency: 'XXX' })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-09', 100_000), snapshot(btc, '2026-10-09', 100_000)])
    const cash = await k.engine.metric('cash', scope())
    expect(cash.value).toEqual(usd(100_000))
    expect(cash.excludedAccounts).toContainEqual(expect.objectContaining({ id: btc.id, reason: 'not money (points or crypto)' }))
  })
  it('a euro debit never makes a dollar payroll run "add up"', async () => {
    const conn = await k.connection({ entityId: acme, key: 'gusto' })
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const wise = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    const tax = txn(wise, '2026-09-15', -326_500, { rawText: 'GUSTO TAX 8812' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-09-14', -750_000, { rawText: 'GUSTO NET 8812' }), tax])
    await k.engine.post(k.ws, { type: 'payroll.run', externalId: 'run-1', connectionId: conn, payDate: '2026-09-15', gross: usd(1_000_000), employerTaxes: usd(76_500), net: usd(750_000), employeeTaxes: usd(250_000), companyDebit: usd(1_076_500), status: 'paid' })
    const [taxRec] = await k.engine.store.listRecords(k.ws, { sourceAccountId: wise.id })
    expect((await k.engine.store.listLinks(k.ws, { types: ['payroll_settlement'] })).filter((l) => l.toId === taxRec!.id)).toEqual([])
  })
})
