// A provider connected twice counts twice until the old connection is removed with its data.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('removing a connection with its data (%s)', (backend) => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('the same Xero documents from an old and a new connection are flagged, and stop counting twice once the old one is removed', async () => {
    const old = await k.connection({ entityId: acme, key: 'xero' })
    const now = await k.connection({ entityId: acme, key: 'xero' })
    const bank = await k.account({ entityId: acme, name: 'Chase' })
    const inv = (conn: string) => invoice(conn, { externalId: 'INV-0042', total: usd(91_726), issueDate: '2026-09-02', dueDate: '2026-10-02' })
    await k.engine.postBatch(k.ws, [inv(old), inv(now), invoice(old, { externalId: 'INV-0043', total: usd(5_000) }), txn(bank, '2026-09-20', 5_000, { counterparty: 'Globex Corp' })])
    await k.disconnect(old)
    expect(await k.bal(acme, 'ar', 'accrual')).toBeGreaterThanOrEqual(91_726 * 2) // counted twice
    const twice = (await k.engine.checks(k.ws)).filter((c) => c.name === 'duplicate_source')
    expect(twice).toHaveLength(1)
    expect(twice[0]?.message).toContain('(disconnected)')
    expect(twice[0]?.message).toContain('both posted the same 1 document, so they count twice. Remove the old connection with its data.')
    expect((await k.engine.dataHealth(k.ws)).line).toContain('1 source counted twice')

    expect(await k.engine.connectionRemoved(k.ws, old)).toBe(2)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(91_726)
    expect(await k.bal(acme, 'revenue', 'accrual')).toBe(-91_726)
    expect(await k.tb(acme, 'accrual')).toBe(0)
    expect((await k.engine.checks(k.ws)).filter((c) => c.name === 'duplicate_source')).toEqual([])
    // Nothing brings them back: the company's connections being re-resolved leaves them out.
    await k.engine.connectionChanged(k.ws, old)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(91_726)
    // Kept for the audit trail, not deleted.
    expect((await k.engine.store.listRecords(k.ws, { connectionId: old })).map((r) => r.status)).toEqual(['excluded', 'excluded'])
  })

  it('retireRecords: only some accounts, from a date on (balances either way), reversals of closed months on the first open day', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const chk = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    const sav = await k.account({ entityId: acme, name: 'Savings', connectionId: plaid })
    await k.engine.postBatch(k.ws, [
      txn(chk, '2026-08-10', -1_000, { counterparty: 'Old shop' }),
      txn(chk, '2026-09-10', -2_000, { counterparty: 'New shop' }),
      txn(sav, '2026-09-12', -4_000, { counterparty: 'Savings shop' }),
    ])
    await k.disconnect(plaid)
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-08-31' })
    // A newer connection reads Checking from Sep 1: the old one's Checking rows from then on stop counting.
    expect(await k.engine.retireRecords(k.ws, { connectionId: plaid, sourceAccountIds: [chk.id], from: '2026-09-01' })).toBe(1)
    expect(await k.bal(acme, `cash:${chk.id}`)).toBe(-1_000)
    expect(await k.bal(acme, `cash:${sav.id}`)).toBe(-4_000)
    // Everything, closed August included: August stays as reported, its reversal lands on September 1st.
    expect(await k.engine.retireRecords(k.ws, { connectionId: plaid })).toBe(2)
    expect(await k.bal(acme, `cash:${chk.id}`, 'cash', '2026-08-31')).toBe(-1_000)
    expect(await k.bal(acme, `cash:${chk.id}`)).toBe(0)
    expect(await k.bal(acme, `cash:${sav.id}`)).toBe(0)
    expect(await k.tb(acme)).toBe(0)
  })
})
