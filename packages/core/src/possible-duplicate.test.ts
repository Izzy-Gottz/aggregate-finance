// possible_duplicate_account: one real account connected through two routes that 3a's mask+label match didn't catch.
// Matching balance history is the signal; we never merge on it (two real accounts can hold the same balance), we flag
// the pair so dc's coverage line carries the overlap and the person resolves it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, type Kit } from './test-kit.ts'
import type { CheckResult } from './checks.ts'

describe('possible_duplicate_account', () => {
  let k: Kit
  let acme: string
  const flags = (checks: CheckResult[]) => checks.filter((c) => c.name === 'possible_duplicate_account')
  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-10-09T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('flags two cash accounts whose balances match across several days', async () => {
    const plaid = await k.account({ entityId: acme, name: 'Mercury (Plaid)', mask: '1234' })
    const direct = await k.account({ entityId: acme, name: 'Mercury' })
    await k.engine.postBatch(k.ws, [
      snapshot(plaid, '2026-09-01', 500_000),
      snapshot(plaid, '2026-09-15', 620_000),
      snapshot(plaid, '2026-09-30', 580_000),
      snapshot(direct, '2026-09-01', 500_000),
      snapshot(direct, '2026-09-15', 620_000),
      snapshot(direct, '2026-09-30', 580_000),
    ])
    const dup = flags(await k.engine.checks(k.ws, { entityIds: [acme] }))
    expect(dup).toHaveLength(1)
    const c = dup[0] as CheckResult
    expect(c.status).toBe('warn')
    expect(new Set([c.subjectId, c.relatedId])).toEqual(new Set([plaid.id, direct.id]))
    expect(c.dupKey).toBeTruthy()
    expect(c.message).toContain('Mercury (Plaid) ••1234')
    expect(c.message).toContain('same account')
  })

  it('does not flag when balances match on fewer than three shared days', async () => {
    const a = await k.account({ entityId: acme, name: 'A' })
    const b = await k.account({ entityId: acme, name: 'B' })
    await k.engine.postBatch(k.ws, [
      snapshot(a, '2026-09-01', 500_000),
      snapshot(a, '2026-09-15', 620_000),
      snapshot(b, '2026-09-01', 500_000),
      snapshot(b, '2026-09-15', 620_000),
    ])
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
  })

  it('does not flag two accounts merely sitting at zero', async () => {
    const a = await k.account({ entityId: acme, name: 'A' })
    const b = await k.account({ entityId: acme, name: 'B' })
    await k.engine.postBatch(k.ws, [
      snapshot(a, '2026-09-01', 0),
      snapshot(a, '2026-09-15', 0),
      snapshot(a, '2026-09-30', 0),
      snapshot(b, '2026-09-01', 0),
      snapshot(b, '2026-09-15', 0),
      snapshot(b, '2026-09-30', 0),
    ])
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
  })

  it('does not flag when the balances differ on any shared day', async () => {
    const a = await k.account({ entityId: acme, name: 'A' })
    const b = await k.account({ entityId: acme, name: 'B' })
    await k.engine.postBatch(k.ws, [
      snapshot(a, '2026-09-01', 500_000),
      snapshot(a, '2026-09-15', 620_000),
      snapshot(a, '2026-09-30', 580_000),
      snapshot(b, '2026-09-01', 500_000),
      snapshot(b, '2026-09-15', 620_001), // one cent off: a different account
      snapshot(b, '2026-09-30', 580_000),
    ])
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
  })

  it('does not pair identical balances that belong to two different companies', async () => {
    const beta = await k.company('Beta')
    const a = await k.account({ entityId: acme, name: 'A' })
    const other = await k.account({ entityId: beta, name: 'Other' })
    for (const acc of [a, other]) {
      await k.engine.postBatch(k.ws, [snapshot(acc, '2026-09-01', 500_000), snapshot(acc, '2026-09-15', 620_000), snapshot(acc, '2026-09-30', 580_000)])
    }
    expect(flags(await k.engine.checks(k.ws, { entityIds: 'all' }))).toHaveLength(0)
  })

  it('stops flagging a pair dismissed as different accounts, and stays quiet as more matching days arrive', async () => {
    const plaid = await k.account({ entityId: acme, name: 'Mercury (Plaid)', mask: '1234' })
    const direct = await k.account({ entityId: acme, name: 'Mercury' })
    const post = (day: string, v: number) => k.engine.postBatch(k.ws, [snapshot(plaid, day, v), snapshot(direct, day, v)])
    await post('2026-09-01', 500_000)
    await post('2026-09-15', 620_000)
    await post('2026-09-30', 580_000)
    const flag = flags(await k.engine.checks(k.ws, { entityIds: [acme] }))[0] as CheckResult
    expect(flag.dupKey).toBeTruthy()
    // The person says these are two different accounts (the real path the server route calls).
    await k.engine.dismissDuplicate(k.ws, { subjectId: flag.subjectId as string, relatedId: flag.relatedId as string, dupKey: flag.dupKey as string })
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
    // Five more matching days are the same kind of evidence, so the pair must NOT re-flag.
    for (const d of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']) await post(d, 600_000)
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
  })

  it('a dismissal keyed to a different evidence kind does not suppress the balance-match flag', async () => {
    const plaid = await k.account({ entityId: acme, name: 'Mercury (Plaid)', mask: '1234' })
    const direct = await k.account({ entityId: acme, name: 'Mercury' })
    for (const d of ['2026-09-01', '2026-09-15', '2026-09-30']) await k.engine.postBatch(k.ws, [snapshot(plaid, d, 500_000), snapshot(direct, d, 500_000)])
    const flag = flags(await k.engine.checks(k.ws, { entityIds: [acme] }))[0] as CheckResult
    // A dismissal for a hypothetical "mask" kind must not quiet the balance evidence.
    await k.engine.dismissDuplicate(k.ws, { subjectId: flag.subjectId as string, relatedId: flag.relatedId as string, dupKey: `${flag.subjectId}|${flag.relatedId}|mask` })
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(1)
  })

  it('stops flagging once the pair is resolved as a duplicate', async () => {
    const plaid = await k.account({ entityId: acme, name: 'Mercury (Plaid)', mask: '1234' })
    const direct = await k.account({ entityId: acme, name: 'Mercury' })
    await k.engine.postBatch(k.ws, [
      snapshot(plaid, '2026-09-01', 500_000),
      snapshot(plaid, '2026-09-15', 620_000),
      snapshot(plaid, '2026-09-30', 580_000),
      snapshot(direct, '2026-09-01', 500_000),
      snapshot(direct, '2026-09-15', 620_000),
      snapshot(direct, '2026-09-30', 580_000),
    ])
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(1)
    await k.markDuplicate(direct.id, plaid.id)
    expect(flags(await k.engine.checks(k.ws, { entityIds: [acme] }))).toHaveLength(0)
  })
})
