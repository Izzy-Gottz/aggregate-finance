// Review shows one question per movement: the shape of a workspace whose accounts moved between companies, with
// withdrawals that fit more than one deposit. All names and amounts are made up.
import { findReviewItem } from '@agfn/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFinance } from './finance.ts'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('Review cards', () => {
  let k: Kit
  let acme: string
  const matches = async () => (await k.engine.reviewItems(k.ws)).filter((i) => i.kind === 'suggested_match')
  const account = (entityId: string, name: string) => k.account({ entityId, name })

  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-11-20T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('the same two rows proposed as two types are one card, of the type their companies fit now', async () => {
    const other = await k.company('Beta')
    const [a, b] = [await account(acme, 'Ally'), await account(other, 'Northbank')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-02', -15_000), txn(b, '2026-11-02', 15_000)])
    await k.engine.reconcile(k.ws)
    const [first] = await matches()
    await k.engine.link(k.ws, { type: 'transfer', fromId: first!.recordIds[0]!, toId: first!.recordIds[1]!, confidence: 0.7, method: 'rule' })
    const items = await matches()
    expect(items).toHaveLength(1)
    expect(items[0]!.confirmLabel).toBe('Yes')
    expect(items[0]!.group).toBeUndefined()
    expect((await k.engine.store.getLink(k.ws, items[0]!.linkId!))?.type).toBe('intercompany')
  })

  it('one withdrawal that fits two deposits is one card: the closest first, the other behind it', async () => {
    const [a, b, c] = [await account(acme, 'Ally'), await account(acme, 'Summit Savings'), await account(acme, 'Harbor Checking')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-09', -10_000), txn(c, '2026-11-12', 10_000), txn(b, '2026-11-10', 10_000)])
    await k.engine.reconcile(k.ws)
    const items = await matches()
    expect(items).toHaveLength(1)
    expect(items[0]!.question).toBe('Did you move $100.00 from Ally to Summit Savings on Nov 9?')
    expect(items[0]!.questionNames).toEqual(['Ally', 'Summit Savings'])
    expect(items[0]!.alternatives?.map((a) => a.question)).toEqual(['Did you move $100.00 from Ally to Harbor Checking on Nov 9?'])

    // The alternative is a normal item, on the card or as the AI and the app read it.
    const views = await createFinance(k.engine).reader.reviewItems!({ workspaceId: k.ws, entityIds: [acme] })
    const alt = findReviewItem(views, items[0]!.alternatives![0]!.id)
    expect(alt?.options).toEqual(['confirm', 'reject'])
    await k.engine.decideLink(k.ws, items[0]!.alternatives![0]!.linkId!, 'confirmed', 'person')
    expect(await matches()).toEqual([])
  })

  it('No to the best match brings the next one up', async () => {
    const [a, b, c] = [await account(acme, 'Ally'), await account(acme, 'Summit Savings'), await account(acme, 'Harbor Checking')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-09', -10_000), txn(b, '2026-11-10', 10_000), txn(c, '2026-11-12', 10_000)])
    await k.engine.reconcile(k.ws)
    const [card] = await matches()
    await k.engine.decideLink(k.ws, card!.linkId!, 'rejected', 'person')
    const [next, ...rest] = await matches()
    expect(next!.question).toContain('Harbor Checking')
    expect(rest).toEqual([])
  })

  it('asks in plain words, with Yes and No', async () => {
    const other = await k.company('Beta')
    const [a, b] = [await account(acme, 'Capital One'), await account(other, 'Ally')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-10-22', -50_000), txn(b, '2026-10-22', 50_000)])
    await k.engine.reconcile(k.ws)
    expect((await matches())[0]).toMatchObject({ question: 'Did you move $500.00 from Capital One to Ally on Oct 22?', confirmLabel: 'Yes', rejectLabel: 'No' })
  })

  it('money with Personal says what Yes means and is never grouped', async () => {
    const me = await k.personal('Sam Rivera')
    const [a, b, c, d] = [await account(acme, 'Ally'), await account(me, 'Home Checking'), await account(acme, 'Summit'), await account(me, 'Home Savings')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-02', -15_000), txn(b, '2026-11-02', 15_000), txn(c, '2026-11-05', -20_000), txn(d, '2026-11-05', 20_000)])
    await k.engine.reconcile(k.ws)
    const items = await matches()
    expect(items).toHaveLength(2)
    for (const i of items) {
      expect(i.confirmLabel).toBe('Yes: money owed between your company and you (not pay)')
      expect(i.group).toBeUndefined()
    }
  })

  it('moves that can be confirmed together share a group', async () => {
    const other = await k.company('Beta')
    const [a, b, c, d] = [await account(acme, 'Ally'), await account(other, 'Northbank'), await account(acme, 'Summit'), await account(other, 'Harbor')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-02', -15_000), txn(b, '2026-11-02', 15_000), txn(c, '2026-11-05', -20_000), txn(d, '2026-11-05', 20_000)])
    await k.engine.reconcile(k.ws)
    expect((await matches()).map((i) => i.group)).toEqual([
      { key: 'moves:companies', label: '2 moves between your companies' },
      { key: 'moves:companies', label: '2 moves between your companies' },
    ])
  })

  it('what changes profit or tax comes first, then the bigger amount; moves come after', async () => {
    const other = await k.company('Beta')
    const [a, b] = [await account(acme, 'Ally'), await account(other, 'Northbank')]
    await k.engine.postBatch(k.ws, [
      txn(a, '2026-11-02', -900_000),
      txn(b, '2026-11-02', 900_000),
      txn(a, '2026-11-10', 2_000, { rawText: 'DEPOSIT 1' }),
      txn(a, '2026-11-11', 75_000, { rawText: 'DEPOSIT 2' }),
    ])
    await k.engine.reconcile(k.ws)
    const items = await k.engine.reviewItems(k.ws)
    expect(items.map((i) => i.kind)).toEqual(['unexplained_money', 'unexplained_money', 'suggested_match'])
    expect(items[0]!.detail).toContain('$750.00')
  })
})
