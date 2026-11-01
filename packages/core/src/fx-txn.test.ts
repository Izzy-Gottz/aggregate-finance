// A ledger transaction never waits on the network: FX rates are fetched before or after it, never during.
import { afterEach, describe, expect, it } from 'vitest'
import { CachedRateSource, FrankfurterRateSource } from './fx.ts'
import type { LedgerStore } from './store.ts'
import { makeKit, txn, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

/** A fake Frankfurter: EUR→USD 1.10 every weekday; records each request and whether a transaction was open. */
function fakeFrankfurter(store: () => LedgerStore | null) {
  const calls: Array<{ url: string; inTx: boolean }> = []
  const weekday = (d: string) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
  const fakeFetch = (async (url: string) => {
    calls.push({ url, inTx: store()?.inTransaction?.() ?? false })
    const m = /\/v1\/(\d{4}-\d{2}-\d{2})(?:\.\.(\d{4}-\d{2}-\d{2}))?\?base=(\w+)&symbols=(\w+)/.exec(url)
    if (!m) return new Response('bad', { status: 400 })
    const [, start, end, from, to] = m as unknown as [string, string, string | undefined, string, string]
    const rate = from === 'EUR' && to === 'USD' ? 1.1 : from === 'USD' && to === 'EUR' ? 1 / 1.1 : null
    if (rate === null) return new Response('{}', { status: 422 })
    if (!end) return Response.json({ date: start, rates: { [to]: rate } })
    const rates: Record<string, Record<string, number>> = {}
    for (let d = start; d <= end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) if (weekday(d)) rates[d] = { [to]: rate }
    return Response.json({ rates })
  }) as unknown as typeof fetch
  return { calls, fetch: fakeFetch }
}

describe.each(backends)('FX outside transactions (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('posting a foreign-currency row fetches its rate outside the transaction, then posts', async () => {
    let store: LedgerStore | null = null
    const fx = fakeFrankfurter(() => store)
    k = await makeKit(backend, {
      rates: (s) => {
        store = s
        return new CachedRateSource(s, new FrankfurterRateSource({ fetch: fx.fetch, sleep: async () => undefined }))
      },
    })
    const acme = await k.company('Acme')
    const eur = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    const usdBank = await k.account({ entityId: acme, name: 'Chase' })
    await k.engine.postBatch(k.ws, [
      txn(eur, '2026-09-07', { minor: -10_000, currency: 'EUR' }, { counterparty: 'Hetzner' }),
      txn(eur, '2026-09-08', { minor: -20_000, currency: 'EUR' }, { counterparty: 'OVH' }),
      txn(usdBank, '2026-09-08', -5_000),
    ])
    expect(fx.calls.length).toBeGreaterThan(0)
    expect(fx.calls.filter((c) => c.inTx)).toEqual([])
    // One ranged request covered both days.
    expect(fx.calls.some((c) => c.url.includes('..'))).toBe(true)
    expect(await k.bal(acme, `cash:${eur.id}`)).toBe(-33_000)
    expect(await k.tb(acme)).toBe(0)

    // Cached now: a later row in range posts with no request at all.
    const before = fx.calls.length
    await k.engine.post(k.ws, txn(eur, '2026-09-08', { minor: -1_000, currency: 'EUR' }, { counterparty: 'OVH again' }))
    expect(fx.calls.length).toBe(before)
  })

  it('a writer apply that needs a rate retries outside its transaction too', async () => {
    let store: LedgerStore | null = null
    const fx = fakeFrankfurter(() => store)
    k = await makeKit(backend, {
      rates: (s) => {
        store = s
        return new CachedRateSource(s, new FrankfurterRateSource({ fetch: fx.fetch, sleep: async () => undefined }))
      },
    })
    const acme = await k.company('Acme')
    const eur = await k.account({ entityId: acme, name: 'Wise EUR', currency: 'EUR' })
    await k.engine.transaction(async () => {
      await k.engine.post(k.ws, txn(eur, '2026-09-09', { minor: 7_000, currency: 'EUR' }, { counterparty: 'Client' }))
    })
    expect(fx.calls.filter((c) => c.inTx)).toEqual([])
    expect(await k.bal(acme, `cash:${eur.id}`)).toBe(7_700)
  })
})
