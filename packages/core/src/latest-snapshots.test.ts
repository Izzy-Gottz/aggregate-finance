// Account balances come from each account's latest provider balance, read for all accounts at once (the overview read
// every snapshot of every account, one account at a time).
import { afterEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, snapshot, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']

describe.each(backends)('latest balance per account (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  it('the newest day wins, and within it the latest reading; an account with nothing has no balance', async () => {
    k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const a = await k.account({ entityId: acme, name: 'Checking' })
    const b = await k.account({ entityId: acme, name: 'Savings' })
    const c = await k.account({ entityId: acme, name: 'Quiet' })
    await k.engine.postBatch(k.ws, [
      snapshot(a, '2026-10-09T10:00:00.000Z', 1_000),
      snapshot(a, '2026-10-10T08:00:00.000Z', 2_000),
      snapshot(a, '2026-10-10T20:00:00.000Z', 3_000),
      snapshot(b, '2026-09-30T10:00:00.000Z', 50_000),
    ])
    const rows = await createFinance(k.engine).reader.accounts({ workspaceId: k.ws, entityIds: [acme] }, {})
    const by = Object.fromEntries(rows.map((r) => [r.name, r.balance?.minor ?? null]))
    expect(by).toEqual({ Checking: 3_000, Savings: 50_000, Quiet: null })
    void c
  })
})
