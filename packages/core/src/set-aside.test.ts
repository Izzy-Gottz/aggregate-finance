// Set-asides: the acceptance case is a real one. A "Taxes" bucket holding a fixed amount in one savings account, not
// counted in cash, due on a date: Aggregate must leave it out of available cash so nobody subtracts by hand.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, snapshot, txn, type Backend, type Kit } from './test-kit.ts'
import { createFinance } from './finance.ts'
import { scopedSetAside, setAsideSentence } from '@agfn/contracts'
import { heldRows, setAsideView, keepUnseenAllocations } from './set-aside.ts'
import { SetAsideError } from './set-aside.ts'

const backends: Backend[] = ['memory', 'sqlite', 'pglite']
const USD = (minor: number) => ({ minor, currency: 'USD' })

describe.each(backends)('set-asides (%s)', (backend) => {
  let k: Kit
  let acme: string
  const metric = async (name: 'cash' | 'available_cash' | 'runway' | 'revenue', entityIds: string[] = [acme]) => k.engine.metric(name, { workspaceId: k.ws, entityIds })
  const minor = (v: unknown) => (v as { minor: number }).minor

  beforeEach(async () => {
    k = await makeKit(backend)
    acme = await k.company('Acme')
    k.setNow('2026-10-28T12:00:00.000Z')
  })
  afterEach(async () => {
    await k.close()
  })

  it('a fixed amount that does not count leaves available cash, not cash; profit and reports never move', async () => {
    const savings = await k.account({ entityId: acme, name: 'Savings' })
    const checking = await k.account({ entityId: acme, name: 'Checking' })
    await k.engine.postBatch(k.ws, [snapshot(savings, '2026-10-27', 2_000_000), snapshot(checking, '2026-10-27', 500_000), txn(checking, '2026-10-20', 90_000, { counterparty: 'Client' })])
    const revenue = await metric('revenue')
    const bucket = await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', setAside: { allocations: [{ accountId: savings.id, kind: 'fixed', minor: 750_000 }], countsInCash: false, goal: { minor: 750_000, currency: 'USD', by: '2027-04-15' } } })
    expect(minor((await metric('cash')).value)).toBe(2_500_000)
    const available = await metric('available_cash')
    expect(minor(available.value)).toBe(1_750_000)
    expect(available.formula).toContain('Taxes')
    expect((await metric('revenue')).value).toEqual(revenue.value)
    const view = (await setAsideView(k.engine.metricContext(k.ws), bucket, '2026-10-28'))!
    expect(view).toMatchObject({ held: USD(750_000), countsInCash: false, goal: { by: '2027-04-15', progressPercent: 100 } })
    expect(setAsideSentence(view)).toContain("don't subtract it by hand")
  })

  it('counts in cash by default: only a label', async () => {
    const savings = await k.account({ entityId: acme, name: 'Savings' })
    await k.engine.postBatch(k.ws, [snapshot(savings, '2026-10-27', 1_000_000)])
    await k.engine.createBucket(k.ws, { entityId: acme, name: 'Fund', setAside: { allocations: [{ accountId: savings.id, kind: 'fixed', minor: 300_000 }], countsInCash: true } })
    expect(minor((await metric('available_cash')).value)).toBe(1_000_000)
  })

  it('an existing bucket built with fields is upgraded in place, and undone by clearing', async () => {
    const savings = await k.account({ entityId: acme, name: 'Savings' })
    await k.engine.postBatch(k.ws, [snapshot(savings, '2026-10-27', 1_000_000)])
    const old = await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', fields: [{ key: 'reserve', label: 'Reserve', type: 'number' }, { key: 'account', label: 'Account', type: 'text' }], values: { reserve: 4000, account: 'Savings' } })
    const up = await k.engine.updateBucket(k.ws, old.id, { setAside: { allocations: [{ accountId: savings.id, kind: 'fixed', minor: 400_000 }], countsInCash: false } })
    expect(up.id).toBe(old.id)
    expect(up.values).toEqual({ reserve: 4000, account: 'Savings' })
    expect(minor((await metric('available_cash')).value)).toBe(600_000)
    await k.engine.updateBucket(k.ws, old.id, { setAside: null })
    expect(minor((await metric('available_cash')).value)).toBe(1_000_000)
  })

  it('a percent follows the balance; goals work on an account that is never cash', async () => {
    const fidelity = await k.account({ entityId: acme, name: 'Fidelity', type: 'investment', includeInCash: false })
    const bank = await k.account({ entityId: acme, name: 'Bank' })
    await k.engine.postBatch(k.ws, [snapshot(fidelity, '2026-10-20', 10_000_000), snapshot(bank, '2026-10-20', 100_000)])
    const b = await k.engine.createBucket(k.ws, { entityId: acme, name: 'College', setAside: { allocations: [{ accountId: fidelity.id, kind: 'percent', percent: 50 }], countsInCash: false, goal: { minor: 10_000_000, currency: 'USD' } } })
    const rc = k.engine.metricContext(k.ws)
    expect((await setAsideView(rc, b, '2026-10-28'))!.goal!.progressPercent).toBe(50)
    await k.engine.postBatch(k.ws, [snapshot(fidelity, '2026-10-27', 12_000_000)])
    expect((await setAsideView(rc, b, '2026-10-28'))!).toMatchObject({ held: USD(6_000_000), goal: { progressPercent: 60 } })
    // Never cash, so it takes nothing out of cash.
    expect(minor((await metric('available_cash')).value)).toBe(100_000)
  })

  it('a percent of inflows counts money in, skips transfers and owner money, and paying releases it; a re-sent row changes nothing', async () => {
    const bank = await k.account({ entityId: acme, name: 'Bank' })
    const sale = txn(bank, '2026-10-05', 100_000)
    const edit = async (externalId: string, patch: Parameters<Kit['engine']['setOverride']>[2]) => {
      const rec = (await k.engine.store.listRecords(k.ws, { sourceAccountId: bank.id })).find((r) => r.externalId === externalId)
      await k.engine.setOverride(k.ws, rec?.id as string, patch, null)
    }
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-01', 500_000), sale, txn(bank, '2026-09-20', 900_000)])
    const b = await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', setAside: { allocations: [{ accountId: bank.id, kind: 'inflow', percent: 30, since: '2026-10-01' }], countsInCash: false } })
    const held = async () => (await heldRows(k.engine.metricContext(k.ws), '2026-10-28')).find((r) => r.bucketId === b.id)!.minor
    expect(await held()).toBe(30_000)
    await k.engine.post(k.ws, sale)
    expect(await held()).toBe(30_000)
    const xfer = txn(bank, '2026-10-10', 200_000)
    const owner = txn(bank, '2026-10-11', 400_000)
    await k.engine.postBatch(k.ws, [xfer, owner])
    await edit(xfer.externalId, { kind: 'transfer' })
    await edit(owner.externalId, { kind: 'owner_contribution' })
    expect(await held()).toBe(30_000)
    // The tax payment, tagged to the bucket, releases what it paid.
    const irs = txn(bank, '2026-10-20', -10_000)
    await k.engine.postBatch(k.ws, [irs])
    await edit(irs.externalId, { bucketId: b.id })
    expect(await held()).toBe(20_000)
    // Corrected to something else, the held amount moves with it.
    await edit(sale.externalId, { kind: 'transfer' })
    expect(await held()).toBe(0)
  })

  it('underfunded: review item while short, gone once fixed; available never goes below what is there', async () => {
    const savings = await k.account({ entityId: acme, name: 'Savings' })
    await k.engine.postBatch(k.ws, [snapshot(savings, '2026-10-27', 300_000)])
    await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', setAside: { allocations: [{ accountId: savings.id, kind: 'fixed', minor: 500_000 }], countsInCash: false } })
    const f = createFinance(k.engine)
    const items = async () => (await f.reader.reviewItems({ workspaceId: k.ws, entityIds: [acme] })).filter((i) => i.kind === 'underfunded_set_aside')
    expect((await items())[0]).toMatchObject({ detail: 'Savings has $3,000.00 but $5,000.00 is set aside from it.', options: [] })
    expect(minor((await metric('available_cash')).value)).toBe(0)
    await k.engine.postBatch(k.ws, [snapshot(savings, '2026-10-28', 800_000)])
    expect(await items()).toEqual([])
  })

  it('counts against the company that owns the account, and a reader sees only accounts they may see', async () => {
    const beta = await k.company('Beta')
    const acmeBank = await k.account({ entityId: acme, name: 'Acme bank' })
    const betaBank = await k.account({ entityId: beta, name: 'Beta bank' })
    await k.engine.postBatch(k.ws, [snapshot(acmeBank, '2026-10-27', 1_000_000), snapshot(betaBank, '2026-10-27', 1_000_000)])
    const b = await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', setAside: { allocations: [{ accountId: acmeBank.id, kind: 'fixed', minor: 100_000 }, { accountId: betaBank.id, kind: 'fixed', minor: 200_000 }], countsInCash: false, goal: { minor: 1_000_000, currency: 'USD' } } })
    expect(minor((await metric('available_cash', [acme])).value)).toBe(900_000)
    expect(minor((await metric('available_cash', [beta])).value)).toBe(800_000)
    const v = (await setAsideView(k.engine.metricContext(k.ws), b, '2026-10-28'))!
    const seen = scopedSetAside(v, [acme], '2026-10-28', '2026-10-28')
    expect(seen.perAccount.map((p) => p.accountName)).toEqual(['Acme bank'])
    expect(seen).toMatchObject({ held: USD(100_000), goal: { progressPercent: 10 } })
    expect(JSON.stringify(seen)).not.toContain('Beta bank')
  })

  it('refuses a card, an unknown account, and more than 100% of one account across buckets', async () => {
    const bank = await k.account({ entityId: acme, name: 'Bank' })
    const card = await k.account({ entityId: acme, name: 'Card', type: 'credit_card' })
    const pct = (accountId: string, percent: number) => ({ allocations: [{ accountId, kind: 'percent' as const, percent }], countsInCash: false })
    await expect(k.engine.createBucket(k.ws, { entityId: acme, name: 'A', setAside: pct(card.id, 10) })).rejects.toThrow(SetAsideError)
    await expect(k.engine.createBucket(k.ws, { entityId: acme, name: 'B', setAside: pct('nope', 10) })).rejects.toThrow(SetAsideError)
    await k.engine.createBucket(k.ws, { entityId: acme, name: 'C', setAside: pct(bank.id, 60) })
    await expect(k.engine.createBucket(k.ws, { entityId: acme, name: 'D', setAside: pct(bank.id, 50) })).rejects.toThrow(/More than 100%/)
  })

  it('runway uses available cash once something is left out, and says so', async () => {
    const bank = await k.account({ entityId: acme, name: 'Bank' })
    await k.engine.postBatch(k.ws, [snapshot(bank, '2026-10-27', 1_200_000), txn(bank, '2026-07-05', -100_000, { externalId: 'a' }), txn(bank, '2026-08-05', -100_000, { externalId: 'b' }), txn(bank, '2026-09-05', -100_000, { externalId: 'c' })])
    const before = await metric('runway')
    await k.engine.createBucket(k.ws, { entityId: acme, name: 'Taxes', setAside: { allocations: [{ accountId: bank.id, kind: 'fixed', minor: 600_000 }], countsInCash: false } })
    const after = await metric('runway')
    expect(after.value as number).toBeLessThan(before.value as number)
    expect(after.formula).toContain('Available cash')
  })
})

describe('keepUnseenAllocations', () => {
  const al = (accountId: string, minor: number) => ({ accountId, kind: 'fixed' as const, minor })
  const current = { allocations: [al('seen', 100), al('hidden', 200)], countsInCash: false, note: 'Q4' }

  it('replaces what the writer sees and keeps the rest', () => {
    expect(keepUnseenAllocations(current as never, { allocations: [al('seen', 300)], countsInCash: false } as never, ['seen'])).toEqual({ allocations: [al('seen', 300), al('hidden', 200)], countsInCash: false })
  })
  it('removing keeps the unseen ones and the settings, and with none unseen it removes', () => {
    expect(keepUnseenAllocations(current as never, null, ['seen'])).toEqual({ allocations: [al('hidden', 200)], countsInCash: false, note: 'Q4' })
    expect(keepUnseenAllocations(current as never, null, ['seen', 'hidden'])).toBeNull()
    expect(keepUnseenAllocations(null, null, [])).toBeNull()
  })
})
