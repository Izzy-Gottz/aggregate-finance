// One account connected twice that twin detection missed: both still count (never auto-subtracted), and every cash,
// burn and runway answer says how much may be counted twice, until one is marked a duplicate.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, txn, usd, type Kit } from './test-kit.ts'

describe('a possible duplicate account in cash, burn and runway', () => {
  let k: Kit
  let acme: string
  beforeEach(async () => {
    k = await makeKit('memory')
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('counts both, says up to how much is counted twice, and stops once one is marked a duplicate', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const merc = await k.connection({ entityId: acme, key: 'mercury' })
    const viaPlaid = await k.account({ entityId: acme, name: 'Mercury Checking', mask: '1234', connectionId: plaid })
    const direct = await k.account({ entityId: acme, name: 'Checking', connectionId: merc })
    const days = ['2026-10-07', '2026-10-08', '2026-10-09']
    await k.engine.postBatch(k.ws, [
      ...days.map((d) => snapshot(viaPlaid, d, 1_000_000)),
      ...days.map((d) => snapshot(direct, d, 1_000_000)),
      txn(viaPlaid, '2026-09-10', -40_000, { counterparty: 'Rent' }),
      txn(direct, '2026-09-10', -40_000, { counterparty: 'Rent' }),
      txn(direct, '2026-09-12', -5_000, { counterparty: 'AWS' }),
    ])
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const cash = await k.engine.metric('cash', scope)
    expect(cash.value).toEqual(usd(2_000_000))
    expect(cash.coverage?.gaps).toContain('Mercury Checking ••1234 and Checking may be one account connected twice, so up to $10,000.00 of cash may be counted twice; mark one a duplicate, or dismiss it if they’re two different accounts'.replace('’', "'"))
    // An explicit period too: the smaller money out of the two.
    const burn = await k.engine.metric('gross_burn', { ...scope, from: '2026-09-01', to: '2026-09-30' })
    expect(burn.value).toEqual(usd(85_000))
    expect(burn.coverage?.gaps).toContainEqual(expect.stringContaining('up to $400.00 of spending in this period may be counted twice'))
    const runway = await k.engine.metric('runway', scope)
    expect((runway.coverage?.gaps ?? []).filter((g) => g.includes('may be one account connected twice'))).toHaveLength(runway.value === null ? 1 : 2)

    await k.markDuplicate(direct.id, viaPlaid.id)
    const after = await k.engine.metric('cash', scope)
    expect(after.value).toEqual(usd(1_000_000))
    expect((after.coverage?.gaps ?? []).some((g) => g.includes('connected twice'))).toBe(false)
  })

  it('dismissing the pair as two different accounts drops the line but keeps both counting', async () => {
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const merc = await k.connection({ entityId: acme, key: 'mercury' })
    const viaPlaid = await k.account({ entityId: acme, name: 'Mercury Checking', mask: '1234', connectionId: plaid })
    const direct = await k.account({ entityId: acme, name: 'Checking', connectionId: merc })
    const days = ['2026-10-07', '2026-10-08', '2026-10-09']
    await k.engine.postBatch(k.ws, [...days.map((d) => snapshot(viaPlaid, d, 1_000_000)), ...days.map((d) => snapshot(direct, d, 1_000_000))])
    const scope = { workspaceId: k.ws, entityIds: [acme] }
    const flag = (await k.engine.checks(k.ws, { entityIds: [acme] })).find((c) => c.name === 'possible_duplicate_account')
    await k.engine.dismissDuplicate(k.ws, { subjectId: flag!.subjectId as string, relatedId: flag!.relatedId as string, dupKey: flag!.dupKey as string })
    // Both still count — a dismissal is never an auto-subtract — but no answer carries the "connected twice" line.
    const cash = await k.engine.metric('cash', scope)
    expect(cash.value).toEqual(usd(2_000_000))
    expect((cash.coverage?.gaps ?? []).some((g) => g.includes('connected twice'))).toBe(false)
    const runway = await k.engine.metric('runway', scope)
    expect((runway.coverage?.gaps ?? []).some((g) => g.includes('connected twice'))).toBe(false)
  })
})
