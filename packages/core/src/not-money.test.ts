// Balances that aren't money here (points, crypto with no ISO code) come in as 'XXX'. They're kept and shown, never
// posted or converted: one such row used to fail its whole batch ("No XXX->USD rate"), the dollar rows with it.
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe("'XXX': not money", () => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  for (const backend of ['memory', 'sqlite'] as const) {
    it(`${backend}: a batch with a dollar row and an XXX row posts the dollar row and keeps the other; cash is unaffected`, async () => {
      k = await makeKit(backend, { now: '2026-10-11T12:00:00.000Z' })
      const acme = await k.company('Acme')
      const usd = await k.account({ entityId: acme, name: 'Checking' })
      // A points account a connector reports as an ordinary account, counted as cash by default.
      const points = await k.account({ entityId: acme, name: 'Rewards', currency: 'XXX', includeInCash: true })
      const snap = (acc: typeof usd, minor: number, day: string) => ({ type: 'balance.snapshot' as const, externalId: `b-${acc.id}-${day}`, connectionId: acc.connectionId as string, accountExternalId: acc.externalId as string, at: `${day}T12:00:00.000Z`, current: { minor, currency: acc.currency } })
      const r = await k.engine.postBatch(k.ws, [snap(usd, 10_500, '2026-09-30'), snap(points, 1_499_850, '2026-09-30'), txn(usd, '2026-10-01', -500), txn(points, '2026-10-02', 150), snap(usd, 10_000, '2026-10-10'), snap(points, 1_500_000, '2026-10-10')])
      expect(r.map((x) => x.status)).toEqual(['recorded', 'recorded', 'posted', 'recorded', 'recorded', 'recorded'])
      const cash = await k.engine.metric('cash', { workspaceId: k.ws, entityIds: [acme] })
      expect(cash.value).toEqual({ minor: 10_000, currency: 'USD' })
      expect(cash.excludedAccounts).toContainEqual({ id: points.id, reason: 'not money (points or crypto)' })
      expect(await k.tb(acme)).toBe(0)
      // Never posted, so nothing to check its balance against: no "balance doesn't match" for it.
      expect((await k.engine.checks(k.ws, { entityIds: [acme] })).filter((c) => c.status !== 'ok')).toEqual([])
      const health = await k.engine.dataHealth(k.ws, [acme])
      expect(health.counts.failedChecks).toBe(0)
    })
  }
})
