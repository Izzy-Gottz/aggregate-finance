// Transaction views read each row's entry kind for a whole page at once; it must match the one-at-a-time read.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('entry kinds for many sources (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })
  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
  })

  it('matches activeEntriesForSource for each source, and leaves out sources with no entries', async () => {
    const acme = await k.company('Acme')
    const conn = await k.connection({ entityId: acme, key: 'xero' })
    const bank = await k.account({ entityId: acme, name: 'Chase' })
    await k.engine.postBatch(k.ws, [invoice(conn, { externalId: 'INV-1', total: usd(5_000) }), txn(bank, '2026-09-20', 5_000, { counterparty: 'Globex' }), txn(bank, '2026-09-21', -1_200, { counterparty: 'Figma' })])
    const records = await k.engine.store.listRecords(k.ws)
    const ids = [...records.map((r) => r.id), 'no-such-record']
    const kinds = await k.engine.store.activeEntryKinds(k.ws, ids)
    for (const r of records) expect(kinds.get(r.id)).toBe((await k.engine.store.activeEntriesForSource(k.ws, r.id))[0]?.kind)
    expect(kinds.has('no-such-record')).toBe(false)
    expect(kinds.size).toBeGreaterThanOrEqual(2)
  })
})
