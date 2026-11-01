// MRR history and movements, golden answers on memory and SQLite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubscriptionUpsert } from '@agfn/contracts'
import { makeKit, usd, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

function sub(connectionId: string, id: string, customer: string, o: Partial<SubscriptionUpsert>): SubscriptionUpsert {
  return { type: 'subscription.upsert', externalId: id, connectionId, customer, status: 'active', mrr: usd(0), interval: 'month', intervalCount: 1, startedAt: '2026-01-01T00:00:00Z', ...o }
}

describe.each(backends)('MRR movements (%s)', (backend) => {
  let k: Kit
  let acme: string
  let stripe: string

  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-07-05T12:00:00.000Z' })
    acme = await k.company('Acme')
    stripe = await k.connection({ entityId: acme, key: 'stripe' })
  })
  afterEach(async () => {
    await k.close()
  })

  it('new, expansion, churn, a subscription that ended before we saw it, and a returning customer', async () => {
    await k.engine.postBatch(k.ws, [
      sub(stripe, 'sub_a', 'Globex', { mrr: usd(10_000), startedAt: '2026-06-15T09:00:00Z' }),
      sub(stripe, 'sub_b', 'Initech', { mrr: usd(5_000), startedAt: '2026-07-03T09:00:00Z' }),
    ])
    k.setNow('2026-08-10T12:00:00.000Z')
    await k.engine.post(k.ws, sub(stripe, 'sub_a', 'Globex', { mrr: usd(15_000), startedAt: '2026-06-15T09:00:00Z' })) // upgraded
    k.setNow('2026-09-05T12:00:00.000Z')
    // Seen for the first time already cancelled: its items say what it was worth.
    await k.engine.post(
      k.ws,
      sub(stripe, 'sub_c', 'Umbrella', { status: 'canceled', startedAt: '2026-05-01T00:00:00Z', endedAt: '2026-08-20T00:00:00Z', items: [{ priceExternalId: 'price_1', quantity: 2, amount: usd(3_000) }] }),
    )
    await k.engine.post(k.ws, sub(stripe, 'sub_b', 'Initech', { status: 'canceled', mrr: usd(0), startedAt: '2026-07-03T09:00:00Z', canceledAt: '2026-09-05T10:00:00Z' }))
    k.setNow('2026-10-05T12:00:00.000Z')
    await k.engine.post(k.ws, sub(stripe, 'sub_d', 'Initech', { mrr: usd(4_000), startedAt: '2026-10-02T00:00:00Z' })) // back

    const months = await k.engine.mrrMovements(k.ws, { from: '2026-06', to: '2026-10' })
    const row = (m: (typeof months)[number]) => [m.month, m.start.minor, m.new.minor, m.expansion.minor, m.reactivation.minor, m.contraction.minor, m.churn.minor, m.end.minor]
    expect(months.map(row)).toEqual([
      // month    start   new     exp    react  contr  churn  end
      ['2026-06', 6_000, 10_000, 0, 0, 0, 0, 16_000],
      ['2026-07', 16_000, 5_000, 0, 0, 0, 0, 21_000],
      ['2026-08', 21_000, 0, 5_000, 0, 0, 6_000, 20_000],
      ['2026-09', 20_000, 0, 0, 0, 0, 5_000, 15_000],
      ['2026-10', 15_000, 0, 0, 4_000, 0, 0, 19_000],
    ])
    const aug = months[2]!
    expect([aug.customersStart, aug.customersEnd, aug.churnedCustomers, aug.revenueChurnRate, aug.customerChurnRate]).toEqual([3, 2, 1, 6_000 / 21_000, 1 / 3])
    for (const m of months) expect(m.start.minor + m.new.minor + m.expansion.minor + m.reactivation.minor - m.contraction.minor - m.churn.minor).toBe(m.end.minor)

    // MRR on a past day counts what was live that day, not today's subscriptions.
    expect((await k.engine.metric('mrr', { workspaceId: k.ws, entityIds: [acme], to: '2026-07-31' })).value).toEqual(usd(21_000))
    expect((await k.engine.metric('mrr', { workspaceId: k.ws, entityIds: [acme] })).value).toEqual(usd(19_000))
    expect((await k.engine.metric('arr', { workspaceId: k.ws, entityIds: [acme], to: '2026-08-31' })).value).toEqual(usd(240_000))
  })

  it('the same change synced twice adds nothing; a downgrade is contraction', async () => {
    await k.engine.post(k.ws, sub(stripe, 'sub_a', 'Globex', { mrr: usd(10_000), startedAt: '2026-06-15T09:00:00Z' }))
    k.setNow('2026-08-10T12:00:00.000Z')
    const down = sub(stripe, 'sub_a', 'Globex', { mrr: usd(8_000), startedAt: '2026-06-15T09:00:00Z' })
    await k.engine.post(k.ws, down)
    await k.engine.post(k.ws, down)
    const [aug] = await k.engine.mrrMovements(k.ws, { from: '2026-08', to: '2026-08' })
    expect([aug?.start.minor, aug?.contraction.minor, aug?.end.minor]).toEqual([10_000, 2_000, 8_000])
  })

  it('a backfill with the provider’s past changes dates the upgrade when it happened; a re-sync adds nothing; later ones count', async () => {
    k.setNow('2026-10-05T12:00:00.000Z')
    const changes = [
      { at: '2026-06-15T09:00:00Z', mrr: usd(10_000) },
      { at: '2026-08-10T09:00:00Z', mrr: usd(15_000) },
      { at: '2026-11-01T00:00:00Z', mrr: usd(99_000) }, // after the snapshot: ignored
    ]
    const now = sub(stripe, 'sub_a', 'Globex', { mrr: usd(15_000), startedAt: '2026-06-15T09:00:00Z', changes })
    await k.engine.post(k.ws, now)
    await k.engine.post(k.ws, now)
    const row = (m: { month: string; new: { minor: number }; expansion: { minor: number }; end: { minor: number } }) => [m.month, m.new.minor, m.expansion.minor, m.end.minor]
    expect((await k.engine.mrrMovements(k.ws, { from: '2026-06', to: '2026-10' })).map(row)).toEqual([
      ['2026-06', 10_000, 0, 10_000],
      ['2026-07', 0, 0, 10_000],
      ['2026-08', 0, 5_000, 15_000],
      ['2026-09', 0, 0, 15_000],
      ['2026-10', 0, 0, 15_000],
    ])
    // A later sync lists one more change: it's dated as listed.
    k.setNow('2026-12-05T12:00:00.000Z')
    await k.engine.post(k.ws, sub(stripe, 'sub_a', 'Globex', { mrr: usd(20_000), startedAt: '2026-06-15T09:00:00Z', changes: [...changes.slice(0, 2), { at: '2026-11-20T09:00:00Z', mrr: usd(20_000) }] }))
    expect((await k.engine.mrrMovements(k.ws, { from: '2026-11', to: '2026-12' })).map(row)).toEqual([
      ['2026-11', 0, 5_000, 20_000],
      ['2026-12', 0, 0, 20_000],
    ])
  })

  it('churn and net new MRR for the last complete month; unknown, not 0%, without a current source', async () => {
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const none = await k.engine.metric('mrr_churn_rate', scope)
    expect([none.state, none.value, none.unknownReason]).toEqual(['unknown', null, 'No subscription source (Stripe, Paddle, …) is connected for this company'])

    const synced = await k.connection({ entityId: acme, key: 'stripe', lastSuccessAt: '2026-10-05T06:00:00Z' })
    await k.engine.postBatch(k.ws, [
      sub(synced, 'sub_a', 'Globex', { mrr: usd(15_000), startedAt: '2026-06-15T09:00:00Z' }),
      sub(synced, 'sub_b', 'Initech', { status: 'canceled', mrr: usd(0), startedAt: '2026-07-03T09:00:00Z', canceledAt: '2026-09-05T10:00:00Z', items: [{ priceExternalId: 'p', quantity: 1, amount: usd(5_000) }] }),
    ])
    k.setNow('2026-10-05T12:00:00.000Z')
    const churn = await k.engine.metric('mrr_churn_rate', scope)
    expect([churn.state, churn.value]).toEqual(['ok', 0.25]) // September: 5,000 of 20,000 churned
    expect((await k.engine.metric('net_new_mrr', scope)).value).toEqual(usd(-5_000))

    // A source that stopped syncing before September ended: unknown, with the reason.
    const behind = await k.connection({ entityId: acme, key: 'paddle', lastSuccessAt: '2026-09-20T06:00:00Z' })
    await k.engine.post(k.ws, sub(behind, 'sub_p', 'Hooli', { mrr: usd(2_000), startedAt: '2026-08-01T00:00:00Z' }))
    const late = await k.engine.metric('mrr_churn_rate', scope)
    expect([late.state, late.value]).toEqual(['unknown', null])
    expect(late.unknownReason).toMatch(/last synced Sep 20.*, before 2026-09 ended$/)
  })
})

describe.each(backends)('MRR names its products (%s)', (backend) => {
  let k: Kit
  let acme: string
  let stripe: string
  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-07-05T12:00:00.000Z' })
    acme = await k.company('Acme')
    stripe = await k.connection({ entityId: acme, key: 'stripe' })
  })
  afterEach(async () => {
    await k.close()
  })
  const item = (product: string | undefined, minor: number) => ({ priceExternalId: `price_${product}`, ...(product ? { product } : {}), quantity: 1, amount: usd(minor) })
  const mrr = (name: 'mrr' | 'arr' = 'mrr') => k.engine.metric(name, { workspaceId: k.ws, entityIds: [acme], asOf: '2026-07-05' } as never)

  it('by contribution, highest first, then by name', async () => {
    await k.engine.postBatch(k.ws, [
      sub(stripe, 's1', 'Ava', { mrr: usd(1_800), startedAt: '2026-06-01T00:00:00Z', items: [item('Bean Club', 1_800)] }),
      sub(stripe, 's2', 'Bo', { mrr: usd(5_400), startedAt: '2026-06-01T00:00:00Z', items: [item('Bean Club', 5_400)] }),
      // One subscription, two products: its value is shared by item amount.
      sub(stripe, 's3', 'Cy', { mrr: usd(4_000), startedAt: '2026-06-01T00:00:00Z', items: [item('Mugs', 1_000), item('Gift Box', 3_000)] }),
      sub(stripe, 's4', 'Di', { mrr: usd(1_000), startedAt: '2026-06-01T00:00:00Z', items: [item('Aprons', 1_000)] }),
    ])
    const a = await mrr()
    expect(a.products).toEqual(['Bean Club', 'Gift Box', 'Aprons', 'Mugs'])
    expect(a.productsMore).toBeUndefined()
    expect((await mrr('arr')).products).toEqual(a.products)
    const months = await k.engine.mrrMovements(k.ws, { from: '2026-06', to: '2026-06' })
    expect(months[0]?.products).toEqual(['Bean Club', 'Gift Box', 'Aprons', 'Mugs'])
  })

  it('the top 10 and how many more', async () => {
    await k.engine.postBatch(k.ws, Array.from({ length: 13 }, (_, i) => sub(stripe, `s${i}`, `C${i}`, { mrr: usd(1_000 + i), startedAt: '2026-06-01T00:00:00Z', items: [item(`P${String(i).padStart(2, '0')}`, 1_000 + i)] })))
    const a = await mrr()
    expect(a.products).toEqual(['P12', 'P11', 'P10', 'P09', 'P08', 'P07', 'P06', 'P05', 'P04', 'P03'])
    expect(a.productsMore).toBe(3)
  })

  it('[] when the subscriptions carry no product names; left out when there are no subscriptions', async () => {
    expect((await mrr()).products).toBeUndefined()
    expect('products' in (await mrr())).toBe(false)
    await k.engine.post(k.ws, sub(stripe, 's1', 'Ava', { mrr: usd(1_800), startedAt: '2026-06-01T00:00:00Z', items: [item(undefined, 1_800)] }))
    expect((await mrr()).products).toEqual([])
    expect((await k.engine.mrrMovements(k.ws, { from: '2026-06', to: '2026-06' }))[0]?.products).toEqual([])
  })
})
