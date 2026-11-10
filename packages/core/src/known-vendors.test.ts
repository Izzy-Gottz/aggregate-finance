// A vendor known by name books to its own kind of spending, whatever the provider guessed. Real case: Plaid read the
// Fly.io hosting charge (Capital One card, Personal) as an airline (TRAVEL_FLIGHTS) on 2026-11-02 and gave the
// 2026-10-02 one no usable category, so the same vendor landed in Travel one month and Uncategorized the next.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Backend, type Kit } from './test-kit.ts'
import { MATCHER_VERSION } from './matching.ts'
import { knownVendorRole } from './known-vendors.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']

// What the Plaid mapper (packages/connectors/plaid/src/map.ts mapTxn) makes of Plaid's rows: counterparty from
// merchant_name, rawText from original_description, categoryHint from personal_finance_category.detailed, and the sign
// flipped (Plaid's +132.59 is money out). plaid.test.ts checks the mapper side of the same rows.
const flyNov = { counterparty: 'Fly.io', rawText: 'FLY.IO 8445759466 DE', categoryHint: 'TRAVEL_FLIGHTS', externalId: 'fly-2026-11' }
const flyOct = { counterparty: 'FLY.IO', rawText: 'FLY.IO FLY.IO DE', categoryHint: 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES', externalId: 'fly-2026-10' }

describe('knownVendorRole', () => {
  it('knows hosting and developer tools by name, never by a plain word', () => {
    expect(knownVendorRole({ counterparty: 'Fly.io' })).toBe('cloud')
    expect(knownVendorRole({ rawText: 'FLY.IO 8445759466 DE' })).toBe('cloud')
    expect(knownVendorRole({ counterparty: 'Vercel Inc.' })).toBe('cloud')
    expect(knownVendorRole({ rawText: 'CLOUDFLARE CLOUDFLARE.COM CA' })).toBe('cloud')
    expect(knownVendorRole({ rawText: 'AWS EMEA aws.amazon.co LU' })).toBe('cloud')
    expect(knownVendorRole({ counterparty: 'Amazon Web Services' })).toBe('cloud')
    expect(knownVendorRole({ rawText: 'NEON.TECH SAN FRANCISCO CA' })).toBe('cloud')
    // Plaid's two names for Neon's charges: "Neon Tech" (11-02, was uncategorized) and "Neon.tech" (10-02, was
    // entertainment).
    expect(knownVendorRole({ counterparty: 'Neon Tech' })).toBe('cloud')
    expect(knownVendorRole({ counterparty: 'Neon.tech' })).toBe('cloud')
    expect(knownVendorRole({ counterparty: 'NEONTECH' })).toBe('cloud')
    expect(knownVendorRole({ rawText: 'MSFT * AZURE' })).toBe('cloud')
    expect(knownVendorRole({ counterparty: 'GitHub' })).toBe('software')
    expect(knownVendorRole({ rawText: 'GITHUB, INC. HTTPSGITHUB.C CA' })).toBe('software')
    // Not these: an airline, a café, a bar, a train, a shop, the Amazon store.
    for (const text of ['SPIRIT AIRLINES FLY', 'FLYING BISCUIT CAFE', 'NEON LOUNGE BAR', 'AMTRAK RAILWAY', 'AZURE NAIL SALON', 'AMAZON.COM*AB12C', 'AMZN Mktp US', 'LAWSON STATION'])
      expect(knownVendorRole({ counterparty: text, rawText: text })).toBeNull()
  })
})

describe.each(backends)('known vendors (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('Fly.io books to Cloud every month, whatever Plaid guessed', async () => {
    k = await makeKit(backend)
    const me = await k.personal('Me')
    const card = await k.account({ entityId: me })
    await k.engine.postBatch(k.ws, [txn(card, '2026-10-02', -1_592, flyOct), txn(card, '2026-11-02', -13_259, flyNov)])
    expect(await k.bal(me, 'cloud')).toBe(14_851)
    expect(await k.bal(me, 'travel')).toBe(0)
    expect(await k.bal(me, 'uncategorized_expense')).toBe(0)
  })

  it('Neon books to Cloud under both names Plaid gave it', async () => {
    k = await makeKit(backend)
    const me = await k.personal('Me')
    const card = await k.account({ entityId: me })
    await k.engine.postBatch(k.ws, [
      txn(card, '2026-10-02', -523, { counterparty: 'Neon.tech', rawText: 'NEON.TECH', categoryHint: 'ENTERTAINMENT_TV_AND_MOVIES', externalId: 'neon-2026-10' }),
      txn(card, '2026-11-02', -5_413, { counterparty: 'Neon Tech', rawText: 'NEON TECH', externalId: 'neon-2026-11' }),
      txn(card, '2026-11-03', -4_000, { counterparty: 'Neon Lounge', rawText: 'NEON LOUNGE', categoryHint: 'FOOD_AND_DRINK_RESTAURANT', externalId: 'bar' }),
    ])
    expect(await k.bal(me, 'cloud')).toBe(5_936)
    expect(await k.bal(me, 'entertainment')).toBe(0)
    expect(await k.bal(me, 'uncategorized_expense')).toBe(0)
    expect(await k.bal(me, 'meals')).toBe(4_000)
  })

  it('a category someone set still wins', async () => {
    k = await makeKit(backend)
    const me = await k.personal('Me')
    const card = await k.account({ entityId: me })
    await k.engine.postBatch(k.ws, [txn(card, '2026-11-02', -13_259, flyNov)])
    const [row] = await k.engine.store.listRecords(k.ws, { sourceAccountId: card.id })
    await k.engine.setOverride(k.ws, row!.id, { category: 'software' }, null)
    expect(await k.bal(me, 'software')).toBe(13_259)
    expect(await k.bal(me, 'cloud')).toBe(0)
  })

  it("decides only the kind of spending: a refund stays a refund, other money in stays asked about", async () => {
    k = await makeKit(backend)
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    await k.engine.postBatch(k.ws, [
      // Plaid calls the Fly.io credit a flight refund: it lowers Cloud, not Travel.
      txn(bank, '2026-11-05', 2_000, { ...flyNov, externalId: 'fly-refund' }),
      // A GitHub Sponsors payout with no category is not a software refund: it may be income, so it's asked about.
      txn(bank, '2026-11-06', 5_000, { counterparty: 'GitHub Sponsors', rawText: 'GITHUB SPONSORS PAYOUT', externalId: 'gh-sponsors' }),
    ])
    expect(await k.bal(acme, 'cloud')).toBe(-2_000)
    expect(await k.bal(acme, 'travel')).toBe(0)
    expect(await k.bal(acme, 'software')).toBe(0)
    expect(await k.bal(acme, 'suspense')).toBe(-5_000)
  })

  it("a workspace whose rows an older release posted, never stamped, is re-filed on the new release's first settle", async () => {
    // Live v188, 11-10: during the deploy's overlap the old machine filled a demo (GitHub to Uncategorized) and the
    // new one's first settle stamped it current, so the rows were never planned again.
    k = await makeKit(backend)
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'demo' })
    const bank = await k.account({ entityId: acme, connectionId: conn })
    const store = k.engine.store as { setMatchedWith: (...a: unknown[]) => Promise<void> }
    const stamp = store.setMatchedWith
    store.setMatchedWith = async () => {} // the old release: plans without the vendor list, stamps nothing yet
    await k.engine.postBatch(k.ws, [txn(bank, '2026-10-12', -8_400, { counterparty: 'Placeholder', rawText: 'placeholder', categoryHint: 'GENERAL_SERVICES_OTHER', externalId: 'gh-oct' })])
    store.setMatchedWith = stamp
    const [row] = await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id })
    if (row?.event.type === 'txn.upsert') await k.engine.store.saveRecord({ ...row, event: { ...row.event, counterparty: 'GitHub', rawText: 'GITHUB INC' } })
    expect(await k.bal(acme, 'uncategorized_expense')).toBe(8_400)
    expect(await k.engine.store.matchedWith(k.ws)).toBeNull()

    await k.engine.settle(k.ws, conn)
    expect(await k.bal(acme, 'software')).toBe(8_400)
    expect(await k.bal(acme, 'uncategorized_expense')).toBe(0)
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
  })

  it("a fresh workspace starts current at its first post, so its own import isn't matched twice", async () => {
    k = await makeKit(backend)
    const acme = await k.company('Acme')
    const bank = await k.account({ entityId: acme })
    expect(await k.engine.store.matchedWith(k.ws)).toBeNull()
    await k.engine.postBatch(k.ws, [txn(bank, '2026-10-12', -8_400, { counterparty: 'GitHub', rawText: 'GITHUB INC', externalId: 'gh' })])
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
    expect(await k.bal(acme, 'software')).toBe(8_400)
  })

  it('rows booked before this move once, on the next settle', async () => {
    k = await makeKit(backend)
    const me = await k.personal('Me')
    const conn = await k.connection({ entityId: me, key: 'plaid' })
    const card = await k.account({ entityId: me, connectionId: conn })
    // Booked as it was: November's guess was travel, October had none a rule knew.
    await k.engine.postBatch(k.ws, [
      txn(card, '2026-10-02', -1_592, { ...flyOct, counterparty: 'Placeholder', rawText: 'placeholder' }),
      txn(card, '2026-11-02', -13_259, { ...flyNov, counterparty: 'Placeholder', rawText: 'placeholder' }),
    ])
    expect(await k.bal(me, 'travel')).toBe(13_259)
    expect(await k.bal(me, 'uncategorized_expense')).toBe(1_592)
    // The stored rows carry Plaid's real names (as they always did); only the rule is new.
    const rows = await k.engine.store.listRecords(k.ws, { sourceAccountId: card.id })
    for (const r of rows) if (r.event.type === 'txn.upsert') {
      const real = r.externalId === 'fly-2026-10' ? flyOct : flyNov
      await k.engine.store.saveRecord({ ...r, event: { ...r.event, counterparty: real.counterparty, rawText: real.rawText } })
    }
    await k.engine.store.setMatchedWith(k.ws, MATCHER_VERSION - 1, '2026-11-01T00:00:00.000Z')

    await k.engine.settle(k.ws, conn)
    expect(await k.bal(me, 'cloud')).toBe(14_851)
    expect(await k.bal(me, 'travel')).toBe(0)
    expect(await k.bal(me, 'uncategorized_expense')).toBe(0)
    expect(await k.engine.store.matchedWith(k.ws)).toBe(MATCHER_VERSION)
    await k.engine.settle(k.ws, conn)
    expect(await k.bal(me, 'cloud')).toBe(14_851)
  })
})
