// Sync pages post with settleLater: no matching or opening balances per page; settle does both once, with the same
// result as posting normally, and a sync that stopped before settling is caught up by the next settle.
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedEvent } from '@agfn/contracts'
import { makeKit, snapshot, txn, type Backend, type Kit } from './test-kit.ts'

const backends: Backend[] = ['memory', 'sqlite']

describe.each(backends)('settling a sync once (%s)', (backend) => {
  let k: Kit
  afterEach(async () => {
    await k.close()
  })

  async function setup() {
    k = await makeKit(backend, { now: '2026-10-09T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const plaid = await k.connection({ entityId: acme, key: 'plaid' })
    const bank = await k.account({ entityId: acme, name: 'Checking', connectionId: plaid })
    const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Amex', connectionId: plaid })
    // The card payment's two sides arrive on different pages; the bank's first balance on the second.
    const pages: NormalizedEvent[][] = [
      [txn(card, '2026-09-12', -5_000, { counterparty: 'Notion' }), txn(bank, '2026-09-25', -5_000, { rawText: 'AMEX EPAYMENT ACH PMT' })],
      [txn(card, '2026-09-25', 5_000, { rawText: 'PAYMENT THANK YOU' }), snapshot(bank, '2026-09-30T08:00:00Z', 100_000)],
    ]
    return { acme, plaid, bank, card, pages }
  }

  async function books(acme: string, bank: { id: string }, card: { id: string }) {
    const links = await k.engine.store.listLinks(k.ws, { statuses: ['confirmed'] })
    return {
      links: links.map((l) => l.type),
      bank: await k.bal(acme, `cash:${bank.id}`),
      card: await k.bal(acme, `card:${card.id}`),
      spend: await k.bal(acme, 'uncategorized_expense'),
      clearing: await k.bal(acme, 'clearing_transfers'),
      tb: await k.tb(acme),
    }
  }

  it('matches across pages and sets the opening balance once, the same as posting each page normally', async () => {
    const { acme, plaid, bank, card, pages } = await setup()
    for (const p of pages) await k.engine.postBatch(k.ws, p)
    const direct = await books(acme, bank, card)
    expect(direct).toEqual({ links: ['card_payment'], bank: 100_000, card: 0, spend: 5_000, clearing: 0, tb: 0 })
    await k.close()

    const again = await setup()
    for (const p of again.pages) await k.engine.postBatch(k.ws, p, { settleLater: true })
    // Nothing matched or opened yet: the payment's sides sit apart and the bank has no opening.
    const before = await books(again.acme, again.bank, again.card)
    expect(before.links).toEqual([])
    expect(before.bank).toBe(-5_000)
    expect(await k.engine.store.unsettledSince(k.ws, again.plaid)).not.toBeNull()

    await k.engine.settle(k.ws, again.plaid)
    expect(await books(again.acme, again.bank, again.card)).toEqual(direct)
    expect(await k.engine.store.unsettledSince(k.ws, again.plaid)).toBeNull()
    void plaid
  })

  it('a sync that stopped before settling is settled with the next one; settling with nothing waiting changes nothing', async () => {
    const { acme, plaid, bank, card, pages } = await setup()
    await k.engine.postBatch(k.ws, pages[0] as NormalizedEvent[], { settleLater: true })
    // (the run failed here) — later a new run posts the rest and settles
    k.setNow('2026-10-09T13:00:00.000Z')
    await k.engine.postBatch(k.ws, pages[1] as NormalizedEvent[], { settleLater: true })
    expect(await k.engine.store.unsettledSince(k.ws, plaid)).toBe('2026-10-09T12:00:00.000Z')
    await k.engine.settle(k.ws, plaid)
    expect(await books(acme, bank, card)).toEqual({ links: ['card_payment'], bank: 100_000, card: 0, spend: 5_000, clearing: 0, tb: 0 })

    const version = await k.engine.store.version(k.ws)
    await k.engine.settle(k.ws, plaid)
    expect(await k.engine.store.version(k.ws)).toBe(version)
  })
})
