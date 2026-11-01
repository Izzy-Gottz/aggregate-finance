// Expensify through the real ledger, worked by hand: card spending is counted once (the card row links to Expensify's
// expense and takes its category), the reimbursement settles the employee's report, and nothing is left to guess.
import type { ConnectionRef } from '@agfn/contracts'
import { MemoryRawSink, runSync } from '@agfn/connector-sdk'
import { fakeClock, fixtureFetch } from '@agfn/connector-sdk/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { makeKit, txn, type Kit } from '../../../core/src/test-kit.ts'
import { createExpensifyConnector, type ExpensifySecret } from './connector.ts'
import { expensifyRoutes } from './expensify.test.ts'

const NOW = Date.parse('2026-10-14T12:00:00Z')

describe.each(['memory', 'sqlite'] as const)('expensify into the ledger (%s)', (backend) => {
  let k: Kit
  afterEach(async () => k.close())

  it('card rows take Expensify’s categories, the reimbursement settles the report, nothing is counted twice', async () => {
    k = await makeKit(backend, { now: '2026-10-21T12:00:00.000Z' })
    const acme = await k.company('Acme')
    const connId = await k.connection({ entityId: acme, key: 'expensify' })
    const card = await k.account({ entityId: acme, type: 'credit_card', name: 'Company card' })
    const bank = await k.account({ entityId: acme, name: 'Checking' })
    await k.engine.postBatch(k.ws, [
      txn(card, '2026-10-04', -129_99, { counterparty: 'Amazon Web Services', rawText: 'AWS EMEA AWS.AMAZON.CO' }),
      txn(card, '2026-10-05', -24_50, { counterparty: 'Uber', rawText: 'UBER *TRIP' }),
      txn(card, '2026-10-07', 15_00, { counterparty: 'Amazon', rawText: 'AMAZON MKTPLACE REFUND' }),
      txn(bank, '2026-10-20', -451_05, { rawText: 'EXPENSIFY INC REIMBURSEMENT JANE' }),
    ])
    const ex = createExpensifyConnector({ deps: { raw: new MemoryRawSink(), fetch: fixtureFetch(expensifyRoutes()).fetch, clock: fakeClock(NOW), random: () => 0.5 } })
    const conn: ConnectionRef = { id: connId, workspaceId: k.ws, connectorKey: 'expensify', secret: { partnerUserID: 'u', partnerUserSecret: 's' } satisfies ExpensifySecret, config: {} }
    await k.engine.postBatch(k.ws, (await runSync(ex, conn, null)).events)
    // Confirm the reimbursement match Review asks about.
    for (const l of await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })) if (l.status === 'proposed') await k.engine.decideLink(k.ws, l.id, 'confirmed', 'person-1')
    // The card rows found Expensify's expenses on their own; the reimbursement was a question (confirmed above).
    const links = await k.engine.store.listLinks(k.ws, { types: ['invoice_payment'] })
    expect(links.map((l) => [l.status, l.amount?.minor]).sort()).toEqual([['confirmed', 129_99], ['confirmed', 24_50], ['confirmed', 451_05]].sort())
    expect(links.filter((l) => l.amount?.minor !== 451_05).every((l) => l.confidence >= 0.95)).toBe(true)
    for (const basis of ['cash', 'accrual'] as const) {
      // 129.99 hosting; 24.50 Uber + 412.30 flight = 436.80 travel; 38.75 dinner. Counted once, nothing uncategorized.
      expect(await k.bal(acme, 'cloud', basis)).toBe(129_99)
      expect(await k.bal(acme, 'travel', basis)).toBe(436_80)
      expect(await k.bal(acme, 'meals', basis)).toBe(38_75)
      expect(await k.bal(acme, 'uncategorized_expense', basis)).toBe(0)
      // Jane is paid back; nothing waits for the bank.
      expect(await k.bal(acme, 'ap', basis)).toBe(0)
      expect(await k.bal(acme, 'clearing_unmatched_receipts', basis)).toBe(0)
      expect(await k.tb(acme, basis)).toBe(0)
    }
    // The card's $15 refund isn't in Expensify's books here: it's asked about, as without Expensify. The draft
    // report (Sam's $6.50 coffee) isn't booked.
    expect(await k.bal(acme, 'suspense')).toBe(-15_00)
    expect((await k.engine.reviewItems(k.ws, { entityIds: [acme] })).map((i) => i.kind)).toEqual(['unexplained_money'])
  })
})
