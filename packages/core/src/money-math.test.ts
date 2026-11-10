// Money arithmetic: totals add integer minor units (1,000 rows of $0.10 are exactly $100.00 in the P&L, burn and
// cash), and yen (no decimals) and dinars (three) are never 100× or 10× off in the ledger or in text.
import { afterEach, describe, expect, it } from 'vitest'
import { formatMoney } from './money.ts'
import { makeKit, txn, usd, type Kit } from './test-kit.ts'

const N = Number(process.env.MM_N ?? 1_000)

describe('money arithmetic', () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('1,000 rows of $0.10 are exactly $100.00 in the P&L, burn and cash', async () => {
    k = await makeKit('memory')
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    const day = (i: number) => `2026-09-${String(1 + (i % 30)).padStart(2, '0')}`
    const rows = Array.from({ length: N }, (_, i) => [txn(bank, day(i), 10, { counterparty: `Client ${i}`, categoryHint: 'INCOME_SALES', externalId: `in-${i}` }), txn(bank, day(i), -10, { counterparty: `Vendor ${i}`, externalId: `out-${i}` })]).flat()
    await k.engine.postBatch(k.ws, rows)
    const sept = { workspaceId: k.ws, entityIds: [acme], from: '2026-09-01', to: '2026-09-30' }
    const pl = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-30', basis: 'cash' })
    expect([pl.revenue.total, pl.operatingExpenses.total, pl.netIncome]).toEqual([usd(N * 10), usd(N * 10), usd(0)])
    // One account, so no money-in row is a candidate transfer for a money-out row (1,000 × 1,000 pairs); cash nets to 0.
    // A section's total is the sum of its lines, to the cent.
    for (const sec of [pl.revenue, pl.operatingExpenses]) expect(sec.lines.reduce((t, l) => t + l.amount.minor, 0)).toBe(sec.total.minor)
    expect((await k.engine.metric('gross_burn', sept)).value).toEqual(usd(N * 10))
    expect((await k.engine.metric('revenue', sept)).value).toEqual(usd(N * 10))
    expect((await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(0))
  })

  it('a yen company and a dinar company keep their own minor units, in figures and text', async () => {
    k = await makeKit('memory', { reporting: 'JPY' })
    const tokyo = await k.company('Tokyo KK', { currency: 'JPY' })
    const bank = await k.account({ entityId: tokyo, name: 'MUFG', currency: 'JPY' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-09-15', -1_000, { counterparty: 'Rent' })])
    const burn = await k.engine.metric('gross_burn', { workspaceId: k.ws, entityIds: [tokyo], from: '2026-09-01', to: '2026-09-30' })
    expect(burn.value).toEqual({ minor: 1_000, currency: 'JPY' })
    expect(formatMoney(1_000, 'JPY')).toBe('¥1,000')
    expect(formatMoney(1_234, 'KWD').replace(/\s/g, ' ')).toBe('KWD 1.234')
    expect(formatMoney(1_234, 'BHD').replace(/\s/g, ' ')).toBe('BHD 1.234')
  })
})
