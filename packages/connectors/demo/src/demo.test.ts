import { describe, expect, it } from 'vitest'
import type { ConnectionRef, NormalizedEvent, ProcessorBalanceTxn, TxnUpsert } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { assertValidEvents, fakeClock, runConnectorContract } from '@agfn/connector-sdk/testing'
import { PROFILES, PROFILE_KEYS, createDemoConnector, demoCaughtUp, type ProfileKey } from './index.ts'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const conn = (profile: ProfileKey): ConnectionRef => ({
  id: `conn_demo_${profile}`,
  workspaceId: 'ws_demo',
  connectorKey: 'demo',
  secret: { demo: true },
  config: { profile, start: '2025-10-09', seed: 'test-seed' },
})
const make = (profile: ProfileKey, t = NOW) => ({ connector: createDemoConnector({ raw: new MemoryRawSink(), clock: fakeClock(t) }), conn: conn(profile) })

async function all(profile: ProfileKey) {
  const { connector, conn: c } = make(profile)
  return (await runSync(connector, c, null)).events
}

describe('demo connector', () => {
  it('reports caught up only after the last page', async () => {
    const { connector, conn: c } = make('harbor')
    expect(demoCaughtUp(null, '2026-10-09')).toBe(false)
    expect(demoCaughtUp('not-a-cursor', '2026-10-09')).toBe(false)
    const first = await connector.sync(c, null)
    expect(demoCaughtUp(first.cursor, '2026-10-09')).toBe(false)
    const done = await runSync(connector, c, null)
    expect(demoCaughtUp(done.cursor, '2026-10-09')).toBe(true)
  })

  it.each(PROFILE_KEYS)('%s passes the connector contract', async (p) => {
    const report = await runConnectorContract({ make: () => make(p), minEvents: 50 })
    // A quick first page, then 13 months of history in whole months, a page stopping past ~1,600 events: 3–5
    // (Harbor, with Stripe, Shopify and cash every day, is the busiest).
    expect(report.pages).toBeGreaterThanOrEqual(3)
    expect(report.pages).toBeLessThanOrEqual(5)
  })

  it.each(PROFILE_KEYS)('%s: every balance snapshot equals opening + rows emitted up to it', async (p) => {
    const { connector, conn: c } = make(p)
    const head = await connector.sync(c, null)
    // The quick first page reports today's balances before any rows (checked against the last page below).
    const events = (await all(p)).slice(head.events.length)
    const bal = new Map(PROFILES[p].accounts.map((a) => [a.id, a.opening]))
    for (const e of events) {
      if (e.type === 'txn.upsert') bal.set(e.accountExternalId, (bal.get(e.accountExternalId) ?? 0) + e.amount.minor)
      if (e.type === 'processor.balance_txn') bal.set(e.accountExternalId, (bal.get(e.accountExternalId) ?? 0) + e.net.minor)
      if (e.type === 'balance.snapshot') expect(e.current.minor).toBe(bal.get(e.accountExternalId))
    }
  })

  it.each(PROFILE_KEYS)('%s: the quick first page has only accounts and today’s balances, equal to the last page’s', async (p) => {
    const { connector, conn: c } = make(p)
    const head = await connector.sync(c, null)
    expect(head.hasMore).toBe(true)
    expect(new Set(head.events.map((e) => e.type))).toEqual(new Set(['account.upsert', 'balance.snapshot']))
    const events = await all(p)
    const last = new Map<string, number>()
    for (const e of events) if (e.type === 'balance.snapshot') last.set(e.externalId, e.current.minor)
    for (const e of head.events) if (e.type === 'balance.snapshot') expect(e.current.minor).toBe(last.get(e.externalId))
  })

  it.each(PROFILE_KEYS)('%s ends the year with believable balances (cash positive, cards owing)', async (p) => {
    const events = await all(p)
    const latest = new Map<string, number>()
    for (const e of events) if (e.type === 'balance.snapshot') latest.set(e.accountExternalId, e.current.minor)
    for (const a of PROFILES[p].accounts) {
      const v = latest.get(a.id) ?? 0
      if (a.type === 'credit_card') expect(v, a.id).toBeLessThanOrEqual(0)
      else expect(v, a.id).toBeGreaterThanOrEqual(0)
      expect(Math.abs(v), a.id).toBeLessThan(2_000_000_00)
    }
    const cash = PROFILES[p].accounts.filter((a) => a.type !== 'credit_card').reduce((s, a) => s + (latest.get(a.id) ?? 0), 0)
    expect(cash).toBeGreaterThan(10_000_00)
  })

  it('personal: a brokerage with holdings that add up to its balance on every snapshot, and it isn\'t cash', async () => {
    const events = await all('personal')
    const snaps = events.filter((e) => e.type === 'balance.snapshot' && e.accountExternalId === 'p-brokerage') as Array<{ current: { minor: number }; holdings?: Array<{ ticker?: string; value: { minor: number } }> }>
    expect(snaps.length).toBeGreaterThan(10)
    for (const s of snaps) expect((s.holdings ?? []).reduce((t, h) => t + h.value.minor, 0)).toBe(s.current.minor)
    expect(snaps.at(-1)?.holdings?.map((h) => h.ticker ?? 'cash')).toEqual(['VTI', 'VXUS', 'BND', 'AAPL', 'cash'])
    expect(PROFILES.personal.accounts.find((a) => a.id === 'p-brokerage')?.type).toBe('investment')
  })

  it('is deterministic for a seed and different for another', async () => {
    const a = await all('northwind')
    const b = await all('northwind')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const other = createDemoConnector({ raw: new MemoryRawSink(), clock: fakeClock(NOW) })
    const c = await runSync(other, { ...conn('northwind'), config: { ...conn('northwind').config, seed: 'other' } }, null)
    expect(JSON.stringify(c.events)).not.toBe(JSON.stringify(a))
  })

  it('a later day extends history without changing earlier events', async () => {
    const first = make('harbor')
    const r1 = await runSync(first.connector, first.conn, null)
    const later = make('harbor', NOW + 3 * 86_400_000)
    const r2 = await runSync(later.connector, later.conn, r1.cursor)
    const newDates = new Set(r2.events.flatMap((e) => (e.type === 'txn.upsert' ? [e.date] : [])))
    expect([...newDates].sort()).toEqual(['2026-10-10', '2026-10-11', '2026-10-12'])
    const fresh = make('harbor', NOW + 3 * 86_400_000)
    const full = await runSync(fresh.connector, fresh.conn, null)
    const byId = new Map(full.events.map((e) => [e.type + e.externalId, JSON.stringify(e)]))
    for (const e of r1.events.filter((x) => x.type === 'txn.upsert' || x.type === 'processor.balance_txn')) {
      expect(byId.get(e.type + e.externalId)).toBe(JSON.stringify(e))
    }
  })

  it('northwind: payouts land in the bank two days later with the payout id; MRR from active subscriptions', async () => {
    const events = await all('northwind')
    const payouts = events.filter((e): e is ProcessorBalanceTxn => e.type === 'processor.balance_txn' && e.kind === 'payout')
    const deposits = new Map(events.filter((e): e is TxnUpsert => e.type === 'txn.upsert' && !!e.linkRefs?.payout_id).map((e) => [e.linkRefs?.payout_id, e]))
    expect(payouts.length).toBeGreaterThan(100)
    for (const p of payouts.filter((x) => (x.arrivalDate ?? '') <= '2026-10-09')) {
      const dep = deposits.get(p.externalId)
      expect(dep, p.externalId).toBeDefined()
      expect(dep?.amount.minor).toBe(-p.net.minor)
      expect(dep?.date).toBe(p.arrivalDate)
    }
    const subs = events.filter((e) => e.type === 'subscription.upsert')
    expect(subs.some((s) => s.type === 'subscription.upsert' && s.status === 'canceled' && s.mrr.minor === 0)).toBe(true)
    const mrr = subs.reduce((s, e) => s + (e.type === 'subscription.upsert' ? e.mrr.minor : 0), 0)
    expect(mrr).toBeGreaterThan(5_000_00)
  })

  it('links: card payments, transfers and the founder loan carry the same ref on both legs', async () => {
    const events = [...(await all('northwind')), ...(await all('personal')), ...(await all('harbor'))]
    const refs = new Map<string, number[]>()
    for (const e of events) {
      if (e.type !== 'txn.upsert') continue
      for (const k of ['card_payment', 'transfer'] as const) {
        const v = e.linkRefs?.[k]
        if (v) refs.set(v, [...(refs.get(v) ?? []), e.amount.minor])
      }
    }
    expect(refs.get('owner-loan-1')).toEqual([2_500_000, -2_500_000])
    for (const [ref, amounts] of refs) {
      expect(amounts, ref).toHaveLength(2)
      expect((amounts[0] ?? 0) + (amounts[1] ?? 0), ref).toBe(0)
    }
  })

  it('bluebird: invoice state matches payments (paid, partial, open, overdue)', async () => {
    const { connector, conn: c } = make('bluebird', Date.parse('2026-11-03T12:00:00Z'))
    const { events } = await runSync(connector, c, null)
    const inv = events.filter((e) => e.type === 'invoice.upsert')
    const statuses = new Set(inv.map((e) => (e.type === 'invoice.upsert' ? e.status : '')))
    expect(statuses).toEqual(new Set(['paid', 'partially_paid', 'open']))
    const applied = new Map<string, number>()
    for (const e of events) if (e.type === 'payment.applied') for (const a of e.applications) applied.set(a.invoiceExternalId, (applied.get(a.invoiceExternalId) ?? 0) + a.amount.minor)
    for (const e of inv) if (e.type === 'invoice.upsert') expect(e.amountPaid.minor).toBe(applied.get(e.externalId) ?? 0)
  })

  it('bluebird: only the last few months of invoices stay unpaid', async () => {
    const { connector, conn: c } = make('bluebird', Date.parse('2026-11-03T12:00:00Z'))
    const { events } = await runSync(connector, c, null)
    for (const e of events) if (e.type === 'invoice.upsert' && e.status !== 'paid') expect(e.issueDate >= '2026-06-01').toBe(true)
  })

  it('payroll runs settle against bank rows that exist', async () => {
    for (const p of ['northwind', 'bluebird', 'harbor'] as const) {
      const events = await all(p)
      const ids = new Set(events.map((e) => e.externalId))
      const runs = events.filter((e) => e.type === 'payroll.run')
      expect(runs.length).toBeGreaterThan(10)
      for (const r of runs) if (r.type === 'payroll.run') for (const s of r.settlementTxnExternalIds ?? []) expect(ids.has(s)).toBe(true)
    }
  })

  it('rejects bad config and cannot be connected through the normal flow', async () => {
    const { connector } = make('northwind')
    await expect(connector.sync({ ...conn('northwind'), config: { profile: 'nope', start: '2025-10-09' } }, null)).rejects.toMatchObject({ kind: 'invalid_input' })
    await expect(connector.sync({ ...conn('northwind'), secret: null }, null)).rejects.toMatchObject({ kind: 'auth' })
    await expect(connector.begin()).rejects.toMatchObject({ kind: 'invalid_input' })
    expect((await connector.connect({ profile: 'harbor' })).config).toMatchObject({ profile: 'harbor', start: '2025-10-09' })
  })

  it('all events are valid together', async () => {
    const events: NormalizedEvent[] = await all('northwind')
    const last = new Map(events.map((e) => [e.type + e.externalId, e]))
    assertValidEvents([...last.values()], { connectionId: 'conn_demo_northwind' })
  })
})
