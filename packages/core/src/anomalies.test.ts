// "Anything odd" detectors and the Monday note, golden answers on memory and SQLite.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { invoice, makeKit, snapshot, txn, usd, type Backend, type Kit } from './test-kit.ts'
import { shortMoney } from './digest.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('anything odd and the Monday note (%s)', (backend) => {
  let k: Kit
  let acme: string

  beforeEach(async () => {
    k = await makeKit(backend)
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('finds duplicate charges, price rises, double billing, a large expense and a missed charge', async () => {
    const sub = await k.company('Memoe')
    const card = await k.account({ entityId: acme, type: 'credit_card' })
    const subCard = await k.account({ entityId: sub, type: 'credit_card' })
    const evs = [
      ...['2026-06-03', '2026-07-03', '2026-08-03', '2026-09-03'].map((d) => txn(card, d, -1_500, { counterparty: 'Figma' })),
      txn(card, '2026-10-03', -1_800, { counterparty: 'Figma' }),
      ...['2026-05-20', '2026-06-20', '2026-07-20', '2026-08-20'].map((d) => txn(card, d, -1_000, { counterparty: 'Notion' })),
      txn(card, '2026-10-01', -4_200, { counterparty: 'Uber' }),
      txn(card, '2026-10-02', -4_200, { counterparty: 'Uber' }),
      txn(card, '2026-10-01', -1_499, { counterparty: 'Zoom' }),
      txn(subCard, '2026-10-02', -1_499, { counterparty: 'Zoom' }),
      ...Array.from({ length: 12 }, (_, i) => txn(card, `2026-0${4 + Math.floor(i / 3)}-${String(2 + i * 2).padStart(2, '0')}`, -500 - i, { counterparty: `Coffee ${String.fromCharCode(65 + i)}x` })),
      txn(card, '2026-10-05', -300_000, { counterparty: 'Big Law LLP' }),
    ]
    await k.engine.postBatch(k.ws, evs)
    const found = await k.engine.anomalies(k.ws, { asOf: '2026-10-09' })
    const byKind = (kind: string) => found.filter((a) => a.kind === kind)
    expect(byKind('duplicate_charge').map((a) => [a.title, a.detail])).toEqual([['Charged twice? Uber', '42.00 USD on 2026-10-01 and 2026-10-02']])
    expect(byKind('price_increase').map((a) => a.title)).toEqual(['Figma went up 20%'])
    expect(byKind('price_increase')[0]?.detail).toBe('15.00 USD → 18.00 USD per month')
    expect(byKind('billed_twice').map((a) => a.detail)).toEqual(['14.99 USD in Acme and Memoe'])
    expect(byKind('large_expense').map((a) => a.title)).toEqual(['Unusually large: Big Law LLP'])
    expect(byKind('missed_payment').map((a) => a.title)).toEqual(["Notion didn't charge as usual"])
    // Warnings first; ids are stable across runs.
    expect(found[0]?.severity).toBe('warn')
    expect((await k.engine.anomalies(k.ws, { asOf: '2026-10-09' })).map((a) => a.id)).toEqual(found.map((a) => a.id))
    // A charge confirmed as a duplicate isn't flagged again.
    const dup = byKind('duplicate_charge')[0]
    await k.engine.link(k.ws, { type: 'duplicate', fromId: dup?.recordIds[0] as string, toId: dup?.recordIds[1] as string, confidence: 1, method: 'human' })
    expect((await k.engine.anomalies(k.ws, { asOf: '2026-10-09' })).filter((a) => a.kind === 'duplicate_charge')).toEqual([])
  })

  it('a missed scheduled bucket payment is odd', async () => {
    await k.engine.createBucket(k.ws, { entityId: acme, name: 'Rent', schedule: { amount: usd(400_000), direction: 'out', cadence: 'monthly', dueDay: 1, startDate: '2026-09-01' } })
    const found = await k.engine.anomalies(k.ws, { asOf: '2026-10-09' })
    expect(found.map((a) => a.title)).toEqual(["Rent wasn't paid", "Rent wasn't paid"])
  })

  it('the Monday note: five lines, or nothing when there is no data', async () => {
    expect(await k.engine.weeklyDigest(k.ws, new Date('2026-10-12T08:00:00Z'))).toBeNull()
    const sub = await k.company('Bluebird Studio')
    const a = await k.account({ entityId: acme })
    const b = await k.account({ entityId: sub })
    const books = await k.connection({ entityId: acme })
    await k.engine.postBatch(k.ws, [
      snapshot(a, '2026-10-11', 28_441_000),
      snapshot(b, '2026-10-11', 9_620_000),
      txn(a, '2026-10-06', 4_210_000, { counterparty: 'Customer' }),
      txn(a, '2026-10-07', -3_180_000, { counterparty: 'Payroll' }),
      txn(a, '2026-10-04', -99_000, { counterparty: 'Before the week' }),
      invoice(books, { total: usd(1_820_000), number: 'INV-7', issueDate: '2026-09-01', dueDate: '2026-09-30' }),
      invoice(books, { direction: 'payable', counterparty: 'Landlord', total: usd(410_000), issueDate: '2026-10-01', dueDate: '2026-10-15' }),
      invoice(books, { direction: 'payable', counterparty: 'Later', total: usd(99_000), issueDate: '2026-10-01', dueDate: '2026-11-15' }),
    ])
    const [inflow] = (await k.engine.store.listRecords(k.ws, { eventTypes: ['txn.upsert'] })).filter((r) => (r.amount?.minor ?? 0) > 0)
    await k.engine.setOverride(k.ws, inflow?.id as string, { kind: 'revenue' }, null)
    const note = await k.engine.weeklyDigest(k.ws, new Date('2026-10-12T08:00:00Z'))
    expect(note).toEqual({
      subject: 'Your week in money · week of Oct 12',
      lines: [
        'Cash: $380,610 across 2 companies (Acme $284,410 · Bluebird Studio $96,200)',
        'Last week: $42,100 in, $31,800 out',
        'Overdue invoices: 1, $18,200',
        'Bills due this week: 1, $4,100',
        'Nothing odd',
      ],
    })
  })

  it('formats short money', () => {
    expect(shortMoney(usd(28_441_049))).toBe('$284,410')
    expect(shortMoney({ minor: 1_000, currency: 'JPY' })).toBe('¥1,000')
    expect(shortMoney({ minor: 123_456, currency: 'CHF' })).toBe('1,235 CHF')
    expect(shortMoney(usd(-5_000))).toBe('-$50')
  })
})
