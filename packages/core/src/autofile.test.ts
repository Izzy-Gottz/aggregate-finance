// Filed for you: the obvious stops being a question, every filing can be undone, and what changes tax is still asked.
// All names and amounts are made up.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Kit } from './test-kit.ts'

describe('filed for you', () => {
  let k: Kit
  let acme: string
  const account = (entityId: string, name: string) => k.account({ entityId, name })
  const run = async () => {
    await k.engine.reconcile(k.ws)
    return k.engine.autoFile(k.ws)
  }
  const questions = () => k.engine.reviewItems(k.ws)

  beforeEach(async () => {
    k = await makeKit('memory', { now: '2026-11-20T12:00:00.000Z' })
    acme = await k.company('Acme')
  })
  afterEach(async () => {
    await k.close()
  })

  it('an exact, unique move between two companies is filed, and undo asks it and leaves it asked', async () => {
    const other = await k.company('Beta')
    const [a, b] = [await account(acme, 'Ally'), await account(other, 'Northbank')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-02', -15_000), txn(b, '2026-11-04', 15_000)])
    expect(await run()).toEqual({ filed: 1 })
    expect(await questions()).toEqual([])
    const [filed] = await k.engine.filedItems(k.ws)
    expect(filed!.text).toBe('$150.00 moved from Ally to Northbank on Nov 2')

    await k.engine.undoFiled(k.ws, filed!.id)
    expect((await questions()).map((i) => i.kind)).toEqual(['suggested_match'])
    expect(await k.engine.filedItems(k.ws)).toEqual([])
    expect(await run()).toEqual({ filed: 0 })
    expect(await questions()).toHaveLength(1)
  })

  it('more than three days apart, a competing deposit, or money with Personal stays a question', async () => {
    const other = await k.company('Beta')
    const me = await k.personal('Sam Rivera')
    const [a, b, c, d, e] = [await account(acme, 'Ally'), await account(other, 'Northbank'), await account(other, 'Harbor'), await account(me, 'Home'), await account(acme, 'Summit')]
    await k.engine.postBatch(k.ws, [
      txn(a, '2026-11-01', -11_000),
      txn(b, '2026-11-05', 11_000), // four days
      txn(a, '2026-11-09', -22_000),
      txn(b, '2026-11-10', 22_000),
      txn(c, '2026-11-11', 22_000), // two possible deposits
      txn(e, '2026-11-12', -33_000),
      txn(d, '2026-11-12', 33_000), // Personal
    ])
    expect(await run()).toEqual({ filed: 0 })
    expect(await questions()).toHaveLength(3)
  })

  it('a stale proposal is closed once the rows sit in other companies, and No answers for both', async () => {
    const me = await k.personal('Sam Rivera')
    const [a, b] = [await account(acme, 'Ally'), await account(me, 'Home')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-02', -15_000), txn(b, '2026-11-02', 15_000)])
    await k.engine.reconcile(k.ws)
    const [card] = await questions()
    const stale = await k.engine.link(k.ws, { type: 'transfer', fromId: card!.recordIds[0]!, toId: card!.recordIds[1]!, confidence: 0.7, method: 'rule' })
    await k.engine.autoFile(k.ws)
    expect((await k.engine.store.getLink(k.ws, stale.linkId))?.status).toBe('rejected')
    await k.engine.decideLink(k.ws, card!.linkId!, 'rejected', 'person')
    // The deposit is unexplained again, and the same pair isn't asked a second time.
    expect((await questions()).filter((i) => i.kind === 'suggested_match')).toEqual([])
  })

  it('No to a move rejects the other proposal for the same two rows', async () => {
    const other = await k.company('Beta')
    const [a, b, c] = [await account(acme, 'Ally'), await account(other, 'Northbank'), await account(other, 'Harbor')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-09', -22_000), txn(b, '2026-11-10', 22_000), txn(c, '2026-11-11', 22_000)])
    await k.engine.reconcile(k.ws)
    const [card] = await questions()
    const twin = await k.engine.link(k.ws, { type: 'transfer', fromId: card!.recordIds[0]!, toId: card!.recordIds[1]!, confidence: 0.7, method: 'rule' })
    await k.engine.decideLink(k.ws, card!.linkId!, 'rejected', 'person')
    expect((await k.engine.store.getLink(k.ws, twin.linkId))?.status).toBe('rejected')
  })

  it('money in under $1 is other income, undoable; $1 is a question', async () => {
    const a = await account(acme, 'Ally')
    await k.engine.postBatch(k.ws, [txn(a, '2026-11-10', 3, { rawText: 'INTEREST' }), txn(a, '2026-11-11', 100, { rawText: 'DEPOSIT' })])
    expect(await run()).toEqual({ filed: 1 })
    expect((await questions()).map((i) => i.detail)).toEqual([expect.stringContaining('$1.00')])
    expect(await k.bal(acme, 'other_income')).toBe(-3)
    const [filed] = await k.engine.filedItems(k.ws)
    expect(filed!.text).toContain('filed as other income')
    await k.engine.undoFiled(k.ws, filed!.id)
    expect(await k.bal(acme, 'other_income')).toBe(0)
    expect(await run()).toEqual({ filed: 0 })
    expect(await questions()).toHaveLength(2)
  })

  it('old deposits from before the connection: Personal is filed as opening balance, a company is asked once', async () => {
    const me = await k.personal('Sam Rivera')
    const [a, b] = [await account(acme, 'Ally'), await account(me, 'Home')]
    await k.engine.postBatch(k.ws, [
      txn(a, '2026-06-01', 40_000, { rawText: 'DEPOSIT' }),
      txn(a, '2026-06-02', 60_000, { rawText: 'DEPOSIT' }),
      txn(b, '2026-06-01', 70_000, { rawText: 'DEPOSIT' }),
      txn(b, '2026-06-02', 80_000, { rawText: 'DEPOSIT' }),
    ])
    expect(await run()).toEqual({ filed: 2 })
    expect(await k.bal(me, 'opening_balance_equity')).toBe(-150_000)
    const items = await questions()
    expect(items).toHaveLength(1)
    expect(items[0]!.question).toContain('2 deposits before Nov 20 in Ally ($1,000.00): count them as your opening balance?')
    expect(items[0]!.choices?.[0]).toEqual({ label: 'Yes, opening balance', edits: { kind: 'other', category: 'opening_balance_equity' } })
  })

  it('nothing is filed into a closed month: links, small money and old deposits stay questions', async () => {
    const other = await k.company('Beta')
    const me = await k.personal('Sam Rivera')
    const [a, b, h] = [await account(acme, 'Ally'), await account(other, 'Northbank'), await account(me, 'Home')]
    await k.engine.postBatch(k.ws, [
      txn(a, '2026-08-10', -15_000),
      txn(b, '2026-08-10', 15_000),
      txn(a, '2026-08-11', 40, { rawText: 'INTEREST' }),
      txn(h, '2026-06-01', 70_000, { rawText: 'DEPOSIT' }),
      txn(h, '2026-06-02', 71_000, { rawText: 'DEPOSIT' }),
    ])
    await k.engine.lockPeriod(k.ws, { entityId: acme, through: '2026-09-30' })
    await k.engine.lockPeriod(k.ws, { entityId: me, through: '2026-09-30' })
    expect(await run()).toEqual({ filed: 0 })
    expect(await k.bal(acme, 'other_income')).toBe(0)
    expect(await k.bal(me, 'opening_balance_equity')).toBe(0)

    // Open again: the same rows are filed.
    await k.engine.unlockPeriod(k.ws, acme)
    await k.engine.unlockPeriod(k.ws, me)
    expect(await run()).toEqual({ filed: 4 })
  })

  it('a locked side on either company keeps a move a question', async () => {
    const other = await k.company('Beta')
    const [a, b] = [await account(acme, 'Ally'), await account(other, 'Northbank')]
    await k.engine.postBatch(k.ws, [txn(a, '2026-08-10', -15_000), txn(b, '2026-08-10', 15_000)])
    await k.engine.lockPeriod(k.ws, { entityId: other, through: '2026-09-30' })
    expect(await run()).toEqual({ filed: 0 })
    expect(await questions()).toHaveLength(1)
  })

  it('a card credit or a refund from before the connection is never opening balance: it changes spending', async () => {
    const me = await k.personal('Sam Rivera')
    const [card, bank] = [await k.account({ entityId: me, name: 'Sapphire', type: 'credit_card' }), await account(me, 'Home')]
    await k.engine.postBatch(k.ws, [txn(card, '2026-06-01', 12_999, { rawText: 'MARKETPLACE REFUND' }), txn(bank, '2026-06-02', 5_000, { rawText: 'STORE REFUND' })])
    expect(await run()).toEqual({ filed: 0 })
    expect(await k.bal(me, 'opening_balance_equity')).toBe(0)
  })

  it('a workspace shaped like 27 open items comes down to a handful of real questions', async () => {
    const other = await k.company('Beta')
    const me = await k.personal('Sam Rivera')
    const [a, b, c, h] = [await account(acme, 'Ally'), await account(other, 'Northbank'), await account(other, 'Harbor'), await account(me, 'Home')]
    const rows = []
    // 8 moves between companies, each proposed under its old type too: 16 cards before.
    for (let n = 0; n < 8; n++) rows.push(txn(a, `2026-10-0${n + 1}`, -10_000 - n), txn(b, `2026-10-0${n + 1}`, 10_000 + n))
    // A withdrawal with two possible deposits: 2 cards before, 1 now.
    rows.push(txn(a, '2026-11-09', -22_000), txn(b, '2026-11-10', 22_000), txn(c, '2026-11-12', 22_000))
    // Small interest, 3 cards before.
    for (const d of ['2026-11-01', '2026-11-02', '2026-11-03']) rows.push(txn(a, d, 3, { rawText: 'FCASH INTEREST' }))
    // Older deposits from before the connection: 3 in Personal filed, 2 in a company asked once.
    for (const d of ['2026-06-01', '2026-06-02', '2026-06-03']) rows.push(txn(h, d, 40_000, { rawText: 'DEPOSIT' }))
    rows.push(txn(a, '2026-06-01', 41_000, { rawText: 'DEPOSIT' }), txn(a, '2026-06-02', 42_000, { rawText: 'DEPOSIT' }))
    // Real questions: two unknown deposits and one move with Personal.
    rows.push(txn(a, '2026-11-14', 90_000, { rawText: 'DEPOSIT' }), txn(a, '2026-11-15', 91_000, { rawText: 'DEPOSIT' }), txn(a, '2026-11-16', -33_000), txn(h, '2026-11-16', 33_000))
    await k.engine.postBatch(k.ws, rows)
    await k.engine.reconcile(k.ws)
    for (const i of (await questions()).filter((x) => x.kind === 'suggested_match' && x.recordIds.length === 2)) {
      const link = await k.engine.store.getLink(k.ws, i.linkId!)
      if (link?.type === 'intercompany' && i.group) await k.engine.link(k.ws, { type: 'transfer', fromId: link.fromId, toId: link.toId, confidence: 0.7, method: 'rule' })
    }
    const open = (await k.engine.store.listLinks(k.ws, { statuses: ['proposed'] })).length
    expect(open).toBeGreaterThanOrEqual(19)

    await k.engine.autoFile(k.ws)
    const left = await questions()
    expect(left.map((i) => i.kind)).toEqual(['unexplained_money', 'unexplained_money', 'suggested_match', 'unexplained_money', 'suggested_match'])
    expect((await k.engine.filedItems(k.ws)).length).toBe(14)
  })
})
