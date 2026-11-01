// Closed periods: reports for a locked month never move; later changes post on the first open day.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('period locks (%s)', (backend) => {
  let k: Kit
  let acme: string

  beforeEach(async () => {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('a change to a closed month posts on the first open day; the month itself stays as reported', async () => {
    const bank = await k.account({ entityId: acme, name: 'Chase' })
    const rent = txn(bank, '2026-08-01', -300_000, { counterparty: 'Landlord' })
    const sale = txn(bank, '2026-08-15', 500_000, { counterparty: 'Globex' })
    await k.engine.postBatch(k.ws, [rent, sale])
    const augustBefore = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-08-01', to: '2026-08-31', basis: 'cash' })

    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-08-31', note: 'August closed' })
    expect((await k.engine.periodLocks(k.ws)).map((l) => [l.through, l.note])).toEqual([['2026-08-31', 'August closed']])

    // The bank changes the August rent row; someone voids the August sale.
    await k.engine.postBatch(k.ws, [{ ...rent, amount: { minor: -320_000, currency: 'USD' } }, { ...sale, status: 'void' }])
    const augustAfter = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-08-01', to: '2026-08-31', basis: 'cash' })
    expect(augustAfter).toEqual(augustBefore)
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash', '2026-08-31')).toBe(200_000)
    // Everything that changed lands on September 1st, and the totals today are the true ones.
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash')).toBe(-320_000)
    const sept1 = await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-01', basis: 'cash' })
    expect(sept1.netIncome.minor).toBe(-20_000) // the extra rent (an unlabeled receipt isn't income, so voiding it isn't either)
    expect(await k.tb(acme, 'cash')).toBe(0)

    // The export agrees: August as reported, the changes on September 1st.
    const exported = await k.engine.journal(k.ws, { entityIds: [acme], basis: 'cash' })
    expect(exported.map((e) => [e.date, e.memo]).sort()).toEqual([
      ['2026-08-01', 'Landlord'],
      ['2026-08-15', 'Globex'],
      ...[
        ['2026-09-01', 'Change to closed period (2026-08-01): Landlord'],
        ['2026-09-01', 'Change to closed period (2026-08-01): Reversal: Landlord'],
        ['2026-09-01', 'Change to closed period (2026-08-15): Reversal: Globex'],
      ].sort(),
    ])

    // Posting the same data again changes nothing more.
    await k.engine.postBatch(k.ws, [{ ...rent, amount: { minor: -320_000, currency: 'USD' } }, { ...sale, status: 'void' }])
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash')).toBe(-320_000)
    expect((await k.engine.profitAndLoss(k.ws, { entityIds: [acme], from: '2026-09-01', to: '2026-09-01', basis: 'cash' })).netIncome.minor).toBe(-20_000)
  })

  it('open months and other companies are untouched; unlocking lets old dates post where they belong again', async () => {
    const other = await k.company('Other')
    const bank = await k.account({ entityId: acme })
    const theirs = await k.account({ entityId: other })
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-08-31' })
    await k.engine.postBatch(k.ws, [txn(bank, '2026-09-10', -1_000), txn(theirs, '2026-08-10', -2_000), txn(bank, '2026-08-20', -4_000, { externalId: 'late' })])
    expect(await k.bal(other, 'cash:' + theirs.id, 'cash', '2026-08-31')).toBe(-2_000)
    // A new row dated in Acme's closed August: posted on September 1st.
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash', '2026-08-31')).toBe(0)
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash', '2026-09-01')).toBe(-4_000)

    await k.engine.unlockPeriod(k.ws, acme)
    expect(await k.engine.periodLocks(k.ws)).toEqual([])
    await k.engine.postBatch(k.ws, [txn(bank, '2026-08-21', -8_000, { externalId: 'later' })])
    expect(await k.bal(acme, 'cash:' + bank.id, 'cash', '2026-08-31')).toBe(-8_000)
  })

  it('a new lock replaces the old one; only past days can be closed', async () => {
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-07-31' })
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-08-31' })
    expect((await k.engine.periodLocks(k.ws)).map((l) => l.through)).toEqual(['2026-08-31'])
    await expect(k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-10-09' })).rejects.toThrow('Only past days')
    await expect(k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-13-01' })).rejects.toThrow('YYYY-MM-DD')
    await expect(k.engine.lockPeriod(k.ws, { entityId: 'ent_nope' as never, through: '2026-08-31' })).rejects.toThrow('Unknown entity')
  })
})
