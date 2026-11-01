// Provider category hints (Plaid personal_finance_category.detailed) pick the expense account for spending: groceries
// are not eating out, and travel includes getting around.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Backend, type Kit } from './test-kit.ts'
import { MATCHER_VERSION } from './matching.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('category hints (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('Plaid food and drink: restaurants, fast food and coffee are meals; groceries and liquor stores are not', async () => {
    k = await makeKit(backend)
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    const spend = (minor: number, categoryHint: string) => txn(bank, '2026-10-02', -minor, { categoryHint, externalId: categoryHint })
    await k.engine.postBatch(k.ws, [
      spend(4_000, 'FOOD_AND_DRINK_RESTAURANT'),
      spend(1_200, 'FOOD_AND_DRINK_FAST_FOOD'),
      spend(500, 'FOOD_AND_DRINK_COFFEE'),
      spend(300, 'FOOD_AND_DRINK_VENDING_MACHINES'),
      spend(9_000, 'FOOD_AND_DRINK_GROCERIES'),
      spend(2_500, 'FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR'),
      spend(6_000, 'TRANSPORTATION_GAS'),
      spend(800, 'TRANSPORTATION_PARKING'),
      spend(15_000, 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY'),
      spend(4_500, 'RENT_AND_UTILITIES_WATER'),
      spend(7_000, 'RENT_AND_UTILITIES_INTERNET_AND_CABLE'),
      spend(240_000, 'RENT_AND_UTILITIES_RENT'),
      spend(30_000, 'TRAVEL_FLIGHTS'),
      spend(342_000, 'LOAN_PAYMENTS_MORTGAGE_PAYMENT'),
      spend(27_125, 'GENERAL_MERCHANDISE'),
      spend(2_299, 'ENTERTAINMENT_TV_AND_MOVIES'),
    ])
    expect(await k.bal(acme, 'meals')).toBe(6_000)
    expect(await k.bal(acme, 'groceries')).toBe(11_500)
    expect(await k.bal(acme, 'travel')).toBe(36_800)
    // Utilities are their own line; rent is the rent.
    expect(await k.bal(acme, 'utilities')).toBe(26_500)
    expect(await k.bal(acme, 'rent')).toBe(240_000)
    expect(await k.bal(acme, 'housing')).toBe(342_000)
    expect(await k.bal(acme, 'shopping')).toBe(27_125)
    expect(await k.bal(acme, 'entertainment')).toBe(2_299)
    expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
  })
})

describe.each(backends)('utilities posted as rent before they had their own account (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('move to Utilities once, on the next settle; a category someone chose stays', async () => {
    k = await makeKit(backend)
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'plaid' })
    const bank = await k.account({ entityId: acme, connectionId: conn })
    // Posted when utilities still went to rent: the rows' provider category is rent's, then said "power".
    await k.engine.postBatch(k.ws, [
      txn(bank, '2026-08-18', -61_000, { categoryHint: 'RENT_AND_UTILITIES_RENT', externalId: 'power-aug' }),
      txn(bank, '2026-09-18', -58_000, { categoryHint: 'RENT_AND_UTILITIES_RENT', externalId: 'power-sep' }),
    ])
    const rows = await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id })
    const sep = rows.find((r) => r.externalId === 'power-sep')!
    await k.engine.setOverride(k.ws, sep.id, { category: 'rent' }, null)
    for (const r of rows) if (r.event.type === 'txn.upsert') await k.engine.store.saveRecord({ ...r, event: { ...r.event, categoryHint: 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY' } })
    await k.engine.store.setMatchedWith(k.ws, 4, '2026-10-01T00:00:00.000Z')
    expect(await k.bal(acme, 'rent')).toBe(119_000)

    await k.engine.settle(k.ws, conn)
    expect(await k.bal(acme, 'utilities')).toBe(61_000)
    expect(await k.bal(acme, 'rent')).toBe(58_000)
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
    // Once: a settle with nothing new does nothing.
    await k.engine.settle(k.ws, conn)
    expect(await k.bal(acme, 'utilities')).toBe(61_000)
  })
})
