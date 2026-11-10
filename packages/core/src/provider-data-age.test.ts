// A provider whose terms cap how old its data may be when shown (Etsy's API Terms: 24 hours). Past the cap since the
// last good sync, its current figures are out of date: its balance is left out of cash (labeled), revenue for a period
// running into today is unknown with the reason, and closed past months stay exactly as recorded. On a real database
// (SQLite and PGlite), through KyselyDirectory and the connector's own limit.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, stripe, snapshot, usd, type Backend, type Kit } from './test-kit.ts'
import type { KyselyDirectory } from './kysely-store.ts'

const NOW = '2026-10-09T12:00:00.000Z'
const hoursAgo = (h: number) => new Date(Date.parse(NOW) - h * 3_600_000).toISOString()

describe.each<Backend>(['sqlite', 'pglite'])('provider data-age cap (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k?.close()
  })

  /** A company with a bank (US$1,000) and an Etsy balance: a US$300 sale in September and a US$200 sale in October. */
  async function setup(etsySyncedHoursAgo: number, key = 'etsy') {
    k = await makeKit(backend, { now: NOW, staleAfterHours: (c) => (c === 'etsy' ? 24 : undefined) })
    const acme = await k.company('Acme')
    const bankConn = await k.connection({ key: 'bank', entityId: acme })
    const bank = await k.account({ entityId: acme, name: 'Checking', connectionId: bankConn })
    const shopConn = await k.connection({ key, entityId: acme, lastSuccessAt: hoursAgo(etsySyncedHoursAgo), createdAt: '2026-08-01T00:00:00.000Z' })
    const shop = await k.account({ entityId: acme, name: 'Etsy (USD)', type: 'processor_balance', connectionId: shopConn })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-08', 100_000), stripe(shop, '2026-09-10', 'charge', 30_000, 0), stripe(shop, '2026-10-05', 'charge', 20_000, 0)])
    const m = (name: 'cash' | 'revenue', from?: string, to?: string) => k.engine.metric(name, { workspaceId: k.ws, entityIds: [acme], ...(from ? { from } : {}), ...(to ? { to } : {}) })
    return { m, shop, acme }
  }

  it('within 24 hours: counted as usual', async () => {
    const { m } = await setup(2)
    const cash = await m('cash')
    expect(cash.state).toBe('ok')
    expect(cash.value).toEqual(usd(150_000))
    const oct = await m('revenue', '2026-10-01', '2026-10-31')
    expect(oct.value).toEqual(usd(20_000))
  })

  it('past 24 hours: the Etsy balance is left out of cash and says why; current revenue is unknown; September is unchanged', async () => {
    const { m, shop, acme } = await setup(30)
    const cash = await m('cash')
    expect(cash.value).toEqual(usd(100_000))
    expect(cash.state).toBe('stale')
    expect(cash.unknownReason).toMatch(/^etsy last synced Oct 8; out of date \(over 24 hours\), so not counted until it syncs again$/)
    expect(cash.excludedAccounts).toContainEqual({ id: shop.id, reason: expect.stringMatching(/out of date/) })
    expect(cash.includedAccounts).not.toContain(shop.id)

    const oct = await m('revenue', '2026-10-01', '2026-10-31')
    expect(oct.value).toBeNull()
    expect(oct.state).toBe('unknown')
    expect(oct.unknownReason).toMatch(/out of date \(over 24 hours\)/)

    const sep = await m('revenue', '2026-09-01', '2026-09-30')
    expect(sep.value).toEqual(usd(30_000))
    // Cash as of a closed past day keeps the Etsy balance it had then.
    const pastCash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme], to: '2026-09-30' })
    expect(pastCash.includedAccounts).toContain(shop.id)
    expect(pastCash.excludedAccounts.some((x) => /out of date/.test(x.reason))).toBe(false)
  })

  it('a connector without a cap keeps the general rules, however old', async () => {
    const { m } = await setup(30, 'stripe')
    const cash = await m('cash')
    expect(cash.value).toEqual(usd(150_000))
    expect(cash.excludedAccounts.some((x) => /out of date/.test(x.reason))).toBe(false)
  })

  it('the next good sync brings it back', async () => {
    const { m } = await setup(30)
    expect((await m('cash')).value).toEqual(usd(100_000))
    k.setNow(hoursAgo(-1))
    // A fresh success, as the sync engine records it.
    await (k.engine.directory as KyselyDirectory).scope.q().updateTable('connections').set({ last_success_at: hoursAgo(-1) }).where('connector_key', '=', 'etsy').execute()
    const cash = await m('cash')
    expect(cash.value).toEqual(usd(150_000))
    expect(cash.state).toBe('ok')
  })
})
