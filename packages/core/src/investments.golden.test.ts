// Investments a company holds (a fund's portfolio, a company's own stake): booked at cost, money back returns cost
// first and the rest is a realized gain, write-offs are not spending (contract: InvestmentEvent).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WriteRejected, type InvestmentEvent, type NormalizedEvent, type Provenance } from '@agfn/contracts'
import { EventValidationError } from './validate.ts'
import { makeKit, txn, usd, type Backend, type Kit } from './test-kit.ts'
import { createFinance } from './finance.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']

describe.each(backends)('investments (%s)', (backend) => {
  let k: Kit
  let fund: string
  let conn: string

  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-12T12:00:00.000Z' })
    fund = await k.company('Harbor Seed Fund I')
    conn = await k.connection({ entityId: fund, key: 'carta' })
  })
  afterEach(async () => {
    await k.close()
  })

  const ev = (externalId: string, kind: InvestmentEvent['kind'], positionId: string, date: string, minor: number | null, extra: Partial<InvestmentEvent> = {}): InvestmentEvent => ({
    type: 'investment.event',
    externalId,
    connectionId: conn,
    kind,
    positionId,
    issuer: positionId === 'tide' ? 'Tidewell Health' : positionId === 'pine' ? 'Pinecrest AI' : 'Quillmark',
    securityType: 'preferred_stock',
    date,
    ...(minor !== null ? { amount: usd(minor) } : {}),
    ...extra,
  })

  async function balanced(): Promise<void> {
    expect(await k.tb(fund, 'cash')).toBe(0)
    expect(await k.tb(fund, 'accrual')).toBe(0)
  }

  it('an investment is an asset at cost, paid by its bank wire; never spending', async () => {
    const bank = await k.account({ entityId: fund })
    await k.engine.post(k.ws, txn(bank, '2026-04-01', 2_000_000_00, { counterparty: 'Opening' }))
    await k.engine.post(k.ws, ev('tide-1', 'invest', 'tide', '2026-04-20', 500_000_00, { shares: 1_000_000, series: 'Seed' }))
    await k.engine.post(k.ws, txn(bank, '2026-04-21', -500_000_00, { counterparty: 'TIDEWELL HEALTH WIRE' }))
    const link = (await k.engine.store.listLinks(k.ws, { types: ['investment_cash'] }))[0]
    expect(link?.status).toBe('confirmed')
    expect(await k.bal(fund, 'investment:tide')).toBe(500_000_00)
    expect(await k.bal(fund, 'clearing_investments')).toBe(0)
    const scope = { workspaceId: k.ws, entityIds: [fund], from: '2026-04-01', to: '2026-04-30' }
    expect((await k.engine.metric('gross_burn', scope)).value).toEqual(usd(0))
    await balanced()
  })

  it('money back returns cost first, the rest is a realized gain; a write-off is not burn', async () => {
    await k.engine.postBatch(k.ws, [
      ev('pine-1', 'invest', 'pine', '2026-06-18', 400_000_00),
      ev('pine-2', 'distribution', 'pine', '2026-08-27', 300_000_00),
      ev('pine-3', 'exit', 'pine', '2026-09-10', 900_000_00),
      ev('tide-1', 'invest', 'tide', '2026-04-20', 500_000_00),
      ev('tide-2', 'write_off', 'tide', '2026-09-30', null),
    ])
    expect(await k.bal(fund, 'investment:pine')).toBe(0)
    expect(await k.bal(fund, 'investment:tide')).toBe(0)
    // Pinecrest: 400k in; 300k back is all cost, then the exit returns the last 100k of cost and 800k of gain.
    expect(await k.bal(fund, 'investment_gains')).toBe(-800_000_00)
    expect(await k.bal(fund, 'investment_writeoffs')).toBe(500_000_00)
    const sep = { workspaceId: k.ws, entityIds: [fund], from: '2026-09-01', to: '2026-09-30' }
    expect((await k.engine.metric('gross_burn', sep)).value).toEqual(usd(0))
    expect((await k.engine.metric('net_burn', sep)).value).toEqual(usd(0))
    expect((await k.engine.metric('revenue', sep)).value).toEqual(usd(0))
    const f = createFinance(k.engine)
    const pnl = (await f.reader.reports({ workspaceId: k.ws, entityIds: [fund] }, 'profit_and_loss', '2026-04-01', '2026-09-30', 'cash'))[0]
    expect(pnl?.total).toEqual(usd(300_000_00))
    await balanced()
  })

  it('an earlier event added later re-plans the rest of the position', async () => {
    await k.engine.post(k.ws, ev('pine-2', 'distribution', 'pine', '2026-08-27', 1_200_000_00))
    expect(await k.bal(fund, 'investment_gains')).toBe(-1_200_000_00) // no cost known yet: all gain
    await k.engine.post(k.ws, ev('pine-1', 'invest', 'pine', '2026-06-18', 400_000_00))
    expect(await k.bal(fund, 'investment_gains')).toBe(-800_000_00)
    expect(await k.bal(fund, 'investment:pine')).toBe(0)
    await balanced()
  })

  it('an exit for less than cost is a realized loss; marks and conversions post nothing', async () => {
    await k.engine.postBatch(k.ws, [
      ev('q-1', 'invest', 'quill', '2026-05-01', 300_000_00, { securityType: 'safe', valuationCap: usd(10_000_000_00), discountPct: 20 }),
      ev('q-2', 'convert', 'quill', '2026-07-01', null, { securityType: 'preferred_stock', series: 'Series A', shares: 250_000 }),
      ev('q-3', 'mark', 'quill', '2026-08-01', 900_000_00, { markSource: 'Series A price' }),
    ])
    expect(await k.bal(fund, 'investment:quill')).toBe(300_000_00)
    const f = createFinance(k.engine)
    const scope = { workspaceId: k.ws, entityIds: [fund] }
    const [q] = (await f.reader.investments?.(scope)) ?? []
    expect(q).toMatchObject({ issuer: 'Quillmark', securityType: 'preferred_stock', series: 'Series A', shares: 250_000, invested: usd(300_000_00), value: usd(900_000_00), valueSource: 'mark', markedAt: '2026-08-01', distributed: usd(0), moic: 3, status: 'active' })
    expect(q?.valuationCap).toBeUndefined()
    await k.engine.post(k.ws, ev('q-4', 'exit', 'quill', '2026-09-15', 100_000_00))
    expect(await k.bal(fund, 'investment:quill')).toBe(0)
    expect(await k.bal(fund, 'investment_gains')).toBe(200_000_00) // a loss
    const [after] = (await f.reader.investments?.(scope)) ?? []
    expect(after).toMatchObject({ value: usd(0), valueSource: 'exited', distributed: usd(100_000_00), moic: 0.33, status: 'exited' })
    // As of a day before the exit, it was still held at its mark.
    const [before] = (await f.reader.investments?.(scope, '2026-09-01')) ?? []
    expect(before).toMatchObject({ status: 'active', value: usd(900_000_00) })
    await balanced()
  })

  it('rejects what can\'t be booked', async () => {
    await expect(k.engine.post(k.ws, ev('bad-1', 'invest', 'tide', '2026-04-20', -5))).rejects.toThrow(EventValidationError)
    await expect(k.engine.post(k.ws, { ...ev('bad-2', 'invest', 'tide', '2026-04-20', null) })).rejects.toThrow(EventValidationError)
    await expect(k.engine.post(k.ws, ev('bad-3', 'invest', 'tide', '2026-04-20', 5, { discountPct: 120 }))).rejects.toThrow(EventValidationError)
  })

  let seq = 0
  const prov = (): Provenance => ({ writeRequestId: `wr_${++seq}_${Math.random().toString(36).slice(2, 8)}`, actorKind: 'person', personId: 'person-owner', label: 'Dana' }) as Provenance

  it('records investments by hand through the writer: a new position, then events on it, refused in plain words when wrong', async () => {
    const f = createFinance(k.engine)
    const w = (payload: Record<string, unknown>) => f.writer.apply({ op: 'record_investment', workspaceId: k.ws, entityId: fund, payload }, prov())
    const made = await w({ event: { kind: 'invest', issuer: 'Tidewell Health', securityType: 'safe', date: '2026-04-20', amount: usd(500_000_00), valuationCap: usd(12_000_000_00) } })
    expect(made.positionId).toBeTruthy()
    expect(made.summary).toBe('Invested in Tidewell Health')
    expect(await k.bal(fund, `investment:${made.positionId}`)).toBe(500_000_00)
    // Later events name the position; the issuer and security type come from it.
    const back = await w({ event: { kind: 'distribution', positionId: made.positionId, date: '2026-08-01', amount: usd(600_000_00) } })
    expect(back.positionId).toBe(made.positionId)
    expect(await k.bal(fund, 'investment_gains')).toBe(-100_000_00)
    await expect(w({ event: { kind: 'mark', positionId: made.positionId, date: '2026-08-02', amount: { minor: 5, currency: 'EUR' } } })).rejects.toThrow(/held in USD/)
    await expect(w({ event: { kind: 'distribution', date: '2026-08-02', amount: usd(5) } })).rejects.toThrow(WriteRejected)
    await expect(w({ event: { kind: 'mark', positionId: 'nope', date: '2026-08-02', amount: usd(5) } })).rejects.toThrow(/No investment nope/)
    await w({ event: { kind: 'convert', positionId: made.positionId, date: '2026-08-03', securityType: 'preferred_stock', series: 'Series A', shares: 40_000 } })
    await expect(w({ event: { kind: 'convert', positionId: made.positionId, date: '2026-08-04', securityType: 'preferred_stock' } })).rejects.toThrow(/nothing to convert/)
    await w({ event: { kind: 'exit', positionId: made.positionId, date: '2026-09-01', amount: usd(0) } })
    await expect(w({ event: { kind: 'mark', positionId: made.positionId, date: '2026-09-02', amount: usd(5) } })).rejects.toThrow(/ended on 2026-09-01/)
    // A distribution on the exit's own day is part of closing it (ordered before the exit), not refused.
    await w({ event: { kind: 'distribution', positionId: made.positionId, date: '2026-09-01', amount: usd(1) } })
    await f.writer.revert(k.ws, (await k.engine.store.listRecords(k.ws, { eventTypes: ['investment.event'] })).filter((r) => r.date === '2026-09-01' && r.event.type === 'investment.event' && r.event.kind === 'distribution')[0]!.id, prov())
    // Undoing the distribution re-plans the position: the exit now returns nothing of 500k cost (a realized loss).
    await f.writer.revert(k.ws, back.recordId, prov())
    expect(await k.bal(fund, 'investment_gains')).toBe(500_000_00)
    expect(await k.bal(fund, `investment:${made.positionId}`)).toBe(0)
    await balanced()
  })

  it('a full listing voids an investment the provider no longer has, and its position re-plans', async () => {
    await k.engine.postBatch(k.ws, [ev('carta:note-1', 'invest', 'quill', '2026-05-01', 300_000_00, { securityType: 'safe' }), ev('carta:cert-1', 'invest', 'tide', '2026-06-01', 200_000_00)])
    k.setNow('2026-10-13T10:00:00.000Z')
    const startedAt = '2026-10-13T09:59:00.000Z'
    await k.engine.postBatch(k.ws, [ev('carta:cert-1', 'invest', 'tide', '2026-06-01', 200_000_00), { type: 'listing.complete', connectionId: conn, externalId: `listing:${startedAt}`, kinds: ['investment'], startedAt, scope: 'carta:' } as unknown as NormalizedEvent])
    expect(await k.bal(fund, 'investment:quill')).toBe(0)
    expect(await k.bal(fund, 'investment:tide')).toBe(200_000_00)
    await balanced()
  })

  it('shares distributed in kind (an exit with no amount) leave at cost: no gain, no loss, no burn', async () => {
    await k.engine.postBatch(k.ws, [ev('t-1', 'invest', 'tide', '2026-04-20', 500_000_00), ev('t-2', 'exit', 'tide', '2026-09-20', null)])
    expect(await k.bal(fund, 'investment:tide')).toBe(0)
    expect(await k.bal(fund, 'owner_draws')).toBe(500_000_00)
    expect(await k.bal(fund, 'investment_gains')).toBe(0)
    expect(await k.bal(fund, 'investment_writeoffs')).toBe(0)
    const [t] = (await createFinance(k.engine).reader.investments?.({ workspaceId: k.ws, entityIds: [fund] })) ?? []
    expect(t).toMatchObject({ status: 'exited', valueSource: 'exited', distributed: usd(0), moic: null })
    await balanced()
  })

  it('an in-kind exit after distributions on the same day still leaves at cost (a Carta-shaped exit)', async () => {
    await k.engine.postBatch(k.ws, [
      ev('m-1', 'invest', 'tide', '2014-03-03', 30_000_00),
      ev('m-2', 'invest', 'tide', '2014-03-03', 95_125_13),
      ev('m-3', 'invest', 'tide', '2014-12-01', 800_000_00),
      ev('m-4', 'invest', 'tide', '2015-08-17', 1_500_000_11),
      ev('m-5', 'distribution', 'tide', '2018-06-20', 55_250_00),
      ev('m-6', 'distribution', 'tide', '2021-07-15', 30_00),
      ev('m-7', 'distribution', 'tide', '2021-07-15', 15_00),
      ev('m-8', 'distribution', 'tide', '2021-07-15', 45_00),
      ev('m-9', 'exit', 'tide', '2021-07-15', null),
    ])
    expect(await k.bal(fund, 'investment:tide')).toBe(0)
    expect(await k.bal(fund, 'investment_gains')).toBe(0)
    expect(await k.bal(fund, 'owner_draws')).toBe(2_425_125_24 - 55_250_00 - 90_00)
    await balanced()
  })

  it('the same position posted one event at a time, in reverse, books the same', async () => {
    const evs = [
      ev('m-1', 'invest', 'tide', '2014-03-03', 30_000_00),
      ev('m-2', 'invest', 'tide', '2014-03-03', 95_125_13),
      ev('m-3', 'invest', 'tide', '2014-12-01', 800_000_00),
      ev('m-4', 'invest', 'tide', '2015-08-17', 1_500_000_11),
      ev('m-5', 'distribution', 'tide', '2018-06-20', 55_250_00),
      ev('m-6', 'distribution', 'tide', '2021-07-15', 30_00),
      ev('m-7', 'distribution', 'tide', '2021-07-15', 15_00),
      ev('m-8', 'distribution', 'tide', '2021-07-15', 45_00),
      ev('m-9', 'exit', 'tide', '2021-07-15', null),
    ]
    for (const e of [...evs].reverse()) await k.engine.post(k.ws, e)
    expect(await k.bal(fund, 'investment:tide')).toBe(0)
    expect(await k.bal(fund, 'investment_gains')).toBe(0)
    expect(await k.bal(fund, 'owner_draws')).toBe(2_425_125_24 - 55_250_00 - 90_00)
    await balanced()
  })

  it('totals per company and currency: one definition for the page and the tool', async () => {
    const other = await k.company('Second Fund')
    const conn2 = await k.connection({ entityId: other, key: 'carta' })
    k.rates.set('2026-04-01', 'EUR', 'USD', '1.10')
    await k.engine.postBatch(k.ws, [
      ev('t-1', 'invest', 'tide', '2026-01-10', 500_000_00),
      ev('t-2', 'mark', 'tide', '2026-06-01', 900_000_00),
      ev('p-1', 'invest', 'pine', '2026-02-01', 400_000_00),
      ev('p-2', 'distribution', 'pine', '2026-05-01', 300_000_00),
      ev('p-3', 'exit', 'pine', '2026-08-01', 900_000_00),
      ev('q-1', 'invest', 'quill', '2026-03-01', 300_000_00),
      ev('q-2', 'write_off', 'quill', '2026-09-01', null),
      ev('g-1', 'invest', 'gone', '2026-03-05', 200_000_00),
      ev('g-2', 'exit', 'gone', '2026-09-10', null),
      ev('e-1', 'invest', 'euro', '2026-04-01', 0, { amount: { minor: 100_000_00, currency: 'EUR' } }),
      { ...ev('o-1', 'invest', 'quill', '2026-04-01', 50_000_00), connectionId: conn2 },
    ])
    const f = createFinance(k.engine)
    const totals = (await f.reader.investmentTotals?.({ workspaceId: k.ws, entityIds: [fund, other] })) ?? []
    expect(totals).toEqual([
      // Tide (active at its mark), Pinecrest (exited at a gain), Quillmark (written off), Gone (left in kind: not in the multiple).
      { entityId: fund, currency: 'USD', positions: 4, active: 1, invested: usd(1_400_000_00), value: usd(900_000_00), distributed: usd(1_200_000_00), writtenOff: usd(300_000_00), moic: 1.75, moicExcludes: 1 },
      { entityId: fund, currency: 'EUR', positions: 1, active: 1, invested: { minor: 100_000_00, currency: 'EUR' }, value: { minor: 100_000_00, currency: 'EUR' }, distributed: { minor: 0, currency: 'EUR' }, writtenOff: { minor: 0, currency: 'EUR' }, moic: 1, moicExcludes: 0 },
      { entityId: other, currency: 'USD', positions: 1, active: 1, invested: usd(50_000_00), value: usd(50_000_00), distributed: usd(0), writtenOff: usd(0), moic: 1, moicExcludes: 0 },
    ])
    // The same positions investments() lists; as of an earlier day, the later events aren't in it.
    expect((await f.reader.investments?.({ workspaceId: k.ws, entityIds: [fund, other] }))?.length).toBe(6)
    const early = (await f.reader.investmentTotals?.({ workspaceId: k.ws, entityIds: [fund] }, '2026-03-31')) ?? []
    expect(early).toEqual([{ entityId: fund, currency: 'USD', positions: 4, active: 4, invested: usd(1_400_000_00), value: usd(1_400_000_00), distributed: usd(0), writtenOff: usd(0), moic: 1, moicExcludes: 0 }])
  })
})

