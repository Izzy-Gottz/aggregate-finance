// A completed full listing (QuickBooks past its 30-day change window, Xero re-lists) shows deletions only by leaving
// records out: those of its kinds that it didn't carry are voided, within safety limits, and come back if re-sent.
import { afterEach, describe, expect, it } from 'vitest'
import type { CreditNoteUpsert, NormalizedEvent } from '@agfn/contracts'
import { invoice, makeKit, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('a completed listing voids what it left out (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit(backend, { now: '2026-10-01T10:00:00.000Z' })
    const acme = await k.company('Acme')
    const qb = await k.connection({ entityId: acme, key: 'quickbooks' })
    const inv = (n: number, o: Partial<Parameters<typeof invoice>[1]> = {}) => invoice(qb, { externalId: `INV-${n}`, total: usd(10_000 * n), issueDate: '2026-09-02', dueDate: '2026-10-02', ...o })
    return { acme, qb, inv }
  }
  const listing = (connectionId: string, kinds: string[], startedAt: string, scope?: string) =>
    ({ type: 'listing.complete', connectionId, externalId: `listing:${startedAt}`, kinds, startedAt, ...(scope ? { scope } : {}) }) as unknown as NormalizedEvent

  it('voids the invoice the provider no longer lists, keeps the unchanged ones, and revives it if it comes back', async () => {
    const { acme, qb, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv(1), inv(2), inv(3)])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(60_000)
    // A day later a full pass lists 1 and 2 (unchanged) but not 3.
    k.setNow('2026-10-02T10:00:00.000Z')
    const started = '2026-10-02T09:59:00.000Z'
    const res = await k.engine.postBatch(k.ws, [inv(1), inv(2), listing(qb, ['invoice'], started)])
    expect(res.map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'recorded'])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(30_000)
    const statuses = Object.fromEntries((await k.engine.store.listRecords(k.ws, { connectionId: qb })).map((r) => [r.externalId, r.status]))
    expect(statuses).toEqual({ 'INV-1': 'posted', 'INV-2': 'posted', 'INV-3': 'void' })
    const check = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'listing')
    expect(check).toMatchObject({ status: 'ok', message: 'QuickBooks: 1 invoice no longer in QuickBooks was voided' })
    // Re-resolving the company's records doesn't bring it back...
    await k.engine.connectionChanged(k.ws, qb)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(30_000)
    // ...but the provider sending it again (even unchanged) does.
    k.setNow('2026-10-03T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [inv(3)])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(60_000)
    expect(await k.tb(acme, 'accrual')).toBe(0)
  })

  it('only its kinds and scope, only synced records; bills are a kind of their own', async () => {
    const { acme, qb, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv(1), inv(2, { externalId: 'other:2' }), inv(4, { direction: 'payable', externalId: 'BILL-4' })])
    k.setNow('2026-10-02T10:00:00.000Z')
    // Lists invoices with prefix INV- (none carried but INV-1): other:2 is out of scope, the bill is another kind.
    await k.engine.postBatch(k.ws, [inv(1), listing(qb, ['invoice'], '2026-10-02T09:00:00.000Z', 'INV-')])
    const statuses = Object.fromEntries((await k.engine.store.listRecords(k.ws, { connectionId: qb })).map((r) => [r.externalId, r.status]))
    expect(statuses).toEqual({ 'INV-1': 'posted', 'other:2': 'posted', 'BILL-4': 'posted' })
    void acme
  })

  it('credit notes of both directions are a kind: the one left out is voided and its invoice is owed again', async () => {
    const { acme, qb, inv } = await setup()
    const cn = (externalId: string, o: Partial<CreditNoteUpsert> = {}): CreditNoteUpsert => ({ type: 'credit_note.upsert', connectionId: qb, externalId, direction: 'receivable', invoiceExternalId: 'INV-1', date: '2026-09-05', amount: usd(2_000), appliedTo: 'invoice', ...o })
    const vc = cn('VC-1', { direction: 'payable', invoiceExternalId: 'BILL-4', amount: usd(1_500) })
    await k.engine.postBatch(k.ws, [inv(1), inv(4, { direction: 'payable', externalId: 'BILL-4' }), cn('CM-1'), cn('CM-2', { amount: usd(3_000) }), vc])
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(5_000)
    // The pass lists CM-2 and the vendor credit, not CM-1; the invoices aren't in this listing's kinds.
    k.setNow('2026-10-02T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [cn('CM-2', { amount: usd(3_000) }), vc, listing(qb, ['credit_note'], '2026-10-02T09:00:00.000Z')])
    const statuses = Object.fromEntries((await k.engine.store.listRecords(k.ws, { connectionId: qb })).map((r) => [r.externalId, r.status]))
    expect(statuses).toMatchObject({ 'INV-1': 'posted', 'BILL-4': 'posted', 'CM-1': 'void', 'CM-2': 'posted', 'VC-1': 'posted' })
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(7_000)
    expect(await k.tb(acme, 'accrual')).toBe(0)
    const check = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'listing')
    expect(check).toMatchObject({ status: 'ok', message: 'QuickBooks: 1 credit note no longer in QuickBooks was voided' })
  })

  it('a listing that carried nothing, or would void most of a kind, voids nothing and says why', async () => {
    const { acme, qb, inv } = await setup()
    await k.engine.postBatch(k.ws, Array.from({ length: 12 }, (_, i) => inv(i + 1)))
    k.setNow('2026-10-02T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [listing(qb, ['invoice'], '2026-10-02T09:00:00.000Z')])
    let warn = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'listing')
    expect(warn).toMatchObject({ status: 'warn' })
    expect(warn?.message).toContain('the listing carried none of the 12')
    // Carries 5 of 12: 7 would go, more than half.
    k.setNow('2026-10-03T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [...Array.from({ length: 5 }, (_, i) => inv(i + 1)), listing(qb, ['invoice'], '2026-10-03T09:00:00.000Z')])
    warn = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'listing')
    expect(warn?.message).toContain('7 of 12 would be voided (more than half)')
    expect((await k.engine.store.listRecords(k.ws, { connectionId: qb })).every((r) => r.status === 'posted')).toBe(true)
  })

  it('works the same on sync pages that settle later', async () => {
    const { acme, qb, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv(1), inv(2)], { settleLater: true })
    await k.engine.settle(k.ws, qb)
    k.setNow('2026-10-02T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [inv(2)], { settleLater: true })
    await k.engine.postBatch(k.ws, [listing(qb, ['invoice'], '2026-10-02T09:00:00.000Z')], { settleLater: true })
    await k.engine.settle(k.ws, qb)
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(20_000)
    expect(await k.tb(acme, 'accrual')).toBe(0)
  })

  it('a deleted invoice in a closed month is reversed on the first open day', async () => {
    const { acme, qb, inv } = await setup()
    await k.engine.postBatch(k.ws, [inv(1), inv(2)])
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-09-30' })
    k.setNow('2026-10-02T10:00:00.000Z')
    await k.engine.postBatch(k.ws, [inv(1), listing(qb, ['invoice'], '2026-10-02T09:00:00.000Z')])
    expect(await k.bal(acme, 'ar', 'accrual', '2026-09-30')).toBe(30_000) // as reported
    expect(await k.bal(acme, 'ar', 'accrual')).toBe(10_000)
  })
})
